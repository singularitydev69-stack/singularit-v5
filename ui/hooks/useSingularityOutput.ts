import { useMemo, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { turnsMapAtom, pinnedSingularityProvidersAtom } from "../state/atoms";
import { AiTurn } from "../types";
import { SingularityOutput } from "../../shared/contract";

export interface SingularityOutputState {
    output: SingularityOutput | null;
    isLoading: boolean;
    isError: boolean;
    providerId?: string | null;
    rawText?: string;
    error?: unknown;
    setPinnedProvider: (providerId: string) => void;
}

export function useSingularityOutput(aiTurnId: string | null, forcedProviderId?: string | null): SingularityOutputState {
    const turnsMap = useAtomValue(turnsMapAtom);
    const pinnedProviders = useAtomValue(pinnedSingularityProvidersAtom);
    const setPinnedProviders = useSetAtom(pinnedSingularityProvidersAtom);

    const setPinnedProvider = useCallback((providerId: string) => {
        if (!aiTurnId) return;
        setPinnedProviders(prev => ({
            ...prev,
            [aiTurnId]: providerId
        }));
    }, [aiTurnId, setPinnedProviders]);

    return useMemo(() => {
        const defaultState = {
            output: null,
            isLoading: false,
            isError: false,
            setPinnedProvider
        };

        if (!aiTurnId) return defaultState;

        const turn = turnsMap.get(aiTurnId);
        if (!turn || turn.type !== "ai") return defaultState;

        const aiTurn = turn as AiTurn;
        // Priority: Forced (Prop) > Pinned (User Selection) > Auto (Fallback)
        const pinnedId = pinnedProviders[aiTurnId];
        const effectiveProviderId = forcedProviderId || pinnedId;

        const singularityOutput = aiTurn.singularityOutput;
        if (singularityOutput && (!effectiveProviderId || String(effectiveProviderId) === String(singularityOutput.providerId))) {
            return {
                output: singularityOutput,
                isLoading: false,
                isError: false,
                providerId: singularityOutput.providerId,
                rawText: singularityOutput.text,
                setPinnedProvider
            };
        }

        const singularityResponses = aiTurn.singularityResponses;
        if (!singularityResponses || Object.keys(singularityResponses).length === 0) {
            if (effectiveProviderId) {
                return {
                    output: null,
                    isLoading: true,
                    isError: false,
                    providerId: effectiveProviderId,
                    setPinnedProvider
                };
            }
            return defaultState;
        }

        let providerId = effectiveProviderId;
        let responses = providerId ? singularityResponses[providerId] : undefined;

        // If a specific provider is requested (Forced or Pinned)
        if (effectiveProviderId) {
            // If requested provider is missing data, show LOADING state for it (Ghost Switching Fix)
            if (!responses || responses.length === 0) {
                return {
                    output: null,
                    isLoading: true, // Explicitly loading the requested provider
                    isError: false,
                    providerId: effectiveProviderId,
                    setPinnedProvider
                };
            }
        } else {
            // Auto Mode: Fallback to last available (or first, depending on preference)
            const keys = Object.keys(singularityResponses);
            providerId = keys[keys.length - 1]; // "Last Write Wins" for auto-mode is usually fine
            responses = singularityResponses[providerId];
        }

        if (!responses || responses.length === 0) return defaultState;

        const latestResponse = responses[responses.length - 1];

        const isLoading = latestResponse.status === "streaming" || latestResponse.status === "pending";
        const isError = latestResponse.status === "error";

        const meta: any = (latestResponse as any).meta || {};
        const metaOutput = meta.singularityOutput as SingularityOutput | undefined;

        let output: SingularityOutput;
        if (metaOutput && typeof metaOutput === "object") {
            output = {
                ...metaOutput,
                text: metaOutput.text || latestResponse.text,
                providerId: metaOutput.providerId || providerId,
                timestamp: metaOutput.timestamp || latestResponse.createdAt || Date.now(),
                leakageDetected: metaOutput.leakageDetected ?? meta.leakageDetected,
                leakageViolations: metaOutput.leakageViolations ?? meta.leakageViolations
            };
        } else {
            output = {
                text: latestResponse.text,
                providerId,
                timestamp: latestResponse.createdAt || Date.now(),
                leakageDetected: meta?.leakageDetected,
                leakageViolations: meta?.leakageViolations
            };
        }

        return {
            output,
            isLoading,
            isError,
            providerId,
            rawText: latestResponse.text,
            error: (latestResponse.meta as any)?.error,
            setPinnedProvider
        };
    }, [aiTurnId, turnsMap, forcedProviderId, pinnedProviders, setPinnedProvider]);
}
