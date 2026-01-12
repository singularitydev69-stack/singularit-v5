
import { MapperService } from './MapperService';
import { ResponseProcessor } from './ResponseProcessor';
import { getHealthTracker } from './provider-health-tracker.js';
import { StepExecutor } from './execution/StepExecutor';
import { StreamingManager } from './execution/StreamingManager';
import { ContextManager } from './execution/ContextManager';
import { PersistenceCoordinator } from './execution/PersistenceCoordinator';
import { TurnEmitter } from './execution/TurnEmitter';
import { CognitivePipelineHandler } from './execution/CognitivePipelineHandler';
import { formatArtifactAsOptions, parseV1MapperToArtifact } from '../../shared/parsing-utils';

export class WorkflowEngine {
  constructor(orchestrator, sessionManager, port, options = {}) {
    this.orchestrator = orchestrator;
    this.sessionManager = sessionManager;
    this.port = port;

    // Services
    this.mapperService = options.mapperService || options.MapperService || new MapperService();
    this.responseProcessor = options.responseProcessor || new ResponseProcessor();
    this.healthTracker = getHealthTracker();

    // Components
    this.stepExecutor = new StepExecutor(
      orchestrator,
      this.mapperService,
      this.responseProcessor,
      this.healthTracker
    );
    this.streamingManager = new StreamingManager(port);
    this.contextManager = new ContextManager(sessionManager);
    this.persistenceCoordinator = new PersistenceCoordinator(sessionManager);
    this.turnEmitter = new TurnEmitter(port);
    this.cognitiveHandler = new CognitivePipelineHandler(port, this.persistenceCoordinator, sessionManager);

    // Executor mapping - FOUNDATION ONLY
    // Singularity/Concierge steps are handled via handleContinueCognitiveRequest
    this._executors = {
      prompt: (step, ctx, _results, _wfCtx, _resolved, opts) =>
        this.stepExecutor.executePromptStep(step, ctx, opts),
      mapping: (step, ctx, results, wfCtx, resolved, opts) =>
        this.stepExecutor.executeMappingStep(step, ctx, results, wfCtx, resolved, opts),
    };

    // Provider key mapping for upsert
    this._providerKeys = {
      prompt: null,
      mapping: 'mappingProvider',
    };
  }

