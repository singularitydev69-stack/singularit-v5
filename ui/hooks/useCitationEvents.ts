import { useEffect } from 'react';

/**
 * Registers global document listeners to intercept citation interactions and invoke a callback with the citation number.
 *
 * Sets up capture-phase, non-passive listeners for "click", "auxclick", and "pointerdown" that extract a numeric citation id from an anchor href starting with "citation:" or from elements with `data-citation-number` / `data-citation`. When a citation number is found, the handler prevents the default action (when cancelable), stops further propagation immediately, and calls `handleCitationClick` with the parsed integer. Listeners are removed on cleanup or when `handleCitationClick` changes.
 *
 * @param handleCitationClick - Callback invoked with the parsed citation number when a citation interaction is intercepted
 */
export function useCitationEvents(
  handleCitationClick: (num: number) => void
) {
  useEffect(() => {
    const handleExtraction = (target: HTMLElement | null) => {
      const anchor = target
        ? (target.closest('a[href^="citation:"]') as HTMLAnchorElement | null)
        : null;
      const citeEl = target
        ? (target.closest(
          "[data-citation-number], [data-citation]",
        ) as HTMLElement | null)
        : null;

      if (!anchor && !citeEl) return NaN;

      let num = NaN;
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        const numMatch = href.match(/(\d+)/);
        num = numMatch ? parseInt(numMatch[1], 10) : NaN;
      } else if (citeEl) {
        const raw =
          citeEl.getAttribute("data-citation-number") ||
          citeEl.getAttribute("data-citation") ||
          "";
        const numMatch = raw.match(/(\d+)/);
        num = numMatch ? parseInt(numMatch[1], 10) : NaN;
      }
      return num;
    };

    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only primary clicks
      try {
        const num = handleExtraction(e.target as HTMLElement | null);
        if (!isNaN(num)) {
          if (e.cancelable) e.preventDefault();
          e.stopImmediatePropagation();
          handleCitationClick(num);
        }
      } catch (err) {
        console.warn("[useCitationEvents] global citation click intercept error", err);
      }
    };

    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return; // Only middle clicks
      try {
        const num = handleExtraction(e.target as HTMLElement | null);
        if (!isNaN(num)) {
          if (e.cancelable) e.preventDefault();
          e.stopImmediatePropagation();
          handleCitationClick(num);
        }
      } catch (err) {
        console.warn("[useCitationEvents] global citation auxclick intercept error", err);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      try {
        const isAux = e.button !== 0;
        const isModifier = e.ctrlKey || (e as any).metaKey;
        if (isAux || isModifier) {
          const num = handleExtraction(e.target as HTMLElement | null);
          if (!isNaN(num)) {
            if (e.cancelable) e.preventDefault();
            e.stopImmediatePropagation();
            handleCitationClick(num);
          }
        }
      } catch (err) {
        console.warn("[useCitationEvents] global citation pointerdown intercept error", err);
      }
    };

    // Use {capture: true, passive: false} to allow preventDefault() without browser warnings
    const nonPassive = { capture: true, passive: false };
    document.addEventListener("click", onClick, nonPassive);
    document.addEventListener("auxclick", onAuxClick, nonPassive);
    document.addEventListener("pointerdown", onPointerDown, nonPassive);

    return () => {
      document.removeEventListener("click", onClick, nonPassive);
      document.removeEventListener("auxclick", onAuxClick, nonPassive);
      document.removeEventListener("pointerdown", onPointerDown, nonPassive);
    };
  }, [handleCitationClick]);
}