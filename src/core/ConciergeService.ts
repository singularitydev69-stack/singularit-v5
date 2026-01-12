// ═══════════════════════════════════════════════════════════════════════════
// CONCIERGE SERVICE
// The Voice of Singularity
// ═══════════════════════════════════════════════════════════════════════════

import {
    ProblemStructure,
    StructuralAnalysis,
    SettledShapeData,
    LinearShapeData,
    KeystoneShapeData,
    ContestedShapeData,
    TradeoffShapeData,
    DimensionalShapeData,
    ExploratoryShapeData,
    ContextualShapeData,
    // NEW: Composite shape types for peak-first detection
    CompositeShape,
    EnrichedClaim,
    DissentPatternData,
    ChallengedPatternData,
    KeystonePatternData,
    ChainPatternData,
    FragilePatternData,
    OrphanedPatternData,
    // Handoff V2
    ConciergeDelta,
} from "../../shared/contract";
import {
    parseConciergeOutput,
    validateBatchPrompt,
    ConciergeSignal,
    // Handoff V2
    hasHandoffContent,
    formatHandoffEcho,
} from "../../shared/parsing-utils";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ConciergeStance = 'default' | 'decide' | 'explore' | 'challenge';

interface StanceGuidance {
    framing: string;
    behavior: string;
    voice: string;
}

interface StanceSelection {
    stance: ConciergeStance;
    reason: 'query_signal' | 'shape_default';
    confidence: number;
}

/**
 * Active workflow state for multi-turn workflows
 */
export interface ActiveWorkflow {
    goal: string;
    steps: WorkflowStep[];
    currentStepIndex: number;
}

export interface WorkflowStep {
    id: string;
    title: string;
    description: string;
    doneWhen: string;
    status: 'pending' | 'active' | 'complete';
}

/**
 * Prior context for fresh concierge instances after COMMIT or batch re-invoke.
 * Contains distilled handoff data and the commit summary.
 */
export interface PriorContext {
    handoff: ConciergeDelta | null;
    committed: string | null;
}

/**
 * Options for building the concierge prompt
 */
export interface ConciergePromptOptions {
    stance?: ConciergeStance;
    conversationHistory?: string;
    activeWorkflow?: ActiveWorkflow;
    isFirstTurn?: boolean;
    /** Prior context for fresh spawns after COMMIT or batch re-invoke */
    priorContext?: PriorContext;
}

