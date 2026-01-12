const STORAGE_KEY = 'htos_provider_locks';

export interface ProviderLocks {
    mapping: boolean;
    singularity: boolean;
}

const DEFAULT_LOCKS: ProviderLocks = { mapping: false, singularity: false };

/**
 * Read locks from chrome.storage.local
 * Works in both UI and service worker
 */
export async function getProviderLocks(): Promise<ProviderLocks> {
    try {
        const data = await chrome.storage.local.get(STORAGE_KEY);
        const stored = data[STORAGE_KEY] as Record<string, any> | undefined;
        return { ...DEFAULT_LOCKS, ...(stored || {}) };
    } catch {
        return DEFAULT_LOCKS;
    }
}

/**
 * Write locks to chrome.storage.local
 */
export async function setProviderLock(
    role: 'mapping' | 'singularity',
    locked: boolean
): Promise<void> {
    const current = await getProviderLocks();
    current[role] = locked;
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
}

/**
 * Subscribe to lock changes (for UI reactivity)
 */
export function subscribeToLockChanges(
    callback: (locks: ProviderLocks) => void
): () => void {
    const listener = (
        changes: { [key: string]: chrome.storage.StorageChange },
        area: string
    ) => {
        if (area === 'local' && changes[STORAGE_KEY]) {
            const newValue = changes[STORAGE_KEY].newValue || {};
            callback({ ...DEFAULT_LOCKS, ...(newValue as Partial<ProviderLocks>) });
        }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
}
