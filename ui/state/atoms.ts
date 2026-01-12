import { atom } from "jotai";
import { atomWithImmer } from "jotai-immer";
import { atomWithStorage, atomFamily } from "jotai/utils";

// Import UI types and constants
import type {
  TurnMessage,
  AiTurn,
  ProviderResponse,
  UiPhase,
  AppStep,
  HistorySessionSummary,
} from "../types";

// =============================================================================
// ATOMIC STATE PRIMITIVES (Map + ID index)
// =============================================================================
/**
 * Map-based turn storage for O(1) lookups and surgical updates.
 * This is the single source of truth for all turn data.
 */
export const turnsMapAtom = atomWithImmer<Map<string, TurnMessage>>(new Map());

/**
 * Ordered list of turn IDs. Changes only when turns are added/removed.
 */
export const turnIdsAtom = atomWithImmer<string[]>([]);

/**
 * Backward-compat: derived messages view from Map + IDs. Read-only.
 */
export const messagesAtom = atom<TurnMessage[]>((get) => {
  const ids = get(turnIdsAtom);
  const map = get(turnsMapAtom);
  return ids.map((id) => map.get(id)).filter((t): t is TurnMessage => !!t);
});

/**
 * Selector: provider responses for a specific AI turn (isolated subscription).
 * DEPRECATED: Use providerEffectiveStateFamily for component isolation.
 */
export const providerResponsesForTurnAtom = atom(
  (get) =>
    (turnId: string): Record<string, ProviderResponse> => {
      const turn = get(turnsMapAtom).get(turnId);
      if (!turn || turn.type !== "ai") return {};
      const aiTurn = turn as AiTurn;
      const out: Record<string, ProviderResponse> = {};
      // Flatten arrays for batch responses: take latest per provider
      Object.entries(aiTurn.batchResponses || {}).forEach(([pid, val]: [string, any]) => {
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length > 0) out[pid] = arr[arr.length - 1] as ProviderResponse;
      });
      return out;
    },
);

// -----------------------------
// Provider Island Isolation Atoms
// -----------------------------
/**
 * Atom family: Get the full response array for a specific provider in a turn.
 * Returns the complete history as an array (never flattened).
 * If the provider has no responses, returns an empty array.
 */
export const providerResponseArrayFamily = atomFamily(
  ({ turnId, providerId }: { turnId: string; providerId: string }) =>
    atom((get) => {
      const turn = get(turnsMapAtom).get(turnId);
      if (!turn || turn.type !== "ai") return [];

      const aiTurn = turn as AiTurn;

      const responses = aiTurn.batchResponses?.[providerId];

      // Always return array, normalize if needed
      if (!responses) return [];
      return Array.isArray(responses) ? responses : [responses];
    }),
  (a, b) => a.turnId === b.turnId && a.providerId === b.providerId
);

/**
 * Derived atom family: Stable, UI-optimized state for a provider.
 * Prevents expensive recalculations during render.
 */
export const providerEffectiveStateFamily = atomFamily(
  ({ turnId, providerId }: { turnId: string; providerId: string }) =>
    atom((get) => {
      const responses = get(providerResponseArrayFamily({ turnId, providerId }));

      return {
        latestResponse: responses.length > 0 ? responses[responses.length - 1] : null,
        historyCount: responses.length,
        isEmpty: responses.length === 0,
        allResponses: responses, // Include full array for history expansion
      };
    }),
  (a, b) => a.turnId === b.turnId && a.providerId === b.providerId
);

/**
 * Atom family: Get only the list of provider IDs for a turn.
 * Parent layout subscribes to this to avoid re-rendering on provider data changes.
 */
export const providerIdsForTurnFamily = atomFamily(
  (turnId: string) =>
    atom((get) => {
      const turn = get(turnsMapAtom).get(turnId);
      if (!turn || turn.type !== "ai") return [];

      const aiTurn = turn as AiTurn;
      return Object.keys(aiTurn.batchResponses || {});
    }),
  (a, b) => a === b
);

/**
 * Selector: get a single turn by ID (entity accessor).
 */
export const turnByIdAtom = atom(
  (get) =>
    (turnId: string): TurnMessage | undefined =>
      get(turnsMapAtom).get(turnId),
);

