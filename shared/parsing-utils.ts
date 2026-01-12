import { Claim, Edge, MapperArtifact, ParsedMapperOutput, GraphTopology, GraphNode, GraphEdge, ConciergeDelta } from './contract';

/**
 * Shared Parsing Utilities for ALL_AVAILABLE_OPTIONS and GRAPH_TOPOLOGY
 * 
 * Single source of truth for parsing mapping responses.
 * Used by both backend (workflow-engine.js) and frontend (DecisionMapSheet.tsx).
 */

// ============================================================================
// TYPES
// ============================================================================

// Graph types imported from contract


// ============================================================================
// CENTRALIZED JSON EXTRACTION
// ============================================================================

export function repairJson(text: string): string {
    const input = String(text ?? '');
    if (!input) return '';

    const stripComments = (src: string): string => {
        let out = '';
        let quote: '"' | "'" | null = null;
        let esc = false;

        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            const next = i + 1 < src.length ? src[i + 1] : '';

            if (quote) {
                out += ch;
                if (esc) {
                    esc = false;
                    continue;
                }
                if (ch === '\\') {
                    esc = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch as any;
                out += ch;
                continue;
            }

            if (ch === '/' && next === '/') {
                while (i < src.length && src[i] !== '\n') i++;
                if (i < src.length && src[i] === '\n') out += '\n';
                continue;
            }

            if (ch === '/' && next === '*') {
                i += 2;
                while (i < src.length) {
                    const a = src[i];
                    const b = i + 1 < src.length ? src[i + 1] : '';
                    if (a === '*' && b === '/') {
                        i++;
                        break;
                    }
                    i++;
                }
                continue;
            }

            out += ch;
        }

        return out;
    };

    const removeTrailingCommas = (src: string): string => {
        let out = '';
        let quote: '"' | "'" | null = null;
        let esc = false;

        for (let i = 0; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                out += ch;
                if (esc) {
                    esc = false;
                    continue;
                }
                if (ch === '\\') {
                    esc = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch as any;
                out += ch;
                continue;
            }

            if (ch === ',') {
                let j = i + 1;
                while (j < src.length && /\s/.test(src[j])) j++;
                const nextNonWs = j < src.length ? src[j] : '';
                if (nextNonWs === '}' || nextNonWs === ']') {
                    continue;
                }
            }

            out += ch;
        }

        return out;
    };

    const quoteUnquotedKeys = (src: string): string => {
        let out = '';
        let quote: '"' | "'" | null = null;
        let esc = false;
        let expectingKey = false;

        const isKeyStart = (c: string) => /[A-Za-z_]/.test(c);
        const isKeyChar = (c: string) => /[A-Za-z0-9_]/.test(c);

        for (let i = 0; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                out += ch;
                if (esc) {
                    esc = false;
                    continue;
                }
                if (ch === '\\') {
                    esc = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch as any;
                out += ch;
                expectingKey = false;
                continue;
            }

            if (ch === '{' || ch === ',') {
                expectingKey = true;
                out += ch;
                continue;
            }

            if (expectingKey) {
                if (/\s/.test(ch)) {
                    out += ch;
                    continue;
                }
                if (ch === '}') {
                    expectingKey = false;
                    out += ch;
                    continue;
                }
                if (ch === '"' || ch === "'") {
                    quote = ch as any;
                    out += ch;
                    expectingKey = false;
                    continue;
                }
                if (isKeyStart(ch)) {
                    let key = ch;
                    let k = i + 1;
                    while (k < src.length && isKeyChar(src[k])) {
                        key += src[k];
                        k++;
                    }
                    let ws = '';
                    let j = k;
                    while (j < src.length && /\s/.test(src[j])) {
                        ws += src[j];
                        j++;
                    }
                    if (j < src.length && src[j] === ':') {
                        out += `"${key}"${ws}:`;
                        i = j;
                        expectingKey = false;
                        continue;
                    }
                    out += key;
                    i = k - 1;
                    expectingKey = false;
                    continue;
                }
                expectingKey = false;
            }

            out += ch;
        }

        return out;
    };

    const noComments = stripComments(input);
    const noTrailing = removeTrailingCommas(noComments);
    const quotedKeys = quoteUnquotedKeys(noTrailing);
    return quotedKeys;
}

export function extractJsonObject(text: string): { json: any | null; path: string } {
    const raw = String(text ?? '').trim();
    if (!raw) return { json: null, path: 'none' };

    const tryParse = (candidate: string): { ok: boolean; value: any } => {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
            if (typeof parsed === 'string') {
                try {
                    const parsed2 = JSON.parse(parsed);
                    if (parsed2 && typeof parsed2 === 'object') return { ok: true, value: parsed2 };
                } catch {
                    return { ok: false, value: null };
                }
            }
        } catch {
            return { ok: false, value: null };
        }
        return { ok: false, value: null };
    };

    const tryParseWithRepair = (candidate: string): { ok: boolean; value: any; repaired: boolean } => {
        const direct = tryParse(candidate);
        if (direct.ok) return { ok: true, value: direct.value, repaired: false };
        const repairedText = repairJson(candidate);
        if (repairedText && repairedText !== candidate) {
            const repaired = tryParse(repairedText);
            if (repaired.ok) return { ok: true, value: repaired.value, repaired: true };
        }
        return { ok: false, value: null, repaired: false };
    };

    const extractCodeBlock = (src: string): string | null => {
        const m = src.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
        return m?.[1]?.trim() ? m[1].trim() : null;
    };

    const extractBalancedBraces = (src: string): string | null => {
        const startObj = src.indexOf('{');
        if (startObj === -1) return null;
        let depth = 0;
        let quote: '"' | "'" | null = null;
        let esc = false;

        for (let i = startObj; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                if (esc) {
                    esc = false;
                    continue;
                }
                if (ch === '\\') {
                    esc = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch as any;
                continue;
            }

            if (ch === '{') depth++;
            if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return src.slice(startObj, i + 1);
                }
            }
        }
        return null;
    };

    const direct = tryParseWithRepair(raw);
    if (direct.ok) return { json: direct.value, path: direct.repaired ? 'repaired' : 'direct' };

    const code = extractCodeBlock(raw);
    if (code) {
        const fromCode = tryParseWithRepair(code);
        if (fromCode.ok) return { json: fromCode.value, path: fromCode.repaired ? 'repaired' : 'code_block' };
        const braceInCode = extractBalancedBraces(code);
        if (braceInCode) {
            const fromBrace = tryParseWithRepair(braceInCode);
            if (fromBrace.ok) return { json: fromBrace.value, path: fromBrace.repaired ? 'repaired' : 'brace_match' };
        }
    }

    const brace = extractBalancedBraces(raw);
    if (brace) {
        const fromBrace = tryParseWithRepair(brace);
        if (fromBrace.ok) return { json: fromBrace.value, path: fromBrace.repaired ? 'repaired' : 'brace_match' };
    }

    return { json: null, path: 'none' };
}

// ============================================================================
// NORMALIZATION
// ============================================================================


/**
 * Normalize markdown escapes and unicode variants
 */
export function normalizeText(text: string): string {
    return text
        .replace(/\\=/g, '=')
        .replace(/\\_/g, '_')
        .replace(/\\\*/g, '*')
        .replace(/\\-/g, '-')
        .replace(/[＝═⁼˭꓿﹦]/g, '=')
        .replace(/[‗₌]/g, '=')
        .replace(/\u2550/g, '=')
        .replace(/\uFF1D/g, '=');
}

