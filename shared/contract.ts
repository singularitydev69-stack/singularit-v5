// ============================================================================
// CORE TYPES & ENUMS
// ============================================================================
export type ProviderKey =
  | "claude"
  | "gemini"
  | "gemini-pro"
  | "gemini-exp"
  | "chatgpt"
  | "qwen";
export type WorkflowStepType =
  | "prompt"
  | "mapping"
  | "singularity";

export type CognitiveMode = "auto";


export interface SingularityPipelineSnapshot {
  userMessage?: string;
  prompt?: string;
  stance?: string;
  stanceReason?: string;
  stanceConfidence?: number;
  structuralShape?: {
    primaryPattern?: string;
    confidence?: number;
  } | null;
  leakageDetected?: boolean;
  leakageViolations?: string[];
}

export interface SingularityOutput {
  text: string;
  providerId: string;
  timestamp: number;
  leakageDetected?: boolean;
  leakageViolations?: string[];
  pipeline?: SingularityPipelineSnapshot | null;
}

/**
 * Concierge Handoff Delta
 * Captures conversational evolution between batch invocations.
 * The concierge appends invisible handoff blocks to responses, which are
 * parsed and stored. When batch is re-invoked, this context is injected
 * to inform batch models of constraints, eliminations, preferences, and
 * situational context that emerged during concierge-only turns.
 */
export interface ConciergeDelta {
  /** Hard limits: "2-person team", "budget under 5K/month" */
  constraints: string[];
  /** Ruled out options: "AWS Lambda (cold start concerns)" */
  eliminated: string[];
  /** Trade-off signals: "simplicity over performance" */
  preferences: string[];
  /** Situational facts: "early-stage startup", "pre-revenue" */
  context: string[];
  /** COMMIT signal - user committed to a plan, triggers fresh spawn. Null if not committed. */
  commit: string | null;
}

export interface Claim {
  id: string;
  label: string;
  text: string;
  dimension?: string | null; // Optional legacy metadata
  supporters: number[];
  type: 'factual' | 'prescriptive' | 'conditional' | 'contested' | 'speculative';
  role: 'anchor' | 'branch' | 'challenger' | 'supplement';
  challenges: string | null;
  quote?: string;
  support_count?: number;
  originalId?: string; // Tracking for edits across turns
}

export interface Edge {
  from: string;
  to: string;
  type: 'supports' | 'conflicts' | 'tradeoff' | 'prerequisite';
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
  reason?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type?: string;
  group?: string;
  theme?: string;
  support_count?: number;
  supporters?: number[];
}

export interface GraphTopology {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProblemStructure {
  primaryPattern:
  | "settled"
  | "linear"
  | "dimensional"
  | "tradeoff"
  | "contested"
  | "exploratory"
  | "contextual"
  | "keystone";
  confidence: number;
  evidence: string[];
  implications: {
    action: string;
  };
  data?: ContestedShapeData | SettledShapeData | KeystoneShapeData | LinearShapeData | TradeoffShapeData | DimensionalShapeData | ExploratoryShapeData | ContextualShapeData;
  scores?: {
    settled: number;
    linear: number;
    keystone: number;
    contested: number;
    tradeoff: number;
    dimensional: number;
    exploratory: number;
  };
  baseConfidence?: number;
  signalPenalty?: number;
  fragilityPenalty?: {
    total: number;
    lowSupportArticulations: number;
    conditionalConflicts: number;
    disconnectedConsensus: boolean;
  };
  signalStrength?: number;
  runnerUpPattern?: ProblemStructure["primaryPattern"];
  compositeShape?: CompositeShape; // NEW: Peak-first composite shape detection
}

export type ClaimRole = 'anchor' | 'branch' | 'challenger' | 'supplement';

export interface ConflictClaim {
  id: string;
  label: string;
  text: string;
  supportCount: number;
  supportRatio: number;
  role: ClaimRole;
  isHighSupport: boolean;
  challenges: string | null;
}

export interface ConflictInfo {
  id: string;                              // "claimA_claimB"

  claimA: ConflictClaim;
  claimB: ConflictClaim;

  // Axis analysis
  axis: {
    explicit: string | null;               // From challenges field
    inferred: string | null;               // From text analysis
    resolved: string;                      // Best available
  };

  // Support analysis
  combinedSupport: number;                 // claimA.supportCount + claimB.supportCount
  supportDelta: number;                    // abs(A - B)
  dynamics: 'symmetric' | 'asymmetric';    // supportDelta < 0.15 * modelCount

