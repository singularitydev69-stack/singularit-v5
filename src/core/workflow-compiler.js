// src/core/workflow-compiler.js - PHASE 3 COMPLETE
/**
 * WorkflowCompiler - PURE FUNCTION
 *
 * Phase 3 completion: Zero database access, fully synchronous.
 * All data comes from ResolvedContext parameter.
 */

export class WorkflowCompiler {
  constructor(sessionManager, config = {}) {
    // Kept only for dependency injection - NEVER USED
    this.sessionManager = sessionManager;

    // Store defaults in memory from injected config
    this.defaults = {
      mapper: config.htos_mapping_provider || null,
    };
  }

  /**
   * PURE COMPILE: Primitive + Context → Workflow Steps
   *
   * @param {Object} request - Initialize/Extend/Recompute primitive
   * @param {Object} resolvedContext - REQUIRED from ContextResolver
   * @returns {Object} Executable workflow
   */
  compile(request, resolvedContext) {
    if (!resolvedContext) {
      throw new Error("[Compiler] resolvedContext required");
    }

    this._validateRequest(request);
    this._validateContext(resolvedContext);

    const compileRequest = this._applyBatchGating(request, resolvedContext);

    const workflowId = this._generateWorkflowId(resolvedContext.type);
    const steps = [];
    // Track created step IDs to ensure correct linkage
    let batchStepId = null;

    console.log(`[Compiler] Compiling ${resolvedContext.type} workflow`);

    // ========================================================================
    // STEP GENERATION: Based on primitive request
    // ========================================================================
    switch (resolvedContext.type) {
      case "initialize":
      case "extend":
        // Batch step if providers specified
        if (compileRequest.providers && compileRequest.providers.length > 0) {
          const batchStep = this._createBatchStep(compileRequest, resolvedContext);
          steps.push(batchStep);
          batchStepId = batchStep.stepId;
        }
        break;

      case "recompute":
        if (resolvedContext.stepType === "batch") {
          // Generate a single-provider prompt step targeting the provider being retried
          const provider = resolvedContext.targetProvider;
          const stepId = `batch-retry-${Date.now()}`;
          // Normalize provider context shape
          const rawCtx = resolvedContext.providerContextsAtSourceTurn
            ? resolvedContext.providerContextsAtSourceTurn[provider]
            : undefined;
          const meta = rawCtx && rawCtx.meta ? rawCtx.meta : rawCtx;
          const providerContexts = meta
            ? { [provider]: { meta, continueThread: true } }
            : undefined;
          const batchStep = {
            stepId,
            type: "prompt",
            payload: {
              prompt: resolvedContext.sourceUserMessage,
              providers: [provider],
              providerContexts,
              useThinking: !!request.useThinking,
            },
          };
          steps.push(batchStep);
          batchStepId = stepId;
        } else {
          console.log("[Compiler] Recompute: Skipping batch (frozen outputs)");
        }
        break;
    }

    // Mapping step first
    if (this._needsMappingStep(compileRequest, resolvedContext)) {
      const mappingStep = this._createMappingStep(compileRequest, resolvedContext, {
        batchStepId,
      });
      steps.push(mappingStep);
    }

    const workflowContext = this._buildWorkflowContext(
      compileRequest,
      resolvedContext,
    );

    console.log(`[Compiler] Generated ${steps.length} steps`);

    return {
      workflowId,
      context: workflowContext,
      steps,
      mode: request.mode,
      singularity: request.singularity,
    };
  }

  // ============================================================================
  // STEP CREATORS (Pure)
  // ============================================================================

  _createBatchStep(request, context) {
    return {
      stepId: `batch-${Date.now()}`,
      type: "prompt",
      payload: {
        prompt: request.userMessage,
        providers: request.providers,
        providerContexts:
          context.type === "extend" ? context.providerContexts : undefined,
        previousContext: context.previousContext || null,
        previousAnalysis: context.previousAnalysis || null,
        providerMeta: request.providerMeta || {},
        useThinking: !!request.useThinking,
      },
    };
  }

  _createMappingStep(request, context, linkIds = {}) {
    // Include provider in stepId so UI can derive provider on failure without result payload
    const mappingProviderId =
      context.type === "recompute"
        ? context.targetProvider
        : request.mapper || this._getDefaultMapper(request);
    const mappingStepId = `mapping-${mappingProviderId}-${Date.now()}`;

    if (context.type === "recompute") {
      return {
        stepId: mappingStepId,
        type: "mapping",
        payload: {
          mappingProvider: context.targetProvider,
          sourceHistorical: {
            turnId: context.sourceTurnId,
            responseType: "batch",
          },
          originalPrompt: context.sourceUserMessage,
          useThinking: !!request.useThinking,
          attemptNumber: 1,
        },
      };
    }

    // Use mapper from primitive
    const mapper = mappingProviderId;

    return {
      stepId: mappingStepId,
      type: "mapping",
      payload: {
        mappingProvider: mapper,
        sourceStepIds: linkIds.batchStepId ? [linkIds.batchStepId] : undefined,
        providerOrder: Array.isArray(request.providers)
          ? request.providers.slice()
          : undefined,
        originalPrompt: request.userMessage,
        useThinking: !!request.useThinking && mapper === "chatgpt",
        attemptNumber: 1,
      },
    };
  }

