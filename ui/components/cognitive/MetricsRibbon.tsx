import React, { useState } from "react";
import {
    StructuralAnalysis,
    ProblemStructure,
    MapperArtifact,
} from "../../../shared/contract";
import { StructuralSummary } from "./StructuralSummary";

interface MetricsRibbonProps {
    artifact?: MapperArtifact;
    analysis?: StructuralAnalysis;
    problemStructure?: ProblemStructure;
}

export const MetricsRibbon: React.FC<MetricsRibbonProps> = ({
    artifact,
    analysis,
    problemStructure,
}) => {
    const [showDetails, setShowDetails] = useState(false);

    if (!analysis) return null;

    const {
        claimsWithLeverage: claims = [],
        patterns,
        landscape,
        ghostAnalysis,
    } = analysis;

    const modelCount = landscape?.modelCount || 0;
    const ghosts = artifact?.ghosts || [];

    // Confidence badge
    const confidence = problemStructure?.confidence;
    const isLowConfidence = confidence ? confidence < 0.5 : false;

    return (
        <div className="bg-surface-raised border border-border-subtle rounded-lg mb-4 px-4 py-3">
            {/* Structure type + confidence */}
            <div className="flex items-center gap-3 mb-3">
                {problemStructure && (
                    <span className="text-xs font-medium text-brand-400 capitalize">
                        {problemStructure.primaryPattern} structure
                    </span>
                )}
                {confidence !== undefined && (
                    <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${isLowConfidence
                            ? "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                            : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                            }`}
                    >
                        {isLowConfidence ? "uncertain" : "stable"}
                    </span>
                )}

                <div className="flex-1" />

                <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="text-[10px] text-text-muted hover:text-text-primary"
                >
                    {showDetails ? "hide details" : "show details"}
                </button>
            </div>

            {/* The three summary lines */}
            <StructuralSummary
                claims={claims}
                conflicts={patterns?.conflictInfos || []}
                cascadeRisks={patterns?.cascadeRisks || []}
                leverageInversions={patterns?.leverageInversions || []}
                ghosts={ghosts}
                problemStructure={problemStructure}
                modelCount={modelCount}
            />

            {/* Expandable details (for power users) */}
            {showDetails && (
                <div className="mt-4 pt-3 border-t border-border-subtle text-xs text-text-muted space-y-2">
                    <div>
                        <span className="text-text-secondary">Landscape:</span> {claims.length > 15 ? 'Extensive' : 'Focused'} claim set synthesized from {modelCount > 5 ? 'multiple' : 'diverse'} sources
                    </div>
                    {patterns?.conflicts && patterns.conflicts.length > 0 && (
                        <div>
                            <span className="text-text-secondary">Conflicts:</span> Point-to-point disagreements detected
                        </div>
                    )}
                    {ghostAnalysis && ghostAnalysis.count > 0 && (
                        <div>
                            <span className="text-text-secondary">Gaps:</span> Unexplored territory identified
                        </div>
                    )}
                    {problemStructure?.evidence && (
                        <div className="mt-2">
                            <span className="text-text-secondary">Evidence:</span>
                            <ul className="mt-1 space-y-0.5 text-[11px]">
                                {problemStructure.evidence.slice(0, 5).map((e, idx) => (
                                    <li key={`${e}-${idx}`}>• {e}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MetricsRibbon;
