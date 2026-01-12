// src/core/preflight-validator.js
import { selectBestProvider, isProviderAuthorized, PROVIDER_PRIORITIES } from '../../shared/provider-config.js';
import { getProviderLocks } from '../../shared/provider-locks.js';

// Provider login URLs (duplicated from auth-config.ts for JS compatibility)
const PROVIDER_URLS = {
    chatgpt: 'https://chatgpt.com',
    claude: 'https://claude.ai',
    gemini: 'https://gemini.google.com',
    'gemini-pro': 'https://gemini.google.com',
    'gemini-exp': 'https://gemini.google.com',
    qwen: 'https://qianwen.com'
};

/**
 * Get the login URL for a provider
 * @param {string} providerId - Provider ID
 * @returns {string} The login URL or a generic fallback
 */
export function getProviderUrl(providerId) {
    return PROVIDER_URLS[providerId] || 'the provider website';
}

/**
 * Create a user-friendly error message for authentication failures
 * @param {string[]} unauthorizedProviders - List of provider IDs that failed auth
 * @param {string} context - Description of the context where the error occurred
 * @returns {string|null} Formatted error message or null if no unauthorized providers
 */
export function createAuthErrorMessage(unauthorizedProviders, context) {
    if (!unauthorizedProviders || unauthorizedProviders.length === 0) {
        return null;
    }

    const providerList = unauthorizedProviders.join(', ');
    const urlList = unauthorizedProviders
        .map(p => `  • ${p}: ${getProviderUrl(p)}`)
        .join('\n');

    return (
        `The following providers are not authenticated: ${providerList}\n\n` +
        `Please log in at:\n${urlList}\n\n` +
        `Context: ${context}`
    );
}

/**
 * Validates and adjusts provider selections before workflow execution.
 * 
 * - Filters out unauthorized batch providers
 * - Applies ephemeral fallback for locked but unauthorized synth/mapper
 * - Returns warnings for UI to display
 */
export async function runPreflight(request, authStatus, availableProviders) {
    let locks = {};
    const warnings = [];
    try {
        locks = await getProviderLocks();
    } catch (e) {
        warnings.push(`Failed to fetch provider locks: ${e.message || String(e)}`);
    }

    // === Filter batch providers ===
    let providers = (request.providers || []).filter(pid => {
        if (!isProviderAuthorized(pid, authStatus)) {
            warnings.push(`Provider "${pid}" is not authorized and was removed from batch`);
            return false;
        }
        return true;
    });

    // If no providers left, pick smart defaults
    if (providers.length === 0) {
        providers = PROVIDER_PRIORITIES.batch
            .filter(pid => isProviderAuthorized(pid, authStatus) && availableProviders.includes(pid))
            .slice(0, 3);
    }

    // === Mapper ===
    let mapper = request.mapper || null;
    if (mapper && !isProviderAuthorized(mapper, authStatus)) {
        const candidate = selectBestProvider('mapping', authStatus, availableProviders);
        if (locks.mapping === mapper) {
            if (candidate) {
                warnings.push(`Mapper "${mapper}" is locked but unauthorized; using "${candidate}" for this request`);
                mapper = candidate;
            } else {
                warnings.push(`Mapper "${mapper}" is locked but unauthorized and no fallback available`);
                mapper = 'gemini'; // safe sentinel
            }
        } else {
            mapper = candidate || 'gemini';
        }
    } else if (!mapper) {
        mapper = selectBestProvider('mapping', authStatus, availableProviders) || 'gemini';
    }

    // === Singularity ===
    let singularity = request.singularity || null;
    if (singularity && !isProviderAuthorized(singularity, authStatus)) {
        // We reuse the mapping lock for now
        const candidate = selectBestProvider('singularity', authStatus, availableProviders);
        if (locks.mapping === singularity) {
            if (candidate) {
                warnings.push(`Singularity provider "${singularity}" is unauthorized; using "${candidate}" for this request`);
                singularity = candidate;
            } else {
                warnings.push(`Singularity provider "${singularity}" is unauthorized and no fallback available`);
                singularity = 'gemini';
            }
        } else {
            singularity = candidate || 'gemini';
        }
    } else if (!singularity) {
        singularity = selectBestProvider('singularity', authStatus, availableProviders) || 'gemini';
    }

    return { providers, mapper, singularity, warnings };
}