  // Classification
  isBothHighSupport: boolean;              // Floor contradicting itself
  isHighVsLow: boolean;                    // Challenger attacking floor
  involvesChallenger: boolean;             // At least one is role=challenger
  involvesAnchor: boolean;                 // At least one is role=anchor
  involvesKeystone: boolean;               // At least one is the keystone

  // Stakes (what choosing requires)
  stakes: {
    choosingA: string;                     // "Accepting A means accepting [X]"
    choosingB: string;                     // "Accepting B means accepting [Y]"
  };

  // Significance score
  significance: number;

  // Part of cluster?
  clusterId: string | null;
}

export interface ConflictCluster {
  id: string;
  axis: string;
  targetId: string;
  challengerIds: string[];
  theme: string;
}

export interface SupportingClaim {
  id: string;
  label: string;
  relationship: 'supports' | 'prerequisite' | 'aligned';
}

export type CentralConflict = CentralConflictIndividual | CentralConflictCluster;

export interface CentralConflictIndividual {
  type: 'individual';
  axis: string;
  positionA: {
    claim: ConflictClaim;
    supportingClaims: SupportingClaim[];
    supportRationale: string;
  };
  positionB: {
    claim: ConflictClaim;
    supportingClaims: SupportingClaim[];
    supportRationale: string;
  };
  dynamics: 'symmetric' | 'asymmetric';
  stakes: {
    choosingA: string;
    choosingB: string;
  };
}

export interface CentralConflictCluster {
  type: 'cluster';
  axis: string;
  target: {
    claim: ConflictClaim;
    supportingClaims: SupportingClaim[];
    supportRationale: string;
  };
  challengers: {
    claims: ConflictClaim[];
    commonTheme: string;
    supportingClaims: SupportingClaim[];
  };
  dynamics: 'one_vs_many';
  stakes: {
    acceptingTarget: string;
    acceptingChallengers: string;
  };
}

export interface FloorClaim {
  id: string;
  label: string;
  text: string;
  supportCount: number;
  supportRatio: number;
  isContested: boolean;
  contestedBy: string[];
}

export interface ChallengerInfo {
  id: string;
  label: string;
  text: string;
  supportCount: number;
  challenges: string | null;
  targetsClaim: string | null;
}

export interface ChainStep {
  id: string;
  label: string;
  text: string;
  supportCount: number;
  supportRatio: number;
  position: number;
  enables: string[];
  isWeakLink: boolean;
  weakReason: string | null;
}

export interface TradeoffOption {
  id: string;
  label: string;
  text: string;
  supportCount: number;
  supportRatio: number;
}

export interface DimensionCluster {
  id: string;
  theme: string;
  claims: Array<{
    id: string;
    label: string;
    text: string;
    supportCount: number;
  }>;
  cohesion: number;
  avgSupport: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHAPE DATA INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface SettledShapeData {
  pattern: 'settled';
  floor: FloorClaim[];
  floorStrength: 'strong' | 'moderate' | 'weak';
  challengers: ChallengerInfo[];
  blindSpots: string[];
  confidence: number;
  strongestOutlier: {
    claim: {
      id: string;
      label: string;
      text: string;
      supportCount: number;
      supportRatio: number;
    };
    reason: 'leverage_inversion' | 'explicit_challenger' | 'minority_voice';
    structuralRole: string;
    whatItQuestions: string;
  } | null;
  floorAssumptions: string[];
  transferQuestion: string;
}

export interface LinearShapeData {
  pattern: 'linear';
  chain: ChainStep[];
  chainLength: number;
  weakLinks: Array<{
    step: ChainStep;
    cascadeSize: number;
  }>;
  alternativeChains: ChainStep[][];
  terminalClaim: ChainStep | null;
  shortcuts: Array<{
    from: ChainStep;
    to: ChainStep;
    skips: string[];
    supportEvidence: string;
  }>;
  chainFragility: {
    weakLinkCount: number;
    totalSteps: number;
    fragilityRatio: number;
    mostVulnerableStep: { step: ChainStep; cascadeSize: number } | null;
  };
  transferQuestion: string;
}

export interface KeystoneShapeData {
  pattern: 'keystone';
  keystone: {
    id: string;
    label: string;
    text: string;
    supportCount: number;
    supportRatio: number;
    dominance: number;
    isFragile: boolean;
  };
  dependencies: Array<{
    id: string;
    label: string;
    relationship: 'prerequisite' | 'supports';
  }>;
  cascadeSize: number;
  challengers: ChallengerInfo[];
  decoupledClaims: Array<{
    id: string;
    label: string;
    text: string;
    supportCount: number;
    independenceReason: string;
  }>;
  cascadeConsequences: {
    directlyAffected: number;
    transitivelyAffected: number;
    survives: number;
  };
  transferQuestion: string;
}

export interface ContestedShapeData {
  pattern: 'contested';
  centralConflict: CentralConflict;
  secondaryConflicts: ConflictInfo[];
  floor: {
    exists: boolean;
    claims: FloorClaim[];
    strength: 'strong' | 'weak' | 'absent';
    isContradictory: boolean;
  };
  fragilities: {
    leverageInversions: LeverageInversionInfo[];
    articulationPoints: string[];
  };
  collapsingQuestion: string | null;
}

export interface TradeoffShapeData {
  pattern: 'tradeoff';
  tradeoffs: Array<{
    id: string;
    optionA: TradeoffOption;
    optionB: TradeoffOption;
    symmetry: 'both_high' | 'both_low' | 'asymmetric';
    governingFactor: string | null;
  }>;
  dominatedOptions: Array<{
    dominated: string;
    dominatedBy: string;
    reason: string;
  }>;
  floor: FloorClaim[];
}

export interface DimensionalShapeData {
  pattern: 'dimensional';
  dimensions: DimensionCluster[];
  interactions: Array<{
    dimensionA: string;
    dimensionB: string;
    relationship: 'independent' | 'overlapping' | 'conflicting';
  }>;
  gaps: string[];
  governingConditions: string[];
  dominantDimension: DimensionCluster | null;
  hiddenDimension: DimensionCluster | null;
  dominantBlindSpots: string[];
  transferQuestion: string;
}

export interface ExploratoryShapeData {
  pattern: 'exploratory';
  strongestSignals: Array<{
    id: string;
    label: string;
    text: string;
    supportCount: number;
    reason: string;
  }>;
  looseClusters: DimensionCluster[];
  isolatedClaims: Array<{
    id: string;
    label: string;
    text: string;
  }>;
  clarifyingQuestions: string[];
  signalStrength: number;
  outerBoundary: {
    id: string;
    label: string;
    text: string;
    supportCount: number;
    distanceReason: string;
  } | null;
  sparsityReasons: string[];
  transferQuestion: string;
}

export interface ContextualShapeData {
  pattern: 'contextual';
  governingCondition: string;
  branches: Array<{
    condition: string;
    claims: FloorClaim[];
  }>;
  defaultPath: {
    exists: boolean;
    claims: FloorClaim[];
  } | null;
  missingContext: string[];
}

export type ShapeData =
  | SettledShapeData
  | LinearShapeData
  | KeystoneShapeData
  | ContestedShapeData
  | TradeoffShapeData
  | DimensionalShapeData
  | ExploratoryShapeData
  | ContextualShapeData;

// ═══════════════════════════════════════════════════════════════════════════
// NEW COMPOSITE SHAPE TYPES (Peak-First Detection)
// ═══════════════════════════════════════════════════════════════════════════

export type PrimaryShape = 'convergent' | 'forked' | 'parallel' | 'constrained' | 'sparse';

export type SecondaryPatternType =
  | 'challenged'
  | 'keystone'
  | 'chain'
  | 'fragile'
  | 'conditional'
  | 'orphaned'
  | 'dissent';

export interface SecondaryPattern {
  type: SecondaryPatternType;
  severity: 'high' | 'medium' | 'low';
  data: ChallengedPatternData | KeystonePatternData | ChainPatternData |
  FragilePatternData | ConditionalPatternData | OrphanedPatternData | DissentPatternData;
}

export interface ChallengedPatternData {
  challenges: Array<{
    challenger: { id: string; label: string; supportRatio: number };
    target: { id: string; label: string; supportRatio: number };
  }>;
}

export interface KeystonePatternData {
  keystone: { id: string; label: string; supportRatio: number };
  dependents: string[];
  cascadeSize: number;
}

export interface ChainPatternData {
  chain: string[];
  length: number;
  weakLinks: string[];
}

export interface FragilePatternData {
  fragilities: Array<{
    peak: { id: string; label: string };
    weakFoundation: { id: string; label: string; supportRatio: number };
  }>;
}

export interface ConditionalPatternData {
  conditions: Array<{ id: string; label: string; branches: string[] }>;
}

export interface OrphanedPatternData {
  orphans: Array<{ id: string; label: string; supportRatio: number; reason: string }>;
}

export interface DissentPatternData {
  voices: Array<{
    id: string;
    label: string;
    text: string;
    supportRatio: number;
    insightType: 'leverage_inversion' | 'explicit_challenger' | 'unique_perspective' | 'edge_case';
    targets?: string[];
    insightScore: number;
  }>;
  strongestVoice: {
    id: string;
    label: string;
    text: string;
    supportRatio: number;
    whyItMatters: string;
  } | null;
  suppressedDimensions: string[];
}

export interface PeakAnalysis {
  peaks: EnrichedClaim[];
  hills: EnrichedClaim[];
  floor: EnrichedClaim[];
  peakIds: Set<string>;
  peakConflicts: Edge[];
  peakTradeoffs: Edge[];
  peakSupports: Edge[];
  peakUnconnected: boolean;
}

export interface CompositeShape {
  primary: PrimaryShape;
  primaryConfidence: number;
  patterns: SecondaryPattern[];
  peaks: Array<{ id: string; label: string; supportRatio: number }>;
  peakRelationship: 'conflicting' | 'trading-off' | 'supporting' | 'independent' | 'none';
  evidence: string[];
  transferQuestion: string;
  // For backwards compatibility with existing shape data builders
  legacyPattern: ProblemStructure['primaryPattern'];
}


export interface CoreRatios {
  concentration: number;
  alignment: number;
  tension: number;
  fragmentation: number;
  depth: number;
}

export interface GraphAnalysis {
  componentCount: number;
  components: string[][];
  longestChain: string[];
  chainCount: number;
  hubClaim: string | null;
  hubDominance: number;
  articulationPoints: string[];
  clusterCohesion: number;
  localCoherence: number;
}

export interface EnrichedClaim extends Claim {
  supportRatio: number;
  leverage: number;
  leverageFactors: {
    supportWeight: number;
    roleWeight: number;
    connectivityWeight: number;
    positionWeight: number;
  };
  keystoneScore: number;
  evidenceGapScore: number;
  supportSkew: number;
  inDegree: number;
  outDegree: number;
  isChainRoot: boolean;
  isChainTerminal: boolean;

