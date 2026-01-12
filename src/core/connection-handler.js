// src/core/connection-handler.js

import { WorkflowEngine } from "./workflow-engine.js";
import { runPreflight, createAuthErrorMessage } from './preflight-validator.js';
import { authManager } from './auth-manager.js';
// Note: ContextResolver is now available via services; we don't import it directly here

/**
 * ConnectionHandler
 *
 * Production-grade pattern for managing port connections.
 * Each UI connection gets its own isolated handler with proper lifecycle.
 *
 * KEY PRINCIPLES:
 * 1. Connection-scoped: Each port gets its own WorkflowEngine instance
 * 2. Async initialization: Don't attach listeners until backend is ready
 * 3. Proper cleanup: Remove listeners and free resources on disconnect
 * 4. No global state pollution: Everything is encapsulated
 * 5. AGGRESSIVE SESSION HYDRATION: Always re-hydrate from persistence for continuation requests
 */

export class ConnectionHandler {
  constructor(port, services) {
    this.port = port;
    this.services = services; // { orchestrator, sessionManager, compiler }
    this.workflowEngine = null;
    this.messageHandler = null;
    this.isInitialized = false;
    this.lifecycleManager = services.lifecycleManager;
  }

  /**
   * Map new primitive requests into legacy ExecuteWorkflowRequest
   * so the existing compiler/engine can process them without signature changes.
   */

  /**
   * Async initialization - waits for backend readiness
   */
  async init() {
    if (this.isInitialized) return;

    // Create WorkflowEngine for this connection
    this.workflowEngine = new WorkflowEngine(
      this.services.orchestrator,
      this.services.sessionManager,
      this.port,
    );

    // Create message handler bound to this instance
    this.messageHandler = this._createMessageHandler();

    // Attach listener
    this.port.onMessage.addListener(this.messageHandler);

    // Attach disconnect handler
    this.port.onDisconnect.addListener(() => this._cleanup());

    this.isInitialized = true;
    console.log("[ConnectionHandler] Initialized for port:", this.port.name);

    // Signal that handler is ready
    this.port.postMessage({ type: "HANDLER_READY" });
  }

  /**
   * Build a stable idempotency key for a client-initiated request so that
   * retries on reconnect don't fan out duplicate provider requests.
   */
  _buildIdempotencyKey(executeRequest) {
    if (!executeRequest || typeof executeRequest !== "object") return null;
    const clientUserTurnId =
      executeRequest.clientUserTurnId ||
      executeRequest.userTurnId ||
      executeRequest?.historicalContext?.userTurnId ||
      null;

    try {
      if (executeRequest.type === "initialize") {
        if (!clientUserTurnId) return null;
        return `idem:init:${clientUserTurnId}`;
      }
      if (executeRequest.type === "extend") {
        if (!clientUserTurnId || !executeRequest.sessionId) return null;
        return `idem:${executeRequest.sessionId}:${clientUserTurnId}`;
      }
      if (executeRequest.type === "recompute") {
        const { sessionId, sourceTurnId, stepType, targetProvider } = executeRequest;
        if (!sessionId || !sourceTurnId || !stepType || !targetProvider) return null;
        return `idem:recompute:${sessionId}:${sourceTurnId}:${stepType}:${targetProvider}`;
      }
    } catch (_) { }
    return null;
  }

