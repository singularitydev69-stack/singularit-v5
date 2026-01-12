import React, { useMemo, useEffect, useState } from 'react';
import { AiTurn } from '../../types';
import { useModeSwitching } from '../../hooks/cognitive/useModeSwitching';
import SingularityOutputView from './SingularityOutputView';
import { SingularityOutputState } from '../../hooks/useSingularityOutput';
import { CouncilOrbs } from '../CouncilOrbs';
import { LLM_PROVIDERS_CONFIG } from '../../constants';
import { useAtomValue, useSetAtom } from 'jotai';
import { selectedModelsAtom, workflowProgressForTurnFamily, activeSplitPanelAtom, isDecisionMapOpenAtom } from '../../state/atoms';
import { parseUnifiedMapperOutput } from '../../../shared/parsing-utils';
import { getLatestResponse } from '../../utils/turn-helpers';
import { getProviderName } from '../../utils/provider-helpers';
import MarkdownDisplay from '../MarkdownDisplay';
import { CopyButton } from '../CopyButton';
import { MetricsRibbon } from './MetricsRibbon';
import StructureGlyph from '../StructureGlyph';
import { computeProblemStructureFromArtifact, computeStructuralAnalysis } from '../../../src/core/PromptMethods';
import { MapperArtifact } from '../../../shared/contract';

interface CognitiveOutputRendererProps {
    aiTurn: AiTurn;
    singularityState: SingularityOutputState;
    onArtifactSelect?: (artifact: { title: string; identifier: string; content: string }) => void;
}

/**
 * Orchestrates the Singularity Response Flow:
 * 1. Batch Streaming: Orbs showing progress
 * 2. Mapper Ready: MetricsRibbon + StructureGlyph + Landscape Narrative appear
 * 3. Concierge Ready: Singularity response crowns the view
 */
