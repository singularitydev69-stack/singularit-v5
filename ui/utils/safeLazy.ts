import React from 'react';

/**
 * A wrapper around React.lazy that detects if a chunk fails to load
 * (usually due to a new deployment/build) and reloads the page automatically
 * after a few retries.
 */
export function safeLazy<T extends React.ComponentType<any>>(
    importFn: () => Promise<{ default: T }>
) {
    const MAX_RETRIES = 2;
    const RELOAD_COUNTER_KEY = "safeLazyReloads";

    return React.lazy(async () => {
        let retries = 0;

        const load = async (): Promise<{ default: T }> => {
            try {
                const module = await importFn();
                // Reset counter on success so next failure in same session can still reload
                sessionStorage.removeItem(RELOAD_COUNTER_KEY);
                return module;
            } catch (error: any) {
                const errorName = error?.name || "";
                const errorMessage = error?.message || "";
                const isNetworkError = errorName === "TypeError" || errorMessage.includes("Failed to fetch");
                const isChunkError = errorName === "ChunkLoadError" || errorMessage.includes("Loading chunk");

                if ((isNetworkError || isChunkError) && retries < MAX_RETRIES) {
                    retries++;
                    const delay = Math.pow(2, retries) * 1000;
                    console.warn(`[safeLazy] Load failed, retrying in ${delay}ms (attempt ${retries}/${MAX_RETRIES})...`, error);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return load();
                }

                console.warn("[safeLazy] Lazy load failed after retries, checking reload guard...", error);
                
                const reloadCount = parseInt(sessionStorage.getItem(RELOAD_COUNTER_KEY) || "0", 10);
                if (reloadCount < 1) {
                    sessionStorage.setItem(RELOAD_COUNTER_KEY, (reloadCount + 1).toString());
                    window.location.reload();
                }

                // Return a user-friendly error component instead of null
                const ErrorFallback = () => React.createElement(
                    'div',
                    { className: 'flex flex-col items-center justify-center p-8 text-text-muted' },
                    React.createElement('div', { className: 'mb-4 text-xl' }, '⚠️'),
                    React.createElement('p', { className: 'mb-4' }, 'Component failed to load'),
                    React.createElement(
                        'button',
                        {
                            className: 'px-4 py-2 bg-surface-raised hover:bg-surface-highlight rounded border border-border-subtle transition-colors',
                            onClick: () => window.location.reload()
                        },
                        'Reload'
                    )
                );
                return { default: ErrorFallback as unknown as T };
            }
        };

        return load();
    });
}