export function parseProseGraphTopology(text: string): GraphTopology | null {
    if (!text) return null;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeMap = new Map<string, string>();
    let nodeCounter = 1;

    const normalizeLabel = (label: string): string => {
        return label
            .trim()
            .replace(/^\*\*|\*\*$/g, '')
            .replace(/^["']|["']$/g, '')
            .trim();
    };

    const getOrCreateNodeId = (rawLabel: string): string => {
        const label = normalizeLabel(rawLabel);
        if (!label) return '';
        const existing = nodeMap.get(label);
        if (existing) return existing;

        const id = `opt_${nodeCounter++}`;
        nodeMap.set(label, id);
        nodes.push({
            id,
            label,
            theme: '',
            supporters: [],
            support_count: 1,
        });
        return id;
    };

    const edgePatterns: RegExp[] = [
        /\*\*([^*]+)\*\*\s*--\[(\w+)\]-->\s*\*\*([^*\n]+)\*\*/g,
        /^[-*•]?\s*([A-Z][^-\n]*?)\s*--\[(\w+)\]-->\s*([^\n]+)/gm,
        /["']([^"']+)["']\s*--\[(\w+)\]-->\s*["']([^"'\n]+)["']/g,
        /([^-\n\[\]]{3,}?)\s*--\[(\w+)\]-->\s*([^\n]+)/g,
    ];

    for (const pattern of edgePatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const sourceLabel = String(match[1] || '').trim();
            const edgeType = String(match[2] || '').toLowerCase();
            const targetLabel = String(match[3] || '').trim();

            const sourceId = getOrCreateNodeId(sourceLabel);
            const targetId = getOrCreateNodeId(targetLabel);

            if (!sourceId || !targetId || !edgeType) continue;

            const exists = edges.some((e) => e.source === sourceId && e.target === targetId && e.type === edgeType);
            if (exists) continue;

            edges.push({
                source: sourceId,
                target: targetId,
                type: edgeType as any,
                reason: '',
            });
        }
    }

    if (nodes.length === 0 || edges.length === 0) return null;
    return { nodes, edges };
}

// ============================================================================
// GRAPH_TOPOLOGY PARSING
// ============================================================================

/**
 * Pattern to match GRAPH_TOPOLOGY headers in various formats
 */
const GRAPH_TOPOLOGY_PATTERN = /\n#{1,3}\s*[^\w\n].*?GRAPH[_\s]*TOPOLOGY|\n?(?:🔬|📊|🗺️)*\s*={0,}GRAPH[_\s]*TOPOLOGY={0,}|\n?(?:🔬|📊|🗺️)\s*GRAPH[_\s]*TOPOLOGY|={3,}\s*GRAPH[_\s]*TOPOLOGY\s*={3,}/iu;

/**
 * Find position of GRAPH_TOPOLOGY header in text
 */
export function findGraphTopologyPosition(text: string): number {
    const match = text.match(GRAPH_TOPOLOGY_PATTERN);
    return match && typeof match.index === 'number' ? match.index : -1;
}

/**
 * Extract GRAPH_TOPOLOGY JSON from text and return cleaned text
 */
export function extractGraphTopologyAndStrip(text: string): { text: string; topology: GraphTopology | null } {
    if (!text || typeof text !== 'string') return { text: text || '', topology: null };

    const normalized = normalizeText(text);
    const match = normalized.match(GRAPH_TOPOLOGY_PATTERN);

    if (!match || typeof match.index !== 'number') {
        return { text: normalized, topology: parseProseGraphTopology(normalized) };
    }

    const start = match.index + match[0].length;
    let rest = normalized.slice(start).trim();

    // Handle code block wrapped JSON
    const codeBlockMatch = rest.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
        rest = codeBlockMatch[1].trim();
    }

    // Find JSON object
    let i = 0;
    while (i < rest.length && rest[i] !== '{') i++;
    if (i >= rest.length) {
        const prose = parseProseGraphTopology(rest);
        if (prose) return { text: normalized.slice(0, match.index).trim(), topology: prose };
        return { text: normalized.slice(0, match.index).trim(), topology: null };
    }

    // Parse JSON with balanced braces
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let j = i; j < rest.length; j++) {
        const ch = rest[j];
        if (inStr) {
            if (esc) {
                esc = false;
            } else if (ch === '\\') {
                esc = true;
            } else if (ch === '"') {
                inStr = false;
            }
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try {
                    let jsonText = rest.slice(i, j + 1);
                    // Fix unquoted S in supporters arrays
                    jsonText = jsonText.replace(/("supporters"\s*:\s*\[)\s*S\s*([,\]])/g, '$1"S"$2');
                    const topology = JSON.parse(jsonText);
                    const before = normalized.slice(0, match.index).trim();
                    const after = rest.slice(j + 1).trim();
                    const newText = after ? `${before}\n${after}` : before;
                    return { text: newText, topology };
                } catch {
                    break;
                }
            }
        }
    }

    const prose = parseProseGraphTopology(rest);
    if (prose) {
        return { text: normalized.slice(0, match.index).trim(), topology: prose };
    }

    return { text: normalized.slice(0, match.index).trim(), topology: null };
}

// ============================================================================
// ALL_AVAILABLE_OPTIONS PARSING
// ============================================================================

/**
 * Patterns to match ALL_AVAILABLE_OPTIONS headers
 */
