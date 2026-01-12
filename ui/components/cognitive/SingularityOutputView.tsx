import React from 'react';
import { AiTurn } from '../../types';
import MarkdownDisplay from '../MarkdownDisplay';
import { SingularityOutputState } from '../../hooks/useSingularityOutput';
import { CopyButton } from '../CopyButton';
import { PipelineErrorBanner } from '../PipelineErrorBanner';

interface SingularityOutputViewProps {
    aiTurn: AiTurn;
    singularityState: SingularityOutputState;
    onRecompute: (options?: any) => void;
    isLoading?: boolean;
}

/**
 * Clean, chat-like display of the Singularity (Concierge) response.
 * Front and center, just like any modern chat interface.
 */
const SingularityOutputView: React.FC<SingularityOutputViewProps> = ({
    aiTurn,
    singularityState,
    onRecompute,
    isLoading
}) => {
    const { output, isError, error, providerId } = singularityState;

    if (isError) {
        const errorObj = error as Record<string, any> | null;
        return (
            <div className="py-8">
                <PipelineErrorBanner
                    type="singularity"
                    failedProviderId={providerId || aiTurn.meta?.singularity || ""}
                    onRetry={(pid) => onRecompute({ providerId: pid })}
                    errorMessage={typeof error === 'string' ? error : errorObj?.message}
                    requiresReauth={!!errorObj?.requiresReauth}
                />
            </div>
        );
    }

    if (!output && !isLoading) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-text-muted italic gap-4">
                <span className="text-5xl filter opacity-30">✨</span>
                <span className="text-sm">No response generated yet.</span>
                <button
                    onClick={() => onRecompute()}
                    className="mt-2 px-6 py-2.5 rounded-xl bg-brand-500/10 hover:bg-brand-500/20 text-brand-500 text-sm font-medium transition-colors border border-brand-500/20"
                >
                    Generate Response
                </button>
            </div>
        );
    }

    if (isLoading && !output) {
        return (
            <div className="flex flex-col items-center justify-center py-16">
                <div className="relative">
                    <div className="w-16 h-16 rounded-full bg-brand-500/10 animate-pulse flex items-center justify-center">
                        <span className="text-3xl">✨</span>
                    </div>
                    <div className="absolute inset-0 rounded-full border-2 border-brand-500/30 animate-ping" />
                </div>
                <div className="text-text-secondary font-medium mt-6">
                    Synthesizing response...
                </div>
                <div className="text-xs text-text-muted mt-2 text-center">
                    Converging insights from the council.
                </div>
            </div>
        );
    }

    return (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Main Response Container - Clean and readable */}
            <div className="bg-surface border border-border-subtle rounded-2xl overflow-hidden shadow-sm relative">
                {/* Subtle gradient accent */}
                <div className="absolute top-0 right-0 w-80 h-80 bg-brand-500/5 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/3 pointer-events-none" />

                {/* Response Content */}
                <div className="relative z-10 px-6 py-8 md:px-8">
                    <div className="prose prose-lg dark:prose-invert max-w-none">
                        <MarkdownDisplay content={output?.text || ""} />
                    </div>
                </div>

                {/* Footer Actions */}
                <div className="relative z-10 px-6 py-4 border-t border-border-subtle/50 bg-surface-highlight/5 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                        {output?.providerId && (
                            <span className="px-2 py-0.5 rounded-md bg-surface-highlight border border-border-subtle">
                                {output.providerId}
                            </span>
                        )}
                        {output?.leakageDetected && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400">
                                ⚠️ Machinery detected
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <CopyButton
                            text={output?.text || ""}
                            label="Copy response"
                            variant="icon"
                        />
                        <button
                            onClick={() => onRecompute()}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-surface-highlight border border-border-subtle transition-colors"
                        >
                            <span>↻</span>
                            <span>Regenerate</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Leakage Details (if any) */}
            {output?.leakageDetected && output.leakageViolations && output.leakageViolations.length > 0 && (
                <div className="mt-4 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mb-2">
                        ⚠️ Machinery Leakage Detected
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {output.leakageViolations.map((v, i) => (
                            <span
                                key={i}
                                className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-400 font-mono"
                            >
                                {v}
                            </span>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default SingularityOutputView;