  // ============================================================================
  // DECISION LOGIC (Pure)
  // ============================================================================

  _needsMappingStep(request, context) {
    if (context.type === "recompute") {
      return context.stepType === "mapping";
    }
    // Check primitive property
    if (!request || !request.includeMapping) return false;
    const providers = Array.isArray(request.providers) ? request.providers : [];
    return providers.length >= 2;
  }

  _applyBatchGating(request, resolvedContext) {
    if (!request || typeof request !== "object") return request;
    if (resolvedContext?.type !== "extend") return request;
    if (request.batchAutoRunEnabled) return request;

    const provider =
      request.singularity ||
      (Array.isArray(request.providers) ? request.providers[0] : null);

    if (!provider) return request;

    return { ...request, providers: [provider] };
  }

  // ============================================================================
  // CONTEXT BUILDER (Pure)
  // ============================================================================

  _buildWorkflowContext(request, context) {
    let sessionId;
    let sessionCreated = false;

    switch (context.type) {
      case "initialize":
        // Prefer sessionId passed in the primitive (set by ConnectionHandler); fallback to generate
        sessionId =
          request.sessionId ||
          `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        sessionCreated = true;
        break;

      case "extend":
      case "recompute":
        sessionId = context.sessionId;
        break;

      default:
        sessionId = "unknown-session";
    }

    const userMessage =
      context.type === "recompute"
        ? context.sourceUserMessage
        : request.userMessage;

    return {
      sessionId,
      threadId: "default-thread",
      targetUserTurnId:
        context.type === "recompute" ? context.sourceTurnId : "",
      sessionCreated,
      userMessage,
    };
  }

  // ============================================================================
  // UTILITIES (Pure)
  // ============================================================================

  _getDefaultMapper(request) {
    return request.providers?.[0] || this.defaults.mapper;
  }

  _generateWorkflowId(contextType) {
    return `wf-${contextType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // ============================================================================
  // VALIDATION
  // ============================================================================

  _validateRequest(request) {
    if (!request?.type) throw new Error("[Compiler] Request type required");

    const validTypes = ["initialize", "extend", "recompute"];
    if (!validTypes.includes(request.type)) {
      throw new Error(`[Compiler] Invalid type: ${request.type}`);
    }

    // Type-specific validation
    switch (request.type) {
      case "initialize":
        if (!request.userMessage?.trim())
          throw new Error("[Compiler] Initialize: userMessage required");
        if (!request.providers?.length)
          throw new Error("[Compiler] Initialize: providers required");
        break;

      case "extend":
        if (!request.sessionId)
          throw new Error("[Compiler] Extend: sessionId required");
        if (!request.userMessage?.trim())
          throw new Error("[Compiler] Extend: userMessage required");
        if (!request.providers?.length)
          throw new Error("[Compiler] Extend: providers required");
        break;

      case "recompute":
        if (!request.sessionId)
          throw new Error("[Compiler] Recompute: sessionId required");
        if (!request.sourceTurnId)
          throw new Error("[Compiler] Recompute: sourceTurnId required");
        if (!request.stepType)
          throw new Error("[Compiler] Recompute: stepType required");
        if (!request.targetProvider)
          throw new Error("[Compiler] Recompute: targetProvider required");
        if (!["batch", "mapping"].includes(request.stepType)) {
          throw new Error(
            `[Compiler] Recompute: unsupported stepType '${request.stepType}' for foundation compiler`,
          );
        }
        break;
    }
  }

  _validateContext(context) {
    if (!context?.type) throw new Error("[Compiler] Context type required");

    const validTypes = ["initialize", "extend", "recompute"];
    if (!validTypes.includes(context.type)) {
      throw new Error(`[Compiler] Invalid context type: ${context.type}`);
    }

    switch (context.type) {
      case "initialize": {
        // initialize has no additional required fields in context
        break;
      }
      case "extend": {
        if (!context.sessionId)
          throw new Error("[Compiler] Extend: sessionId required");
        if (!context.lastTurnId)
          throw new Error("[Compiler] Extend: lastTurnId required");
        if (!context.providerContexts)
          throw new Error("[Compiler] Extend: providerContexts required");
        break;
      }
      case "recompute": {
        if (!context.sessionId)
          throw new Error("[Compiler] Recompute: sessionId required");
        if (!context.sourceTurnId)
          throw new Error("[Compiler] Recompute: sourceTurnId required");
        if (!context.stepType)
          throw new Error("[Compiler] Recompute: stepType required");
        if (!context.targetProvider)
          throw new Error("[Compiler] Recompute: targetProvider required");
        // Only require frozenBatchOutputs for non-batch historical recomputes
        if (context.stepType !== "batch" && !context.frozenBatchOutputs) {
          throw new Error(
            "[Compiler] Recompute: frozenBatchOutputs required for non-batch recompute",
          );
        }
        break;
      }
    }
  }
}