// -----------------------------
// Core chat state
// -----------------------------
export const currentSessionIdAtom = atomWithStorage<string | null>(
  "htos_last_session_id",
  null,
);
// Deprecated legacy pending user turns removed; TURN_CREATED event handles optimistic UI

// -----------------------------
// UI phase & loading
// -----------------------------
export const isLoadingAtom = atom<boolean>(false);
export const uiPhaseAtom = atom<UiPhase>("idle");
export const activeAiTurnIdAtom = atom<string | null>(null);
export const currentAppStepAtom = atom<AppStep>("initial");
// Derived: continuation mode is true whenever there is an active session and at least one turn
export const isContinuationModeAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  const turnIds = get(turnIdsAtom);
  return sessionId !== null && turnIds.length > 0;
});

// -----------------------------
// Streaming performance optimization
// -----------------------------
/**
 * Tracks which provider is currently streaming (for granular streaming indicators).
 * Updated by usePortMessageHandler when processing PARTIAL_RESULT messages.
 */
export const lastStreamingProviderAtom = atom<string | null>(null);

/**
 * Derived atom: represents the turn that should be "live" in the UI.
 * Merges recompute targeting and normal streaming into a single source of truth.
 */
export const activeStreamingTurnIdAtom = atom<string | null>((get) => {
  const recompute = get(activeRecomputeStateAtom);
  if (recompute) return recompute.aiTurnId;
  return get(activeAiTurnIdAtom);
});

/**
 * Bundle all global streaming state for efficient subscription.
 */
const globalStreamingStateAtom = atom((get) => ({
  activeId: get(activeStreamingTurnIdAtom),
  isLoading: get(isLoadingAtom),
  appStep: get(currentAppStepAtom),
}));

/**
 * Shared idle state object: ensures reference equality for non-active turns.
 * Critical: without this, every turn re-renders on every streaming tick.
 */
const idleStreamingState: { isLoading: boolean; appStep: AppStep; activeProviderId: string | null } = {
  isLoading: false,
  appStep: "initial",
  activeProviderId: null,
};

/**
 * Per-turn derived streaming state with active provider tracking.
 * Only the active turn sees changing values. All other turns share idleStreamingState.
 * Extended to track which specific provider is streaming for granular UI indicators.
 */
export const turnStreamingStateFamily = atomFamily(
  (turnId: string) =>
    atom((get) => {
      const { activeId, isLoading, appStep } = get(globalStreamingStateAtom);
      const recompute = get(activeRecomputeStateAtom);
      const lastStreamingProvider = get(lastStreamingProviderAtom);

      if (activeId === turnId) {
        // Priority: recompute provider > last streaming provider > null
        const activeProviderId = recompute?.aiTurnId === turnId
          ? recompute.providerId
          : (isLoading ? lastStreamingProvider : null);

        // New object only for active turn – triggers re-render
        return { isLoading, appStep, activeProviderId };
      }
      // All non-active turns share this single, stable reference
      return idleStreamingState;
    }),
  (a, b) => a === b,
);

// -----------------------------
// UI visibility
// -----------------------------
export const isHistoryPanelOpenAtom = atom<boolean>(false);
export const isSettingsOpenAtom = atom<boolean>(false);
export const showWelcomeAtom = atom((get) => get(turnIdsAtom).length === 0);
export const turnExpandedStateFamily = atomFamily(
  (_turnId: string) => atom(false),
  (a, b) => a === b,
);



export const showScrollToBottomAtom = atom<boolean>(false);

// -----------------------------
// Model & feature configuration (persisted)
// -----------------------------
export const selectedModelsAtom = atomWithStorage<Record<string, boolean>>(
  "htos_selected_models",
  {},
);
export const mappingEnabledAtom = atomWithStorage<boolean>(
  "htos_mapping_enabled",
  true,
);
export const mappingProviderAtom = atomWithStorage<string | null>(
  "htos_mapping_provider",
  null,
);

export const singularityProviderAtom = atomWithStorage<string | null>(
  "htos_singularity_provider",
  null,
);

/**
 * Batch auto-run toggle for Singularity phases.
 * When OFF (default), batch providers won't run automatically after turn 1.
 * User must explicitly enable to trigger batch fanout on follow-up messages.
 */
