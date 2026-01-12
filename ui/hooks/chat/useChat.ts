// ui/hooks/useChat.ts - MAP-BASED STATE MANAGEMENT
import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import api from "../../services/extension-api";
import {
  turnsMapAtom,
  turnIdsAtom,
  messagesAtom,
  currentSessionIdAtom,
  isLoadingAtom,
  selectedModelsAtom,
  mappingEnabledAtom,
  mappingProviderAtom,
  singularityProviderAtom,
  powerUserModeAtom,
  thinkOnChatGPTAtom,
  activeAiTurnIdAtom,
  currentAppStepAtom,
  uiPhaseAtom,
  isHistoryPanelOpenAtom,
  selectedModeAtom,
  activeProviderTargetAtom,
  batchAutoRunEnabledAtom,
} from "../../state/atoms";
// Optimistic AI turn creation is now handled upon TURN_CREATED from backend
import type {
  ProviderKey,
  PrimitiveWorkflowRequest,
} from "../../../shared/contract";
import { LLM_PROVIDERS_CONFIG } from "../../constants";
import { computeThinkFlag } from "../../../src/think/computeThinkFlag.js";

import type {
  HistorySessionSummary,
  FullSessionPayload,
  TurnMessage,
  UserTurn,
  AiTurn,
  ProviderResponse,
} from "../../types";

