import React, { useState, useMemo, useRef, useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { providerEffectiveStateFamily, isSplitOpenAtom, mappingProviderAtom, providerAuthStatusAtom, selectedModelsAtom, singularityProviderAtom, providerLocksAtom } from "../state/atoms";
import { LLMProvider } from "../types";
import { PROVIDER_ACCENT_COLORS, WORKFLOW_STAGE_COLORS } from "../constants";
import { getProviderColor, getProviderLogo } from "../utils/provider-helpers";
import { setProviderLock } from "@shared/provider-locks";
import clsx from "clsx";

interface CouncilOrbsProps {
    turnId?: string; // Optional for active mode
    providers: LLMProvider[];
    voiceProviderId: string | null; // The active synthesizer (Crown)
    onOrbClick?: (providerId: string) => void;
    onCrownMove?: (providerId: string) => void;
    onTrayExpand?: () => void;
    isTrayExpanded?: boolean;
    visibleProviderIds?: string[]; // Optional filter for visible orbs
    variant?: "tray" | "divider" | "welcome" | "historical" | "active";
    isEditMode?: boolean; // When true, auto-open the model selection menu
    isSingularityMode?: boolean;
    // New: per-provider workflow progress (providerId -> { stage, progress })
    workflowProgress?: Record<string, { stage: WorkflowStage; progress?: number }>;
    // New: collapsed state (only show active/crown orb, expand on hover)
    collapsed?: boolean;
}

// Workflow stage type for progress indicator used by Orbs
export type WorkflowStage =
    | 'idle'
    | 'thinking'
    | 'streaming'
    | 'complete'
    | 'error';

export const CouncilOrbs: React.FC<CouncilOrbsProps> = React.memo(({
    turnId,
    providers,
    voiceProviderId,
    onOrbClick,
    onCrownMove,
    isTrayExpanded,
    variant = "tray",
    visibleProviderIds,
    isEditMode = false,
    workflowProgress = {},
    isSingularityMode = false,
    collapsed = false, // Default to expanded
}) => {
    const [hoveredOrb, setHoveredOrb] = useState<string | null>(null);
    const [isCrownMode, setIsCrownMode] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    // Internal state for hover-expansion when collapsed
    const [isExpanded, setIsExpanded] = useState(false);

    const longPressRef = useRef<any>(null);
    const isSplitOpen = useAtomValue(isSplitOpenAtom);
    const authStatus = useAtomValue(providerAuthStatusAtom);
    const [mapProviderVal, setMapProvider] = useAtom(mappingProviderAtom);
    const [selectedModels, setSelectedModels] = useAtom(selectedModelsAtom);
    const [singularityProvider, setSingularityProvider] = useAtom(singularityProviderAtom);
    const setLocks = useSetAtom(providerLocksAtom);
    const containerRef = useRef<HTMLDivElement>(null);

    // Click Outside Listener
    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (isMenuOpen && containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsMenuOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isMenuOpen]);

    // Auto-open menu when isEditMode becomes true
    React.useEffect(() => {
        if (variant === 'active') return;

        if (isEditMode) {
            setIsMenuOpen(true);

        } else {
            setIsMenuOpen(false);

        }
    }, [isEditMode, voiceProviderId, variant]);

    // Filter out system provider if present
    const allProviders = useMemo(() => {
        return providers.filter(p => p.id !== 'system');
    }, [providers]);

    // displayProviders is used for orbs - can be filtered by visibleProviderIds
    const displayProviders = useMemo(() => {
        let filtered = allProviders;
        if (visibleProviderIds) {
            filtered = filtered.filter(p => visibleProviderIds.includes(String(p.id)));
        }
        return filtered;
    }, [allProviders, visibleProviderIds]);

    const handleOrbClickInternal = (e: React.MouseEvent, providerId: string) => {
        e.stopPropagation();

        // If a turnId is provided, we treat this as an interaction with a specific turn step.
        // Clicks should open the response panel OR move the crown (if in crown mode).
        // They should NOT toggle the global model selection (which is the fallback for the config tray).
        if (turnId) {
            if (isCrownMode && onCrownMove) {
                onCrownMove(providerId);
                setIsCrownMode(false);
            } else if (onOrbClick) {
                onOrbClick(providerId);
            }
            return;
        }

        // --- GLOBAL CONFIGURATION TRAY BEHAVIOR (no turnId) ---
        if (variant === "active") {
            // Toggle witness
            const isUnauthorized = authStatus && authStatus[providerId] === false;
            if (isUnauthorized) return;

            if (isCrownMode) {
                // Changing Crown
                if (onCrownMove) {
                    onCrownMove(providerId);
                    setIsCrownMode(false);
                }
            } else {
                // Toggling Witness
                const isSelected = !!selectedModels[providerId];
                setSelectedModels((prev: Record<string, boolean>) => ({ ...prev, [providerId]: !isSelected }));
            }
        } else {
            // Tray/Historical/etc. without turnId
            if (isCrownMode && onCrownMove) {
                onCrownMove(providerId);
                setIsCrownMode(false);
            } else if (onOrbClick) {
                onOrbClick(providerId);
            }
        }
    };

    const handleCrownClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (variant === "historical") return; // No crown interaction for historical
        setIsCrownMode(!isCrownMode);
    };

    // Determine if this should be dimmed (historical variant when split is open)
    const shouldDim = variant === "historical" && isSplitOpen;

    // Priority ranking for orb placement (closest to voice = highest priority)
    const PRIORITY_ORDER = ['claude', 'gemini-exp', 'qwen', 'gemini-pro', 'chatgpt', 'gemini'];

    const getPriority = (providerId: string) => {
        const index = PRIORITY_ORDER.indexOf(providerId);
        return index === -1 ? 999 : index; // Unknown providers go to the end
    };

    // Separate voice and non-voice providers
    const voiceProviderObj = displayProviders.find(p => String(p.id) === voiceProviderId);

    // For 'active' mode, if the voice provider is not in the display list (shouldn't happen if all are shown), find it in allProviders
    const activeVoiceObj = voiceProviderObj || (variant === "active" ? allProviders.find(p => String(p.id) === voiceProviderId) : undefined);

    const otherProviders = displayProviders
        .filter(p => String(p.id) !== voiceProviderId)
        .sort((a, b) => getPriority(String(a.id)) - getPriority(String(b.id)));

    // Distribute alternating left/right with highest priority closest to voice
    const leftOrbs: LLMProvider[] = [];
    const rightOrbs: LLMProvider[] = [];

    otherProviders.forEach((provider, index) => {
        if (index % 2 === 0) {
            rightOrbs.push(provider);
        } else {
            leftOrbs.push(provider);
        }
    });

    leftOrbs.reverse();

    const shouldDimInSplitMode = isSplitOpen && variant === "tray";

    const handleLongPressStart = (_pid: string | null) => {
        if (variant === "historical") return; // Disable menu for historical

        if (longPressRef.current) clearTimeout(longPressRef.current);
        longPressRef.current = setTimeout(() => {

            setIsMenuOpen(true);
        }, 500);
    };

    const handleLongPressCancel = () => {
        if (longPressRef.current) {
            clearTimeout(longPressRef.current);
            longPressRef.current = null;
        }
    };



    const handleSelectMap = (pid: string) => {
        if (mapProviderVal === pid) {
            setMapProvider(null);
            setProviderLock('mapping', true);
            setLocks(prev => ({ ...prev, mapping: true }));
        } else {
            setMapProvider(pid);
            setProviderLock('mapping', true);
            setLocks(prev => ({ ...prev, mapping: true }));
        }
    };


    const handleSelectSingularity = (pid: string) => {
        if (singularityProvider === pid) {
            setSingularityProvider(null);
            setProviderLock('singularity', true);
            setLocks(prev => ({ ...prev, singularity: true }));
        } else {
            setSingularityProvider(pid);
            setProviderLock('singularity', true);
            setLocks(prev => ({ ...prev, singularity: true }));
        }
    };


    return (
        <div
            className={clsx(
                "council-tray-container relative transition-all duration-300 ease-out",
                isTrayExpanded ? "opacity-0 pointer-events-none h-0 overflow-hidden" : "opacity-100",
                variant === "tray" && "council-tray",
                variant === "divider" && "council-divider",
                variant === "historical" && "council-historical",
                variant === "active" && "council-active w-full flex justify-center py-0 px-4 !bg-transparent !shadow-none !border-none",
                shouldDim && "council-historical-dimmed",
                shouldDimInSplitMode && "council-tray-dimmed-split"
            )}
            onMouseDown={() => handleLongPressStart(null)}
            onMouseUp={handleLongPressCancel}
            onMouseLeave={(e) => {
                handleLongPressCancel();
                if (collapsed) setIsExpanded(false);
            }}
            onMouseEnter={(e) => {
                if (collapsed) setIsExpanded(true);
            }}
            ref={containerRef}
            style={variant === "active" ? { pointerEvents: "auto" } : undefined}
        >
            {/* Orb bar with centered voice and fanned others */}
            {/* Active variant gets a glass-morphic container for visual separation */}
            <div className={clsx(
                "council-orb-bar flex items-center justify-center relative transition-all duration-300",
                variant === "active" && "council-orb-bar--active",
                // Collapsed state logic: hide left/right groups if collapsed and not hovered
                collapsed && !isExpanded && "council-orb-bar--collapsed"
            )}>
                {/* Left side orbs - Hide if collapsed */}
                <div className={clsx(
                    "council-orb-group council-orb-group--left transition-all duration-300",
                    collapsed && !isExpanded && "opacity-0 -translate-x-4 pointer-events-none scale-90"
                )}>
                    {leftOrbs.map((p) => {
                        const pid = String(p.id);
                        return (
                            <Orb
                                key={pid}
                                turnId={turnId || ""}
                                provider={p}
                                isVoice={false}
                                isCrownMode={isCrownMode}
                                onHover={setHoveredOrb}
                                onClick={(e) => handleOrbClickInternal(e, pid)}
                                onCrownClick={handleCrownClick}
                                hoveredOrb={hoveredOrb}
                                variant={variant as any}
                                disabled={authStatus && authStatus[pid] === false}
                                isSelected={variant === "active" ? !!selectedModels[pid] : undefined}
                                onLongPressStart={() => handleLongPressStart(pid)}
                                onLongPressCancel={handleLongPressCancel}
                                workflowStage={workflowProgress[pid]?.stage}
                                workflowProgress={workflowProgress[pid]?.progress}
                                isDimmed={isSingularityMode}
                            />
                        );
                    })}
                </div>

                {/* CENTER: Voice Orb */}
                <div
                    className={clsx(
                        "council-voice-zone"
                    )}
                >
                    {variant !== "active" && <div className="council-glass-ring" />}

                    {activeVoiceObj && (
                        <Orb
                            key={String(activeVoiceObj.id)}
                            turnId={turnId || ""}
                            provider={activeVoiceObj}
                            isVoice={true}
                            showCrown={true}
                            isCrownMode={isCrownMode}
                            onHover={setHoveredOrb}
                            onClick={(e) => {
                                e.stopPropagation();
                                handleOrbClickInternal(e, String(activeVoiceObj.id));
                            }}
                            onCrownClick={handleCrownClick}
                            hoveredOrb={hoveredOrb}
                            variant={variant as any}
                            disabled={authStatus && authStatus[String(activeVoiceObj.id)] === false}
                            isSelected={variant === "active" ? !!selectedModels[String(activeVoiceObj.id)] : undefined}
                            workflowStage={workflowProgress[String(activeVoiceObj.id)]?.stage}
                            workflowProgress={workflowProgress[String(activeVoiceObj.id)]?.progress}
                        />
                    )}
                </div>

                {/* Right side orbs - Hide if collapsed */}
                <div className={clsx(
                    "council-orb-group council-orb-group--right transition-all duration-300",
                    collapsed && !isExpanded && "opacity-0 translate-x-4 pointer-events-none scale-90"
                )}>
                    {rightOrbs.map((p) => {
                        const pid = String(p.id);
                        return (
                            <Orb
                                key={pid}
                                turnId={turnId || ""}
                                provider={p}
                                isVoice={false}
                                isCrownMode={isCrownMode}
                                onHover={setHoveredOrb}
                                onClick={(e) => handleOrbClickInternal(e, pid)}
                                onCrownClick={handleCrownClick}
                                hoveredOrb={hoveredOrb}
                                variant={variant as any}
                                disabled={authStatus && authStatus[pid] === false}
                                isSelected={variant === "active" ? !!selectedModels[pid] : undefined}
                                onLongPressStart={() => handleLongPressStart(pid)}
                                onLongPressCancel={handleLongPressCancel}
                                workflowStage={workflowProgress[pid]?.stage}
                                workflowProgress={workflowProgress[pid]?.progress}
                                isDimmed={isSingularityMode}
                            />
                        );
                    })}
                </div>

                {/* Settings Button for Active Mode - positioned at far right edge */}
                {variant === "active" && (
                    <div className="absolute right-[-140px] top-1/2 -translate-y-1/2">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsMenuOpen(!isMenuOpen);
                            }}
                            className="bg-surface-raised hover:bg-surface-highlight border border-border-subtle rounded-full p-2 text-text-muted hover:text-text-primary transition-all shadow-sm"
                            title="Configure Council"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>

            {/* Crown Mode Indicator */}
            {isCrownMode && (
                <div className="council-crown-indicator">Select new voice</div>
            )}

            {isMenuOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 bottom-[110%] bg-surface-raised border border-border-subtle rounded-xl shadow-elevated p-3 z-[100] min-w-[500px] w-max max-w-[90vw]">
                    <div className="text-xs text-text-muted mb-2">Council Menu</div>
                    <div className="grid grid-cols-2 gap-4">


                        {/* Mapper Dropdown */}
                        <div>
                            <div className="flex items-center gap-2 mb-2 text-sm"><span>🧩</span><span>Mapper</span></div>
                            <select
                                value={mapProviderVal || ""}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val === "") {
                                        setMapProvider(null);
                                        setProviderLock('mapping', true);
                                        setLocks(prev => ({ ...prev, mapping: true }));
                                    } else {
                                        handleSelectMap(val);
                                    }
                                }}
                                className="w-full bg-chip border border-border-subtle rounded-md px-2 py-1.5 text-xs text-text-primary outline-none focus:border-brand-500 transition-colors"
                            >
                                <option value="">None</option>
                                {allProviders.map(p => {
                                    const pid = String(p.id);
                                    const isUnauthorized = authStatus && authStatus[pid] === false;
                                    return (
                                        <option key={`m-${pid}`} value={pid} disabled={isUnauthorized}>
                                            {p.name} {isUnauthorized ? "(Locked)" : ""}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>



                        <div>
                            <div className="flex items-center gap-2 mb-2 text-sm"><span>🕳️</span><span>Singularity</span></div>
                            <select
                                value={singularityProvider || ""}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val === "") {
                                        setSingularityProvider(null);
                                        setProviderLock('singularity', true);
                                        setLocks(prev => ({ ...prev, singularity: true }));
                                    } else {
                                        handleSelectSingularity(val);
                                    }
                                }}
                                className="w-full bg-chip border border-border-subtle rounded-md px-2 py-1.5 text-xs text-text-primary outline-none focus:border-brand-500 transition-colors"
                            >
                                <option value="">None</option>
                                {allProviders.map(p => {
                                    const pid = String(p.id);
                                    const isUnauthorized = authStatus && authStatus[pid] === false;
                                    return (
                                        <option key={`s-${pid}`} value={pid} disabled={isUnauthorized}>
                                            {p.name} {isUnauthorized ? "(Locked)" : ""}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>

                        {/* Witness Section - Full Width */}
                        <div className="col-span-2">
                            <div className="flex items-center gap-2 mb-2 text-sm"><span>👁️</span><span>Witness</span></div>
                            <div className="flex flex-wrap gap-2">
                                {allProviders.map(p => {
                                    const pid = String(p.id);
                                    const checked = !!selectedModels?.[pid];
                                    const isUnauthorized = authStatus && authStatus[pid] === false;
                                    return (
                                        <button
                                            key={`w-${pid}`}
                                            onClick={() => !isUnauthorized && setSelectedModels((prev: any) => ({ ...(prev || {}), [pid]: !checked }))}
                                            disabled={isUnauthorized}
                                            className={clsx("px-2 py-1 rounded-md text-xs border transition-colors",
                                                checked ? "bg-brand-500/15 border-brand-500 text-text-primary" : "bg-chip border-border-subtle text-text-secondary hover:bg-surface-highlight",
                                                isUnauthorized && "opacity-50 cursor-not-allowed hover:bg-chip"
                                            )}
                                            title={isUnauthorized ? `Login required for ${p.name}` : undefined}
                                        >
                                            {p.name} {checked ? "✓" : ""} {isUnauthorized ? "🔒" : ""}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end mt-3">
                        <button onClick={() => setIsMenuOpen(false)} className="px-3 py-1.5 text-xs rounded-md bg-surface-highlight hover:bg-surface-raised border border-border-subtle text-text-secondary transition-colors">Close</button>
                    </div>
                </div>
            )}
        </div>
    );
});

interface OrbProps {
    turnId: string;
    provider: LLMProvider;
    isVoice: boolean;
    showCrown?: boolean;
    isCrownMode: boolean;
    onHover: (id: string | null) => void;
    onClick: (e: React.MouseEvent) => void;
    onCrownClick: (e: React.MouseEvent) => void;
    hoveredOrb: string | null;
    variant?: "tray" | "divider" | "historical" | "welcome" | "active";
    onLongPressStart?: () => void;
    onLongPressCancel?: () => void;
    disabled?: boolean;
    isSelected?: boolean;
    // Workflow progress (optional)
    workflowStage?: WorkflowStage;
    workflowProgress?: number; // 0-100
    isDimmed?: boolean;
}

const Orb: React.FC<OrbProps> = ({
    turnId,
    provider,
    isVoice,
    showCrown = true,
    isCrownMode,
    onHover,
    onClick,
    onCrownClick,
    hoveredOrb,
    variant = "tray",
    onLongPressStart,
    onLongPressCancel,
    disabled = false,
    isSelected,
    workflowStage = 'idle',
    workflowProgress = 0,
    isDimmed = false,
}) => {
    const pid = String(provider.id);
    const state = useAtomValue(providerEffectiveStateFamily({ turnId, providerId: pid }));

    // For active variant, we don't use turn state status, we use selection state
    const isStreaming = variant !== "active" && state.latestResponse?.status === 'streaming';
    const hasError = variant !== "active" && (
        state.latestResponse?.status === 'error' ||
        (state.latestResponse?.status as any) === 'failed' ||
        (state.latestResponse?.status as any) === 'skipped'
    );
    const isHovered = hoveredOrb === pid;

    // Get colors and logo
    const primaryColor = getProviderColor(pid);
    const accentColor = PROVIDER_ACCENT_COLORS[pid] || PROVIDER_ACCENT_COLORS['default'];
    const stageColor = WORKFLOW_STAGE_COLORS[workflowStage] || WORKFLOW_STAGE_COLORS.idle;
    const logoSrc = getProviderLogo(pid) || '';

    // Active variant styling logic
    const isActiveVariant = variant === "active";
    const showAsActive = isActiveVariant ? isSelected : true; // In active mode, dim if not selected

    // In historical mode, it's always "active" because we filter list upstream vs "active" mode where we show all

    // Progress ring geometry for workflow progress
    const circumference = 2 * Math.PI * 18; // r=18
    const progressOffset = circumference - (workflowProgress / 100) * circumference;

    // Track stage transitions for per-orb animations
    const prevStageRef = useRef<WorkflowStage>(workflowStage);
    const [animationClass, setAnimationClass] = useState<string>('');

    const rotation = useMemo(() => Math.random() * 360, []);

    useEffect(() => {
        const prevStage = prevStageRef.current;

        // Detect "start streaming" transition
        if (prevStage !== 'streaming' && workflowStage === 'streaming') {
            setAnimationClass('council-orb--start-pulse');
            const timer = setTimeout(() => setAnimationClass(''), 600);
            return () => clearTimeout(timer);
        }

        // Detect "completion" transition
        if (prevStage !== 'complete' && workflowStage === 'complete') {
            setAnimationClass('council-orb--complete-flash');
            const timer = setTimeout(() => setAnimationClass(''), 500);
            return () => clearTimeout(timer);
        }

        prevStageRef.current = workflowStage;
    }, [workflowStage]);

    return (
        <div
            className={clsx(
                "council-orb-wrapper",
                isVoice && "council-orb-wrapper--voice",
                isActiveVariant && !showAsActive && !isVoice && "council-orb-wrapper--inactive",
                isDimmed && "opacity-30 grayscale pointer-events-none"
            )}
        >
            {/* Crown Icon for Voice Provider */}
            {isVoice && showCrown && (
                <button
                    type="button"
                    className={clsx(
                        "council-crown",
                        isActiveVariant && !isCrownMode && "council-crown--active",
                        variant === "historical" && "council-crown--historical",
                        isCrownMode && "council-crown--selecting"
                    )}
                    onClick={(e) => { if (variant !== "historical") onCrownClick(e); }}
                    title={variant === "historical" ? "Synthesizer for this turn" : "Click to change voice"}
                >
                    👑
                </button>
            )}

            {/* Workflow Progress Ring */}
            {workflowStage !== 'idle' && (
                <svg className="council-progress-ring" viewBox="0 0 44 44">
                    <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
                    <circle
                        cx="22"
                        cy="22"
                        r="18"
                        fill="none"
                        stroke={stageColor}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={progressOffset}
                        className="council-progress-ring__progress"
                        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                    />
                </svg>
            )}

            <button
                type="button"
                className={clsx(
                    "council-orb transition-all duration-300 ease-out",
                    // Shape and Size
                    isVoice ? "council-orb-voice" : "council-orb-regular",

                    // Historical Mode: Static orbs (no heavy animation), but still interactive
                    variant === "historical" && "council-orb-historical",

                    // Status Effects
                    isStreaming && "council-orb-streaming",
                    hasError && "council-orb-error",

                    // Active Mode Selection Dimming
                    // Unselected: Distinctly "Off" but visible logos. Low opacity (40%) + Grayscale.
                    // Hover brings it to life (Full Opacity + Color + Bloom).
                    isActiveVariant && !showAsActive && "opacity-90 brightness-90 scale-100 hover:opacity-100 hover:brightness-100 hover:scale-105 hover:shadow-[0_0_15px_-3px_var(--model-color)] transition-all duration-300",

                    // Selected: "On" State. Full Opacity, Color, Glow.
                    // Added brightness boost to combat "dullness".
                    isActiveVariant && showAsActive && "opacity-100 shadow-[0_0_20px_-4px_var(--model-color)] ring-1 ring-[var(--model-color)]/50 scale-125 z-10",

                    // Crown Mode Selection Target
                    isCrownMode && !isVoice && "ring-2 ring-brand-500/50 ring-offset-1 ring-offset-surface cursor-crosshair animate-pulse",
                    disabled && "opacity-50 cursor-not-allowed",

                    // Per-orb stage transition animations
                    animationClass
                )}
                style={{
                    '--model-color': primaryColor,
                    '--orb-color': primaryColor,
                    '--orb-accent': accentColor,
                    '--rotation': `${rotation}deg`,
                    '--logo-src': logoSrc ? `url('${logoSrc}')` : 'none'
                } as React.CSSProperties}
                onMouseEnter={() => onHover(pid)}
                onMouseLeave={() => onHover(null)}
                onClick={onClick}
                onMouseDown={onLongPressStart}
                onMouseUp={onLongPressCancel}
            >
                {/* Internal orb layers for enhanced visuals */}
                <div className="council-orb__core" />
                <div className="council-orb__glow" />
                <div className="council-orb__spinner" />
                {logoSrc && (
                    <div className="council-orb__logo" style={{ backgroundImage: `url('${logoSrc}')` }} />
                )}
                {(isStreaming || workflowStage === 'streaming') && <div className="council-orb__pulse" />}
            </button>

            {/* Workflow Stage Indicator */}
            {workflowStage !== 'idle' && workflowStage !== 'complete' && (
                <div className="council-stage-badge" style={{ backgroundColor: stageColor }}>
                    {workflowStage === 'thinking' && '🤔'}
                    {workflowStage === 'streaming' && '💬'}

                    {workflowStage === 'error' && '⚠️'}
                </div>
            )}

            {/* Tooltip */}
            {isHovered && (
                <div className="council-tooltip">
                    <span className="council-tooltip__name">{provider.name}</span>
                    {workflowStage !== 'idle' && (
                        <span className="council-tooltip__stage">
                            {workflowStage === 'thinking' && 'Processing...'}
                            {workflowStage === 'streaming' && (
                                typeof workflowProgress === 'number' && workflowProgress > 0
                                    ? `Generating (${workflowProgress}%)`
                                    : 'Generating...'
                            )}

                            {workflowStage === 'complete' && 'Complete'}
                            {workflowStage === 'error' && 'Error'}
                        </span>
                    )}
                    {isActiveVariant && !showAsActive && !isVoice && (
                        <span className="council-tooltip__action">Click to enable</span>
                    )}
                </div>
            )}
        </div>
    );
};