export const batchAutoRunEnabledAtom = atomWithStorage<boolean>(
  "htos_batch_auto_run",
  false,
);

export interface ProviderLocks {
  mapping: boolean;
  singularity: boolean;
}

export const providerLocksAtom = atom<ProviderLocks>({
  mapping: false,
  singularity: false,
});





export const powerUserModeAtom = atomWithStorage<boolean>(
  "htos_power_user_mode",
  false,
);
export const thinkOnChatGPTAtom = atomWithStorage<boolean>(
  "htos_think_chatgpt",
  false,
);
export const isVisibleModeAtom = atomWithStorage<boolean>(
  "htos_visible_mode",
  true,
);
export const isReducedMotionAtom = atomWithStorage<boolean>(
  "htos_reduced_motion",
  false,
);
export const includePromptInCopyAtom = atomWithStorage<boolean>(
  "htos_include_prompt_in_copy",
  true,
);

/**
 * Feature flag for the new Cognitive Pipeline (v2)
 * REMOVED: Now controlled by selectedModeAtom ("standard" vs "auto")
 */

// Provider Contexts
export const providerContextsAtom = atomWithImmer<Record<string, any>>({});

// -----------------------------
// Precise recompute targeting
// -----------------------------
export const activeRecomputeStateAtom = atom<{
  aiTurnId: string;
  stepType:
  | "mapping"
  | "batch"
  | "singularity";
  providerId: string;
} | null>(null);

export const activeProviderTargetAtom = atom<{
  aiTurnId: string;
  providerId: string;
} | null>(null);



// -----------------------------
// Round-level selections
// -----------------------------
export const mappingRecomputeSelectionByRoundAtom = atomWithImmer<
  Record<string, string | null>
>({});
// Persist "show history" state per provider (aiTurnId-providerId)
export const providerHistoryExpandedFamily = atomFamily(
  (_key: string) => atom(false),
  (a, b) => a === b,
);

export const thinkMappingByRoundAtom = atomWithImmer<Record<string, boolean>>(
  {},
);


// -----------------------------
// History & sessions
// -----------------------------
export const historySessionsAtom = atomWithImmer<HistorySessionSummary[]>([]);
export const isHistoryLoadingAtom = atom<boolean>(false);
// -----------------------------
// Connection & system state
// -----------------------------
export const connectionStatusAtom = atom<{
  isConnected: boolean;
  isReconnecting: boolean;
  hasEverConnected: boolean;
}>({ isConnected: false, isReconnecting: false, hasEverConnected: false });
export const providerAuthStatusAtom = atom<Record<string, boolean>>({});
export const alertTextAtom = atom<string | null>(null);
export const chatInputHeightAtom = atom<number>(80);
// Track last meaningful workflow activity to allow UI watchdogs
export const lastActivityAtAtom = atom<number>(0);

// -----------------------------
// Derived atoms (examples)
// -----------------------------
export const activeProviderCountAtom = atom((get) => {
  const selected = get(selectedModelsAtom) || {};
  return Object.values(selected).filter(Boolean).length;
});

export const isFirstTurnAtom = atom((get) => {
  const ids = get(turnIdsAtom);
  const map = get(turnsMapAtom);
  return !ids.some((id) => map.get(id)?.type === "user");
});

export const chatInputValueAtom = atomWithStorage<string>(
  "htos_chat_input_value",
  "",
  undefined,
  { getOnInit: true }
);

// -----------------------------
// Global Toast Notification
// -----------------------------
export type Toast = {
  id: number;
  message: string;
  type?: 'info' | 'success' | 'error';
} | null;

export const toastAtom = atom<Toast>(null);

// -----------------------------
// Split Pane & Decision Map State
// -----------------------------

export const activeSplitPanelAtom = atom<{ turnId: string; providerId: string } | null>(null);

// Derived atom for performance: ChatView subscribes to this boolean, not the full object
export const isSplitOpenAtom = atom((get) => get(activeSplitPanelAtom) !== null);


export const isDecisionMapOpenAtom = atom<{ turnId: string } | null>(null);
export const isDecisionMapVisibleAtom = atom((get) => get(isDecisionMapOpenAtom) !== null);