  /**
   * Emit TURN_FINALIZED constructed directly from persistence for a completed turn.
   * Used to resume UI after port reconnect when streaming was missed.
   */
  async _emitFinalizedFromPersistence(sessionId, aiTurnId) {
    try {
      const adapter = this.services?.sessionManager?.adapter;
      if (!adapter) return;

      const aiTurn = await adapter.get("turns", aiTurnId);
      if (!aiTurn || (aiTurn.type !== "ai" && aiTurn.role !== "assistant")) return;

      const userTurnId = aiTurn.userTurnId;
      const userTurn = userTurnId ? await adapter.get("turns", userTurnId) : null;

      const resps = await adapter.getResponsesByTurnId(aiTurnId);
      const buckets = {
        batchResponses: {},
        mappingResponses: {},
        singularityResponses: {},
      };
      for (const r of resps || []) {
        if (!r) continue;
        const entry = {
          providerId: r.providerId,
          text: r.text || "",
          status: r.status || "completed",
          createdAt: r.createdAt || Date.now(),
          updatedAt: r.updatedAt || r.createdAt || Date.now(),
          meta: r.meta || {},
          responseIndex: r.responseIndex ?? 0,
        };
        if (r.responseType === "batch") {
          (buckets.batchResponses[r.providerId] ||= []).push(entry);
        } else if (r.responseType === "mapping") {
          (buckets.mappingResponses[r.providerId] ||= []).push(entry);
        } else if (r.responseType === "singularity") {
          (buckets.singularityResponses[r.providerId] ||= []).push(entry);
        }
      }

      for (const group of Object.values(buckets)) {
        for (const pid of Object.keys(group)) {
          group[pid].sort((a, b) => (a.responseIndex ?? 0) - (b.responseIndex ?? 0));
        }
      }

      let inferredSingularityOutput = aiTurn.singularityOutput;
      if (!inferredSingularityOutput) {
        try {
          const firstProviderId = Object.keys(buckets.singularityResponses || {})[0];
          const arr = firstProviderId ? buckets.singularityResponses[firstProviderId] : null;
          const last = Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null;
          if (last?.meta?.singularityOutput) inferredSingularityOutput = last.meta.singularityOutput;
        } catch (_) { }
      }

      // Require at least some responses to finalize
      const hasAny =
        Object.keys(buckets.batchResponses).length > 0 ||
        Object.keys(buckets.mappingResponses).length > 0 ||
        Object.keys(buckets.singularityResponses).length > 0;
      if (!hasAny) return;

      this.port?.postMessage({
        type: "TURN_FINALIZED",
        sessionId: sessionId,
        userTurnId: userTurnId,
        aiTurnId: aiTurnId,
        turn: {
          user: userTurn
            ? {
              id: userTurn.id,
              type: "user",
              text: userTurn.text || userTurn.content || "",
              createdAt: userTurn.createdAt || Date.now(),
              sessionId,
            }
            : {
              id: userTurnId || "unknown",
              type: "user",
              text: "",
              createdAt: Date.now(),
              sessionId,
            },
          ai: {
            id: aiTurnId,
            type: "ai",
            userTurnId: userTurnId || "unknown",
            sessionId,
            threadId: aiTurn.threadId || "default-thread",
            createdAt: aiTurn.createdAt || Date.now(),
            batchResponses: buckets.batchResponses,
            mappingResponses: buckets.mappingResponses,
            singularityResponses: buckets.singularityResponses,
            meta: aiTurn.meta || {},
            mapperArtifact: aiTurn.mapperArtifact,
            singularityOutput: inferredSingularityOutput,
          },
        },
      });
    } catch (e) {
      console.warn("[ConnectionHandler] Failed to emit TURN_FINALIZED from persistence:", e);
    }
  }

  /**
   * Create the message handler function
   * This is separate so we can properly remove it on cleanup
   */
  _createMessageHandler() {
    return async (message) => {
      if (!message || !message.type) return;

      if (message.type !== "keepalive_ping") {
        console.log(`[ConnectionHandler] Received: ${message.type}`);
      }

      try {
        switch (message.type) {
          case "EXECUTE_WORKFLOW":
            await this._handleExecuteWorkflow(message);
            break;
          case 'RETRY_PROVIDERS':
            if (this.workflowEngine && typeof this.workflowEngine.handleRetryRequest === 'function') {
              await this.workflowEngine.handleRetryRequest(message);
            } else {
              console.warn('[ConnectionHandler] Retry requested but workflowEngine is not ready');
            }
            break;

          case "KEEPALIVE_PING":
            this.port.postMessage({
              type: "KEEPALIVE_PONG",
              timestamp: Date.now(),
            });
            break;

          case "reconnect":
            this.port.postMessage({
              type: "reconnect_ack",
              serverTime: Date.now(),
            });
            break;

          case "abort":
            await this._handleAbort(message);
            break;
          case "CONTINUE_COGNITIVE_WORKFLOW":
            if (this.workflowEngine) {
              await this.workflowEngine.handleContinueCognitiveRequest(message.payload);
            }
            break;

          default:
            console.warn(
              `[ConnectionHandler] Unknown message type: ${message.type}`,
            );
        }
      } catch (error) {
        console.error("[ConnectionHandler] Message handling failed:", error);
        this._sendError(message, error);
      }
    };
  }