export interface HandleTurnResult {
    response: string;
    stance: ConciergeStance;
    stanceReason: string;
    signal: ConciergeSignal | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDOFF V2: PROTOCOL AND MESSAGE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handoff protocol injected on Turn 2 of each concierge instance.
 * Model learns this format and uses it for Turn 2+ until fresh spawn.
 */
export const HANDOFF_PROTOCOL = `## Handoff Protocol

From this turn forward, if meaningful context emerges that would help future analysis, end your response with a handoff block:

---HANDOFF---
constraints: [hard limits - budget, team size, timeline, technical requirements]
eliminated: [options ruled out, with brief reason]
preferences: [trade-off signals user has indicated: "X over Y"]
context: [situational facts revealed: stage, domain, team composition]
>>>COMMIT: [only if user commits to a plan or requests execution guidance — summarize decision and intent]
---/HANDOFF---

Rules:
• Only include if something worth capturing emerged this turn
• Each handoff is COMPLETE — carry forward anything still true
• Be terse: few words per item, semicolon-separated
• >>>COMMIT is a special signal — only use when user is done exploring and ready to execute
• Never reference the handoff in your visible response to the user
• Omit the entire block if nothing meaningful emerged

`;

/**
 * Build message for Turn 2: injects handoff protocol before user message.
 */
export function buildTurn2Message(userMessage: string): string {
    return HANDOFF_PROTOCOL + `User: "${userMessage}"`;
}

/**
 * Build message for Turn 3+: echoes current handoff before user message.
 * Allows model to update or carry forward the handoff.
 */
export function buildTurn3PlusMessage(
    userMessage: string,
    pendingHandoff: ConciergeDelta | null
): string {
    if (pendingHandoff && hasHandoffContent(pendingHandoff)) {
        return formatHandoffEcho(pendingHandoff) + `User: "${userMessage}"`;
    }
    return userMessage;
}

/**
 * Build prior context section for fresh spawns.
 * Woven into buildConciergePrompt() when priorContext is provided.
 */
function buildPriorContextSection(priorContext: PriorContext): string {
    const parts: string[] = [];

    // What was committed (most important)
    if (priorContext.committed) {
        parts.push(`## What's Been Decided\n\n${priorContext.committed}\n`);
    }

    // Distilled context from prior conversation
    if (priorContext.handoff && hasHandoffContent(priorContext.handoff)) {
        parts.push(`## Prior Context\n`);

        if (priorContext.handoff.constraints.length > 0) {
            parts.push(`**Constraints:** ${priorContext.handoff.constraints.join('; ')}`);
        }
        if (priorContext.handoff.eliminated.length > 0) {
            parts.push(`**Ruled out:** ${priorContext.handoff.eliminated.join('; ')}`);
        }
        if (priorContext.handoff.preferences.length > 0) {
            parts.push(`**Preferences:** ${priorContext.handoff.preferences.join('; ')}`);
        }
        if (priorContext.handoff.context.length > 0) {
            parts.push(`**Situation:** ${priorContext.handoff.context.join('; ')}`);
        }
        parts.push('');
    }

    return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// STANCE SELECTION
// ═══════════════════════════════════════════════════════════════════════════

export function selectStance(
    userMessage: string,
    shape: ProblemStructure
): StanceSelection {

    // 1. Check for explicit query signals first
    const queryStance = detectQueryIntent(userMessage);
    if (queryStance.stance !== 'default') {
        return {
            stance: queryStance.stance,
            reason: 'query_signal',
            confidence: queryStance.confidence
        };
    }

    // 2. Shape-informed defaults
    const shapeStance = getShapeDefaultStance(shape);
    return {
        stance: shapeStance.stance,
        reason: 'shape_default',
        confidence: shapeStance.confidence
    };
}

function detectQueryIntent(userMessage: string): { stance: ConciergeStance; confidence: number } {
    const lower = userMessage.toLowerCase();

    // DECIDE signals (high confidence)
    const strongDecide = [
        /\bshould i\b/,
        /\bjust tell me\b/,
        /\bwhat do i do\b/,
        /\bmake (the |a )?decision\b/,
        /\bpick (one|the best)\b/,
    ];
    if (strongDecide.some(p => p.test(lower))) {
        return { stance: 'decide', confidence: 0.9 };
    }

    // DECIDE signals (medium confidence)
    const mediumDecide = [
        /\bwhich (one|should)\b/,
        /\bchoose\b/,
        /\bbest\b/,
        /\brecommend\b/,
    ];
    if (mediumDecide.some(p => p.test(lower))) {
        return { stance: 'decide', confidence: 0.7 };
    }

    // CHALLENGE signals
    const challengePatterns = [
        /\bwhat('s| is) wrong\b/,
        /\bchallenge\b/,
        /\bdevil'?s advocate\b/,
        /\bpoke holes\b/,
        /\bstress test\b/,
        /\bwhat am i missing\b/,
        /\bblind spot/,
        /\bweak(ness|point)/,
        /\bcritique\b/,
        /\bpush back\b/,
        /\battack\b/,
    ];
    if (challengePatterns.some(p => p.test(lower))) {
        return { stance: 'challenge', confidence: 0.85 };
    }

    // EXPLORE signals
    const explorePatterns = [
        /\bwhat are (the |my )?options\b/,
        /\bexplore\b/,
        /\bmap out\b/,
        /\bpossibilities\b/,
        /\balternatives\b/,
        /\bwhat else\b/,
        /\btrade-?offs?\b/,
        /\bpros and cons\b/,
        /\bcompare\b/,
        /\bbreak(down| it down)\b/,
        /\bwalk me through\b/,
    ];
    if (explorePatterns.some(p => p.test(lower))) {
        return { stance: 'explore', confidence: 0.75 };
    }

    // No strong signal
    return { stance: 'default', confidence: 0.5 };
}

function getShapeDefaultStance(shape: ProblemStructure): { stance: ConciergeStance; confidence: number } {
    switch (shape.primaryPattern) {
        case 'tradeoff':
            // Explicit tradeoffs - explore helps map the space
            return { stance: 'explore', confidence: 0.7 };

        case 'exploratory':
            // Sparse structure - explore to find what matters
            return { stance: 'explore', confidence: 0.65 };

        case 'dimensional':
            // Multiple factors - explore to surface dimensions
            return { stance: 'explore', confidence: 0.6 };

        case 'contextual':
            // Need more info - explore to surface what's missing
            return { stance: 'explore', confidence: 0.65 };

        case 'contested':
        case 'settled':
        case 'keystone':
        case 'linear':
        default:
            // Default stance works well for these
            return { stance: 'default', confidence: 0.6 };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// STANCE GUIDANCE
// ═══════════════════════════════════════════════════════════════════════════

export function getStanceGuidance(stance: ConciergeStance): StanceGuidance {
    switch (stance) {
        case 'decide':
            return {
                framing: 'The user needs a decision, not exploration.',
                behavior: `Eliminate until one path remains.

Apply these filters to every position:
1. **Actionability**: Can someone DO something with this?
2. **Relevance**: Does it advance toward the implied goal?
3. **Superiority**: Does it BEAT alternatives, or merely exist alongside them?

What fails these tests gets eliminated. What survives is the answer.

If multiple paths survive, state the tiebreaker: "If X matters more, do A. If Y matters more, do B."
If nothing survives cleanly, say so—explain what's missing.

Do not hedge. Do not present options. Decide.`,
                voice: `- Decisive. No hedging without explicit conditions.
- If something was eliminated, you may briefly note why.
- End with: "Do X. Here's why. Next step: Y."`
            };

        case 'explore':
            return {
                framing: 'The user wants to see the territory, not collapse to an answer.',
                behavior: `Open the space. Show the branches. Don't pick for them.

- Surface dimensions they might not have considered
- Show where positions fork based on context
- Present tradeoffs explicitly: "Optimizing for X gives you A. Optimizing for Y gives you B."
- Identify what context would change the answer

You are a map, not a guide. Let them navigate.`,
                voice: `- Curious. Generative. 
- "If X, then A. If Y, then B."
- "The key variable here is..."
- End with a question that would help them navigate: "What matters more to you: X or Y?"`
            };

        case 'challenge':
            return {
                framing: 'The user wants their assumptions tested. Be adversarial.',
                behavior: `Attack the floor. Find the fragile foundations.

- What does the apparent consensus assume without stating?
- Which low-support positions have structural importance? (They might be right.)
- What conditions would make the strongest position fail?
- What are the challengers seeing that the floor is missing?

You are the devil's advocate. Find the cracks. Surface the risk.
But be constructive—challenge to strengthen, not to destroy.`,
                voice: `- Adversarial but constructive.
- "The agreement assumes X. But what if X is false?"
- "The weak point here is..."
- End with the strongest counter-position that survives scrutiny.`
            };

        case 'default':
        default:
            return {
                framing: '',
                behavior: `Respond directly to the query using what the structure reveals.

- If there's strong agreement, speak with confidence.
- If there's genuine tension, surface it naturally—don't hide it.
- If the structure is sparse, acknowledge uncertainty.
- Land somewhere useful. Don't leave them suspended in possibility.`,
                voice: `- Direct. No preamble.
- Conviction when structure supports it.
- Acknowledge uncertainty when structure is fragile.
- Surface tensions when they matter.
- End with forward motion—a next step, a key question, or a clear position.`
            };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHAPE-SPECIFIC BRIEFS
// ═══════════════════════════════════════════════════════════════════════════

function buildSettledBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ratios } = analysis;
    const data = shape.data as SettledShapeData;

    if (!data || data.pattern !== 'settled') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: SETTLED (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `Strong agreement exists. The floor is established.\n\n`;
    brief += `**Floor Strength**: ${data.floorStrength.toUpperCase()}\n`;
    brief += `**Claims**: ${landscape.claimCount} from ${landscape.modelCount} sources\n`;
    brief += `**Concentration**: ${Math.round(ratios.concentration * 100)}%\n\n`;

    brief += `## The Floor\n\n`;
    if (data.floor.length > 0) {
        data.floor.forEach(c => {
            const contested = c.isContested ? ' ⚠️ CONTESTED' : '';
            brief += `**${c.label}** [${c.supportCount}/${landscape.modelCount}]${contested}\n`;
            brief += `${c.text}\n\n`;
        });
    } else {
        brief += `No strong consensus claims.\n\n`;
    }

    if (data.challengers.length > 0) {
        brief += `## Challengers\n\n`;
        data.challengers.forEach(c => {
            brief += `⚡ **${c.label}** [${c.supportCount}/${landscape.modelCount}]\n`;
            brief += `${c.text}\n`;
            if (c.challenges) {
                brief += `*Challenges: ${c.challenges}*\n`;
            }
            brief += `\n`;
        });
    }

    if (data.blindSpots.length > 0) {
        brief += `## Blind Spots\n\n`;
        data.blindSpots.forEach(g => {
            brief += `• ${g}\n`;
        });
        brief += `\n`;
    }

    const contestedFloor = data.floor.filter(c => c.isContested);
    if (contestedFloor.length > 0) {
        brief += `## ⚠️ Warning\n\n`;
        brief += `${contestedFloor.length} floor claim(s) are under challenge. Settlement may be fragile.\n`;
    }

    return brief;
}

function buildLinearBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ratios } = analysis;
    const data = shape.data as LinearShapeData;

    if (!data || data.pattern !== 'linear') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: LINEAR (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `There's a sequence of ${data.chainLength} steps. Order matters.\n\n`;
    brief += `**Chain Length**: ${data.chainLength} steps\n`;
    brief += `**Weak Links**: ${data.weakLinks.length}\n`;
    brief += `**Depth**: ${Math.round(ratios.depth * 100)}%\n\n`;

    brief += `## The Chain\n\n`;
    data.chain.forEach((step, idx) => {
        const weakIcon = step.isWeakLink ? ' ⚠️ WEAK' : '';
        const arrow = idx < data.chain.length - 1 ? ' →' : ' (terminal)';

        brief += `### Step ${idx + 1}: ${step.label}${weakIcon}\n`;
        brief += `[${step.supportCount}/${landscape.modelCount}]${arrow}\n\n`;
        brief += `${step.text}\n\n`;

        if (step.isWeakLink && step.weakReason) {
            brief += `*⚠️ ${step.weakReason}*\n\n`;
        }
    });

    if (data.weakLinks.length > 0) {
        brief += `## Cascade Risks\n\n`;
        data.weakLinks.forEach(wl => {
            brief += `• **${wl.step.label}** — If this fails, ${wl.cascadeSize} downstream step(s) fail\n`;
        });
        brief += `\n`;
    }

    return brief;
}

function buildKeystoneBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape } = analysis;
    const data = shape.data as KeystoneShapeData;

    if (!data || data.pattern !== 'keystone') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: KEYSTONE (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `Everything hinges on one critical claim.\n\n`;

    const fragileIcon = data.keystone.isFragile ? ' ⚠️ FRAGILE' : ' ✓ SOLID';
    brief += `## The Keystone${fragileIcon}\n\n`;
    brief += `**${data.keystone.label}** [${data.keystone.supportCount}/${landscape.modelCount}]\n`;
    brief += `${data.keystone.text}\n\n`;
    brief += `**Dominance**: ${data.keystone.dominance.toFixed(1)}x more connected than next claim\n`;
    brief += `**Cascade Size**: ${data.cascadeSize} dependent claims\n\n`;

    if (data.dependencies.length > 0) {
        brief += `## Dependencies\n\n`;
        brief += `These claims require the keystone to hold:\n\n`;
        data.dependencies.forEach(d => {
            brief += `• **${d.label}** (${d.relationship})\n`;
        });
        brief += `\n`;
    }

    brief += `## If Keystone Fails\n\n`;
    if (data.keystone.isFragile) {
        brief += `⚠️ **HIGH RISK**: The keystone has only ${data.keystone.supportCount} supporter(s).\n`;
        brief += `If it falls, ${data.cascadeSize} claims collapse with it.\n\n`;
    } else {
        brief += `The keystone has solid support, but still carries ${data.cascadeSize} dependents.\n\n`;
    }

    if (data.challengers.length > 0) {
        brief += `## Challengers to Keystone\n\n`;
        data.challengers.forEach(c => {
            brief += `⚡ **${c.label}** [${c.supportCount}/${landscape.modelCount}]\n`;
            brief += `${c.text}\n\n`;
        });
    }

    return brief;
}

function buildContestedBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ratios, patterns } = analysis;
    const data = shape.data as ContestedShapeData;

    if (!data || data.pattern !== 'contested') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: CONTESTED (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `There is genuine disagreement. The axis is: **${data.centralConflict.axis}**\n\n`;
    brief += `**Tension**: ${Math.round(ratios.tension * 100)}%\n`;
    brief += `**Conflicts**: ${patterns.conflicts.length}\n\n`;

    brief += `## The Central Conflict\n\n`;

    if (data.centralConflict.type === 'cluster') {
        const cc = data.centralConflict;

        brief += `### Target Position\n`;
        brief += `**${cc.target.claim.label}** [${cc.target.claim.supportCount}/${landscape.modelCount}]\n`;
        brief += `${cc.target.claim.text}\n\n`;

        brief += `### Challenger Positions (${cc.challengers.claims.length})\n`;
        cc.challengers.claims.forEach(c => {
            brief += `⚡ **${c.label}** [${c.supportCount}/${landscape.modelCount}]\n`;
            brief += `${c.text}\n\n`;
        });

        brief += `**Common Theme**: ${cc.challengers.commonTheme}\n\n`;

    } else {
        const cc = data.centralConflict;

        brief += `### Position A\n`;
        brief += `**${cc.positionA.claim.label}** [${cc.positionA.claim.supportCount}/${landscape.modelCount}]\n`;
        brief += `${cc.positionA.claim.text}\n\n`;

        brief += `### Position B\n`;
        brief += `**${cc.positionB.claim.label}** [${cc.positionB.claim.supportCount}/${landscape.modelCount}]\n`;
        brief += `${cc.positionB.claim.text}\n\n`;

        brief += `**Dynamics**: ${cc.dynamics}\n`;
    }

    brief += `\n## Stakes\n\n`;
    if (data.centralConflict.type === 'cluster') {
        brief += `• ${data.centralConflict.stakes.acceptingTarget}\n`;
        brief += `• ${data.centralConflict.stakes.acceptingChallengers}\n\n`;
    } else {
        brief += `• ${data.centralConflict.stakes.choosingA}\n`;
        brief += `• ${data.centralConflict.stakes.choosingB}\n\n`;
    }

    if (data.secondaryConflicts.length > 0) {
        brief += `## Secondary Conflicts\n\n`;
        data.secondaryConflicts.slice(0, 3).forEach(c => {
            brief += `• ${c.claimA.label} vs ${c.claimB.label}\n`;
        });
        brief += `\n`;
    }

    if (data.floor.exists) {
        brief += `## Weak Floor (Outside Conflict)\n\n`;
        data.floor.claims.forEach(c => {
            brief += `• **${c.label}** [${c.supportCount}]\n`;
        });
        brief += `\n`;
    }

    if (data.collapsingQuestion) {
        brief += `## The Question\n\n`;
        brief += `${data.collapsingQuestion}\n`;
    }

    return brief;
}

function buildTradeoffBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ratios } = analysis;
    const data = shape.data as TradeoffShapeData;

    if (!data || data.pattern !== 'tradeoff') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: TRADEOFF (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `Explicit tradeoffs exist. No universal best.\n\n`;
    brief += `**Tradeoffs**: ${data.tradeoffs.length}\n`;
    brief += `**Tension**: ${Math.round(ratios.tension * 100)}%\n\n`;

    data.tradeoffs.forEach((t, idx) => {
        brief += `## Tradeoff ${idx + 1}\n\n`;

        brief += `### Option A: ${t.optionA.label}\n`;
        brief += `[${t.optionA.supportCount}/${landscape.modelCount}]\n`;
        brief += `${t.optionA.text}\n\n`;

        brief += `### Option B: ${t.optionB.label}\n`;
        brief += `[${t.optionB.supportCount}/${landscape.modelCount}]\n`;
        brief += `${t.optionB.text}\n\n`;

        brief += `**Symmetry**: ${t.symmetry.replace('_', ' ')}\n`;
        if (t.governingFactor) {
            brief += `**Governing Factor**: ${t.governingFactor}\n`;
        }
        brief += `\n`;
    });

    if (data.dominatedOptions.length > 0) {
        brief += `## Dominated Options\n\n`;
        data.dominatedOptions.forEach(d => {
            brief += `• ${d.dominated} is dominated by ${d.dominatedBy}\n`;
            brief += `  *${d.reason}*\n`;
        });
        brief += `\n`;
    }

    if (data.floor.length > 0) {
        brief += `## Agreed Ground (Not In Tradeoff)\n\n`;
        data.floor.forEach(c => {
            brief += `• **${c.label}** [${c.supportCount}]\n`;
        });
        brief += `\n`;
    }

    return brief;
}

function buildDimensionalBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, graph } = analysis;
    const data = shape.data as DimensionalShapeData;