// =============================================================================
// Workflow Progress (for Council Orbs UI)
// =============================================================================

export type WorkflowStage =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'complete'
  | 'error';

export interface ProviderWorkflowState {
  stage: WorkflowStage;
  progress?: number; // 0-100
  error?: string;
}

// ProviderId -> { stage, progress }
export const workflowProgressAtom = atom<Record<string, ProviderWorkflowState>>({});

const idleWorkflowProgress: Record<string, ProviderWorkflowState> = {};

export const workflowProgressForTurnFamily = atomFamily(
  (turnId: string) =>
    atom((get) => {
      const activeId = get(activeStreamingTurnIdAtom);
      const isLoading = get(isLoadingAtom);
      if (activeId === turnId && isLoading) return get(workflowProgressAtom);
      return idleWorkflowProgress;
    }),
  (a, b) => a === b,
);

// =============================================================================
// Error resilience state (per-current turn)
// =============================================================================
import type { ProviderError } from "@shared/contract";

/**
 * Track errors per provider for the current turn
 */
export const providerErrorsAtom = atom<Record<string, ProviderError>>({});

const idleProviderErrors: Record<string, ProviderError> = {};

export const providerErrorsForTurnFamily = atomFamily(
  (turnId: string) =>
    atom((get) => {
      const activeId = get(activeStreamingTurnIdAtom);
      if (activeId === turnId) return get(providerErrorsAtom);
      return idleProviderErrors;
    }),
  (a, b) => a === b,
);

/**
 * Track which providers can be retried based on error classification
 */
export const retryableProvidersAtom = atom<string[]>((get) => {
  const errors = get(providerErrorsAtom);
  return Object.entries(errors)
    .filter(([, err]) => !!err && !!err.retryable)
    .map(([pid]) => pid);
});

const idleRetryableProviders: string[] = [];

export const retryableProvidersForTurnFamily = atomFamily(
  (turnId: string) =>
    atom((get) => {
      const activeId = get(activeStreamingTurnIdAtom);
      if (activeId === turnId) return get(retryableProvidersAtom);
      return idleRetryableProviders;
    }),
  (a, b) => a === b,
);

/**
 * Current workflow degradation status
 */
export const workflowDegradedAtom = atom<{
  isDegraded: boolean;
  successCount: number;
  totalCount: number;
  failedProviders: string[];
}>({
  isDegraded: false,
  successCount: 0,
  totalCount: 0,
  failedProviders: []
});

// =============================================================================
// Streaming UX State (for Council Orbs visibility control)
// =============================================================================

export const isRoundActiveAtom = atom((get) => get(isLoadingAtom));

/**
 * Maps turnId -> providerId for the "pinned" or preferred singularity provider.
 * This ensures that if a user selects a specific provider's analysis, it stays selected
 * even if new data streams in or the component re-renders.
 */
export const pinnedSingularityProvidersAtom = atom<Record<string, string>>({});

// --- Derived Atoms ---

/**
 * Track if we've auto-opened the split pane for the current turn
 * Value is the turnId or null
 */
export const hasAutoOpenedPaneAtom = atom<string | null>(null);



/**
 * Selected Cognitive Mode (e.g. "auto", "understand", "decide")
 * Persisted in local storage.
 */
import { CognitiveMode } from "@shared/contract";

export const selectedModeAtom = atomWithStorage<CognitiveMode>(
  "htos_selected_mode",
  "auto"
);


// -----------------------------
// Cognitive Pipeline UI State
// -----------------------------
import { CognitiveViewMode } from "../types";

/**
 * Tracks the active view for each cognitive turn.
 * Key: aiTurnId, Value: 'artifact' | 'understand' | 'gauntlet'
 */
export const cognitiveModeMapAtom = atomWithImmer<Record<string, CognitiveViewMode>>({});

/**
 * Family to access/update mode for a specific turn
 */
export const turnCognitiveModeFamily = atomFamily(
  (turnId: string) =>
    atom(
      (get) => get(cognitiveModeMapAtom)[turnId] || 'artifact',
      (_get, set, newMode: CognitiveViewMode) => {
        set(cognitiveModeMapAtom, (draft) => {
          draft[turnId] = newMode;
        });
      }
    ),
  (a, b) => a === b
);