  /**
   * Handle EXECUTE_WORKFLOW message
   */
  async _handleExecuteWorkflow(message) {
    let executeRequest = message.payload;
    let resolvedContext = null;

    const VALID_TYPES = ["initialize", "extend", "recompute"];
    if (!executeRequest || !VALID_TYPES.includes(executeRequest.type)) {
      const errorMsg = `Invalid request type: ${executeRequest?.type}. Must be one of: ${VALID_TYPES.join(", ")}`;
      console.error(`[ConnectionHandler] ${errorMsg}`);

      try {
        this.port.postMessage({
          type: "WORKFLOW_COMPLETE",
          sessionId: executeRequest?.sessionId || "unknown",
          error: errorMsg,
        });
      } catch (_) { }

      return;
    }

    // Record activity
    try {
      if (
        this.lifecycleManager &&
        typeof this.lifecycleManager.recordActivity === "function"
      ) {
        this.lifecycleManager.recordActivity();
      }
    } catch (e) { }

    try {
      this.lifecycleManager?.activateWorkflowMode();

      // ========================================================================
      // Idempotency Guard: short-circuit duplicate requests
      // Minimal behavior per invariants:
      // - If mapping exists for clientUserTurnId → re-emit TURN_CREATED
      // - If persisted results exist → emit TURN_FINALIZED from persistence
      // - Do NOT poll inflight or re-fanout providers
      // ========================================================================
      const idemKeyEarly = this._buildIdempotencyKey(executeRequest);
      if (idemKeyEarly && this.services?.sessionManager?.adapter) {
        try {
          const existing = await this.services.sessionManager.adapter.get(
            "metadata",
            idemKeyEarly,
          );
          if (existing && existing.entityId) {
            const sessionIdForEmit =
              existing.sessionId || executeRequest.sessionId || "unknown";
            const histUserTurnId = executeRequest?.historicalContext?.userTurnId;
            const userTurnIdEarly =
              executeRequest?.clientUserTurnId ||
              executeRequest?.userTurnId ||
              histUserTurnId ||
              "unknown";

            try {
              if (executeRequest?.type !== "recompute") {
                this.port.postMessage({
                  type: "TURN_CREATED",
                  sessionId: sessionIdForEmit,
                  userTurnId: userTurnIdEarly,
                  aiTurnId: existing.entityId,
                  providers: executeRequest.providers || [],
                  mappingProvider: executeRequest.mapper || null,
                });
              }
            } catch (_) { }

            // If we already have responses → emit finalized; otherwise return without recompute
            try {
              const responses = await this.services.sessionManager.adapter.getResponsesByTurnId(existing.entityId);
              const hasAny = Array.isArray(responses) && responses.length > 0;
              if (hasAny) {
                await this._emitFinalizedFromPersistence(
                  sessionIdForEmit,
                  existing.entityId,
                );
              }
            } catch (_) { }
            return; // ✅ Duplicate handled via rehydrate only
          }
        } catch (_) { }
      }

      // ========================================================================
      // PHASE 5: Primitives-only execution path (fail-fast on legacy)
      // ========================================================================
      const isPrimitive =
        executeRequest &&
        typeof executeRequest.type === "string" &&
        ["initialize", "extend", "recompute"].includes(executeRequest.type);
      if (!isPrimitive) {
        const errMsg =
          '[ConnectionHandler] Non-primitive request rejected. Use {type:"initialize"|"extend"|"recompute"} primitives only.';
        console.error(errMsg, { received: executeRequest });
        try {
          this.port.postMessage({
            type: "WORKFLOW_STEP_UPDATE",
            sessionId: executeRequest?.sessionId || "unknown",
            stepId: "validate-primitive",
            status: "failed",
            error:
              "Legacy ExecuteWorkflowRequest is no longer supported. Please migrate to primitives.",
            // Attach recompute metadata when applicable
            isRecompute: executeRequest?.type === "recompute",
            sourceTurnId: executeRequest?.sourceTurnId,
          });
          this.port.postMessage({
            type: "WORKFLOW_COMPLETE",
            sessionId: executeRequest?.sessionId || "unknown",
            error: "Legacy ExecuteWorkflowRequest is no longer supported.",
          });
        } catch (_) { }
        return;
      }

      // Phase 5 path: Resolve → Map → Compile → Execute
      console.log(
        `[ConnectionHandler] Processing ${executeRequest.type} primitive`,
      );

      if (executeRequest.type === "recompute") {
        if (executeRequest.stepType === "singularity") {
          if (this.workflowEngine && typeof this.workflowEngine.handleContinueCognitiveRequest === "function") {
            await this.workflowEngine.handleContinueCognitiveRequest({
              sessionId: executeRequest.sessionId,
              aiTurnId: executeRequest.sourceTurnId,
              providerId: executeRequest.targetProvider,
              isRecompute: true,
              sourceTurnId: executeRequest.sourceTurnId,
              useThinking: !!executeRequest.useThinking,
            });
          } else {
            console.warn("[ConnectionHandler] Singularity recompute requested but workflowEngine is not ready");
          }
          return;
        }
      }

      // Step 1: Resolve context
      try {
        resolvedContext =
          await this.services.contextResolver.resolve(executeRequest);
        console.log(
          `[ConnectionHandler] Context resolved: ${resolvedContext.type}`,
        );
      } catch (e) {
        console.error("[ConnectionHandler] Context resolution failed:", e);
        throw e;
      }

      // Step 2: Preflight authorization + smart defaults routing (cached 60s)
      try {
        await this._applyPreflightSmartDefaults(executeRequest);
      } catch (e) {
        console.warn("[ConnectionHandler] Preflight smart-defaults failed:", e);
      }

      // Step 3: No mapping needed - compiler accepts primitives + resolvedContext
      console.log("[ConnectionHandler] Passing primitive directly to compiler");

      // ========================================================================
      // Validation
      // ========================================================================
      const histUserTurnId = executeRequest?.historicalContext?.userTurnId;
      // Prefer primitive's clientUserTurnId; fall back to legacy userTurnId
      const userTurnId =
        executeRequest?.clientUserTurnId ||
        executeRequest?.userTurnId ||
        histUserTurnId;
      const hasBatch =
        Array.isArray(executeRequest?.providers) &&
        executeRequest.providers.length > 0;

      // Generate session ID if needed
      if (!executeRequest?.sessionId || executeRequest.sessionId === "") {
        executeRequest.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.log(
          "[ConnectionHandler] Generated session ID:",
          executeRequest.sessionId,
        );
      }

      // ========================================================================
      // Compile
      // ========================================================================
      const workflowRequest = this.services.compiler.compile(
        executeRequest,
        resolvedContext,
      );

      const firstPromptStep = Array.isArray(workflowRequest?.steps)
        ? workflowRequest.steps.find((s) => s && s.type === "prompt")
        : null;
      const effectiveProviders =
        Array.isArray(firstPromptStep?.payload?.providers) &&
        firstPromptStep.payload.providers.length > 0
          ? firstPromptStep.payload.providers
          : (executeRequest.providers || []);
      // ========================================================================
      // TURN_CREATED message
      // ========================================================================
      const createsNewTurn = executeRequest.type !== "recompute" && hasBatch;
      if (createsNewTurn) {
        const aiTurnId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        workflowRequest.context = {
          ...workflowRequest.context,
          canonicalUserTurnId: userTurnId,
          canonicalAiTurnId: aiTurnId,
        };

        try {
          this.port.postMessage({
            type: "TURN_CREATED",
            sessionId:
              workflowRequest.context.sessionId || executeRequest.sessionId,
            userTurnId,
            aiTurnId,
            // ✅ Include actual providers being used so UI doesn't guess from stale state
            providers: effectiveProviders,
            mappingProvider: executeRequest.mapper || null,
          });
        } catch (_) { }

        try {
          const key = `inflight:${workflowRequest.context.sessionId}:${aiTurnId}`;
          const runId = crypto.randomUUID();
          await this.services.sessionManager.adapter.put("metadata", {
            key,
            sessionId: workflowRequest.context.sessionId,
            entityId: aiTurnId,
            type: "inflight_workflow",
            requestType: executeRequest.type,
            userMessage: executeRequest.userMessage,
            providers: effectiveProviders,
            providerMeta: executeRequest.providerMeta || {},
            runId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          // Also record idempotency mapping so reconnect retries don't duplicate fanout
          const idemKey = this._buildIdempotencyKey(executeRequest);
          if (idemKey) {
            await this.services.sessionManager.adapter.put("metadata", {
              key: idemKey,
              sessionId: workflowRequest.context.sessionId,
              entityId: aiTurnId,
              type: "request_idempotency",
              requestType: executeRequest.type,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        } catch (_) { }
      }

      // NOTE: TURN_CREATED now emits from WorkflowEngine after persistence
      // to ensure authoritative IDs. We no longer emit here to avoid
      // premature/non-canonical IDs.

      // ========================================================================
      // Execute
      // ========================================================================
      await this.workflowEngine.execute(workflowRequest, resolvedContext);

      try {
        const key = `inflight:${workflowRequest.context.sessionId}:${workflowRequest.context.canonicalAiTurnId}`;
        await this.services.sessionManager.adapter.delete("metadata", key);
      } catch (_) { }
    } catch (error) {
      console.error("[ConnectionHandler] Workflow failed:", error);
      try {
        this.port.postMessage({
          type: "WORKFLOW_STEP_UPDATE",
          sessionId: executeRequest?.sessionId || "unknown",
          stepId: "handler-error",
          status: "failed",
          error: error.message || String(error),
          // Attach recompute metadata when applicable
          isRecompute: executeRequest?.type === "recompute",
          sourceTurnId: executeRequest?.sourceTurnId,
        });
        this.port.postMessage({
          type: "WORKFLOW_COMPLETE",
          sessionId: executeRequest?.sessionId || "unknown",
          error: error.message || String(error),
        });
      } catch (e) {
        console.error("[ConnectionHandler] Failed to send error message:", e);
      }
    } finally {
      this.lifecycleManager?.deactivateWorkflowMode();
    }
  }

  /**
   * CRITICAL: Ensure session is fully hydrated from persistence
   * This solves the SW restart context loss bug
   */
  // Legacy hydration helper removed: session hydration now handled by persistence-backed readers


  /**
   * Preflight authorization check and smart-defaults routing.
   * - Runs after Context Resolution, before Compilation.
   * - Caches auth status for 60s to avoid repeated cookie reads.
   * - Filters unauth providers from batch.
   * - Selects mapper/refiner/antagonist defaults when missing.
   * - Applies ephemeral fallback when a locked provider is unavailable.
   */
  async _applyPreflightSmartDefaults(executeRequest) {
    // Use centralized AuthManager
    const authStatus = await authManager.getAuthStatus();
    const availableProviders = this.services.providerRegistry?.listProviders?.() || [];

    // Run preflight (handles filtering + fallbacks)
    const result = await runPreflight(
      {
        providers: executeRequest.providers,
        mapper: executeRequest.mapper,
        singularity: executeRequest.singularity,
      },
      authStatus,
      availableProviders
    );

    // Apply results
    executeRequest.providers = result.providers;
    executeRequest.mapper = result.mapper;
    executeRequest.singularity = result.singularity;

    // Emit warnings (not errors!)
    if (result.warnings.length > 0) {
      this.port.postMessage({
        type: 'PREFLIGHT_WARNINGS',
        sessionId: executeRequest.sessionId,
        warnings: result.warnings,
      });
    }

    // ONLY fail if zero providers available
    const hasAnyProvider =
      result.providers.length > 0 ||
      result.mapper !== null ||
      result.singularity !== null;

    if (!hasAnyProvider) {
      const attempted = [
        ...(executeRequest.providers || []),
        executeRequest.mapper,
        executeRequest.singularity,
      ].filter(Boolean);

      const errorMsg = createAuthErrorMessage(
        attempted,
        'Pre-workflow validation found no authorized providers'
      ) || `No authorized providers available. Attempted: ${attempted.join(', ')}. Please log in to at least one AI service.`;

      throw new Error(errorMsg);
    }
  }

  /**
   * Handle abort message
   */
  async _handleAbort(message) {
    if (message.sessionId && this.services.orchestrator) {
      this.services.orchestrator._abortRequest(message.sessionId);
    }
  }

  /**
   * Send error back to UI
   */
  _sendError(originalMessage, error) {
    this.port.postMessage({
      type: "WORKFLOW_STEP_UPDATE",
      sessionId: originalMessage.payload?.sessionId || "unknown",
      stepId: "handler-error",
      status: "failed",
      error: error.message || String(error),
    });
  }

  /**
   * Cleanup on disconnect
   */
  _cleanup() {
    console.log("[ConnectionHandler] Cleaning up connection");

    // Deactivate lifecycle manager on disconnect
    this.lifecycleManager?.deactivateWorkflowMode();

    // Remove message listener
    if (this.messageHandler) {
      try {
        this.port.onMessage.removeListener(this.messageHandler);
      } catch (e) {
        // Port may already be dead
      }
    }

    // Null out references for GC
    this.workflowEngine = null;
    this.messageHandler = null;
    this.port = null;
    this.services = null;
    this.lifecycleManager = null;
    this.isInitialized = false;
  }
}