export const CognitiveOutputRenderer: React.FC<CognitiveOutputRendererProps> = ({
    aiTurn,
    singularityState,
    onArtifactSelect
}) => {
    const {
        activeMode,
        setActiveMode: setActiveModeInternal,
        triggerAndSwitch,
        isTransitioning
    } = useModeSwitching(aiTurn.id);

    const selectedModels = useAtomValue(selectedModelsAtom);
    const workflowProgress = useAtomValue(workflowProgressForTurnFamily(aiTurn.id));
    const setActiveSplitPanel = useSetAtom(activeSplitPanelAtom);
    const setIsDecisionMapOpen = useSetAtom(isDecisionMapOpenAtom);

    const hasSingularityOutput = !!(
        singularityState.output ||
        aiTurn.singularityOutput ||
        (aiTurn.singularityResponses && Object.keys(aiTurn.singularityResponses).length > 0)
    );

    const [hasAutoSwitched, setHasAutoSwitched] = useState(false);
    const [hasUserOverride, setHasUserOverride] = useState(false);
    const [isOrbTrayExpanded, setIsOrbTrayExpanded] = useState(false);

    const setActiveMode = (mode: any) => {
        setHasUserOverride(true);
        setActiveModeInternal(mode);
    };

    useEffect(() => {
        if (!hasSingularityOutput || hasAutoSwitched || hasUserOverride) return;
        if (activeMode !== 'singularity') {
            setActiveModeInternal('singularity');
        }
        setHasAutoSwitched(true);
    }, [hasSingularityOutput, hasAutoSwitched, hasUserOverride, activeMode, setActiveModeInternal]);

    // Get mapper data
    const activeMapperPid = useMemo(() => {
        if (aiTurn.meta?.mapper) return aiTurn.meta.mapper;
        const keys = Object.keys(aiTurn.mappingResponses || {});
        return keys.length > 0 ? keys[0] : null;
    }, [aiTurn.meta?.mapper, aiTurn.mappingResponses]);

    const latestMapping = useMemo(() => {
        if (!activeMapperPid) return null;
        return getLatestResponse((aiTurn.mappingResponses || {})[activeMapperPid]);
    }, [aiTurn.mappingResponses, activeMapperPid]);

    const mapperNarrative = useMemo(() => {
        const fromMeta = String((latestMapping?.meta as any)?.rawMappingText || "");
        const fromText = String(latestMapping?.text || "");
        const raw = fromMeta && fromMeta.length >= fromText.length ? fromMeta : fromText;
        const parsed = parseUnifiedMapperOutput(raw);
        return parsed.narrative || "";
    }, [latestMapping]);

    const mapperProviderName = useMemo(() => {
        return activeMapperPid ? getProviderName(activeMapperPid) : "";
    }, [activeMapperPid]);

    // Visible providers for orbs
    const visibleProviderIds = useMemo(() => {
        const keys = Object.keys(aiTurn?.batchResponses || {});
        if (keys.length > 0) return keys;
        return LLM_PROVIDERS_CONFIG.filter(p => !!selectedModels?.[p.id]).map(p => p.id);
    }, [aiTurn, selectedModels]);

    const orbProviderIds = useMemo(() => {
        const ids = [
            ...visibleProviderIds,
            ...(activeMapperPid ? [String(activeMapperPid)] : []),
        ].filter(Boolean).map(String);
        return Array.from(new Set(ids));
    }, [activeMapperPid, visibleProviderIds]);

    const orbVoiceProviderId = useMemo(() => {
        const fromMeta = activeMapperPid ? String(activeMapperPid) : null;
        if (fromMeta) return fromMeta;
        const fromMapping = Object.keys(aiTurn.mappingResponses || {})[0];
        if (fromMapping) return String(fromMapping);
        return orbProviderIds[0] ? String(orbProviderIds[0]) : null;
    }, [activeMapperPid, aiTurn.mappingResponses, orbProviderIds]);

    const isWorkflowSettled = useMemo(() => {
        const states = Object.values(workflowProgress || {});
        if (states.length === 0) return false;
        return states.every((p: any) => {
            const stage = String(p?.stage || 'idle');
            return stage === 'idle' || stage === 'complete';
        });
    }, [workflowProgress]);

    // Compute structural analysis
    const structuralAnalysis = useMemo(() => {
        if (!aiTurn.mapperArtifact) return undefined;
        try {
            return computeStructuralAnalysis(aiTurn.mapperArtifact as MapperArtifact);
        } catch (e) {
            return undefined;
        }
    }, [aiTurn.mapperArtifact]);

    const problemStructure = useMemo(() => {
        if (!aiTurn.mapperArtifact) return undefined;
        try {
            return computeProblemStructureFromArtifact(aiTurn.mapperArtifact as MapperArtifact);
        } catch {
            return undefined;
        }
    }, [aiTurn.mapperArtifact]);

    const isStreaming = Object.values(workflowProgress).some(
        p => p.stage === 'thinking' || p.stage === 'streaming'
    );

    const showSingularity = hasSingularityOutput && activeMode === 'singularity';

    return (
        <div className="w-full max-w-3xl mx-auto animate-in fade-in duration-500">
            {/* === UNIFIED HEADER (Toggle + Orbs + Metrics) === */}
            <div className="flex flex-col gap-6 mb-8">
                {/* View Toggle */}
                {hasSingularityOutput && (
                    <div className="flex justify-center">
                        <button
                            onClick={() => setActiveMode(showSingularity ? 'artifact' : 'singularity')}
                            className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-raised border border-border-subtle hover:bg-surface-highlight text-sm font-medium text-text-secondary transition-all shadow-sm"
                        >
                            <span>{showSingularity ? '🗺️' : '✨'}</span>
                            <span>{showSingularity ? 'See Analysis' : 'Back to Response'}</span>
                        </button>
                    </div>
                )}

                {/* Council Orbs */}
                <div className="flex justify-center">
                    <div
                        onMouseEnter={() => setIsOrbTrayExpanded(true)}
                        onMouseLeave={() => setIsOrbTrayExpanded(false)}
                        className="transition-all duration-200"
                    >
                        <CouncilOrbs
                            providers={LLM_PROVIDERS_CONFIG}
                            turnId={aiTurn.id}
                            voiceProviderId={orbVoiceProviderId}
                            visibleProviderIds={
                                !isStreaming && isWorkflowSettled && !isOrbTrayExpanded
                                    ? (orbVoiceProviderId ? [String(orbVoiceProviderId)] : [])
                                    : orbProviderIds
                            }
                            variant={isStreaming ? "active" : "historical"}
                            workflowProgress={workflowProgress}
                            onOrbClick={(pid) => {
                                setActiveSplitPanel({ turnId: aiTurn.id, providerId: pid });
                                singularityState.setPinnedProvider(pid);
                            }}
                        />
                    </div>
                </div>

                {/* Structural Summary (Ribbon + Glyph) */}
                {structuralAnalysis && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-500">
                        <MetricsRibbon
                            artifact={aiTurn.mapperArtifact}
                            analysis={structuralAnalysis}
                            problemStructure={problemStructure}
                        />

                        {problemStructure && (
                            <div className="flex justify-center p-4 bg-surface-raised/30 rounded-xl border border-border-subtle/50">
                                <div className="flex flex-col items-center gap-2">
                                    <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">
                                        Structural Topology
                                    </div>
                                    <StructureGlyph
                                        pattern={problemStructure.primaryPattern}
                                        claimCount={aiTurn.mapperArtifact?.claims?.length || 0}
                                        width={320}
                                        height={140}
                                        onClick={() => setIsDecisionMapOpen({ turnId: aiTurn.id })}
                                    />
                                    <div className="text-[11px] text-text-muted italic">
                                        {problemStructure.confidence > 0.7
                                            ? `High confidence ${problemStructure.primaryPattern} pattern detected`
                                            : `Emerging ${problemStructure.primaryPattern} structure`}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* === MAIN CONTENT AREA === */}
            {showSingularity ? (
                <SingularityOutputView
                    aiTurn={aiTurn}
                    singularityState={singularityState}
                    onRecompute={triggerAndSwitch}
                    isLoading={isTransitioning}
                />
            ) : (
                /* === INTERIM / ANALYSIS BUBBLE === */
                <div className="animate-in fade-in duration-500">
                    {mapperNarrative ? (
                        <div className="bg-surface border border-border-subtle rounded-2xl overflow-hidden shadow-sm">
                            <div className="px-4 py-3 border-b border-border-subtle bg-surface-highlight/10 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="text-lg">📖</span>
                                    <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                                        The Landscape
                                    </span>
                                    {mapperProviderName && (
                                        <span className="text-[11px] text-text-tertiary">
                                            via {mapperProviderName}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <CopyButton
                                        text={mapperNarrative}
                                        label="Copy mapper narrative"
                                        variant="icon"
                                    />
                                    {aiTurn.mapperArtifact && onArtifactSelect && (
                                        <button
                                            onClick={() => onArtifactSelect({
                                                title: "Mapper Artifact",
                                                identifier: `artifact-${aiTurn.id}`,
                                                content: JSON.stringify(aiTurn.mapperArtifact, null, 2)
                                            })}
                                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-raised hover:bg-surface-highlight border border-border-subtle text-xs text-text-secondary transition-colors"
                                            title="View Artifact"
                                        >
                                            <span>📄</span>
                                            <span>Artifact</span>
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setIsDecisionMapOpen({ turnId: aiTurn.id })}
                                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-raised hover:bg-surface-highlight border border-border-subtle text-xs text-text-secondary transition-colors"
                                        title="Open Decision Map"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                                            <line x1="3" x2="21" y1="9" y2="9" />
                                            <line x1="9" x2="9" y1="21" y2="9" />
                                        </svg>
                                        <span>Map</span>
                                    </button>
                                </div>
                            </div>
                            <div className="px-6 py-6 md:px-8 text-sm text-text-muted leading-relaxed font-serif">
                                <MarkdownDisplay content={mapperNarrative} />
                            </div>
                        </div>
                    ) : isStreaming ? (
                        <div className="flex flex-col items-center justify-center p-12 bg-surface-highlight/10 rounded-xl border border-dashed border-border-subtle">
                            <div className="text-3xl mb-4 animate-pulse">🧩</div>
                            <div className="text-text-secondary font-medium">
                                Gathering perspectives...
                            </div>
                            <div className="text-xs text-text-muted mt-2 text-center">
                                Experts are deliberating. Analysis will appear shortly.
                            </div>
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
};