const OPTIONS_PATTERNS = [
    // Markdown H2/H3 header with any emoji prefix: ## 🛠️ ALL_AVAILABLE_OPTIONS
    { re: /\n#{1,3}\s*[^\w\n].*?ALL[_\s]*AVAILABLE[_\s]*OPTIONS.*?\n/iu, minPosition: 0.15 },

    // Emoji-prefixed format (🛠️ ALL_AVAILABLE_OPTIONS) - standalone
    { re: /\n?(?:🛠️|🔧|⚙️|🛠)\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS\s*\n/iu, minPosition: 0.15 },

    // Standard delimiter with === or --- or unicode equivalent wrapper
    { re: /\n?[=\-─━═＝]{2,}\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS\s*[=\-─━═＝]{2,}\n?/i, minPosition: 0 },
    { re: /\n?[=\-─━═＝]{2,}\s*ALL[_\s]*OPTIONS\s*[=\-─━═＝]{2,}\n?/i, minPosition: 0 },

    // Markdown wrapped variants or multi-char blocks
    { re: /\n\*\*\s*[=\-─━═＝]{2,}\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS\s*[=\-─━═＝]{2,}\s*\*\*\n?/i, minPosition: 0 },
    { re: /\n\*{0,2}[=\-─━═＝]{3,}\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS\s*[=\-─━═＝]{3,}\*{0,2}\n/i, minPosition: 0 },
    { re: /\n###\s*[=\-─━═＝]{2,}\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS\s*[=\-─━═＝]{2,}\n?/i, minPosition: 0 },

    // Heading styles
    { re: /\n\*\*\s*All\s+Available\s+Options:?\s*\*\*\n/i, minPosition: 0.25 },
    { re: /\n##\s+All\s+Available\s+Options:?\n/i, minPosition: 0.25 },
    { re: /\n###\s+All\s+Available\s+Options:?\n/i, minPosition: 0.25 },

    // Looser patterns
    { re: /\nAll\s+Available\s+Options:\n/i, minPosition: 0.3 },
    { re: /\n\*\*\s*Options:?\s*\*\*\n/i, minPosition: 0.3 },
    { re: /\n##\s+Options:?\n/i, minPosition: 0.3 },
];

/**
 * Clean narrative text by removing trailing separators and leftover header fragments
 */
export function cleanNarrativeText(text: string): string {
    return text
        .replace(/\n---+\s*$/, '')
        .replace(/\n#{1,3}\s*(?:🛠️|🔧|⚙️|🛠)?\s*ALL[_\s]*AVAILABLE[_\s]*OPTIONS.*$/iu, '')
        .replace(/\n#{1,3}\s*(?:🛠️|🔧|⚙️|🛠)\s*$/iu, '')
        .replace(/(?:🛠️|🔧|⚙️|🛠)\s*$/iu, '')
        .trim();
}

/**
 * Clean options text by removing trailing GRAPH_TOPOLOGY header
 */
export function cleanOptionsText(text: string): string {
    const graphTopoPos = findGraphTopologyPosition(text);
    if (graphTopoPos > 0) {
        return text.slice(0, graphTopoPos).trim();
    }
    return text.trim();
}

/**
 * Extract ALL_AVAILABLE_OPTIONS from text and return cleaned narrative
 */
export function extractOptionsAndStrip(text: string): { text: string; options: string | null } {
    if (!text || typeof text !== 'string') return { text: text || '', options: null };

    let normalized = normalizeText(text);

    // First, find and strip GRAPH_TOPOLOGY section
    const graphTopoStart = findGraphTopologyPosition(normalized);
    if (graphTopoStart > 0) {
        normalized = normalized.slice(0, graphTopoStart).trim();
    }

    // Find best matching options delimiter
    let bestMatch: { index: number; length: number } | null = null;
    let bestScore = -1;

    for (const pattern of OPTIONS_PATTERNS) {
        const match = normalized.match(pattern.re);
        if (match && typeof match.index === 'number') {
            const position = match.index / normalized.length;
            if (position < pattern.minPosition) continue;
            const score = position * 100;
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { index: match.index, length: match[0].length };
            }
        }
    }

    if (!bestMatch) return { text: normalized, options: null };

    const afterDelimiter = normalized.substring(bestMatch.index + bestMatch.length).trim();
    const listPreview = afterDelimiter.slice(0, 400);

    // Validate that what follows looks like structured content
    const hasListStructure = /^\s*[-*•]\s+|\n\s*[-*•]\s+|^\s*\d+\.\s+|\n\s*\d+\.\s+|^\s*\*\*[^*]+\*\*|^\s*Theme\s*:|^\s*###?\s+|^\s*[A-Z][^:\n]{2,}:|(?:🌀|🗿|😀|🙏|🚀|🛩)/iu.test(listPreview);
    const hasSubstantiveContent = afterDelimiter.length > 50 && (afterDelimiter.includes('\n') || afterDelimiter.includes(':'));

    if (!hasListStructure && !hasSubstantiveContent) {
        return { text: normalized, options: null };
    }

    const narrative = cleanNarrativeText(normalized.substring(0, bestMatch.index));
    const options = cleanOptionsText(afterDelimiter);

    return { text: narrative, options: options || null };
}

/**
 * Parse mapping response - convenience function that extracts both options and topology
 */
export function parseMappingResponse(response: string | null | undefined): {
    narrative: string;
    options: string | null;
    optionTitles: string[];
    graphTopology: any | null;
} {
    if (!response) return { narrative: '', options: null, optionTitles: [], graphTopology: null };

    const hasUnifiedTags =
        response.includes('<map>') ||
        response.includes('<narrative>') ||
        response.includes('\\<map\\>') ||
        response.includes('\\<narrative\\>') ||
        /#{1,6}\s*THE\s*(?:MAP|NARRATIVE)\b/i.test(response) ||
        /#{1,3}\s*(?:\d+\.)?\s*\\?<(?:map|narrative)\\?>/i.test(response) ||
        /#{1,3}\s*(?:\d+\.)?\s*(?:map|narrative)\s*\n/i.test(response) ||
        /\*\*(?:map|narrative)\*\*/i.test(response) ||
        response.includes('<narrative_summary>') ||
        response.includes('<options_inventory>') ||
        response.includes('<mapper_artifact>') ||
        response.includes('<graph_topology>') ||
        response.includes('\\<narrative_summary\\>') ||
        response.includes('\\<options_inventory\\>') ||
        response.includes('\\<mapper_artifact\\>') ||
        response.includes('\\<graph_topology\\>') ||
        /#{1,3}\s*(?:\d+\.)?\s*\\?<(?:narrative_summary|options_inventory|mapper_artifact|graph_topology)\\?>/i.test(response) ||
        /#{1,3}\s*(?:\d+\.)?\s*(?:narrative[_\s]*summary|options[_\s]*inventory|mapper[_\s]*artifact|graph[_\s]*topology)\s*\n/i.test(response) ||
        /\*\*(?:narrative[_\s]*summary|options[_\s]*inventory|mapper[_\s]*artifact|graph[_\s]*topology)\*\*/i.test(response);

    if (hasUnifiedTags) {
        const unified = parseUnifiedMapperOutput(response);
        const optionTitles = unified.options ? parseOptionTitles(unified.options) : [];
        return {
            narrative: unified.narrative || response, // Fallback to raw if narrative tag is missing
            options: unified.options ?? null,
            optionTitles,
            graphTopology: unified.topology,
        };
    }

    // First extract graph topology
    const { text: textWithoutTopology, topology } = extractGraphTopologyAndStrip(response);

    // Then extract options from remaining text
    const { text: narrative, options } = extractOptionsAndStrip(textWithoutTopology);

    // Extract option titles if options were found
    const optionTitles = options ? parseOptionTitles(options) : [];

    return {
        narrative: cleanNarrativeText(narrative),
        options: options ? cleanOptionsText(options) : null,
        optionTitles,
        graphTopology: topology,
    };
}

/**
 * Extract bold titles from options text
 */
export function parseOptionTitles(optionsText: string): string[] {
    if (!optionsText) return [];
    const titles: string[] = [];
    const lines = optionsText.split('\n');
    for (const line of lines) {
        // Match: **Bold Title** (with optional colon/dash after)
        const match = line.match(/\*\*([^*]+)\*\*/);
        if (match) {
            const title = match[1].trim();
            // Avoid duplicates
            if (title && !titles.includes(title)) {
                titles.push(title);
            }
        }
    }
    return titles;
}

// ============================================================================
// MAPPER ARTIFACT PARSING
// ============================================================================

/**
 * Create empty MapperArtifact
 */
export function createEmptyMapperArtifact(): MapperArtifact {
    return {
        claims: [],
        edges: [],
        ghosts: [],
        query: "",
        turn: 0,
        timestamp: new Date().toISOString(),
        model_count: 0,
        souvenir: ""
    };
}

const NARRATIVE_SUMMARY_PATTERNS: RegExp[] = [
    /<narrative_summary>([\s\S]*?)<\/narrative_summary>/i,
    /\\<narrative_summary\\>([\s\S]*?)\\<\/narrative_summary\\>/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<narrative_summary\\?>\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*\\?<|$)/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<narrative_summary\\?>\s*\n([\s\S]*?)\\?<\/narrative_summary\\?>/i,
    /#{1,3}\s*(?:\d+\.)?\s*narrative[_\s]*summary\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*(?:options|mapper|graph)|$)/i,
    /\*\*narrative[_\s]*summary\*\*[:\s]*\n([\s\S]*?)(?=\*\*(?:options|mapper|graph)|#{1,3}|$)/i,
];

const OPTIONS_INVENTORY_PATTERNS: RegExp[] = [
    /<options_inventory>([\s\S]*?)<\/options_inventory>/i,
    /\\<options_inventory\\>([\s\S]*?)\\<\/options_inventory\\>/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<options_inventory\\?>\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*\\?<|$)/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<options_inventory\\?>\s*\n([\s\S]*?)\\?<\/options_inventory\\?>/i,
    /#{1,3}\s*(?:\d+\.)?\s*options[_\s]*inventory\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*(?:narrative|mapper|graph)|$)/i,
    /\*\*options[_\s]*inventory\*\*[:\s]*\n([\s\S]*?)(?=\*\*(?:narrative|mapper|graph)|#{1,3}|$)/i,
];

const MAPPER_ARTIFACT_PATTERNS: RegExp[] = [
    /<mapper_artifact>([\s\S]*?)<\/mapper_artifact>/i,
    /\\<mapper_artifact\\>([\s\S]*?)\\<\/mapper_artifact\\>/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<mapper_artifact\\?>\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*\\?<|$)/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<mapper_artifact\\?>\s*\n([\s\S]*?)(?:\\?<\/mapper_artifact\\?>|(?=#{1,3}\s*(?:\d+\.)?\s*(?:graph|$)))/i,
    /#{1,3}\s*(?:\d+\.)?\s*mapper[_\s]*artifact\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*(?:narrative|options|graph)|$)/i,
    /\*\*mapper[_\s]*artifact\*\*[:\s]*\n([\s\S]*?)(?=\*\*(?:narrative|options|graph)|#{1,3}|$)/i,
    /mapper[_\s]*artifact[:\s]*\n*```(?:json)?\s*\n?(\{[\s\S]*?"consensus"[\s\S]*?"claims"[\s\S]*?\})\s*\n?```/i,
];

const GRAPH_TOPOLOGY_TAG_PATTERNS: RegExp[] = [
    /<graph_topology>([\s\S]*?)<\/graph_topology>/i,
    /\\<graph_topology\\>([\s\S]*?)\\<\/graph_topology\\>/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<graph_topology\\?>\s*\n([\s\S]*?)(?=#{1,3}\s*(?:\d+\.)?\s*\\?<|$)/i,
    /#{1,3}\s*(?:\d+\.)?\s*\\?<graph_topology\\?>\s*\n([\s\S]*?)\\?<\/graph_topology\\?>/i,
    /#{1,3}\s*(?:\d+\.)?\s*graph[_\s]*topology\s*\n([\s\S]*?)(?=#{1,3}\s|$)/i,
    /\*\*graph[_\s]*topology\*\*[:\s]*\n([\s\S]*?)(?=\*\*|#{1,3}|$)/i,
];

function tryPatterns(text: string, patterns: RegExp[]): string | null {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return null;
}

interface PatternMatch {
    content: string;
    patternIndex: number;
    position: number;
    length: number;
}

function bestPatternMatchFromSources(sources: Array<string | null | undefined>, patterns: RegExp[]): PatternMatch | null {
    let best: { match: PatternMatch; score: number } | null = null;

    for (let s = 0; s < sources.length; s++) {
        const src = sources[s];
        if (!src) continue;

        for (let p = 0; p < patterns.length; p++) {
            const re = patterns[p];
            const cloned = new RegExp(re.source, re.flags);
            const m = cloned.exec(src);
            if (!m || !m[1] || !String(m[1]).trim()) continue;
            const content = String(m[1]).trim();

            const position = typeof (m as any).index === 'number' ? (m as any).index : src.indexOf(m[0] || '');
            const length = content.length;

            let score = (patterns.length - p) * 1_000_000 + length;
            if (length > src.length * 0.9) score -= 500_000;
            score -= Math.max(0, position);

            if (!best || score > best.score) {
                best = {
                    match: { content, patternIndex: p, position: Math.max(0, position), length },
                    score,
                };
            }
        }
    }

    return best ? best.match : null;
}

function extractJsonFromContent(content: string | null): any | null {
    if (!content) return null;

    const extracted = extractJsonObject(content);
    if (extracted.json) return extracted.json;

    let jsonText = content.trim();
    const codeFenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeFenceMatch) jsonText = codeFenceMatch[1].trim();

    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(jsonText.substring(firstBrace, lastBrace + 1));
        } catch { }
    }

    try {
        return JSON.parse(jsonText);
    } catch {
        return null;
    }
}

/**
 * Parse Unified Mapper Output
 * Extracts content from <raw_narrative>, <options_inventory>, <mapper_artifact>, and <graph_topology> tags.
 */
export function extractAnchorPositions(narrative: string): Array<{ label: string; id: string; position: number }> {
    const anchors: Array<{ label: string; id: string; position: number }> = [];
    const pattern = /\*\*\[([^\]|]+)\|([^\]]+)\]\*\*|\[([^\]|]+)\|([^\]]+)\]/g;

    let match;
    while ((match = pattern.exec(narrative)) !== null) {
        const label = (match[1] ?? match[3] ?? '').trim();
        const id = (match[2] ?? match[4] ?? '').trim();
        if (!label || !id) continue;
        anchors.push({
            label,
            id,
            position: match.index
        });
    }
    return anchors;
}

/**
 * Parse Unified Mapper Output (V3)
 * Extracts content from <narrative> and <map> tags.
 * Falls back to legacy parsing if those tags are absent.
 */
export function parseUnifiedMapperOutput(text: string): ParsedMapperOutput {
    if (!text) {
        return {
            claims: [],
            edges: [],
            ghosts: [],
            narrative: "",
            map: { claims: [], edges: [], ghosts: [] },
            anchors: [],
            topology: null,
            options: null,
            artifact: null
        };
    }

    const normalizedText = text.replace(/\\</g, '<').replace(/\\>/g, '>');

    type HeadingBlock = {
        kind: 'map' | 'narrative';
        headerStart: number;
        contentStart: number;
    };

    const headingBlocks: HeadingBlock[] = [];
    const headingRe = /^#{1,6}\s*THE\s*(MAP|NARRATIVE)\b.*$/gim;
    let hm: RegExpExecArray | null;
    while ((hm = headingRe.exec(normalizedText)) !== null) {
        const headerStart = typeof hm.index === 'number' ? hm.index : -1;
        if (headerStart < 0) continue;
        const headerLineEnd = normalizedText.indexOf('\n', headerStart);
        const contentStart = headerLineEnd === -1 ? normalizedText.length : headerLineEnd + 1;
        const kind = String(hm[1] || '').toLowerCase() === 'map' ? 'map' : 'narrative';
        headingBlocks.push({ kind, headerStart, contentStart });
    }

    headingBlocks.sort((a, b) => a.headerStart - b.headerStart);

    const getHeadingBlockContent = (kind: HeadingBlock['kind']): { content: string; start: number; end: number } | null => {
        const idx = [...headingBlocks].reverse().findIndex(b => b.kind === kind);
        if (idx === -1) return null;
        const blockIndex = headingBlocks.length - 1 - idx;
        const block = headingBlocks[blockIndex];
        const next = headingBlocks.find((b, i) => i > blockIndex && b.headerStart > block.headerStart);
        const end = next ? next.headerStart : normalizedText.length;
        const content = normalizedText.slice(block.contentStart, end).trim();
        return { content, start: block.headerStart, end };
    };

    const mapSection = getHeadingBlockContent('map');
    const narrativeSection = getHeadingBlockContent('narrative');

    // 1. Try V3 Extraction (<map> and <narrative>)
    const mapTagPattern = /<map\b[^>]*>([\s\S]*?)<\/map\s*>/gi;
    const narrativeTagPattern = /<narrative\b[^>]*>([\s\S]*?)<\/narrative\s*>/gi;
    const rawNarrativeTagPattern = /<raw_narrative\b[^>]*>([\s\S]*?)<\/raw_narrative\s*>/gi;

    const mapMatches = Array.from(normalizedText.matchAll(mapTagPattern));
    const narrativeMatches = Array.from(normalizedText.matchAll(narrativeTagPattern));
    const rawNarrativeMatches = Array.from(normalizedText.matchAll(rawNarrativeTagPattern));
    const narrativeMatch = narrativeMatches.length > 0 ? narrativeMatches[narrativeMatches.length - 1] : null;
    const rawNarrativeMatch = rawNarrativeMatches.length > 0 ? rawNarrativeMatches[rawNarrativeMatches.length - 1] : null;

    let map: any = { claims: [], edges: [], ghosts: [] };
    let foundV3Map = false;
    let narrativeFromHeading: string | null = narrativeSection?.content ? narrativeSection.content : null;

    // A. Explicit Tag Match
    if (mapMatches.length > 0) {
        for (let i = mapMatches.length - 1; i >= 0; i--) {
            const content = mapMatches[i]?.[1];
            if (!content) continue;
            const extracted = extractJsonFromContent(content);
            if (extracted && typeof extracted === 'object' && Array.isArray((extracted as any).claims) && Array.isArray((extracted as any).edges)) {
                map = extracted;
                foundV3Map = true;
                break;
            }
        }
    } else {
        const openIdx = normalizedText.search(/<map\b[^>]*>/i);
        if (openIdx !== -1) {
            const afterOpen = normalizedText.slice(openIdx);
            const tagEnd = afterOpen.indexOf('>');
            if (tagEnd !== -1) {
                const content = afterOpen.slice(tagEnd + 1);
                const extracted = extractJsonFromContent(content);
                if (extracted && typeof extracted === 'object' && Array.isArray((extracted as any).claims) && Array.isArray((extracted as any).edges)) {
                    map = extracted;
                    foundV3Map = true;
                }
            }
        }
    }

    if (!foundV3Map && mapSection?.content) {
        const extracted = extractJsonFromContent(mapSection.content);
        if (extracted && typeof extracted === 'object' && Array.isArray((extracted as any).claims) && Array.isArray((extracted as any).edges)) {
            map = extracted;
            foundV3Map = true;
        }
    }

    // B. Fallback: Look for V3 JSON structure anywhere if tags failed or missing
    if (!foundV3Map) {
        try {
            const extracted = extractJsonFromContent(normalizedText);
            // Check signature of V3 map
            if (extracted && Array.isArray(extracted.claims) && Array.isArray(extracted.edges)) {
                map = extracted;
                foundV3Map = true;
            }
        } catch { }
    }

    if (foundV3Map || narrativeMatch || rawNarrativeMatch || narrativeFromHeading) {
        let narrative = "";
        const candidates: string[] = [];
        if (narrativeMatch && narrativeMatch[1]) candidates.push(String(narrativeMatch[1]).trim());
        if (rawNarrativeMatch && rawNarrativeMatch[1]) candidates.push(String(rawNarrativeMatch[1]).trim());
        if (narrativeFromHeading) {
            candidates.push(
                narrativeFromHeading
                    .replace(/<narrative\b[^>]*>/i, '')
                    .replace(/<\/narrative\s*>/i, '')
                    .replace(/<raw_narrative\b[^>]*>/i, '')
                    .replace(/<\/raw_narrative\s*>/i, '')
                    .trim()
            );
        }
        candidates.sort((a, b) => b.length - a.length);
        narrative = candidates.find((c) => c && c.trim()) || "";

        if (!narrative) {
            // Fallback: if map is found but no narrative tag, assume rest is narrative
            narrative = normalizedText.replace(/<map\b[^>]*>[\s\S]*?<\/map\s*>/i, '').trim();
            if (mapSection) {
                narrative = (normalizedText.slice(0, mapSection.start) + normalizedText.slice(mapSection.end)).trim();
            }
        }

        const anchors = extractAnchorPositions(narrative);

        const normalizeClaimType = (t: any): Claim["type"] => {
            const v = String(t || "").toLowerCase();
            if (v === "factual" || v === "prescriptive" || v === "conditional" || v === "contested" || v === "speculative") {
                return v as Claim["type"];
            }
            return "speculative";
        };

        const normalizeClaimRole = (r: any): Claim["role"] => {
            const v = String(r || "").toLowerCase();
            if (v === "anchor" || v === "branch" || v === "challenger" || v === "supplement") {
                return v as Claim["role"];
            }
            return "branch";
        };

        const normalizedClaims: Claim[] = Array.isArray((map as any).claims)
            ? (map as any).claims
                .filter((c: any) => c && (c.id || c.label))
                .map((c: any): Claim => {
                    const role = normalizeClaimRole(c.role);
                    return {
                        id: String(c.id ?? ""),
                        label: String(c.label ?? ""),
                        text: String(c.text ?? ""),
                        supporters: Array.isArray(c.supporters) ? c.supporters.filter((s: any) => typeof s === "number") : [],
                        type: normalizeClaimType(c.type),
                        role,
                        challenges: role === "challenger" && typeof c.challenges === "string" ? c.challenges : null,
                        ...(typeof c.quote === "string" ? { quote: c.quote } : {}),
                        ...(typeof c.support_count === "number" ? { support_count: c.support_count } : {}),
                        ...(typeof c.originalId === "string" ? { originalId: c.originalId } : {}),
                    };
                })
                .filter((c: any) => c.id && c.label)
            : [];

        const normalizedEdges: Edge[] = Array.isArray((map as any).edges)
            ? (map as any).edges
                .filter((e: any) => e && (e.from || e.to))
                .map((e: any) => ({
                    from: String(e.from ?? ""),
                    to: String(e.to ?? ""),
                    type:
                        e.type === "supports" || e.type === "conflicts" || e.type === "tradeoff" || e.type === "prerequisite"
                            ? e.type
                            : "supports",
                }))
                .filter((e: any) => e.from && e.to)
            : [];

        const normalizedGhosts: string[] | null =
            (map as any).ghosts == null
                ? null
                : Array.isArray((map as any).ghosts)
                    ? (map as any).ghosts.map((g: any) => String(g)).filter((g: any) => g && g.trim())
                    : [String((map as any).ghosts)].filter((g: any) => g && g.trim());

        // Auto-generate topology from map for compatibility
        let topology: GraphTopology | null = null;
        if (normalizedClaims.length > 0 || normalizedEdges.length > 0) {
            topology = {
                nodes: normalizedClaims.map((c: any) => ({
                    id: c.id,
                    label: c.label,
                    theme: c.type,
                    supporters: Array.isArray(c.supporters) ? c.supporters.filter((s: any) => typeof s === 'number') : [],
                    support_count: (c.supporters?.length || 0)
                })),
                edges: normalizedEdges.map((e: any) => ({
                    source: e.from,
                    target: e.to,
                    type: e.type,
                    reason: e.type
                }))
            };
        }

        const artifact = {
            ...createEmptyMapperArtifact(),
            claims: normalizedClaims,
            edges: normalizedEdges,
            ghosts: normalizedGhosts
        };

        return {
            claims: normalizedClaims,
            edges: normalizedEdges,
            ghosts: normalizedGhosts,
            narrative,
            map: { claims: normalizedClaims, edges: normalizedEdges, ghosts: normalizedGhosts },
            anchors,
            topology,
            options: null,
            artifact
        };
    }

    // 2. Legacy Fallback
    const extractWithPatterns = (patterns: RegExp[]): string | null => {
        const best = bestPatternMatchFromSources([normalizedText, text], patterns);
        if (best?.content) return best.content;
        const first = tryPatterns(normalizedText, patterns);
        if (first) return first;
        return tryPatterns(text, patterns);
    };

    const narrativeSummary = extractWithPatterns(NARRATIVE_SUMMARY_PATTERNS);
    const optionsInventory = extractWithPatterns(OPTIONS_INVENTORY_PATTERNS);
    const mapperArtifactRaw = extractWithPatterns(MAPPER_ARTIFACT_PATTERNS);
    const graphTopologyRaw = extractWithPatterns(GRAPH_TOPOLOGY_TAG_PATTERNS);

    const empty = createEmptyMapperArtifact();

    let artifact: MapperArtifact | null = null;
    if (mapperArtifactRaw) {
        const parsed = extractJsonFromContent(mapperArtifactRaw);
        if (parsed && typeof parsed === 'object') {
            // Attempt to fit into MapperArtifact shape
            artifact = { ...empty, ...parsed };
        }
    }

    // Attempt embedded JSON if explicit artifact missing
    if (!artifact) {
        const embeddedMatch = normalizedText.match(/```(?:json)?\s*(\{[\s\S]*?"consensus"[\s\S]*?"claims"[\s\S]*?\})\s*```/i);
        if (embeddedMatch) {
            const parsed = extractJsonFromContent(embeddedMatch[1]);
            if (parsed) artifact = { ...empty, ...parsed };
        }
    }

    let topology: GraphTopology | null = null;
    if (graphTopologyRaw) {
        const parsed = extractJsonFromContent(graphTopologyRaw);
        if (parsed && Array.isArray((parsed as any).nodes)) {
            topology = parsed as GraphTopology;
        } else {
            topology = parseProseGraphTopology(graphTopologyRaw);
        }
    }

    if (!topology) {
        topology = parseProseGraphTopology(text);
    }

    const stripNonNarrativeSections = (src: string): string => {
        let out = src;
        out = out.replace(/<mapper_artifact\b[^>]*>[\s\S]*?<\/mapper_artifact\s*>/gi, '');
        out = out.replace(/\\<mapper_artifact\\>[\s\S]*?\\<\/mapper_artifact\\>/gi, '');
        out = out.replace(/<options_inventory\b[^>]*>[\s\S]*?<\/options_inventory\s*>/gi, '');
        out = out.replace(/\\<options_inventory\\>[\s\S]*?\\<\/options_inventory\\>/gi, '');
        out = out.replace(/<graph_topology\b[^>]*>[\s\S]*?<\/graph_topology\s*>/gi, '');
        out = out.replace(/\\<graph_topology\\>[\s\S]*?\\<\/graph_topology\\>/gi, '');

        out = out.replace(
            /^[ \t]*#{1,6}\s*(?:\d+\.)?\s*(?:mapper[_\s]*artifact|graph[_\s]*topology|options[_\s]*inventory)\b[\s\S]*?(?=^[ \t]*#{1,6}\s|$)/gim,
            '',
        );

        out = out.replace(
            /^\*\*(?:mapper[_\s]*artifact|graph[_\s]*topology|options[_\s]*inventory)\*\*[:\s]*\n[\s\S]*?(?=^\*\*|^[ \t]*#{1,6}\s|$)/gim,
            '',
        );

        return out.trim();
    };

    const strippedBase = stripNonNarrativeSections(normalizedText);
    const { text: strippedNoTopology, topology: strippedTopology } = extractGraphTopologyAndStrip(strippedBase);
    const { text: strippedNarrativeText, options: strippedOptions } = extractOptionsAndStrip(strippedNoTopology);
    const cleanedStrippedNarrative = cleanNarrativeText(strippedNarrativeText);
    const cleanedNarrativeSummary = narrativeSummary ? cleanNarrativeText(narrativeSummary) : "";

    const pickedNarrative =
        [cleanedStrippedNarrative, cleanedNarrativeSummary]
            .filter((s) => s && s.trim().length > 0)
            .sort((a, b) => b.length - a.length)[0] || "";

    const pickedOptionsRaw =
        (optionsInventory ? optionsInventory : null) ||
        (strippedOptions ? strippedOptions : null) ||
        null;
    const pickedOptions = pickedOptionsRaw ? cleanOptionsText(pickedOptionsRaw) : null;

    if (!topology && strippedTopology) {
        topology = strippedTopology;
    }

    const pickedAnchors = pickedNarrative ? extractAnchorPositions(pickedNarrative) : [];

    // If absolutely nothing structural found, treat as raw narrative
    if (!narrativeSummary && !optionsInventory && !mapperArtifactRaw && !graphTopologyRaw) {
        const { text: textWithoutTopology, topology: legacyTopology } = extractGraphTopologyAndStrip(text);
        const { text: narrative, options } = extractOptionsAndStrip(textWithoutTopology);
        return {
            claims: [],
            edges: [],
            ghosts: [],
            narrative: cleanNarrativeText(narrative),
            options: options ? cleanOptionsText(options) : null,
            artifact: null,
            topology: legacyTopology || topology,
            map: null,
            anchors: extractAnchorPositions(cleanNarrativeText(narrative))
        };
    }

    // Legacy structured output
    return {
        claims: artifact?.claims || [],
        edges: artifact?.edges || [],
        ghosts: artifact?.ghosts || [],
        narrative: pickedNarrative,
        options: pickedOptions,
        artifact: artifact,
        topology: (topology as any) || null, // Cast to avoid deep mismatch if any fields slightly differ
        map: null,
        anchors: pickedAnchors
    };
}

/**
 * Parse MapperArtifact from text.
 * Expects sections: ===CONSENSUS===, ===OUTLIERS===, ===METADATA===
 */
/**
 * Parse MapperArtifact from text.
 * Expects sections: ===CONSENSUS===, ===OUTLIERS===, ===METADATA===
 * Adapts legacy sections to V3 schema (claims, edges, ghosts).
 */
export function parseMapperArtifact(text: string): MapperArtifact {
    if (!text) return createEmptyMapperArtifact();

    const normalized = normalizeText(text);
    const artifact = createEmptyMapperArtifact();

    // 1. Try Unified Tagged Parser first
    if (
        normalized.includes('<mapper_artifact>') ||
        normalized.includes('\\<mapper_artifact\\>') ||
        /#{1,3}\s*(?:\d+\.)?\s*\\?<mapper_artifact\\?>/i.test(text) ||
        /#{1,3}\s*(?:\d+\.)?\s*mapper[_\s]*artifact\s*\n/i.test(text)
    ) {
        const unified = parseUnifiedMapperOutput(text);
        if (unified.map) {
            // Convert map to artifact
            return {
                ...artifact,
                claims: unified.map.claims || [],
                edges: unified.map.edges || [],
                ghosts: unified.map.ghosts || []
            };
        }
        if (unified.artifact) return unified.artifact;
    }

    // 2. Try JSON parsing
    try {
        const jsonMatch = normalized.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || normalized.match(/^\{[\s\S]*\}$/);
        if (jsonMatch) {
            const jsonText = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonText);
            if (parsed && typeof parsed === 'object') {
                // If it's V3 JSON
                if (parsed.claims) return { ...artifact, ...parsed };

                // If it's V2 JSON (consensus/outliers), adapt it
                if (parsed.consensus) {
                    const consensusClaims = Array.isArray(parsed.consensus.claims) ? parsed.consensus.claims.map((c: any, idx: number) => ({
                        id: `claim_${idx + 1}`,
                        label: c.text.split(' ').slice(0, 3).join(' '),
                        text: c.text,
                        supporters: c.supporters || [],
                        type: 'factual',
                        role: 'anchor',
                        challenges: null
                    })) : [];

                    const outlierClaims = Array.isArray(parsed.outliers) ? parsed.outliers.map((o: any, idx: number) => ({
                        id: `outlier_${idx + 1}`,
                        label: o.insight.split(' ').slice(0, 3).join(' '),
                        text: o.insight,
                        supporters: [o.source_index !== undefined ? o.source_index : -1],
                        type: 'speculative',
                        role: o.type === 'frame_challenger' ? 'challenger' : 'supplement',
                        challenges: o.challenges || null
                    })) : [];

                    return {
                        ...artifact,
                        claims: [...consensusClaims, ...outlierClaims],
                        edges: [], // V2 didn't have explicit edges usually, or they werent compatible
                        ghosts: parsed.ghost ? [parsed.ghost] : [],
                        ...parsed
                    };
                }
            }
        }
    } catch (e) {
        // Fallback to regex
    }

    // Helper for Mapper sections with === headers
    const extractMapperSection = (name: string) => {
        const pattern = new RegExp(`={3,}\\s*${name}\\s*={3,}\\n([\\s\\S]*?)(?=\\n={3,}|$)`, 'i');
        const match = normalized.match(pattern);
        return match ? match[1].trim() : extractSection(normalized, name);
    };

    const consensusText = extractMapperSection('CONSENSUS');
    const outliersText = extractMapperSection('OUTLIERS');
    const metadataText = extractMapperSection('METADATA');

    const newClaims: any[] = [];

    // Parse Consensus
    if (consensusText) {
        const lines = consensusText.split('\n');
        lines.forEach((line, idx) => {
            const match = line.match(/^[-*•]\s*(.+)$/);
            if (match) {
                newClaims.push({
                    id: `c_${idx}`,
                    label: match[1].split(' ').slice(0, 3).join(' '),
                    text: match[1].trim(),
                    supporters: [],
                    type: 'factual',
                    role: 'anchor'
                });
            }
        });
    }

    // Parse Outliers
    if (outliersText) {
        const outlierBlocks = outliersText.split(/\n\s*[-*•]\s+/).filter(Boolean);
        outlierBlocks.forEach((block, idx) => {
            const parts = block.split('\n');
            if (parts.length > 0) {
                newClaims.push({
                    id: `o_${idx}`,
                    label: parts[0].split(' ').slice(0, 3).join(' '),
                    text: parts[0].trim(),
                    supporters: [],
                    type: 'speculative',
                    role: 'supplement'
                });
            }
        });
    }

    if (newClaims.length > 0) artifact.claims = newClaims;

    // Parse Metadata
    if (metadataText) {
        const ghost = extractLabeledValue(metadataText, 'ghost');
        if (ghost && ghost.toLowerCase() !== 'none') artifact.ghosts = [ghost];

        const query = extractLabeledValue(metadataText, 'query');
        if (query) artifact.query = query;
    }

    return artifact;
}

export function formatArtifactAsOptions(artifact: MapperArtifact): string {
    const safe = artifact || createEmptyMapperArtifact();
    const lines: string[] = [];

    const claims = Array.isArray(safe?.claims) ? safe.claims : [];
    const modelCount = typeof safe?.model_count === "number" ? safe.model_count : 0;

    const consensus = claims.filter(c => c.supporters && c.supporters.length >= 2);
    const divergent = claims.filter(c => !c.supporters || c.supporters.length < 2);

    if (consensus.length > 0) {
        lines.push("### Consensus Claims");
        for (const c of consensus) {
            const supportCount = c.supporters ? c.supporters.length : 0;
            const denom = modelCount > 0 ? modelCount : (supportCount > 0 ? supportCount : 1);
            lines.push(`- **${c.label}** ("${c.text}") [${supportCount}/${denom}]`);
        }
    }

    if (divergent.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("### Particulars");
        for (const c of divergent) {
            lines.push(`- **${c.label}** ("${c.text}") [Model ${c.supporters[0] || '?'}]`);
            if (c.challenges) lines.push(`  Challenges: ${c.challenges}`);
        }
    }

    return lines.join("\n").trim();
}

export function parseV1MapperToArtifact(
    v1Output: string,
    options: { graphTopology?: any; query?: string; turn?: number; timestamp?: string } = {},
): MapperArtifact {
    const normalizedForTags = String(v1Output || '').replace(/\\</g, '<').replace(/\\>/g, '>');
    const hasUnifiedTaggedOutput =
        /<mapper_artifact\b/i.test(normalizedForTags) ||
        /<map\b/i.test(normalizedForTags) ||
        /#{1,6}\s*THE\s*MAP\b/im.test(normalizedForTags) ||
        /#{1,6}\s*THE\s*NARRATIVE\b/im.test(normalizedForTags);

    if (hasUnifiedTaggedOutput) {
        const unified = parseUnifiedMapperOutput(v1Output);

        let unifiedArtifact = unified.artifact;
        if (!unifiedArtifact && unified.map && unified.map.claims) {
            unifiedArtifact = {
                ...createEmptyMapperArtifact(),
                claims: unified.map.claims,
                edges: unified.map.edges || [],
                ghosts: unified.map.ghosts || [],
            };
        }

        if (unifiedArtifact) {
            return {
                ...unifiedArtifact,
                query: options.query || unifiedArtifact.query || "",
                turn: options.turn || unifiedArtifact.turn || 0,
                timestamp: options.timestamp || unifiedArtifact.timestamp || new Date().toISOString()
            };
        }
    }

    // 2. Normalize and fallback to V2 JSON
    const normalizedOutput = normalizedForTags;
    // ... Parsing V2 JSON and adapting it ...
    // Note: For simplicity, if we don't find V2 JSON, we fall back to empty or rudimentary

    // We reuse parseMapperArtifact as the robust fallback since it now handles V2 adaptation
    const parsed = parseMapperArtifact(normalizedOutput);

    const topologyCandidate = options.graphTopology && typeof options.graphTopology === 'object'
        ? (options.graphTopology as GraphTopology)
        : null;

    const claimTypeFromNode = (nodeType: any): Claim['type'] => {
        const t = String(nodeType || '').toLowerCase();
        if (t === 'factual' || t === 'prescriptive' || t === 'conditional' || t === 'contested' || t === 'speculative') {
            return t as Claim['type'];
        }
        return 'speculative';
    };

    const edgeTypeFromGraph = (raw: any): Edge['type'] => {
        const t = String(raw || '').toLowerCase();
        if (t.includes('conflict')) return 'conflicts';
        if (t.includes('trade')) return 'tradeoff';
        if (t.includes('pre') && t.includes('req')) return 'prerequisite';
        if (t === 'supports' || t === 'conflicts' || t === 'tradeoff' || t === 'prerequisite') return t as Edge['type'];
        return 'supports';
    };

    let claims: Claim[] = Array.isArray(parsed.claims) ? parsed.claims : [];
    let edges: Edge[] = Array.isArray(parsed.edges) ? parsed.edges : [];
    const ghosts = parsed.ghosts ?? null;

    if (topologyCandidate?.nodes?.length && claims.length === 0) {
        claims = topologyCandidate.nodes
            .filter((n: any) => n && (n.id || n.label))
            .map((n: any): Claim => {
                const supporters: number[] = Array.isArray(n.supporters)
                    ? n.supporters.filter((s: any) => typeof s === 'number')
                    : [];
                return {
                    id: String(n.id ?? ''),
                    label: String(n.label ?? ''),
                    text: String(n.text ?? n.label ?? ''),
                    supporters,
                    type: claimTypeFromNode(n.type ?? n.theme),
                    role: 'branch',
                    challenges: null,
                    support_count: typeof n.support_count === 'number' ? n.support_count : supporters.length,
                };
            })
            .filter((c: Claim) => !!c.id && !!c.label);
    }

    if (topologyCandidate?.edges?.length && edges.length === 0) {
        edges = topologyCandidate.edges
            .filter((e: any) => e && (e.source || e.target))
            .map((e: any) => ({
                from: String(e.source ?? ''),
                to: String(e.target ?? ''),
                type: edgeTypeFromGraph(e.type),
            }))
            .filter((e: any) => e.from && e.to);
    }

    let model_count = typeof parsed.model_count === 'number' ? parsed.model_count : 0;
    if ((!model_count || model_count === 0) && topologyCandidate?.nodes?.length) {
        let maxSupporter = 0;
        for (const n of topologyCandidate.nodes) {
            const supporters = Array.isArray((n as any)?.supporters) ? (n as any).supporters : [];
            for (const s of supporters) {
                if (typeof s === 'number' && s > maxSupporter) maxSupporter = s;
            }
        }
        model_count = maxSupporter || 0;
    }

    return {
        ...parsed,
        claims,
        edges,
        ghosts,
        ...(model_count ? { model_count } : {}),
        query: options.query || parsed.query || "",
        turn: options.turn || parsed.turn || 0,
        timestamp: options.timestamp || parsed.timestamp || new Date().toISOString()
    };
}

// ============================================================================
// CORE HELPERS
// ============================================================================

/**
 * Extract a named section from markdown text.
 * Handles: ## Header, ### Header, **Header**:, Header:, etc.
 */
function extractSection(text: string, sectionName: string): string {
    if (!text || !sectionName) return '';

    const escapedName = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    // Patterns from strictest to loosest for main section
    const patterns = [
        // ## Section Name or ### Section Name
        new RegExp(
            `(?:^|\\n)#{1,3}\\s*[^\\w\\n]*${escapedName}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n---\\s*\\n|$)`,
            'i'
        ),
        // **Section Name**: or **Section Name**
        new RegExp(
            `\\*\\*\\s*${escapedName}\\s*\\*\\*[:\\s]*\\n?([\\s\\S]*?)(?=\\n\\*\\*[A-Z]|\\n#{1,3}\\s|\\n---\\s*\\n|$)`,
            'i'
        ),
        // Section Name: (plain)
        new RegExp(
            `(?:^|\\n)${escapedName}[:\\s]+\\n?([\\s\\S]*?)(?=\\n[A-Z][a-z]+[:\\s]+\\n|\\n#{1,3}\\s|\\n---\\s*\\n|$)`,
            'i'
        ),
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }

    return '';
}

/**
 * Extract a labeled value from text.
 * Handles: **Label**: value, - **Label**: value, Label: value
 */
function extractLabeledValue(text: string, label: string): string | null {
    if (!text || !label) return null;

    const escaped = label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    const patterns = [
        // - **Label**: value (list item with bold)
        new RegExp(`[-*•]\\s*\\*\\*${escaped}\\*\\*[:\\s]*([^\\n]+)`, 'i'),
        // **Label**: value (inline bold)
        new RegExp(`\\*\\*${escaped}\\*\\*[:\\s]*([^\\n]+)`, 'i'),
        // Label: value (plain)
        new RegExp(`(?:^|\\n)${escaped}[:\\s]+([^\\n]+)`, 'i'),
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }

    return null;
}

// ============================================================================
// CONCIERGE BATCH REQUEST PARSING
// ============================================================================

/**
 * Signal types for concierge-triggered batch requests
 */
export interface WorkflowSignal {
    type: 'GENERATE_WORKFLOW';
    goal: string;
    context: string;
    batchPrompt: string;
}

export interface StepHelpSignal {
    type: 'STEP_HELP_NEEDED';
    step: string;
    blocker: string;
    constraint: string;
    batchPrompt: string;
}

export type ConciergeSignal = WorkflowSignal | StepHelpSignal | null;

export interface ConciergeOutput {
    userResponse: string;
    signal: ConciergeSignal;
}

/**
 * Parse concierge output to extract user-facing response and any batch request signals.
 * The signal is delimited by <<<SINGULARITY_BATCH_REQUEST>>> ... <<<END_BATCH_REQUEST>>>
 */
export function parseConciergeOutput(rawResponse: string): ConciergeOutput {
    if (!rawResponse) {
        return { userResponse: '', signal: null };
    }

    // Look for the signal delimiter
    const signalMatch = rawResponse.match(
        /<<<SINGULARITY_BATCH_REQUEST>>>([\s\S]*?)<<<END_BATCH_REQUEST>>>/
    );

    if (!signalMatch) {
        return {
            userResponse: rawResponse.trim(),
            signal: null
        };
    }

    // Extract user-facing response (everything before the signal)
    const userResponse = rawResponse
        .substring(0, rawResponse.indexOf('<<<SINGULARITY_BATCH_REQUEST>>>'))
        .trim();

    // Parse the signal content
    const signalContent = signalMatch[1];
    const signal = parseSignalContent(signalContent);

    return {
        userResponse,
        signal
    };
}

/**
 * Parse the content inside the batch request delimiters
 */
function parseSignalContent(content: string): ConciergeSignal {
    if (!content) return null;

    // Extract TYPE
    const typeMatch = content.match(/TYPE:\s*(\w+)/i);
    const type = typeMatch?.[1]?.toUpperCase();

    // Extract PROMPT (everything after "PROMPT:")
    const promptMatch = content.match(/PROMPT:\s*([\s\S]*?)$/);
    const batchPrompt = promptMatch?.[1]?.trim() || '';

    if (!batchPrompt) {
        console.warn('[parsing-utils] Signal detected but no batch prompt found');
        return null;
    }

    if (type === 'WORKFLOW') {
        const goalMatch = content.match(/GOAL:\s*(.+?)(?=\n(?:STEP:|BLOCKER:|CONTEXT:|PROMPT:)|$)/s);
        const contextMatch = content.match(/CONTEXT:\s*(.+?)(?=\n(?:PROMPT:)|$)/s);

        return {
            type: 'GENERATE_WORKFLOW',
            goal: goalMatch?.[1]?.trim() || '',
            context: contextMatch?.[1]?.trim() || '',
            batchPrompt
        };
    }

    if (type === 'STEP_HELP') {
        const stepMatch = content.match(/STEP:\s*(.+?)(?=\n(?:BLOCKER:|CONTEXT:|PROMPT:)|$)/s);
        const blockerMatch = content.match(/BLOCKER:\s*(.+?)(?=\n(?:CONTEXT:|PROMPT:)|$)/s);
        const contextMatch = content.match(/CONTEXT:\s*(.+?)(?=\n(?:PROMPT:)|$)/s);

        return {
            type: 'STEP_HELP_NEEDED',
            step: stepMatch?.[1]?.trim() || '',
            blocker: blockerMatch?.[1]?.trim() || '',
            constraint: contextMatch?.[1]?.trim() || '',
            batchPrompt
        };
    }

    console.warn(`[parsing-utils] Unknown signal type: ${type}`);
    return null;
}

/**
 * Validate a batch prompt for quality
 */
export function validateBatchPrompt(prompt: string): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (!prompt) {
        issues.push('Prompt is empty');
        return { valid: false, issues };
    }

    // Check for expert role at start
    const startsWithRole = /^You are (a |an |the )/i.test(prompt.trim());
    if (!startsWithRole) {
        issues.push('Prompt should start with an expert role definition ("You are a...")');
    }

    // Check for specificity
    if (prompt.length < 200) {
        issues.push('Prompt seems too short—may lack necessary context');
    }

    // Check for generic role
    const genericRoles = [
        /You are an? (expert|assistant|helper|AI)/i,
        /You are an? (software engineer|developer|marketer)\.?\s/i, // Too generic if no qualifiers
    ];
    if (genericRoles.some(p => p.test(prompt))) {
        issues.push('Expert role may be too generic—add specific credentials and experience');
    }

    // Check for context section
    if (!/context|situation|background/i.test(prompt)) {
        issues.push('Prompt may be missing context section');
    }

    // Check for output specification
    if (!/provide|create|generate|output|deliverable/i.test(prompt)) {
        issues.push('Prompt may be missing clear output specification');
    }

    return {
        valid: issues.length === 0,
        issues
    };
}

// ============================================================================
// CONCIERGE HANDOFF PARSING (Phase 2: Conversational Evolution)
// ============================================================================

/**
 * Regex to match handoff blocks in concierge responses.
 * Supports both standard and escaped tag variants.
 * Format:
 *   ---HANDOFF---
 *   constraints: item1; item2
 *   eliminated: item1; item2
 *   preferences: item1; item2
 *   context: item1; item2
 *   >>>COMMIT: decision summary
 *   ---/HANDOFF---
 */
const HANDOFF_REGEX = /---HANDOFF---\r?\n?([\s\S]*?)---\/HANDOFF---/;

/**
 * Regex for COMMIT signal (unique marker to avoid false positives)
 */
const COMMIT_MARKER_REGEX = />>>COMMIT:\s*(.+)$/m;

/**
 * Placeholders to reject - model echoing instructions verbatim
 */
const BLOCKED_COMMIT_PLACEHOLDERS = [
    '[decision summary]',
    '[what was decided and what user wants to do next]',
    '[only if user commits to a plan or requests execution guidance — summarize decision and intent]',
    '[only if user commits to a plan or requests execution guidance - summarize decision and intent]',
];

export interface ParsedHandoffResponse {
    /** Response to show the user (handoff block stripped) */
    userFacing: string;
    /** Parsed handoff data or null if no handoff block found */
    handoff: ConciergeDelta | null;
}

/**
 * Parse concierge response to extract and strip handoff block.
 * Returns both the user-facing text and the parsed handoff delta.
 * 
 * @param raw - Raw concierge response text
 * @returns ParsedHandoffResponse with userFacing text and optional handoff
 */
export function parseHandoffResponse(raw: string): ParsedHandoffResponse {
    if (!raw || typeof raw !== 'string') {
        return { userFacing: raw || '', handoff: null };
    }

    const match = raw.match(HANDOFF_REGEX);

    if (!match) {
        return { userFacing: raw.trim(), handoff: null };
    }

    // Strip the handoff block from user-facing response
    const userFacing = raw.replace(HANDOFF_REGEX, '').trim();

    // Parse the handoff block content
    const handoff = parseHandoffBlock(match[1]);

    return { userFacing, handoff };
}

/**
 * Parse the COMMIT field with echo rejection.
 * Rejects template placeholders that indicate the model is echoing instructions.
 * 
 * @param text - Full handoff block content
 * @returns Commit string or null if not found/rejected
 */
function parseCommitField(text: string): string | null {
    const match = text.match(COMMIT_MARKER_REGEX);
    if (!match?.[1]) return null;

    const commitText = match[1].trim();
    const lowerText = commitText.toLowerCase();

    // 1. Block exact template placeholders
    if (BLOCKED_COMMIT_PLACEHOLDERS.some(p => lowerText === p.toLowerCase())) {
        return null;
    }

    // 2. Block short bracketed content (≤3 words) — likely placeholder
    if (/^\[.+\]$/.test(commitText)) {
        const inner = commitText.slice(1, -1).trim();
        const wordCount = inner.split(/\s+/).length;
        if (wordCount <= 3) {
            return null;
        }
    }

    return commitText;
}

/**
 * Parse the content inside ---HANDOFF--- block into ConciergeDelta.
 * Handles semicolon-separated values, COMMIT signal, and graceful degradation.
 * 
 * @param text - Content inside the handoff delimiters
 * @returns Parsed ConciergeDelta structure
 */
function parseHandoffBlock(text: string): ConciergeDelta {
    const delta: ConciergeDelta = {
        constraints: [],
        eliminated: [],
        preferences: [],
        context: [],
        commit: null
    };

    if (!text || typeof text !== 'string') {
        return delta;
    }

    // Parse COMMIT field separately (special handling with echo rejection)
    delta.commit = parseCommitField(text);

    // Parse other fields
    for (const line of text.split('\n')) {
        // Skip lines that are COMMIT (already handled)
        if (line.trim().startsWith('>>>COMMIT:')) continue;

        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();

        // Skip empty values or explicit "none"
        if (!value || value.toLowerCase() === 'none') continue;

        // Parse semicolon-separated items, trim whitespace, filter empty
        const items = value
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        // Map to appropriate bucket
        switch (key) {
            case 'constraints':
            case 'constraint':
                delta.constraints = items;
                break;
            case 'eliminated':
            case 'eliminate':
            case 'ruled out':
            case 'ruled_out':
                delta.eliminated = items;
                break;
            case 'preferences':
            case 'preference':
            case 'trade-offs':
            case 'tradeoffs':
                delta.preferences = items;
                break;
            case 'context':
            case 'situation':
            case 'situational':
                delta.context = items;
                break;
            // Silently ignore unknown keys (including 'committed' etc)
        }
    }

    return delta;
}

/**
 * Check if a ConciergeDelta has any meaningful content.
 * Used to avoid storing/injecting empty handoffs.
 * 
 * @param delta - ConciergeDelta to check
 * @returns true if any bucket has items or commit is set
 */
export function hasHandoffContent(delta: ConciergeDelta | null | undefined): boolean {
    if (!delta) return false;
    return (
        delta.constraints.length > 0 ||
        delta.eliminated.length > 0 ||
        delta.preferences.length > 0 ||
        delta.context.length > 0 ||
        delta.commit !== null
    );
}

/**
 * Format handoff context for injection into batch prompts.
 * Returns a human-readable block if handoff has content, null otherwise.
 * 
 * @param handoff - ConciergeDelta to format
 * @returns Formatted context string or null
 */
export function formatHandoffContext(handoff: ConciergeDelta | null | undefined): string | null {
    if (!handoff || !hasHandoffContent(handoff)) {
        return null;
    }

    const lines = ['[Conversation context since last analysis:]'];

    if (handoff.constraints.length > 0) {
        lines.push(`Constraints: ${handoff.constraints.join('; ')}`);
    }
    if (handoff.eliminated.length > 0) {
        lines.push(`Ruled out: ${handoff.eliminated.join('; ')}`);
    }
    if (handoff.preferences.length > 0) {
        lines.push(`Preferences: ${handoff.preferences.join('; ')}`);
    }
    if (handoff.context.length > 0) {
        lines.push(`Situation: ${handoff.context.join('; ')}`);
    }

    return lines.join('\n');
}

/**
 * Format handoff for echo back to concierge on Turn 3+.
 * Shows current handoff state so model can update or carry forward.
 * NEVER includes commit - that triggers fresh spawn, no echo needed.
 * 
 * @param handoff - Current ConciergeDelta to echo
 * @returns Formatted echo block to prepend to user message
 */
export function formatHandoffEcho(handoff: ConciergeDelta): string {
    const lines: string[] = ['Your current handoff (update if needed):'];
    lines.push('');
    lines.push('---CURRENT_HANDOFF---');

    if (handoff.constraints.length > 0) {
        lines.push(`constraints: ${handoff.constraints.join('; ')}`);
    }
    if (handoff.eliminated.length > 0) {
        lines.push(`eliminated: ${handoff.eliminated.join('; ')}`);
    }
    if (handoff.preferences.length > 0) {
        lines.push(`preferences: ${handoff.preferences.join('; ')}`);
    }
    if (handoff.context.length > 0) {
        lines.push(`context: ${handoff.context.join('; ')}`);
    }
    // NEVER echo >>>COMMIT — it triggers fresh spawn, no echo needed

    lines.push('---/CURRENT_HANDOFF---');
    lines.push('');

    return lines.join('\n');
}

/**
 * Create an empty ConciergeDelta.
 * Useful for initialization.
 */
export function createEmptyHandoff(): ConciergeDelta {
    return {
        constraints: [],
        eliminated: [],
        preferences: [],
        context: [],
        commit: null
    };
}

