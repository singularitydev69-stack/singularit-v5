import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  isLoadingAtom,
  uiPhaseAtom,
  activeAiTurnIdAtom,
  alertTextAtom,
  lastActivityAtAtom,
  connectionStatusAtom,
} from "../../state/atoms";

const LOADING_TIMEOUT_MS = 45000; // 45 seconds

export function useLoadingWatchdog() {
  const isLoading = useAtomValue(isLoadingAtom);
  const lastActivityAt = useAtomValue(lastActivityAtAtom);
  const setIsLoading = useSetAtom(isLoadingAtom);
  const setUiPhase = useSetAtom(uiPhaseAtom);
  const setActiveAiTurnId = useSetAtom(activeAiTurnIdAtom);
  const setAlertText = useSetAtom(alertTextAtom);

  const latestIsLoadingRef = useRef(isLoading);
  useEffect(() => {
    latestIsLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    let timeout: any;
    if (isLoading) {
      const now = Date.now();
      const baseline =
        lastActivityAt && lastActivityAt > 0 ? lastActivityAt : now;
      const remaining = Math.max(LOADING_TIMEOUT_MS - (now - baseline), 1000);
      timeout = setTimeout(() => {
        const elapsed = Date.now() - (lastActivityAt || baseline);
        if (latestIsLoadingRef.current && elapsed >= LOADING_TIMEOUT_MS) {
          setIsLoading(false);
          setUiPhase("awaiting_action");
          setActiveAiTurnId(null);
          setAlertText("Processing stalled or timed out. Please try again.");
        }
      }, remaining);
    }
    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [
    isLoading,
    lastActivityAt,
    setIsLoading,
    setUiPhase,
    setActiveAiTurnId,
    setAlertText,
  ]);
}

/**
 * useResponsiveLoadingGuard
 * Non-destructive guard that observes loading and activity and surfaces alerts
 * rather than resetting state. Intended to replace useLoadingWatchdog.
 */
export function useResponsiveLoadingGuard(options?: {
  idleWarnMs?: number;
  idleCriticalMs?: number;
}) {
  const idleWarnMs = options?.idleWarnMs ?? 15_000;
  const idleCriticalMs = options?.idleCriticalMs ?? 45_000;

  const isLoading = useAtomValue(isLoadingAtom);
  const lastActivityAt = useAtomValue(lastActivityAtAtom);
  const connection = useAtomValue(connectionStatusAtom);
  const setAlertText = useSetAtom(alertTextAtom);
  const alertText = useAtomValue(alertTextAtom);

  const isLoadingRef = useRef(isLoading);
  const lastActivityAtRef = useRef(lastActivityAt);
  const warnedRef = useRef(false);
  const escalatedRef = useRef(false);

  useEffect(() => {
    isLoadingRef.current = isLoading;
    lastActivityAtRef.current = lastActivityAt;
    // Reset flags if loading stops
    if (!isLoading) {
      warnedRef.current = false;
      escalatedRef.current = false;
    }
  }, [isLoading, lastActivityAt]);

  useEffect(() => {
    // Guard only when connected and currently loading
    if (!isLoading || !connection?.isConnected) {
      if (alertText) setAlertText(null);
      return;
    }

    const baseline =
      lastActivityAtRef.current && lastActivityAtRef.current > 0
        ? lastActivityAtRef.current
        : Date.now();

    const interval = setInterval(() => {
      const now = Date.now();
      const currentLastActivity = lastActivityAtRef.current;
      const currentIsLoading = isLoadingRef.current;
      const idleFor = now - baseline;

      // Clear on fresh activity or when loading finishes
      if (!currentIsLoading || (currentLastActivity && currentLastActivity > baseline)) {
        setAlertText(null);
        // Reset escalation flags if we see fresh activity
        if (currentLastActivity && currentLastActivity > baseline) {
          warnedRef.current = false;
          escalatedRef.current = false;
        }
        return;
      }

      if (!warnedRef.current && idleFor >= idleWarnMs) {
        setAlertText(
          "Still processing… you can press Stop to abort and retry if needed.",
        );
        warnedRef.current = true;
      }

      if (!escalatedRef.current && idleFor >= idleCriticalMs) {
        setAlertText(
          "Processing is taking longer than expected. Consider pressing Stop, checking provider status, or switching model.",
        );
        escalatedRef.current = true;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [
    isLoading,
    connection?.isConnected,
    setAlertText,
    idleWarnMs,
    idleCriticalMs,
  ]);
}