    if (!data || data.pattern !== 'dimensional') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: DIMENSIONAL (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `Multiple independent factors determine the answer.\n\n`;
    brief += `**Dimensions**: ${data.dimensions.length}\n`;
    brief += `**Components**: ${graph.componentCount}\n`;
    brief += `**Local Coherence**: ${Math.round(graph.localCoherence * 100)}%\n\n`;

    data.dimensions.forEach((dim) => {
        brief += `## ${dim.theme}\n\n`;
        dim.claims.forEach(c => {
            brief += `• **${c.label}** [${c.supportCount}/${landscape.modelCount}]\n`;
            brief += `  ${c.text}\n\n`;
        });
    });

    if (data.interactions.length > 0) {
        brief += `## Dimension Interactions\n\n`;
        data.interactions.forEach(i => {
            const icon = i.relationship === 'conflicting' ? '⚡' : i.relationship === 'overlapping' ? '↔' : '○';
            brief += `${icon} ${i.dimensionA} — ${i.dimensionB}: ${i.relationship}\n`;
        });
        brief += `\n`;
    }

    if (data.governingConditions.length > 0) {
        brief += `## Governing Conditions\n\n`;
        data.governingConditions.forEach(c => {
            brief += `• ${c}\n`;
        });
        brief += `\n`;
    }

    if (data.gaps.length > 0) {
        brief += `## Unexplored Combinations\n\n`;
        data.gaps.forEach(g => {
            brief += `• ${g}\n`;
        });
        brief += `\n`;
    }

    return brief;
}

function buildExploratoryBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ratios, patterns, ghostAnalysis } = analysis;
    const data = shape.data as ExploratoryShapeData;

    if (!data || data.pattern !== 'exploratory') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: EXPLORATORY (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `Structure is sparse. Low confidence. Be honest about uncertainty.\n\n`;
    brief += `**Signal Strength**: ${Math.round(data.signalStrength * 100)}%\n`;
    brief += `**Claims**: ${landscape.claimCount} (${patterns.isolatedClaims.length} isolated)\n`;
    brief += `**Fragmentation**: ${Math.round(ratios.fragmentation * 100)}%\n\n`;

    if (data.strongestSignals.length > 0) {
        brief += `## Strongest Signals\n\n`;
        data.strongestSignals.forEach(s => {
            brief += `**${s.label}** [${s.supportCount}/${landscape.modelCount}] — ${s.reason}\n`;
            brief += `${s.text}\n\n`;
        });
    }

    if (data.looseClusters.length > 0) {
        brief += `## Loose Clusters\n\n`;
        data.looseClusters.forEach(c => {
            const labels = c.claims.map(cl => cl.label).join(', ');
            brief += `• **${c.theme}**: ${labels}\n`;
        });
        brief += `\n`;
    }

    if (data.isolatedClaims.length > 0) {
        brief += `## Isolated Claims\n\n`;
        data.isolatedClaims.forEach(c => {
            brief += `○ **${c.label}**\n`;
            brief += `  ${c.text}\n\n`;
        });
    }

    if (data.clarifyingQuestions.length > 0) {
        brief += `## To Collapse Ambiguity\n\n`;
        data.clarifyingQuestions.forEach(q => {
            brief += `• ${q}\n`;
        });
        brief += `\n`;
    }

    if (ghostAnalysis.count > 0) {
        brief += `## Gaps\n\n`;
        brief += `${ghostAnalysis.count} unaddressed area(s).\n`;
    }

    return brief;
}

function buildContextualBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape } = analysis;
    const data = shape.data as ContextualShapeData;

    if (!data || data.pattern !== 'contextual') {
        return buildGenericBrief(analysis);
    }

    let brief = '';

    brief += `## Shape: CONTEXTUAL (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `The answer depends on specific external factors.\n\n`;

    brief += `## The Fork\n\n`;
    brief += `**Governing Condition**: ${data.governingCondition}\n\n`;

    if (data.branches.length > 0) {
        brief += `## Branches\n\n`;
        data.branches.forEach((branch) => {
            brief += `### ${branch.condition}\n\n`;
            branch.claims.forEach(c => {
                brief += `• **${c.label}** [${c.supportCount}/${landscape.modelCount}]\n`;
                brief += `  ${c.text}\n\n`;
            });
        });
    }

    if (data.defaultPath?.exists) {
        brief += `## Default Path (Highest Support)\n\n`;
        data.defaultPath.claims.forEach(c => {
            brief += `• **${c.label}** [${c.supportCount}]\n`;
        });
        brief += `\n`;
    }

    if (data.missingContext.length > 0) {
        brief += `## Missing Context\n\n`;
        brief += `To give a specific answer, I need to know:\n\n`;
        data.missingContext.forEach(m => {
            brief += `• ${m}\n`;
        });
        brief += `\n`;
    }

    return brief;
}