  isHighSupport: boolean;
  isLeverageInversion: boolean;
  isKeystone: boolean;
  isEvidenceGap: boolean;
  isOutlier: boolean;
  isContested: boolean;
  isConditional: boolean;
  isChallenger: boolean;
  isIsolated: boolean;
  chainDepth: number;
}

export interface LeverageInversionInfo {
  claimId: string;
  claimLabel: string;
  strongClaim?: string; // High-support claim that depends on this singular foundation
  supporterCount: number;
  reason: string;
  affectedClaims: string[];
}
export type LeverageInversion = LeverageInversionInfo; // Alias for backward compatibility


export interface CascadeRiskInfo {
  sourceId: string;
  sourceLabel: string;
  dependentIds: string[];
  dependentLabels: string[];
  depth: number;
}
export type CascadeRisk = CascadeRiskInfo; // Alias for backward compatibility


export interface ConflictPair {
  claimA: { id: string; label: string; supporterCount: number };
  claimB: { id: string; label: string; supporterCount: number };
  isBothConsensus: boolean;
  dynamics: "symmetric" | "asymmetric";
}

export interface MapperOutput {
  claims: Claim[];
  edges: Edge[];
  ghosts: string[] | null;
}

export interface ParsedMapperOutput extends MapperOutput {
  narrative: string;
  anchors: Array<{ label: string; id: string; position: number }>;
  // Compatibility / Parsing fields
  map?: MapperOutput | null;
  topology?: GraphTopology | null;
  options?: string | null;
  artifact?: MapperArtifact | null;
}

export interface MapperArtifact extends MapperOutput {
  id?: string;
  query?: string;
  turn?: number;
  timestamp?: string;
  model_count?: number;
  souvenir?: string;
  problemStructure?: ProblemStructure;
  narrative?: string;
  anchors?: Array<{ label: string; id: string; position: number }>;
}



// ============================================================================
// SECTION 1: WORKFLOW PRIMITIVES (UI -> BACKEND)
// These are the three fundamental requests the UI can send to the backend.
// ============================================================================

export type PrimitiveWorkflowRequest =
  | InitializeRequest
  | ExtendRequest
  | RecomputeRequest;

/**
 * Starts a new conversation thread.
 */
export interface InitializeRequest {
  type: "initialize";
  sessionId?: string | null; // Optional: can be omitted to let the backend create a new session.
  userMessage: string;
  providers: ProviderKey[];
  includeMapping: boolean;
  mapper?: ProviderKey;
  singularity?: ProviderKey;
  useThinking?: boolean;
  providerMeta?: Partial<Record<ProviderKey, any>>;
  clientUserTurnId?: string; // Optional: client-side provisional ID for the user's turn.
  mode?: CognitiveMode;
}

/**
 * Continues an existing conversation with a new user message.
 */
export interface ArtifactCurationPayload {
  turnId: string | null;
  timestamp: number;
  selectedArtifactIds: string[];
  edits?: any;
}

export interface ExtendRequest {
  type: "extend";
  sessionId: string;
  userMessage: string;
  providers: ProviderKey[];
  forcedContextReset?: ProviderKey[];
  includeMapping: boolean;
  mapper?: ProviderKey;
  singularity?: ProviderKey;
  useThinking?: boolean;
  providerMeta?: Partial<Record<ProviderKey, any>>;
  clientUserTurnId?: string;
  mode?: CognitiveMode;
  artifactCuration?: ArtifactCurationPayload;
  /** When true, batch providers run automatically even after turn 1 */
  batchAutoRunEnabled?: boolean;
}

/**
 * Re-runs a workflow step for a historical turn with a different provider.
 */
export interface RecomputeRequest {
  type: "recompute";
  sessionId: string;
  sourceTurnId: string;
  stepType:
  | "mapping"
  | "batch"
  | "singularity";
  targetProvider: ProviderKey;
  userMessage?: string;
  useThinking?: boolean;
  /** Type of concierge prompt used (e.g. starter_1, explorer_1) */
  frozenSingularityPromptType?: string;
  /** Seed data needed to rebuild the prompt (e.g. handovers, context meta) */
  frozenSingularityPromptSeed?: any;
}

// ============================================================================
// SECTION 2: COMPILED WORKFLOW (BACKEND-INTERNAL)
// These are the low-level, imperative steps produced by the WorkflowCompiler.
// ============================================================================

export interface PromptStepPayload {
  prompt: string;
  providers: ProviderKey[];
  providerContexts?: Record<
    ProviderKey,
    { meta: any; continueThread: boolean }
  >;
  providerMeta?: Partial<Record<ProviderKey, any>>;
  useThinking?: boolean;
}

export interface MappingStepPayload {
  mappingProvider: ProviderKey;
  sourceStepIds?: string[];
  sourceHistorical?: {
    turnId: string;
    mapperArtifact?: MapperArtifact;
  }

}



export interface SingularityStepPayload {
  singularityProvider: ProviderKey;
  originalPrompt: string;
  mapperArtifact?: MapperArtifact;
  mappingText?: string;
  mappingMeta?: any;
}

export interface WorkflowStep {
  stepId: string;
  type: WorkflowStepType;
  payload:
  | PromptStepPayload
  | MappingStepPayload
  | SingularityStepPayload;
}

export interface WorkflowContext {
  sessionId: string;
  threadId: string;
  targetUserTurnId: string;
}

export interface WorkflowRequest {
  workflowId: string;
  context: WorkflowContext;
  steps: WorkflowStep[];
}

// ============================================================================
// SECTION 2b: RESOLVED CONTEXT (Output of ContextResolver)
// ============================================================================

export type ResolvedContext =
  | InitializeContext
  | ExtendContext
  | RecomputeContext;

export interface InitializeContext {
  type: "initialize";
  providers: ProviderKey[];
}

export interface ExtendContext {
  type: "extend";
  sessionId: string;
  lastTurnId: string;
  providerContexts: Record<ProviderKey, { meta: any; continueThread: boolean }>;
}

export interface RecomputeContext {
  type: "recompute";
  sessionId: string;
  sourceTurnId: string;
  frozenBatchOutputs: Record<ProviderKey, ProviderResponse>;
  latestMappingOutput?: { providerId: string; text: string; meta: any } | null;
  providerContextsAtSourceTurn: Record<ProviderKey, { meta: any }>;
  stepType: "mapping" | "batch" | "singularity";
  targetProvider: ProviderKey;
  sourceUserMessage: string;
  /** Type of concierge prompt used (e.g. starter_1, explorer_1) */
  frozenSingularityPromptType?: string;
  /** Seed data needed to rebuild the prompt (e.g. handovers, context meta) */
  frozenSingularityPromptSeed?: any;
}

// ============================================================================
// SECTION 3: REAL-TIME MESSAGING (BACKEND -> UI)
// These are messages sent from the backend to the UI for real-time updates.
// ============================================================================

export interface PartialResultMessage {
  type: "PARTIAL_RESULT";
  sessionId: string;
  stepId: string;
  providerId: ProviderKey;
  chunk: { text?: string; meta?: any };
}

export interface WorkflowStepUpdateMessage {
  type: "WORKFLOW_STEP_UPDATE";
  sessionId: string;
  stepId: string;
  status: "completed" | "failed";
  result?: {
    results?: Record<string, ProviderResponse>; // For batch steps
    providerId?: string; // For single-provider steps
    text?: string;
    status?: string;
    meta?: any;
  };
  error?: string;
}

export interface WorkflowCompleteMessage {
  type: "WORKFLOW_COMPLETE";
  sessionId: string;
  workflowId: string;
  finalResults?: Record<string, any>;
  error?: string;
}

// Real-time workflow progress telemetry for UI (optional but recommended)
export interface WorkflowProgressMessage {
  type: 'WORKFLOW_PROGRESS';
  sessionId: string;
  aiTurnId: string;
  phase: 'batch' | 'mapping';
  providerStatuses: ProviderStatus[];
  completedCount: number;
  totalCount: number;
  estimatedTimeRemaining?: number; // milliseconds
}

export interface TurnCreatedMessage {
  type: "TURN_CREATED";
  sessionId: string;
  userTurnId: string;
  aiTurnId: string;
  providers?: ProviderKey[];
  mappingProvider?: ProviderKey | null;
}

export interface TurnFinalizedMessage {
  type: "TURN_FINALIZED";
  sessionId: string;
  userTurnId: string;
  aiTurnId: string;
  turn: {
    user: {
      id: string;
      type: "user";
      text: string;
      createdAt: number;
      sessionId: string;
    };
    ai: AiTurn;
  };
}

export type PortMessage =
  | PartialResultMessage
  | WorkflowStepUpdateMessage
  | WorkflowCompleteMessage
  | WorkflowProgressMessage
  | WorkflowPartialCompleteMessage
  | RetryProviderRequest
  | TurnFinalizedMessage
  | TurnCreatedMessage;

// ============================================================================
// SECTION 3b: ERROR RESILIENCE & RETRIES (SHARED TYPES)
// ============================================================================

/**
 * Error classification for user-facing messaging and retry logic
 */
export type ProviderErrorType =
  | 'rate_limit'      // 429 - Retryable after cooldown
  | 'auth_expired'    // 401/403 - Requires re-login
  | 'timeout'         // Request took too long - Retryable
  | 'circuit_open'    // Too many recent failures - Auto-retry later
  | 'content_filter'  // Response blocked by provider - Not retryable
  | 'input_too_long'  // Input exceeds provider limit - Not retryable
  | 'network'         // Connection failed - Retryable
  | 'unknown';        // Catch-all - Maybe retryable

export interface ProviderError {
  type: ProviderErrorType;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;    // For rate limits
  requiresReauth?: boolean; // For auth errors
}

/**
 * Enhanced provider status in WORKFLOW_PROGRESS
 */
export interface ProviderStatus {
  providerId: string;
  status: 'queued' | 'active' | 'streaming' | 'completed' | 'failed' | 'skipped';
  progress?: number;
  error?: ProviderError;       // Detailed error info when status === 'failed'
  skippedReason?: string;      // Why it was skipped (e.g., "circuit open")
}

/**
 * Retry request from frontend
 */
export interface RetryProviderRequest {
  type: 'RETRY_PROVIDERS';
  sessionId: string;
  aiTurnId: string;
  providerIds: string[];       // Which providers to retry
  retryScope: 'batch' | 'mapping'; // Which phase to retry
}

/**
 * Partial completion message - sent when workflow completes with some failures
 */
export interface WorkflowPartialCompleteMessage {
  type: 'WORKFLOW_PARTIAL_COMPLETE';
  sessionId: string;
  aiTurnId: string;
  successfulProviders: string[];
  failedProviders: Array<{
    providerId: string;
    error: ProviderError;
  }>;
  mappingCompleted: boolean;
}

// ============================================================================
// SECTION 4: PERSISTENT DATA MODELS
// These are the core data entities representing the application's state.
// ============================================================================


export interface ProviderResponse {
  providerId: string;
  text: string;
  status: "pending" | "streaming" | "completed" | "error";
  createdAt: number;
  updatedAt?: number;
  attemptNumber?: number;
  artifacts?: Array<{
    title: string;
    identifier: string;
    content: string;
    type: string;
  }>;
  meta?: {
    conversationId?: string;
    parentMessageId?: string;
    tokenCount?: number;
    thinkingUsed?: boolean;
    _rawError?: string;
    allAvailableOptions?: string;
    citationSourceOrder?: Record<string | number, string>;
    synthesizer?: string;
    mapper?: string;
    [key: string]: any; // Keep index signature for genuinely unknown provider metadata, but we've explicitly typed the known ones.
  };
}

export interface AiTurn {
  id: string;
  type: "ai";
  sessionId: string | null;
  threadId: string;
  userTurnId: string;
  createdAt: number;
  isComplete?: boolean;
  // Arrays for all response buckets for uniform handling
  batchResponses: Record<string, ProviderResponse[]>;
  mappingResponses: Record<string, ProviderResponse[]>;
  exploreResponses?: Record<string, ProviderResponse[]>;
  singularityResponses?: Record<string, ProviderResponse[]>;