export function useChat() {
  // Reads
  const selectedModels = useAtomValue(selectedModelsAtom);
  const mappingEnabled = useAtomValue(mappingEnabledAtom);
  const mappingProvider = useAtomValue(mappingProviderAtom);
  const powerUserMode = useAtomValue(powerUserModeAtom);
  const thinkOnChatGPT = useAtomValue(thinkOnChatGPTAtom);
  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const turnIds = useAtomValue(turnIdsAtom);
  const singularityProvider = useAtomValue(singularityProviderAtom);
  const selectedMode = useAtomValue(selectedModeAtom);
  const batchAutoRunEnabled = useAtomValue(batchAutoRunEnabledAtom);



  // Writes
  const setTurnsMap = useSetAtom(turnsMapAtom);
  const setTurnIds = useSetAtom(turnIdsAtom);
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  // pendingUserTurns is no longer used in the new TURN_CREATED flow
  const setIsLoading = useSetAtom(isLoadingAtom);
  const setActiveAiTurnId = useSetAtom(activeAiTurnIdAtom);
  const setCurrentAppStep = useSetAtom(currentAppStepAtom);
  const setUiPhase = useSetAtom(uiPhaseAtom);
  const setIsHistoryPanelOpen = useSetAtom(isHistoryPanelOpenAtom);
  const setActiveTarget = useSetAtom(activeProviderTargetAtom);


  const sendMessage = useCallback(
    async (prompt: string, mode: "new" | "continuation") => {
      if (!prompt || !prompt.trim()) return;

      setIsLoading(true);
      setUiPhase("streaming");
      setCurrentAppStep("initial");

      const activeProviders = LLM_PROVIDERS_CONFIG
        .filter((p) => selectedModels[p.id])
        .map((p) => p.id as ProviderKey);

      const ts = Date.now();
      const userTurnId = `user-${ts}-${Math.random().toString(36).slice(2, 8)}`;

      const userTurn: UserTurn = {
        type: "user",
        id: userTurnId,
        text: prompt,
        createdAt: ts,
        sessionId: currentSessionId || null,
      };

      // Write user turn to Map + IDs
      setTurnsMap((draft: Map<string, TurnMessage>) => {
        draft.set(userTurn.id, userTurn);
      });
      setTurnIds((draft: string[]) => {
        draft.push(userTurn.id);
      });
      // No pending cache: rely on Jotai atom serialization across updaters

      try {
        const shouldUseMapping = mappingEnabled && mappingProvider !== null;
        const effectiveMappingProvider = mappingProvider;

        const effectiveSingularityProvider = singularityProvider;

        const isInitialize =
          mode === "new" && (!currentSessionId || turnIds.length === 0);

        // Validate continuation has a sessionId and bind the port before sending
        if (!isInitialize) {
          if (!currentSessionId) {
            console.error(
              "[useChat] Continuation requested but currentSessionId is missing. Aborting send.",
            );
            setIsLoading(false);
            setUiPhase("awaiting_action");
            return;
          }
          // Proactively bind/reconnect the port scoped to the target session
          try {
            await api.ensurePort({ sessionId: currentSessionId });
          } catch (e) {
            console.warn(
              "[useChat] ensurePort failed prior to extend; proceeding with executeWorkflow",
              e,
            );
          }
        }

        // Build NEW primitive request shape
        const primitive: PrimitiveWorkflowRequest = isInitialize
          ? {
            type: "initialize",
            sessionId: null, // backend is authoritative; do not generate in UI
            userMessage: prompt,
            providers: activeProviders,
            includeMapping: shouldUseMapping,
            mapper: shouldUseMapping
              ? (effectiveMappingProvider as ProviderKey)
              : undefined,
            singularity: effectiveSingularityProvider
              ? (effectiveSingularityProvider as ProviderKey)
              : undefined,
            useThinking: computeThinkFlag({
              modeThinkButtonOn: thinkOnChatGPT,
              input: prompt,
            }),
            providerMeta: {},
            clientUserTurnId: userTurnId,
            mode: selectedMode as any,
          }
          : {
            type: "extend",
            sessionId: currentSessionId as string,
            userMessage: prompt,
            providers: activeProviders,
            includeMapping: shouldUseMapping,
            mapper: shouldUseMapping
              ? (effectiveMappingProvider as ProviderKey)
              : undefined,
            singularity: effectiveSingularityProvider
              ? (effectiveSingularityProvider as ProviderKey)
              : undefined,
            useThinking: computeThinkFlag({
              modeThinkButtonOn: thinkOnChatGPT,
              input: prompt,
            }),
            providerMeta: {},
            clientUserTurnId: userTurnId,
            mode: selectedMode as any,
            batchAutoRunEnabled, // FEATURE 1: Gate batch after turn 1
          };

        // AI turn will be created upon TURN_CREATED from backend
        // Port is already ensured above for extend; for initialize, executeWorkflow ensures port
        await api.executeWorkflow(primitive);
        // For initialize, sessionId will be set by TURN_CREATED handler; do not set here
      } catch (err) {
        console.error("Failed to execute workflow:", err);
        setIsLoading(false);
        setActiveAiTurnId(null);
      }
    },
    [
      setTurnsMap,
      setTurnIds,
      selectedModels,
      currentSessionId,
      setIsLoading,
      setUiPhase,
      setCurrentAppStep,
      setActiveAiTurnId,
      mappingProvider,
      singularityProvider,
      thinkOnChatGPT,
      turnIds,
      selectedMode,
      batchAutoRunEnabled,
    ],
  );

  const newChat = useCallback(() => {
    // Reset to initial welcome state for a brand-new conversation
    setCurrentSessionId(null);
    setTurnsMap(new Map());
    setTurnIds([]);
    setActiveAiTurnId(null);
    setActiveTarget(null);
  }, [setCurrentSessionId, setTurnsMap, setTurnIds, setActiveAiTurnId, setActiveTarget]);

  const selectChat = useCallback(
    async (session: HistorySessionSummary) => {
      const sessionId = session.sessionId || session.id;
      if (!sessionId) {
        console.error("[useChat] No sessionId in session object");
        return;
      }

      setCurrentSessionId(sessionId);
      setActiveTarget(null);
      setIsLoading(true);

      try {
        const response = await api.getHistorySession(sessionId);
        const fullSession = response as unknown as FullSessionPayload;

        if (!fullSession || !fullSession.turns) {
          console.warn("[useChat] Empty session loaded");
          setTurnsMap((draft: Map<string, TurnMessage>) => {
            draft.clear();
          });
          setTurnIds((draft: string[]) => {
            draft.length = 0;
          });
          setIsLoading(false);
          return;
        }

        const providerContexts = (fullSession as any).providerContexts || {};

        /**
         * CRITICAL FIX: Transform backend "rounds" format
         * Backend sends: { userTurnId, aiTurnId, user: {...}, providers: {...}, mappingResponses }
         */
        const newIds: string[] = [];
        const newMap = new Map<string, TurnMessage>();

        fullSession.turns.forEach((round: any) => {
          // 1. Extract UserTurn
          if (round.user && round.user.text) {
            const userTurn: UserTurn = {
              type: "user",
              id:
                round.userTurnId || round.user.id || `user-${round.createdAt}`,
              text: round.user.text,
              createdAt: round.user.createdAt || round.createdAt || Date.now(),
              sessionId: fullSession.sessionId,
            };
            newIds.push(userTurn.id);
            newMap.set(userTurn.id, userTurn);
          }

          // 2. Extract AiTurn
          const providers = round.providers || {};
          const hasProviderData = Object.keys(providers).length > 0;

          if (hasProviderData) {
            // Transform providers object to batchResponses (arrays per provider)
            const batchResponses: Record<string, ProviderResponse[]> = {};
            Object.entries(providers).forEach(
              ([providerId, data]: [string, any]) => {
                const arr: ProviderResponse[] = Array.isArray(data)
                  ? (data as ProviderResponse[])
                  : [
                    {
                      providerId: providerId as ProviderKey,
                      text: (data?.text as string) || "",
                      status: "completed",
                      createdAt:
                        round.completedAt || round.createdAt || Date.now(),
                      updatedAt:
                        round.completedAt || round.createdAt || Date.now(),
                      meta: data?.meta || {},
                    },
                  ];
                batchResponses[providerId] = arr;
              },
            );

            // Normalize mapping/other responses to arrays
            const normalizeResponseMap = (
              raw: any,
            ): Record<string, ProviderResponse[]> => {
              if (!raw) return {};
              const result: Record<string, ProviderResponse[]> = {};
              const hydrateTextFromMeta = (
                resp: any,
                pid: string,
              ): ProviderResponse => {
                const baseMeta = resp?.meta || {};
                const ctxEntry = (providerContexts as any)?.[pid];
                const ctxMeta =
                  ctxEntry && typeof ctxEntry === "object"
                    ? (ctxEntry as any).meta || {}
                    : {};
                const mergedMeta = { ...ctxMeta, ...baseMeta };
                const fromMeta =
                  typeof mergedMeta?.rawMappingText === "string"
                    ? mergedMeta.rawMappingText
                    : "";
                const fromText = typeof resp?.text === "string" ? resp.text : "";
                const text =
                  fromMeta && fromMeta.length >= fromText.length ? fromMeta : fromText;
                return {
                  ...(resp || {}),
                  text,
                  meta: mergedMeta,
                } as ProviderResponse;
              };
              Object.entries(raw).forEach(([pid, val]: [string, any]) => {
                if (Array.isArray(val)) {
                  result[pid] = val.map((resp: any) =>
                    hydrateTextFromMeta(resp, pid),
                  );
                } else {
                  result[pid] = [hydrateTextFromMeta(val, pid)];
                }
              });
              return result;
            };

            const aiTurn: AiTurn = {
              type: "ai",
              id: round.aiTurnId || `ai-${round.completedAt || Date.now()}`,
              userTurnId: round.userTurnId,
              sessionId: fullSession.sessionId,
              threadId: "default-thread",
              createdAt: round.completedAt || round.createdAt || Date.now(),
              batchResponses,

              mappingResponses: normalizeResponseMap(round.mappingResponses),
              singularityResponses: normalizeResponseMap(round.singularityResponses),
              // Cognitive pipeline structured outputs
              mapperArtifact: round.mapperArtifact || undefined,
              singularityOutput: round.singularityOutput || undefined,
            };
            newIds.push(aiTurn.id);
            newMap.set(aiTurn.id, aiTurn);
          }
        });

        console.log("[useChat] Loaded session with", newIds.length, "turns");

        // Replace Map + IDs atomically
        setTurnsMap(newMap);
        setTurnIds(newIds);

        await api.ensurePort({ sessionId });
      } catch (error) {
        console.error("[useChat] Error loading session:", error);
        setTurnsMap((draft: Map<string, TurnMessage>) => {
          draft.clear();
        });
        setTurnIds((draft: string[]) => {
          draft.length = 0;
        });
      } finally {
        setIsLoading(false);
        setIsHistoryPanelOpen(false);
      }
    },
    [
      setTurnsMap,
      setTurnIds,
      setCurrentSessionId,
      setIsLoading,
      setIsHistoryPanelOpen,
      setActiveTarget,
    ],
  );

  const deleteChat = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const result = await api.deleteBackgroundSession(sessionId);
        const removed = !!result?.removed;

        // If the deleted session is currently active, clear chat state
        if (removed && currentSessionId && currentSessionId === sessionId) {
          setCurrentSessionId(null);
          setTurnsMap(new Map());
          setTurnIds([]);
          setActiveAiTurnId(null);
          setActiveTarget(null);
        }

        return removed;
      } catch (err) {
        console.error("Failed to delete session", err);
        return false;
      }
    },
    [
      currentSessionId,
      setCurrentSessionId,
      setTurnsMap,
      setTurnIds,
      setActiveAiTurnId,
      setActiveTarget,
    ],
  );

  const deleteChats = useCallback(
    async (sessionIds: string[]): Promise<{ removed: string[] }> => {
      try {
        const response = await api.deleteBackgroundSessions(sessionIds);
        const removedIds = Array.isArray(response?.ids) ? response.ids : [];
        // If active chat is among removed, clear state
        if (currentSessionId && removedIds.includes(currentSessionId)) {
          setCurrentSessionId(null);
          setTurnsMap(new Map());
          setTurnIds([]);
          setActiveAiTurnId(null);
          setActiveTarget(null);
        }
        return { removed: removedIds };
      } catch (err) {
        console.error("Failed to batch delete sessions", err);
        return { removed: [] };
      }
    },
    [
      currentSessionId,
      setCurrentSessionId,
      setTurnsMap,
      setTurnIds,
      setActiveAiTurnId,
      setActiveTarget,
    ],
  );


  const abort = useCallback(async (): Promise<void> => {
    try {
      const sid = currentSessionId;
      if (!sid) {
        console.warn("[useChat] abort() called but no currentSessionId");
      } else {
        await api.abortWorkflow(sid);
      }
    } catch (err) {
      console.error("[useChat] Failed to abort workflow:", err);
    } finally {
      // Immediately reflect stop intent in UI; backend will send finalization if applicable
      setIsLoading(false);
      setUiPhase("awaiting_action");
    }
  }, [currentSessionId, setIsLoading, setUiPhase]);

  // Backward-compat: derive messages for consumers still expecting it
  const messages = useAtomValue(messagesAtom);
  return {
    sendMessage,
    newChat,
    selectChat,
    deleteChat,
    deleteChats,
    abort,
    messages,
  };
}
