import { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
    providerAuthStatusAtom,
    mappingProviderAtom,
    singularityProviderAtom,
    providerLocksAtom,
} from '../../state/atoms';
import {
    selectBestProvider,
    isProviderAuthorized,
} from '@shared/provider-config';
import {
    getProviderLocks,
    subscribeToLockChanges,
} from '@shared/provider-locks';

/**
 * Automatically choose sensible default providers when authentication or availability changes.
 *
 * Will set mapping and singularity providers to the best available option when no selection exists
 * or the current selection is not authorized, while respecting user locks so locked providers are not changed.
 *
 * @returns An object with `isInitialized` set to `true` once the initial provider selection check has completed
 */
export function useSmartProviderDefaults() {
    const authStatus = useAtomValue(providerAuthStatusAtom);
    const [mappingProvider, setMappingProvider] = useAtom(mappingProviderAtom);
    const [singularityProvider, setSingularityProvider] = useAtom(singularityProviderAtom);
    const setLocks = useSetAtom(providerLocksAtom);

    // Track if we've done initial selection to avoid flash
    const [initialized, setInitialized] = useState(false);

    // Load locks from chrome.storage on mount + subscribe to changes
    useEffect(() => {
        getProviderLocks().then(setLocks);
        return subscribeToLockChanges(setLocks);
    }, [setLocks]);

    const locks = useAtomValue(providerLocksAtom);

    // React to auth changes
    useEffect(() => {
        // Skip if no auth data yet
        if (Object.keys(authStatus).length === 0) return;

        // === Mapping Provider ===
        if (!locks.mapping) {
            const currentValid = mappingProvider && isProviderAuthorized(mappingProvider, authStatus);

            if (!currentValid) {
                const best = selectBestProvider('mapping', authStatus);
                if (best && best !== mappingProvider) {
                    console.log(`[SmartDefaults] Mapping: ${mappingProvider} → ${best}`);
                    setMappingProvider(best);
                }
            }
        }

        // === Singularity Provider ===
        if (!locks.singularity) {
            const currentValid = singularityProvider && isProviderAuthorized(singularityProvider, authStatus);

            if (!currentValid) {
                const best = selectBestProvider('singularity', authStatus);
                if (best && best !== singularityProvider) {
                    console.log(`[SmartDefaults] Singularity: ${singularityProvider} → ${best}`);
                    setSingularityProvider(best);
                }
            }
        }

        setInitialized(true);
    }, [authStatus, locks, mappingProvider, setMappingProvider, singularityProvider, setSingularityProvider]);

    return { isInitialized: initialized };
}