  // Cognitive Pipeline Artifacts (Computed)
  mapperArtifact?: MapperArtifact;
  singularityOutput?: SingularityOutput;

  meta?: {
    branchPointTurnId?: string;
    replacesId?: string;
    isHistoricalRerun?: boolean;
    synthForUserTurnId?: string;
    [key: string]: any;
  };
}

export interface Thread {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  branchPointTurnId: string | null;
  name: string;
  color: string;
  isActive: boolean;
  createdAt: number;
  lastActivity: number;
}

// ============================================================================
// TYPE GUARDS
// ============================================================================
export function isPromptPayload(payload: any): payload is PromptStepPayload {
  return "prompt" in payload && "providers" in payload;
}
export function isMappingPayload(payload: any): payload is MappingStepPayload {
  return "mappingProvider" in payload;
}
export function isSingularityPayload(payload: any): payload is SingularityStepPayload {
  return "singularityProvider" in payload;
}

export function isUserTurn(turn: any): turn is { type: "user" } {
  return !!turn && typeof turn === "object" && turn.type === "user";
}
export function isAiTurn(turn: any): turn is { type: "ai" } {
  return !!turn && typeof turn === "object" && turn.type === "ai";
}

// ============================================================================
// STRUCTURAL ANALYSIS TYPES (Moved from MapperService)
// ============================================================================

export interface TradeoffPair {
  claimA: { id: string; label: string; supporterCount: number };
  claimB: { id: string; label: string; supporterCount: number };
  symmetry: "both_consensus" | "both_singular" | "asymmetric";
}

export interface ConvergencePoint {
  targetId: string;
  targetLabel: string;
  sourceIds: string[];
  sourceLabels: string[];
  edgeType: "prerequisite" | "supports";
}

export interface StructuralAnalysis {
  edges: Edge[];
  landscape: {
    dominantType: Claim["type"];
    typeDistribution: Record<string, number>;
    dominantRole: Claim["role"];
    roleDistribution: Record<string, number>;
    claimCount: number;
    modelCount: number;
    convergenceRatio: number;
  };
  claimsWithLeverage: EnrichedClaim[];
  patterns: {
    leverageInversions: LeverageInversion[];
    cascadeRisks: CascadeRisk[];
    conflicts: ConflictPair[];
    conflictInfos?: ConflictInfo[]; // New Enriched Conflicts
    conflictClusters?: ConflictCluster[]; // New Clusters
    tradeoffs: TradeoffPair[];
    convergencePoints: ConvergencePoint[];
    isolatedClaims: string[];
  };
  ghostAnalysis: {
    count: number;
    mayExtendChallenger: boolean;
    challengerIds: string[];
  };
  // V3.1 additions
  graph: GraphAnalysis;
  ratios: CoreRatios;
  shape: ProblemStructure;
}