  async execute(request, resolvedContext) {
    const { context, steps } = request;
    const stepResults = new Map();
    const workflowContexts = {};

    this.currentUserMessage =
      context?.userMessage ||
      request?.context?.userMessage ||
      this.currentUserMessage ||
      "";

    if (!this.currentUserMessage?.trim()) {
      console.error("[WorkflowEngine] CRITICAL: execute() with empty userMessage!");
      return;
    }

    if (!context.sessionId || context.sessionId === "new-session") {
      context.sessionId =
        context.sessionId && context.sessionId !== "new-session"
          ? context.sessionId
          : `sid-${Date.now()}`;
    }

    try {
      const mode = request.mode || "auto";
      context.mode = mode;

      // VALIDATION: Ensure only foundation steps are present in the main loop
      const invalidSteps = steps.filter(s => !['prompt', 'mapping'].includes(s.type));
      if (invalidSteps.length > 0) {
        throw new Error(`Foundation phase received cognitive/legacy steps: ${invalidSteps.map(s => s.type).join(', ')}. Foundation only supports 'prompt' and 'mapping'.`);
      }

      this._seedContexts(resolvedContext, stepResults, workflowContexts);
      this._hydrateV1Artifacts(context, resolvedContext);

      // ✅ SINGLE LOOP - Steps are already ordered by WorkflowCompiler
      for (const step of steps) {
        // Execute the step
        const result = await this._executeStep(
          step, context, stepResults, workflowContexts, resolvedContext
        );

        // Check for halt conditions
        const haltReason = await this._checkHaltConditions(
          step, result, request, context, steps, stepResults, resolvedContext
        );

        if (haltReason) {
          await this._haltWorkflow(request, context, steps, stepResults, resolvedContext, haltReason);
          return;
        }
      }

      // All steps completed successfully
      await this._persistAndFinalize(request, context, steps, stepResults, resolvedContext);

    } catch (error) {
      console.error(`[WorkflowEngine] Critical workflow execution error:`, error);
      this.port.postMessage({
        type: "WORKFLOW_COMPLETE",
        sessionId: context.sessionId,
        workflowId: request.workflowId,
        error: "A critical error occurred.",
      });
    } finally {
      this.streamingManager.clearCache(context?.sessionId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED STEP EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  async _executeStep(step, context, stepResults, workflowContexts, resolvedContext) {
    const executor = this._executors[step.type];
    if (!executor) {
      throw new Error(`Unknown step type: ${step.type}`);
    }

    const options = this._buildOptionsForStep(step.type);

    try {
      const result = await executor(step, context, stepResults, workflowContexts, resolvedContext, options);

      stepResults.set(step.stepId, { status: "completed", result });
      this._emitStepUpdate(step, context, result, resolvedContext, "completed");

      if (step.type === 'prompt' && result?.results) {
        Object.entries(result.results).forEach(([pid, data]) => {
          if (data?.meta && Object.keys(data.meta).length > 0) {
            workflowContexts[pid] = data.meta;
          }
        });
      }

      await this._persistStepResponse(step, context, result, resolvedContext);

      return result;

    } catch (error) {
      stepResults.set(step.stepId, { status: "failed", error: error.message });
      this._emitStepUpdate(step, context, { error: error.message }, resolvedContext, "failed");
      throw error;
    }
  }

  _buildOptionsForStep(stepType) {
    const baseOptions = {
      streamingManager: this.streamingManager,
      persistenceCoordinator: this.persistenceCoordinator,
      sessionManager: this.sessionManager,
    };

    if (stepType === 'mapping') {
      baseOptions.contextManager = this.contextManager;
    }
    // Note: refiner/antagonist options setup kept generic or handled in CognitivePipelineHandler if needed,
    // but here we are strictly Foundation phase.

    return baseOptions;
  }

  async _persistStepResponse(step, context, result, resolvedContext) {
    if (resolvedContext?.type === "recompute") return;
    if (step.type === 'prompt') return;

    const providerKey = this._providerKeys[step.type];
    if (!providerKey) return;

    const aiTurnId = context?.canonicalAiTurnId;
    const providerId = step?.payload?.[providerKey];

    if (aiTurnId && providerId) {
      try {
        await this.persistenceCoordinator.upsertProviderResponse(
          context.sessionId,
          aiTurnId,
          providerId,
          step.type,
          0,
          {
            text: result?.text || "",
            status: result?.status || "completed",
            meta: result?.meta || {},
          }
        );
      } catch (_) { }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROL FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  async _checkHaltConditions(step, result, request, context, steps, stepResults, resolvedContext) {
    if (step.type === 'prompt') {
      const resultsObj = result?.results || {};
      const successfulCount = Object.values(resultsObj).filter(r => r.status === 'completed').length;
      const mappingPlanned = Array.isArray(steps) && steps.some(s => s && s.type === 'mapping');
      if (mappingPlanned && resolvedContext?.type !== 'recompute' && successfulCount < 2) {
        return "insufficient_witnesses";
      }
    }

    if (step.type === 'mapping') {
      const shouldHalt = await this.cognitiveHandler.orchestrateSingularityPhase(
        request,
        context,
        steps,
        stepResults,
        resolvedContext,
        this.currentUserMessage,
        this.stepExecutor,
        this.streamingManager,
      );
      if (shouldHalt) {
        return "singularity_orchestration_complete";
      }
    }

    return null;
  }

  async _haltWorkflow(request, context, steps, stepResults, resolvedContext, haltReason) {

    await this._persistAndFinalize(request, context, steps, stepResults, resolvedContext);

    this.port.postMessage({
      type: "WORKFLOW_COMPLETE",
      sessionId: context.sessionId,
      workflowId: request.workflowId,
      finalResults: Object.fromEntries(stepResults),
      haltReason,
    });
  }

  // --- HELPERS ---

  _seedContexts(resolvedContext, stepResults, workflowContexts) {
    if (resolvedContext && resolvedContext.type === "recompute") {
      console.log("[WorkflowEngine] Seeding frozen batch outputs for recompute");
      try {
        stepResults.set("batch", {
          status: "completed",
          result: { results: resolvedContext.frozenBatchOutputs },
        });
      } catch (e) {
        console.warn("[WorkflowEngine] Failed to seed frozen batch outputs:", e);
      }

      try {
        Object.entries(resolvedContext.providerContextsAtSourceTurn || {}).forEach(([pid, ctx]) => {
          if (ctx && typeof ctx === "object") {
            workflowContexts[pid] = ctx;
          }
        });
      } catch (e) {
        console.warn("[WorkflowEngine] Failed to cache historical provider contexts:", e);
      }
    }

    if (resolvedContext && resolvedContext.type === "extend") {
      try {
        const ctxs = resolvedContext.providerContexts || {};
        const cachedProviders = [];
        Object.entries(ctxs).forEach(([pid, meta]) => {
          if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
            workflowContexts[pid] = meta;
            cachedProviders.push(pid);
          }
        });
        if (cachedProviders.length > 0) {
          console.log(`[WorkflowEngine] Pre-cached contexts from ResolvedContext.extend for providers: ${cachedProviders.join(", ")}`);
        }
      } catch (e) {
        console.warn("[WorkflowEngine] Failed to cache provider contexts from extend:", e);
      }
    }
  }

  _hydrateV1Artifacts(context, resolvedContext) {
    if (!context.mapperArtifact) {
      try {
        const previousOutputs = resolvedContext?.providerContexts || {};
        const v1MappingText = Object.values(previousOutputs)
          .map(ctx => ctx?.text || "")
          .find(text => text.includes("<mapping_output>") || text.includes("<decision_map>"));

        if (v1MappingText) {
          context.mapperArtifact = parseV1MapperToArtifact(v1MappingText, {
            query: context.userMessage || ""
          });
        }
      } catch (err) {
        console.warn("[WorkflowEngine] Cross-version hydration failed:", err);
      }
    }
    if (context.mapperArtifact && !context.extractedOptions) {
      try {
        console.log("[WorkflowEngine] Flattening V2 MapperArtifact for V1-compatible consumers...");
        context.extractedOptions = formatArtifactAsOptions(context.mapperArtifact);
      } catch (err) {
        console.warn("[WorkflowEngine] V2 artifact flattening failed:", err);
      }
    }
  }

  _emitStepUpdate(step, context, result, resolvedContext, status) {
    this.port.postMessage({
      type: "WORKFLOW_STEP_UPDATE",
      sessionId: context.sessionId,
      stepId: step.stepId,
      status: status,
      result: status === 'completed' ? result : undefined,
      error: status === 'failed' ? result.error : undefined,
      isRecompute: resolvedContext?.type === "recompute",
      sourceTurnId: resolvedContext?.sourceTurnId,
    });
  }

  async _persistAndFinalize(request, context, steps, stepResults, resolvedContext) {
    const result = {
      batchOutputs: {},
      mappingOutputs: {},
      singularityOutputs: {},
    };

    const stepById = new Map((steps || []).map((s) => [s.stepId, s]));
    stepResults.forEach((stepResult, stepId) => {
      if (stepResult.status !== "completed") return;
      const step = stepById.get(stepId);
      if (!step) return;
      if (step.type === "prompt") {
        result.batchOutputs = stepResult.result?.results || {};
      } else if (step.type === "mapping") {
        const providerId = step.payload?.mappingProvider;
        if (providerId) result.mappingOutputs[providerId] = stepResult.result;
      }
    });

    const persistRequest = {
      type: resolvedContext?.type || "unknown",
      sessionId: context.sessionId,
      userMessage: this.currentUserMessage,
      // ✅ CRITICAL: Ensure cognitive artifacts are persisted
      mapperArtifact: context?.mapperArtifact,
      singularityOutput: context?.singularityOutput,
      storedAnalysis: context?.storedAnalysis,
    };
    if (resolvedContext?.type === "recompute") {
      persistRequest.sourceTurnId = resolvedContext.sourceTurnId;
      persistRequest.stepType = resolvedContext.stepType;
      persistRequest.targetProvider = resolvedContext.targetProvider;
    }
    if (context?.canonicalUserTurnId)
      persistRequest.canonicalUserTurnId = context.canonicalUserTurnId;
    if (context?.canonicalAiTurnId)
      persistRequest.canonicalAiTurnId = context.canonicalAiTurnId;

    console.log(
      `[WorkflowEngine] Persisting (consolidated) ${persistRequest.type} workflow to SessionManager`,
    );

    const persistResult = await this.persistenceCoordinator.persistWorkflowResult(
      persistRequest,
      resolvedContext,
      result
    );

    if (persistResult) {
      if (persistResult.userTurnId)
        context.canonicalUserTurnId = persistResult.userTurnId;
      if (persistResult.aiTurnId)
        context.canonicalAiTurnId = persistResult.aiTurnId;
      if (resolvedContext?.type === "initialize" && persistResult.sessionId) {
        context.sessionId = persistResult.sessionId;
        console.log(
          `[WorkflowEngine] Initialize complete: session=${persistResult.sessionId}`,
        );
      }
    }

    this.port.postMessage({
      type: "WORKFLOW_COMPLETE",
      sessionId: context.sessionId,
      workflowId: request.workflowId,
      finalResults: Object.fromEntries(stepResults),
    });

    this.turnEmitter.emitTurnFinalized(context, steps, stepResults, resolvedContext, this.currentUserMessage);
  }

  async handleRetryRequest(message) {
    try {
      const { sessionId, aiTurnId, providerIds, retryScope } = message || {};
      console.log(`[WorkflowEngine] Retry requested for providers = ${(providerIds || []).join(', ')} scope = ${retryScope} `);

      try {
        (providerIds || []).forEach((pid) => this.healthTracker.resetCircuit(pid));
      } catch (_) { }

      try {
        this.port.postMessage({
          type: 'WORKFLOW_PROGRESS',
          sessionId: sessionId,
          aiTurnId: aiTurnId,
          phase: retryScope || 'batch',
          providerStatuses: (providerIds || []).map((id) => ({ providerId: id, status: 'queued', progress: 0 })),
          completedCount: 0,
          totalCount: (providerIds || []).length,
        });
      } catch (_) { }
    } catch (e) {
      console.warn('[WorkflowEngine] handleRetryRequest failed:', e);
    }
  }

  async handleContinueCognitiveRequest(payload) {
    return this.cognitiveHandler.handleContinueRequest(
      payload,
      this.stepExecutor,
      this.streamingManager,
      this.contextManager
    );
  }
}