function buildGenericBrief(analysis: StructuralAnalysis): string {
    const { shape, claimsWithLeverage: claims, landscape, ratios, ghostAnalysis } = analysis;

    let brief = '';

    brief += `## Shape: ${shape.primaryPattern.toUpperCase()} (${Math.round(shape.confidence * 100)}%)\n\n`;
    brief += `${shape.implications.action}\n\n`;

    brief += `## Metrics\n\n`;
    brief += `• Claims: ${landscape.claimCount} from ${landscape.modelCount} sources\n`;
    brief += `• Concentration: ${Math.round(ratios.concentration * 100)}%\n`;
    brief += `• Tension: ${Math.round(ratios.tension * 100)}%\n\n`;

    const floor = claims.filter(c => c.isHighSupport);
    if (floor.length > 0) {
        brief += `## Floor (${floor.length})\n\n`;
        floor.forEach(c => {
            brief += `**${c.label}** [${c.supporters.length}/${landscape.modelCount}]\n`;
            brief += `${c.text}\n\n`;
        });
    }

    const lowSupport = claims.filter(c => !c.isHighSupport);
    if (lowSupport.length > 0) {
        brief += `## Other Claims (${lowSupport.length})\n\n`;
        lowSupport.slice(0, 5).forEach(c => {
            const icon = c.role === 'challenger' ? '⚡' : '○';
            brief += `${icon} **${c.label}** [${c.supporters.length}]\n`;
        });
        if (lowSupport.length > 5) {
            brief += `... and ${lowSupport.length - 5} more\n`;
        }
        brief += `\n`;
    }

    if (ghostAnalysis.count > 0) {
        brief += `## Gaps\n\n`;
        brief += `${ghostAnalysis.count} unaddressed area(s).\n`;
    }

    return brief;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHAPE GUIDANCE
// ═══════════════════════════════════════════════════════════════════════════

export function getShapeGuidance(shape: ProblemStructure): string {
    // Check for composite shape
    const composite = shape.compositeShape;
    const hasDissentPattern = composite?.patterns.some(p => p.type === 'dissent');

    const guidance: Record<ProblemStructure['primaryPattern'], string> = {
        settled: `**Shape Note: CONVERGENT**
Strong agreement exists. ${hasDissentPattern ? 'But there is dissent—surface it.' : 'Watch for blind spots in unanimous consensus.'}
Lead with the answer, but make the minority report visible. Consensus isn't always correct.`,

        contested: `**Shape Note: FORKED**
Genuine disagreement exists between well-supported positions. This is a real fork, not uncertainty.
Present both paths as valid. Help them see what each choice requires and forecloses.
Don't pick a side unless they give you context that resolves the fork.`,

        keystone: `**Shape Note: HUB-CENTRIC**
Everything hinges on one critical claim. Center your response around it.
Show what depends on it. If they ask "why" or "what if," stress-test the keystone.
If it fails, acknowledge the cascade honestly.`,

        linear: `**Shape Note: SEQUENTIAL**
There's a clear sequence with prerequisites. Walk through steps in order.
Emphasize why order matters. Help them identify where they are in the chain.
Flag weak links—steps with low support that could break the sequence.`,

        tradeoff: `**Shape Note: CONSTRAINED**
Explicit tradeoffs exist. There is no universal best.
Map what is sacrificed for what is gained. Ask about priorities.
Don't force a choice—show the consequences of each path.`,

        dimensional: `**Shape Note: PARALLEL**
Multiple valid dimensions exist that don't directly interact.
Ask which dimension matters most to them. Don't collapse prematurely.
Each dimension may have its own answer.`,

        contextual: `**Shape Note: CONDITIONAL**
The answer depends on specific context you don't have.
Ask for the missing context directly. Explain how the answer changes based on it.
Don't guess—show the branches and let them pick.`,

        exploratory: `**Shape Note: SPARSE**
Structure is weak. Low confidence. Be honest about uncertainty.
Surface what signals exist. Ask clarifying questions.
Don't fabricate certainty where none exists.`,
    };

    return guidance[shape.primaryPattern] || guidance.exploratory;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BRIEF DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

export function buildStructuralBrief(analysis: StructuralAnalysis): string {
    const { shape, landscape, ghostAnalysis, patterns } = analysis;
    const modelCount = landscape.modelCount || 0;
    const claimById = new Map<string, { id: string; label?: string; text?: string }>();
    (analysis.claimsWithLeverage || []).forEach((c) => {
        if (c?.id) claimById.set(c.id, c);
    });

    const formatSupport = (supportCount?: number) => {
        if (typeof supportCount !== "number") return "";
        return modelCount > 0 ? ` [${supportCount}/${modelCount}]` : ` [${supportCount}]`;
    };

    const topClaims = (analysis.claimsWithLeverage || [])
        .slice()
        .sort((a, b) => (b.support_count || 0) - (a.support_count || 0))
        .slice(0, 6);

    let brief = "";

    brief += `## Topology: ${getTopologyName(shape.primaryPattern)}\n\n`;
    brief += `${getTopologyDescription(shape.primaryPattern)}\n\n`;

    if (topClaims.length > 0) {
        brief += `## Core Claims\n\n`;
        topClaims.forEach((c) => {
            brief += `• **${c.label}**${formatSupport(c.support_count)}\n`;
            if (c.text) brief += `  ${c.text}\n`;
        });
        brief += `\n`;
    }

    const conflictInfos = Array.isArray(patterns?.conflictInfos) ? patterns.conflictInfos : [];
    const topConflicts = conflictInfos
        .slice()
        .sort((a, b) => (b.significance || 0) - (a.significance || 0))
        .slice(0, 3);
    if (topConflicts.length > 0) {
        brief += `## Key Tensions\n\n`;
        topConflicts.forEach((c) => {
            const axis = c?.axis?.resolved ? ` — ${c.axis.resolved}` : "";
            brief += `• **${c.claimA.label}**${formatSupport(c.claimA.supportCount)} vs **${c.claimB.label}**${formatSupport(c.claimB.supportCount)}${axis}\n`;
            if (c?.stakes?.choosingA) brief += `  - Stakes (A): ${c.stakes.choosingA}\n`;
            if (c?.stakes?.choosingB) brief += `  - Stakes (B): ${c.stakes.choosingB}\n`;
        });
        brief += `\n`;
    }

    const tradeoffs = Array.isArray(patterns?.tradeoffs) ? patterns.tradeoffs : [];
    if (tradeoffs.length > 0 && topConflicts.length === 0) {
        brief += `## Tradeoffs\n\n`;
        tradeoffs.slice(0, 3).forEach((t) => {
            const aSupport = modelCount > 0 ? `${t.claimA.supporterCount}/${modelCount}` : String(t.claimA.supporterCount);
            const bSupport = modelCount > 0 ? `${t.claimB.supporterCount}/${modelCount}` : String(t.claimB.supporterCount);
            brief += `• **${t.claimA.label}** [${aSupport}] vs **${t.claimB.label}** [${bSupport}]\n`;
        });
        brief += `\n`;
    }

    const leverageInversions = Array.isArray(patterns?.leverageInversions) ? patterns.leverageInversions : [];
    const cascadeRisks = Array.isArray(patterns?.cascadeRisks) ? patterns.cascadeRisks : [];
    if (leverageInversions.length > 0 || cascadeRisks.length > 0) {
        brief += `## Structural Risks\n\n`;
        leverageInversions.slice(0, 3).forEach((li) => {
            const support = typeof li.supporterCount === "number" ? formatSupport(li.supporterCount) : "";
            const strongClaim = li.strongClaim ? ` — many arguments lean on "${li.strongClaim}"` : "";
            brief += `• **${li.claimLabel}**${support}${strongClaim}\n`;
            if (li.reason) brief += `  ${li.reason}\n`;
        });
        cascadeRisks.slice(0, 3).forEach((cr) => {
            const dependents = Array.isArray(cr.dependentLabels) ? cr.dependentLabels.filter(Boolean) : [];
            const preview = dependents.slice(0, 4).join(", ");
            const more = dependents.length > 4 ? ` (+${dependents.length - 4} more)` : "";
            if (preview) {
                brief += `• If **${cr.sourceLabel}** breaks, it may break: ${preview}${more}\n`;
            } else {
                brief += `• If **${cr.sourceLabel}** breaks, downstream claims may fail\n`;
            }
        });
        brief += `\n`;
    }

    if (ghostAnalysis.count > 0) {
        brief += `## Gaps\n\n`;
        brief += `• ${ghostAnalysis.count} area(s) not addressed by any source\n`;
        if (ghostAnalysis.mayExtendChallenger && Array.isArray(ghostAnalysis.challengerIds)) {
            const challengerLabels = ghostAnalysis.challengerIds
                .map((id) => claimById.get(id)?.label)
                .filter(Boolean)
                .slice(0, 4);
            if (challengerLabels.length > 0) {
                brief += `• These challenger claims may expand if explored: ${challengerLabels.join(", ")}\n`;
            }
        }
        brief += `\n`;
    }

    brief += `## The Flow\n\n`;
    brief += buildFlowSection(analysis);
    brief += `\n`;

    brief += `## The Friction\n\n`;
    brief += buildFrictionSection(analysis);
    brief += `\n`;

    const fragilities = collectFragilities(analysis);
    if (fragilities.length > 0) {
        brief += `## Fragilities\n\n`;
        fragilities.forEach(f => {
            brief += `• ${f}\n`;
        });
        brief += `\n`;
    }

    brief += `## The Transfer\n\n`;
    brief += buildTransferSection(analysis);

    return brief;
}

function getTopologyName(pattern: string): string {
    const names: Record<string, string> = {
        settled: "CONVERGENT",
        contested: "FORKED",
        keystone: "HUB-CENTRIC",
        linear: "SEQUENTIAL",
        tradeoff: "CONSTRAINED",
        dimensional: "PARALLEL",
        exploratory: "SPARSE",
        contextual: "CONDITIONAL",
    };
    return names[pattern] || pattern.toUpperCase();
}

function getTopologyDescription(pattern: string): string {
    const descriptions: Record<string, string> = {
        settled:
            "Multiple reasoning paths converge on a central cluster. " +
            "Strong agreement exists, but check the minority report—consensus can mask blind spots.",
        contested:
            "The structure contains genuine opposition between well-supported positions. " +
            "This is a real fork—choosing one path forecloses another. The question is: what determines which path applies?",
        keystone:
            "The structure radiates from a central hub. Many claims depend on one foundation. " +
            "If that foundation is wrong, the cascade is significant.",
        linear:
            "The structure forms sequential chains of prerequisites. " +
            "Order matters. Validate early steps before proceeding.",
        tradeoff:
            "The structure contains explicit optimization boundaries. " +
            "You cannot maximize both. What are you optimizing for?",
        dimensional:
            "The structure fragments into independent clusters. " +
            "Different lenses on the problem that don't directly interact. Which dimension matters most?",
        exploratory:
            "The structure is sparse or fragmented. Low coherence. " +
            "Either the domain is underexplored, the question was ambiguous, or perspectives diverged significantly.",
        contextual:
            "The structure is conditional—different paths activate based on specific inputs. " +
            "There is no universal answer; it depends on context the system does not have.",
    };
    return descriptions[pattern] || "Pattern detected but not characterized.";
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITE SHAPE FLOW/FRICTION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildFlowFromComposite(composite: CompositeShape, modelCount: number): string {
    const peakLabels = composite.peaks.slice(0, 3).map(p => `"${p.label}"`).join(', ');

    let flow = '';

    switch (composite.primary) {
        case 'convergent':
            flow += `**Narrative Gravity:** The landscape converges on ${peakLabels}.\n\n`;
            flow += composite.peaks.length === 1
                ? `This is the dominant position with ${(composite.peaks[0].supportRatio * 100).toFixed(0)}% support.\n\n`
                : `These positions reinforce each other.\n\n`;

            composite.peaks.forEach(p => {
                flow += `• **${p.label}** [${(p.supportRatio * 100).toFixed(0)}%]\n`;
            });
            break;

        case 'forked':
            flow += `**The Fork:** Two or more valid paths exist.\n\n`;
            flow += `${peakLabels} are all well-supported but conflict.\n`;
            flow += `The choice between them depends on values you haven't stated.\n\n`;

            flow += `**Peak Relationship:** ${composite.peakRelationship}\n\n`;

            composite.peaks.forEach(p => {
                flow += `• **${p.label}** [${(p.supportRatio * 100).toFixed(0)}%]\n`;
            });
            break;

        case 'parallel':
            flow += `**Independent Dimensions:** ${peakLabels} address different aspects of the problem.\n\n`;
            flow += `They don't conflict because they don't interact.\n\n`;

            composite.peaks.forEach(p => {
                flow += `• **${p.label}** [${(p.supportRatio * 100).toFixed(0)}%]\n`;
            });
            break;

        case 'constrained':
            flow += `**Optimization Boundary:** ${peakLabels} represent tradeoffs.\n\n`;
            flow += `Choosing one means sacrificing aspects of others.\n\n`;

            composite.peaks.forEach(p => {
                flow += `• **${p.label}** [${(p.supportRatio * 100).toFixed(0)}%]\n`;
            });
            break;

        case 'sparse':
            flow += `**Weak Signal:** No position has strong support.\n\n`;
            flow += `The models diverge significantly, suggesting the problem is underspecified.\n\n`;

            if (composite.peaks.length > 0) {
                flow += `**Strongest signals:**\n`;
                composite.peaks.forEach(p => {
                    flow += `• **${p.label}** [${(p.supportRatio * 100).toFixed(0)}%]\n`;
                });
            }
            break;
    }

    flow += '\n';
    return flow;
}

function buildFrictionFromComposite(
    composite: CompositeShape,
    claims: EnrichedClaim[],
    modelCount: number
): string {
    const frictionParts: string[] = [];

    // ─────────────────────────────────────────────────────────────────────────
    // DISSENT IS PRIMARY FOR CONVERGENT/PARALLEL SHAPES
    // ─────────────────────────────────────────────────────────────────────────
    const dissentPattern = composite.patterns.find(p => p.type === 'dissent');

    if (composite.primary === 'convergent' || composite.primary === 'parallel') {
        if (dissentPattern) {
            const dissent = dissentPattern.data as DissentPatternData;

            if (dissent.strongestVoice) {
                frictionParts.push(
                    `**The Minority Report:** "${dissent.strongestVoice.label}" ` +
                    `(${(dissent.strongestVoice.supportRatio * 100).toFixed(0)}% support)\n\n` +
                    `${dissent.strongestVoice.whyItMatters}\n\n` +
                    `> "${dissent.strongestVoice.text}"`
                );
            }

            if (dissent.voices.length > 1) {
                const others = dissent.voices.slice(1, 3);
                frictionParts.push(
                    `**Other Dissenting Voices:**\n` +
                    others.map(v => `• "${v.label}" (${v.insightType.replace(/_/g, ' ')})`).join('\n')
                );
            }

            if (dissent.suppressedDimensions.length > 0) {
                frictionParts.push(
                    `**Suppressed Dimensions:** The minority uniquely represents: ${dissent.suppressedDimensions.join(', ')}`
                );
            }
        } else {
            frictionParts.push(
                `**Unanimous Consensus Warning:** No dissenting voices detected.\n` +
                `Either the answer is genuinely clear, or all models share a blind spot.`
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OTHER PATTERNS
    // ─────────────────────────────────────────────────────────────────────────
    const otherPatterns = composite.patterns
        .filter(p => p.type !== 'dissent')
        .sort((a, b) => {
            const severityOrder = { high: 0, medium: 1, low: 2 };
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

    for (const pattern of otherPatterns.slice(0, 2)) {
        switch (pattern.type) {
            case 'fragile': {
                const frag = pattern.data as FragilePatternData;
                frictionParts.push(
                    `**Fragile Foundation:** "${frag.fragilities[0].peak.label}" depends on ` +
                    `"${frag.fragilities[0].weakFoundation.label}" ` +
                    `(${(frag.fragilities[0].weakFoundation.supportRatio * 100).toFixed(0)}% support).\n` +
                    `The consensus rests on contested ground.`
                );
                break;
            }

            case 'keystone': {
                const ks = pattern.data as KeystonePatternData;
                frictionParts.push(
                    `**Keystone Risk:** Everything flows from "${ks.keystone.label}".\n` +
                    `If this breaks, ${ks.cascadeSize} dependent claim(s) fall with it.`
                );
                break;
            }

            case 'challenged': {
                if (!dissentPattern) {
                    const ch = pattern.data as ChallengedPatternData;
                    frictionParts.push(
                        `**Under Siege:** The floor is challenged by ${ch.challenges.length} claim(s).`
                    );
                }
                break;
            }

            case 'chain': {
                const chain = pattern.data as ChainPatternData;
                if (chain.weakLinks.length > 0) {
                    frictionParts.push(
                        `**Chain Vulnerability:** ${chain.weakLinks.length} weak link(s) in the sequence.`
                    );
                }
                break;
            }

            case 'orphaned': {
                const orphans = pattern.data as OrphanedPatternData;
                frictionParts.push(
                    `**Disconnected Signal:** "${orphans.orphans[0].label}" has high support ` +
                    `but isn't connected to anything. It may represent a missed dimension.`
                );
                break;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FOR FORKED SHAPES: What both sides miss
    // ─────────────────────────────────────────────────────────────────────────
    if (composite.primary === 'forked' && dissentPattern) {
        const dissent = dissentPattern.data as DissentPatternData;
        if (dissent.strongestVoice) {
            frictionParts.push(
                `**What Both Forks Miss:** "${dissent.strongestVoice.label}" isn't aligned with either position—it may represent the actual answer.`
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FOR CONSTRAINED SHAPES: Emphasize the cost
    // ─────────────────────────────────────────────────────────────────────────
    if (composite.primary === 'constrained') {
        frictionParts.push(
            `**There is no resolution to a true tradeoff.** Choosing means accepting the cost of what you did not choose.`
        );
    }

    if (frictionParts.length === 0) {
        frictionParts.push(`**No significant friction detected.**`);
    }

    return frictionParts.join('\n\n');
}

function buildFlowSection(analysis: StructuralAnalysis): string {
    const { shape, landscape, claimsWithLeverage } = analysis;

    // Use composite shape if available (new system)
    if (shape.compositeShape) {
        return buildFlowFromComposite(shape.compositeShape, landscape.modelCount);
    }

    // Fall back to legacy builders
    const data = shape.data;

    if (!data) return "Structure data not available.\n";

    switch (shape.primaryPattern) {
        case "settled":
            return buildSettledFlow(data as SettledShapeData, landscape.modelCount);
        case "contested":
            return buildContestedFlow(data as ContestedShapeData, landscape.modelCount);
        case "keystone":
            return buildKeystoneFlow(data as KeystoneShapeData, landscape.modelCount);
        case "linear":
            return buildLinearFlow(data as LinearShapeData, landscape.modelCount);
        case "tradeoff":
            return buildTradeoffFlow(data as TradeoffShapeData, landscape.modelCount);
        case "dimensional":
            return buildDimensionalFlow(data as DimensionalShapeData, landscape.modelCount);
        case "exploratory":
            return buildExploratoryFlow(data as ExploratoryShapeData, landscape.modelCount);
        case "contextual":
            return buildContextualFlow(data as ContextualShapeData, landscape.modelCount);
        default:
            return "Flow not characterized for this pattern.\n";
    }
}

function buildSettledFlow(data: SettledShapeData, modelCount: number): string {
    let flow = `**Narrative Gravity:** Reasoning paths converge on ${data.floor.length} central claim(s).\n\n`;

    flow += `**The Centroid (${data.floorStrength} floor):**\n\n`;

    data.floor.forEach(c => {
        const contested = c.isContested ? " ⚠️" : "";
        flow += `• **${c.label}** [${c.supportCount}/${modelCount}]${contested}\n`;
        flow += `  ${c.text}\n\n`;
    });

    if (data.floorAssumptions && data.floorAssumptions.length > 0) {
        flow += `**What the centroid assumes:**\n`;
        data.floorAssumptions.forEach(a => {
            flow += `• ${a}\n`;
        });
        flow += `\n`;
    }

    return flow;
}

function buildContestedFlow(data: ContestedShapeData, modelCount: number): string {
    let flow = `**The Fault Line:** ${data.centralConflict.axis}\n\n`;

    if (data.centralConflict.type === "individual") {
        const cc = data.centralConflict;

        flow += `**Position A: ${cc.positionA.claim.label}** [${cc.positionA.claim.supportCount}/${modelCount}]\n`;
        flow += `${cc.positionA.claim.text}\n\n`;

        flow += `**Position B: ${cc.positionB.claim.label}** [${cc.positionB.claim.supportCount}/${modelCount}]\n`;
        flow += `${cc.positionB.claim.text}\n\n`;

        flow += `**Dynamics:** ${cc.dynamics === "symmetric" ? "Evenly matched" : "Asymmetric support"}\n\n`;
    } else {
        const cc = data.centralConflict;

        flow += `**Target Under Siege: ${cc.target.claim.label}** [${cc.target.claim.supportCount}/${modelCount}]\n`;
        flow += `${cc.target.claim.text}\n\n`;

        flow += `**Challengers (${cc.challengers.claims.length}):**\n`;
        cc.challengers.claims.forEach(c => {
            flow += `• **${c.label}** [${c.supportCount}/${modelCount}]: ${c.text}\n`;
        });
        flow += `\n`;
    }

    flow += `**Stakes:**\n`;
    if (data.centralConflict.type === "individual") {
        flow += `• Choosing A: ${data.centralConflict.stakes.choosingA}\n`;
        flow += `• Choosing B: ${data.centralConflict.stakes.choosingB}\n`;
    } else {
        flow += `• Accepting target: ${data.centralConflict.stakes.acceptingTarget}\n`;
        flow += `• Accepting challengers: ${data.centralConflict.stakes.acceptingChallengers}\n`;
    }
    flow += `\n`;

    return flow;
}

function buildKeystoneFlow(data: KeystoneShapeData, modelCount: number): string {
    const fragileMarker = data.keystone.isFragile ? " ⚠️ FRAGILE" : "";

    let flow = `**The Hub: ${data.keystone.label}** [${data.keystone.supportCount}/${modelCount}]${fragileMarker}\n`;
    flow += `${data.keystone.text}\n\n`;

    flow += `**Structural Position:**\n`;
    flow += `• Dominance: ${data.keystone.dominance.toFixed(1)}x more connected than next claim\n`;
    flow += `• Cascade size: ${data.cascadeSize} claims depend on this\n\n`;

    if (data.dependencies.length > 0) {
        flow += `**What flows from the hub:**\n`;
        data.dependencies.slice(0, 5).forEach(d => {
            flow += `• ${d.label} (${d.relationship})\n`;
        });
        if (data.dependencies.length > 5) {
            flow += `• ...and ${data.dependencies.length - 5} more\n`;
        }
        flow += `\n`;
    }

    return flow;
}

function buildLinearFlow(data: LinearShapeData, modelCount: number): string {
    let flow = `**The Sequence:** ${data.chainLength} steps\n\n`;

    data.chain.forEach((step, idx) => {
        const weakMarker = step.isWeakLink ? " ⚠️ WEAK LINK" : "";
        const arrow = idx < data.chain.length - 1 ? " →" : " (terminal)";

        flow += `**Step ${idx + 1}: ${step.label}** [${step.supportCount}/${modelCount}]${weakMarker}${arrow}\n`;
        flow += `${step.text}\n`;

        if (step.isWeakLink && step.weakReason) {
            flow += `*${step.weakReason}*\n`;
        }
        flow += `\n`;
    });

    return flow;
}

function buildTradeoffFlow(data: TradeoffShapeData, modelCount: number): string {
    let flow = `**Optimization Boundaries:** ${data.tradeoffs.length} detected\n\n`;

    data.tradeoffs.forEach((t, idx) => {
        flow += `### Tradeoff ${idx + 1}\n\n`;

        flow += `**Option A: ${t.optionA.label}** [${t.optionA.supportCount}/${modelCount}]\n`;
        flow += `${t.optionA.text}\n\n`;

        flow += `**Option B: ${t.optionB.label}** [${t.optionB.supportCount}/${modelCount}]\n`;
        flow += `${t.optionB.text}\n\n`;

        flow += `**Balance:** ${t.symmetry.replace("_", " ")}\n`;
        if (t.governingFactor) {
            flow += `**Governing factor:** ${t.governingFactor}\n`;
        }
        flow += `\n`;
    });

    if (data.dominatedOptions.length > 0) {
        flow += `**Dominated options (can be eliminated):**\n`;
        data.dominatedOptions.forEach(d => {
            flow += `• ${d.dominated} — dominated by ${d.dominatedBy}\n`;
        });
        flow += `\n`;
    }

    return flow;
}

function buildDimensionalFlow(data: DimensionalShapeData, modelCount: number): string {
    let flow = `**Independent Dimensions:** ${data.dimensions.length}\n\n`;

    if (data.dominantDimension) {
        const avgSupporters = modelCount > 0 ? Math.round(data.dominantDimension.avgSupport * modelCount) : null;
        flow += `### Primary Lens: ${data.dominantDimension.theme}\n`;
        flow += `${data.dominantDimension.claims.length} claims`;
        if (typeof avgSupporters === "number") {
            flow += `, avg support: ${avgSupporters}/${modelCount}`;
        }
        flow += `\n\n`;

        data.dominantDimension.claims.slice(0, 3).forEach(c => {
            flow += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
        });
        if (data.dominantDimension.claims.length > 3) {
            flow += `• ...and ${data.dominantDimension.claims.length - 3} more\n`;
        }
        flow += `\n`;
    }

    if (data.dimensions.length > 1) {
        flow += `**Other dimensions:**\n`;
        data.dimensions.slice(1).forEach(d => {
            flow += `• ${d.theme}: ${d.claims.length} claims\n`;
        });
        flow += `\n`;
    }

    const conflicts = data.interactions.filter(i => i.relationship === "conflicting");
    if (conflicts.length > 0) {
        flow += `**Dimension conflicts:** ${conflicts.length}\n`;
    }

    return flow;
}

function buildExploratoryFlow(data: ExploratoryShapeData, modelCount: number): string {
    const signalLabel = data.signalStrength < 0.35 ? "low" : data.signalStrength < 0.6 ? "medium" : "high";
    let flow = `**Signal Strength:** ${signalLabel} (sparse)\n\n`;

    if (data.strongestSignals.length > 0) {
        flow += `**Strongest signals:**\n\n`;
        data.strongestSignals.forEach(s => {
            flow += `• **${s.label}** [${s.supportCount}/${modelCount}] — ${s.reason}\n`;
            flow += `  ${s.text}\n\n`;
        });
    }

    if (data.looseClusters.length > 0) {
        flow += `**Loose clusters:**\n`;
        data.looseClusters.forEach(c => {
            const labels = c.claims.map(cl => cl.label).join(", ");
            flow += `• ${c.theme}: ${labels}\n`;
        });
        flow += `\n`;
    }

    if (data.sparsityReasons && data.sparsityReasons.length > 0) {
        flow += `**Why the structure is sparse:**\n`;
        data.sparsityReasons.forEach(r => {
            flow += `• ${r}\n`;
        });
        flow += `\n`;
    }

    return flow;
}

function buildContextualFlow(data: ContextualShapeData, modelCount: number): string {
    let flow = `**Governing Condition:** ${data.governingCondition}\n\n`;

    flow += `**Branches:**\n\n`;

    data.branches.forEach(branch => {
        flow += `### ${branch.condition}\n`;
        branch.claims.forEach(c => {
            flow += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
        });
        flow += `\n`;
    });

    if (data.defaultPath?.exists) {
        flow += `**Default path (highest support):**\n`;
        data.defaultPath.claims.forEach(c => {
            flow += `• ${c.label}\n`;
        });
        flow += `\n`;
    }

    return flow;
}

function buildFrictionSection(analysis: StructuralAnalysis): string {
    const { shape, landscape, claimsWithLeverage } = analysis;

    // Use composite shape if available (new system)
    if (shape.compositeShape) {
        return buildFrictionFromComposite(shape.compositeShape, claimsWithLeverage, landscape.modelCount);
    }

    // Fall back to legacy builders
    const data = shape.data;

    if (!data) return "Friction data not available.\n";

    switch (shape.primaryPattern) {
        case "settled":
            return buildSettledFriction(data as SettledShapeData, landscape.modelCount);
        case "contested":
            return buildContestedFriction(data as ContestedShapeData);
        case "keystone":
            return buildKeystoneFriction(data as KeystoneShapeData, landscape.modelCount);
        case "linear":
            return buildLinearFriction(data as LinearShapeData);
        case "tradeoff":
            return buildTradeoffFriction(data as TradeoffShapeData);
        case "dimensional":
            return buildDimensionalFriction(data as DimensionalShapeData, landscape.modelCount);
        case "exploratory":
            return buildExploratoryFriction(data as ExploratoryShapeData, landscape.modelCount);
        case "contextual":
            return buildContextualFriction(data as ContextualShapeData);
        default:
            return "Friction not characterized for this pattern.\n";
    }
}

function buildSettledFriction(data: SettledShapeData, modelCount: number): string {
    let friction = "";

    if (data.strongestOutlier) {
        const o = data.strongestOutlier;
        friction += `**The Minority Report:**\n\n`;
        friction += `**${o.claim.label}** [${o.claim.supportCount}/${modelCount}]\n`;
        friction += `${o.claim.text}\n\n`;
        friction += `• Structural role: ${o.structuralRole}\n`;
        friction += `• What it questions: ${o.whatItQuestions}\n\n`;
        friction += `*For the consensus to be correct, this minority view must be wrong. Is it?*\n\n`;
    } else if (data.challengers.length > 0) {
        friction += `**Explicit Challengers:**\n\n`;
        data.challengers.forEach(c => {
            friction += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
            friction += `  ${c.text}\n`;
            if (c.challenges) {
                friction += `  *Challenges: ${c.challenges}*\n`;
            }
            friction += `\n`;
        });
    } else {
        friction += `**No significant friction detected.**\n\n`;
        friction += `This is either genuine consensus OR a blind spot where all sources share the same gap.\n\n`;
    }

    if (data.blindSpots.length > 0) {
        friction += `**Unexplored areas (potential friction sources):**\n`;
        data.blindSpots.slice(0, 3).forEach(b => {
            friction += `• ${b}\n`;
        });
        friction += `\n`;
    }

    return friction;
}

function buildContestedFriction(data: ContestedShapeData): string {
    let friction = `**The friction IS the structure.** Both positions are the friction against each other.\n\n`;

    if (data.floor.exists && data.floor.claims.length > 0) {
        friction += `**Outside the conflict (potential common ground):**\n`;
        data.floor.claims.forEach(c => {
            friction += `• **${c.label}** [${c.supportCount}]\n`;
        });
        friction += `\n`;
    }

    if (data.secondaryConflicts.length > 0) {
        friction += `**Secondary conflicts:**\n`;
        data.secondaryConflicts.slice(0, 3).forEach(c => {
            friction += `• ${c.claimA.label} vs ${c.claimB.label}\n`;
        });
        friction += `\n`;
    }

    return friction;
}

function buildKeystoneFriction(data: KeystoneShapeData, modelCount: number): string {
    let friction = "";

    if (data.challengers.length > 0) {
        friction += `**Challengers to the hub:**\n\n`;
        data.challengers.forEach(c => {
            friction += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
            friction += `  ${c.text}\n\n`;
        });
    }

    if (data.decoupledClaims && data.decoupledClaims.length > 0) {
        friction += `**Decoupled claims (survive if hub fails):**\n\n`;
        data.decoupledClaims.forEach(c => {
            friction += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
            friction += `  Not connected to hub — ${c.independenceReason}\n\n`;
        });
    } else {
        friction += `**No decoupled claims found.** If the hub fails, the entire structure is compromised.\n\n`;
    }

    if (data.cascadeConsequences) {
        friction += `**If the hub is wrong:**\n`;
        friction += `• Directly affected: ${data.cascadeConsequences.directlyAffected} claims\n`;
        friction += `• Transitively affected: ${data.cascadeConsequences.transitivelyAffected} claims\n`;
        friction += `• Survives regardless: ${data.cascadeConsequences.survives} claims\n\n`;
    }

    return friction;
}

function buildLinearFriction(data: LinearShapeData): string {
    let friction = "";

    if (data.weakLinks.length > 0) {
        friction += `**Weak links in the chain:**\n\n`;
        data.weakLinks.forEach(wl => {
            friction += `• **Step ${wl.step.position + 1}: ${wl.step.label}**\n`;
            friction += `  Only ${wl.step.supportCount} supporter(s)\n`;
            friction += `  If this breaks: ${wl.cascadeSize} downstream step(s) fail\n\n`;
        });
    } else {
        friction += `**No weak links detected.** All steps have reasonable support.\n\n`;
    }

    if (data.shortcuts && data.shortcuts.length > 0) {
        friction += `**Potential shortcuts (steps might be bypassable):**\n\n`;
        data.shortcuts.forEach(s => {
            const skipsText = s.skips.length > 0 ? `Skips: ${s.skips.length} step(s)` : "";
            friction += `• ${s.from.label} → ${s.to.label} ${skipsText}\n`;
            friction += `  ${s.supportEvidence}\n\n`;
        });
    }

    if (data.chainFragility) {
        friction += `**Chain fragility:** ${data.chainFragility.weakLinkCount}/${data.chainFragility.totalSteps} steps are weak links\n\n`;
    }

    return friction;
}

function buildTradeoffFriction(data: TradeoffShapeData): string {
    let friction = `**There is no resolution to a true tradeoff.** `;
    friction += `Choosing means accepting the cost of what you did not choose.\n\n`;

    data.tradeoffs.forEach((t, idx) => {
        friction += `**Tradeoff ${idx + 1}:**\n`;
        friction += `• Choosing ${t.optionA.label} costs you: what ${t.optionB.label} provides\n`;
        friction += `• Choosing ${t.optionB.label} costs you: what ${t.optionA.label} provides\n\n`;
    });

    if (data.floor.length > 0) {
        friction += `**Unaffected by tradeoff:**\n`;
        data.floor.forEach(c => {
            friction += `• ${c.label}\n`;
        });
        friction += `\n`;
    }

    return friction;
}

function buildDimensionalFriction(data: DimensionalShapeData, modelCount: number): string {
    let friction = "";

    if (data.hiddenDimension) {
        friction += `**The Hidden Dimension: ${data.hiddenDimension.theme}**\n\n`;
        friction += `This perspective has ${data.hiddenDimension.claims.length} claim(s) but may be overlooked.\n\n`;

        data.hiddenDimension.claims.forEach(c => {
            friction += `• **${c.label}** [${c.supportCount}/${modelCount}]\n`;
        });
        friction += `\n`;
    }

    if (data.dominantBlindSpots && data.dominantBlindSpots.length > 0) {
        friction += `**What the primary lens may miss:**\n`;
        data.dominantBlindSpots.forEach(b => {
            friction += `• ${b}\n`;
        });
        friction += `\n`;
    }

    const conflicts = data.interactions.filter(i => i.relationship === "conflicting");
    if (conflicts.length > 0) {
        friction += `**Dimension conflicts:**\n`;
        conflicts.forEach(c => {
            const dimA = data.dimensions.find(d => d.id === c.dimensionA);
            const dimB = data.dimensions.find(d => d.id === c.dimensionB);
            friction += `• ${dimA?.theme} conflicts with ${dimB?.theme}\n`;
        });
        friction += `\n`;
    }

    return friction;
}

function buildExploratoryFriction(data: ExploratoryShapeData, modelCount: number): string {
    let friction = "";

    if (data.outerBoundary) {
        friction += `**The Outer Boundary:**\n\n`;
        friction += `**${data.outerBoundary.label}** [${data.outerBoundary.supportCount}/${modelCount}]\n`;
        friction += `${data.outerBoundary.text}\n`;
        friction += `*${data.outerBoundary.distanceReason}*\n\n`;
        friction += `This marks how far the unmapped territory extends.\n\n`;
    }

    if (data.isolatedClaims.length > 0) {
        friction += `**Isolated claims (no connections):**\n`;
        data.isolatedClaims.forEach(c => {
            friction += `• ${c.label}\n`;
        });
        friction += `\n`;
    }

    friction += `**The structure is sparse—this could mean:**\n`;
    friction += `• The question was ambiguous\n`;
    friction += `• The domain is genuinely underexplored\n`;
    friction += `• Structure exists but was not detected\n`;
    friction += `• Perspectives interpreted the question differently\n\n`;

    return friction;
}

function buildContextualFriction(data: ContextualShapeData): string {
    let friction = `**The friction is: which branch applies?**\n\n`;

    if (data.branches.length > 1) {
        const nonDefault = data.branches.filter(b =>
            !data.defaultPath?.claims.some(c => b.claims.some(bc => bc.id === c.id))
        );

        if (nonDefault.length > 0) {
            friction += `**The exceptions:**\n`;
            nonDefault.forEach(b => {
                friction += `• ${b.condition}\n`;
            });
            friction += `\n`;
        }
    }

    if (data.missingContext.length > 0) {
        friction += `**To resolve which branch applies, need to know:**\n`;
        data.missingContext.forEach(m => {
            friction += `• ${m}\n`;
        });
        friction += `\n`;
    }

    return friction;
}

function collectFragilities(analysis: StructuralAnalysis): string[] {
    const { patterns, graph, shape } = analysis;
    const fragilities: string[] = [];

    if (patterns.leverageInversions.length > 0) {
        fragilities.push(
            `${patterns.leverageInversions.length} claim(s) have low support but high structural importance`
        );
    }

    if (graph.articulationPoints.length > 0) {
        fragilities.push(
            `${graph.articulationPoints.length} bridge node(s) whose removal would disconnect the graph`
        );
    }

    if (shape.signalStrength && shape.signalStrength < 0.4) {
        fragilities.push(
            `Low signal strength — structure may not be reliable`
        );
    }

    if (shape.fragilityPenalty) {
        const fp = shape.fragilityPenalty;
        if (fp.lowSupportArticulations > 0) {
            fragilities.push(`${fp.lowSupportArticulations} fragile bridge(s) with low support`);
        }
        if (fp.conditionalConflicts > 0) {
            fragilities.push(`${fp.conditionalConflicts} hidden conflict(s) that may activate under conditions`);
        }
        if (fp.disconnectedConsensus) {
            fragilities.push(`High-support claims are not well connected to each other`);
        }
    }

    return fragilities;
}

function buildTransferSection(analysis: StructuralAnalysis): string {
    const { shape } = analysis;

    let transfer = "";

    // Use composite shape transfer question if available (prioritizes dissent for convergent shapes)
    const transferQuestion = shape.compositeShape?.transferQuestion ||
        getTransferQuestion(shape.primaryPattern, shape.data);

    transfer += `**The question this hands to you:**\n\n`;
    transfer += `${transferQuestion}\n\n`;

    const whatWouldHelp = getWhatWouldHelp(shape.primaryPattern, shape.data, analysis);
    if (whatWouldHelp.length > 0) {
        transfer += `**What would help:**\n`;
        whatWouldHelp.forEach(w => {
            transfer += `• ${w}\n`;
        });
        transfer += `\n`;
    }

    return transfer;
}

function getTransferQuestion(pattern: string, data: any): string {
    if (data?.transferQuestion) {
        return data.transferQuestion;
    }

    const defaults: Record<string, string> = {
        settled:
            "For the consensus to hold, what assumption must be true? Is it true in your situation?",
        contested:
            "Which constraint matters more to you? The choice determines the path.",
        keystone:
            "Is the foundation valid? Everything else depends on your answer.",
        linear:
            "Where are you in this sequence? Have you validated the early steps?",
        tradeoff:
            "What are you optimizing for? The system cannot maximize both.",
        dimensional:
            "Which dimension is most relevant to your situation?",
        exploratory:
            "What specific question would collapse this ambiguity?",
        contextual:
            "Which situation applies to you? The answer is conditional on your context.",
    };

    return defaults[pattern] || "What would help you navigate this?";
}

function getWhatWouldHelp(pattern: string, data: any, analysis: StructuralAnalysis): string[] {
    const helps: string[] = [];

    if (analysis.ghostAnalysis.count > 0) {
        helps.push(`Exploration of ${analysis.ghostAnalysis.count} unaddressed area(s)`);
    }

    switch (pattern) {
        case "settled":
            if (data?.strongestOutlier) {
                helps.push(`Your assessment of whether "${data.strongestOutlier.claim.label}" has merit`);
            }
            break;
        case "contested":
            if (data?.collapsingQuestion) {
                helps.push(`Your answer to: ${data.collapsingQuestion}`);
            }
            break;
        case "keystone":
            if (data?.keystone?.isFragile) {
                helps.push(`Validation of the fragile keystone: "${data.keystone.label}"`);
            }
            break;
        case "linear":
            if (data?.chainFragility?.mostVulnerableStep) {
                helps.push(
                    `Validation of weak link: "${data.chainFragility.mostVulnerableStep.step.label}"`
                );
            }
            break;
        case "exploratory":
            if (data?.clarifyingQuestions) {
                data.clarifyingQuestions.forEach((q: string) => helps.push(q));
            }
            break;
        case "contextual":
            if (data?.missingContext) {
                data.missingContext.forEach((m: string) =>
                    helps.push(`Your context: ${m}`)
                );
            }
            break;
    }

    return helps;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

function formatActiveWorkflow(workflow: ActiveWorkflow): string {
    let output = `**Goal:** ${workflow.goal}\n\n`;
    output += `**Progress:** Step ${workflow.currentStepIndex + 1} of ${workflow.steps.length}\n\n`;

    workflow.steps.forEach((step, idx) => {
        const statusIcon = step.status === 'complete' ? '✓' : step.status === 'active' ? '→' : '○';
        const current = idx === workflow.currentStepIndex ? ' **(current)**' : '';
        output += `${statusIcon} **${step.title}**${current}\n`;
        if (idx === workflow.currentStepIndex) {
            output += `   ${step.description}\n`;
            output += `   *Done when: ${step.doneWhen}*\n`;
        }
        output += '\n';
    });

    return output;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

export function buildConciergePrompt(
    userMessage: string,
    analysis: StructuralAnalysis,
    options?: ConciergePromptOptions
): string {
    const stance = options?.stance ?? 'default';
    const structuralBrief = buildStructuralBrief(analysis);
    const shapeGuidance = getShapeGuidance(analysis.shape);
    const stanceGuidance = getStanceGuidance(stance);

    const framingLine = stanceGuidance.framing
        ? `\n${stanceGuidance.framing}\n`
        : '';

    // Handoff V2: Prior context for fresh spawns after COMMIT or batch re-invoke
    const priorContextSection = options?.priorContext
        ? buildPriorContextSection(options.priorContext)
        : '';

    const historySection = options?.conversationHistory
        ? `## Conversation\n${options.conversationHistory}\n\n`
        : '';

    const workflowSection = options?.activeWorkflow
        ? `## Active Workflow\n${formatActiveWorkflow(options.activeWorkflow)}\n`
        : '';

    return `You are Singularity—an intelligence that has drawn from multiple expert perspectives.${framingLine}

## The Query

"${userMessage}"

${priorContextSection}${historySection}## What You Know

${structuralBrief}

${workflowSection}## How To Respond

${shapeGuidance}

${stanceGuidance.behavior}

## Voice

${stanceGuidance.voice}

## Never

- Reference "models," "analysis," "structure," "claims"
- Hedge without explaining what you're uncertain about
- Be vague when you have signal
- Say "it depends" without saying on what

Respond.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST-PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

const MACHINERY_SWAPS: Array<[RegExp, string]> = [
    [/\bthe models\b/gi, 'the experts'],
    [/\bmodels\b/gi, 'perspectives'],
    [/\baccording to (the )?analysis\b/gi, 'from what I see'],
    [/\bbased on (the )?(structural )?analysis\b/gi, 'from the evidence'],
    [/\bthe analysis (shows|indicates|suggests)\b/gi, 'the evidence $1'],
    [/\bconsensus\b/gi, 'agreement'],
    [/\bclaim_\d+\b/gi, ''],
    [/\bstructural(ly)?\b/gi, ''],
    [/\bhigh-support claim/gi, 'strong position'],
    [/\blow-support claim/gi, 'minority view'],
    [/\bthe structural brief\b/gi, 'what I know'],
    [/\bshape:\s*\w+/gi, ''],
];

export function postProcess(response: string): string {
    let out = response;
    MACHINERY_SWAPS.forEach(([pattern, replacement]) => {
        out = out.replace(pattern, replacement);
    });
    return out.replace(/\s{2,}/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAKAGE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export function detectMachineryLeakage(text: string): { leaked: boolean; violations: string[] } {
    const violations: string[] = [];
    const lower = text.toLowerCase();

    if (/claim_\d+/.test(text)) violations.push("raw_claim_id");
    if (/clustering_coefficient/.test(lower)) violations.push("raw_metric_name");
    if (/structural analysis/.test(lower)) violations.push("structural_analysis");
    if (/graph topology/.test(lower)) violations.push("graph_topology");
    if (/according to the model/.test(lower)) violations.push("model_reference");
    if (/based on the analysis/.test(lower)) violations.push("analysis_reference");

    const FORBIDDEN = [
        "structural brief",
        "shape: settled",
        "shape: contested",
        "shape: keystone",
        "shape: linear",
        "shape: tradeoff",
        "shape: dimensional",
        "shape: exploratory",
        "shape: contextual",
        "leverage inversion",
        "articulation point",
        "high-support claim",
        "low-support claim",
    ];

    FORBIDDEN.forEach(phrase => {
        if (lower.includes(phrase)) {
            violations.push(`phrase: ${phrase}`);
        }
    });

    return {
        leaked: violations.length > 0,
        violations
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// META QUERIES
// ═══════════════════════════════════════════════════════════════════════════

export function isMetaQuery(message: string): boolean {
    return [
        /how many (models|experts|sources|perspectives)/i,
        /what (models|sources)/i,
        /show (me )?(the )?(structure|map|graph)/i,
        /how (do|does) (you|this) work/i,
        /where (does|did) this come from/i,
        /explain your(self| reasoning)/i,
    ].some(p => p.test(message));
}

export function buildMetaResponse(analysis: StructuralAnalysis): string {
    const { landscape, patterns, shape, ghostAnalysis } = analysis;
    const highSupportCount = analysis.claimsWithLeverage.filter(c => c.isHighSupport).length;
    const tensionCount = patterns.conflicts.length + patterns.tradeoffs.length;

    return `I drew from ${landscape.modelCount} expert perspectives to form this view.

• **Pattern**: ${shape.primaryPattern} (${Math.round(shape.confidence * 100)}% confidence)
• **Strong positions**: ${highSupportCount}
• **Tensions**: ${tensionCount}
• **Gaps**: ${ghostAnalysis.count}

${shape.implications.action}

Want the full breakdown, or shall we continue?`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleTurn(
    userMessage: string,
    analysis: StructuralAnalysis,
    callLLM: (prompt: string) => Promise<string>,
    options?: {
        stanceOverride?: ConciergeStance;
        conversationHistory?: string;
        activeWorkflow?: ActiveWorkflow;
        isFirstTurn?: boolean;
    }
): Promise<HandleTurnResult> {

    // Handle meta queries
    if (isMetaQuery(userMessage)) {
        return {
            response: buildMetaResponse(analysis),
            stance: 'default',
            stanceReason: 'meta_query',
            signal: null
        };
    }

    // Select stance
    const selection = options?.stanceOverride
        ? { stance: options.stanceOverride, reason: 'user_override' as const, confidence: 1.0 }
        : selectStance(userMessage, analysis.shape);

    // Build and execute prompt
    const prompt = buildConciergePrompt(userMessage, analysis, {
        stance: selection.stance,
        conversationHistory: options?.conversationHistory,
        activeWorkflow: options?.activeWorkflow,
        isFirstTurn: options?.isFirstTurn,
    });
    const raw = await callLLM(prompt);

    // Parse output for signals
    const parsed = parseConciergeOutput(raw);

    // Post-process user-facing response
    const processed = postProcess(parsed.userResponse);

    // Check for leakage
    const leakage = detectMachineryLeakage(processed);
    if (leakage.leaked) {
        console.warn('[ConciergeService] Machinery leakage detected:', leakage.violations);
    }

    // Log signal and validate batch prompt if present
    if (parsed.signal) {
        console.log('[ConciergeService] Signal detected:', parsed.signal.type);
        const validation = validateBatchPrompt(parsed.signal.batchPrompt);
        if (!validation.valid) {
            console.warn('[ConciergeService] Batch prompt quality issues:', validation.issues);
        }
    }

    return {
        response: processed,
        stance: selection.stance,
        stanceReason: selection.reason,
        signal: parsed.signal
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export const ConciergeService = {
    selectStance,
    buildConciergePrompt,
    buildStructuralBrief,
    postProcess,
    detectMachineryLeakage,
    isMetaQuery,
    buildMetaResponse,
    handleTurn,
    // Re-export signal parsing for convenience
    parseConciergeOutput,
    validateBatchPrompt,
    // Handoff V2
    HANDOFF_PROTOCOL,
    buildTurn2Message,
    buildTurn3PlusMessage,
};
