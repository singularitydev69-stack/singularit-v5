/**
 * Reactive Context Bridge
 * Matches user messages against previous turn's claim structure
 * to inject relevant context into the next batch prompt.
 * 
 * Zero external dependencies. Optimized for browser extensions.
 */
import { EnrichedClaim, Edge, StructuralAnalysis } from "../../shared/contract";

// ============================================================================
// TYPES
// ============================================================================

interface TermEntry {
  canonical: string;
  claimIds: Set<string>;
  weight: number;
  isProperNoun: boolean;
}

interface TermIndex {
  terms: Map<string, TermEntry>;
  claimTerms: Map<string, string[]>;
}

// ============================================================================
// TERM RELATIONS (Derived Synonyms from Claim Structure)
// ============================================================================

interface TermRelations {
  related: Map<string, Set<string>>;    // Terms in supporting claims
  opposing: Map<string, Set<string>>;   // Terms in conflicting claims
}

interface TermIndexWithRelations extends TermIndex {
  relations: TermRelations;
}

interface MatchedClaim {
  id: string;
  label: string;
  text: string;
  tier: 'peak' | 'hill' | 'floor';
  supportRatio: number;
  matchScore: number;
}

interface RelevantEdge {
  type: string;
  fromLabel: string;
  toLabel: string;
}

export interface ReactiveBridge {
  matched: MatchedClaim[];
  edges: RelevantEdge[];
  context: string;
}

// Partial analysis type for storage (only what we need)
export type StoredAnalysis = Pick<StructuralAnalysis, 'claimsWithLeverage' | 'edges'>;

// ============================================================================
// CONSTANTS
// ============================================================================

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  'about', 'between', 'under', 'again', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because',
  'what', 'which', 'who', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'you', 'your', 'he', 'him', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'want', 'like', 'think', 'know',
  'use', 'make', 'get', 'go', 'say', 'see', 'come', 'take'
]);

const TECH_TERMS = new Set([
  'react', 'vue', 'svelte', 'angular', 'node', 'typescript', 'javascript',
  'python', 'rust', 'go', 'aws', 'gcp', 'azure', 'docker', 'kubernetes',
  'postgresql', 'mongodb', 'redis', 'graphql', 'rest', 'api', 'sdk', 'cli',
  'mvp', 'saas', 'b2b', 'b2c', 'ui', 'ux'
]);

// ✅ FIX: Compile tech term regex once at module level (Performance Fix)
const TECH_TERM_REGEX = new RegExp(
  `\\b(${Array.from(TECH_TERMS).join('|')})\\b`,
  'gi'
);

// ============================================================================
// FUZZY MATCHING (Zero Dependencies)
// ============================================================================

/**
 * Compute the Levenshtein edit distance between two strings with an optional early cutoff.
 *
 * @param a - The first string to compare
 * @param b - The second string to compare
 * @param maxDistance - Maximum distance to consider; if the actual distance exceeds this value the function returns `maxDistance + 1`
 * @returns The number of single-character edits required to transform `a` into `b`. Returns `maxDistance + 1` when the distance exceeds `maxDistance`.
 */
function levenshtein(a: string, b: string, maxDistance: number = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap to ensure a is shorter (optimization)
  if (a.length > b.length) [a, b] = [b, a];

  // If length difference exceeds maxDistance, bail early
  if (b.length - a.length > maxDistance) return maxDistance + 1;

  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1]
        ? row[j - 1]
        : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;

    // Early termination: if entire row exceeds threshold, stop
    if (Math.min(...row) > maxDistance) return maxDistance + 1;
  }

  return row[b.length];
}

/**
 * Computes character n-gram overlap similarity between two strings.
 *
 * Measures similarity as the size of the intersection of n-gram sets divided by their union (Jaccard index).
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @param n - N-gram size to use (default 2). Values greater than the length of either string yield 0.
 * @returns A number in [0, 1] representing n-gram overlap (1 = identical n-gram sets, 0 = no overlap)
 */
function ngramSimilarity(a: string, b: string, n: number = 2): number {
  if (a === b) return 1.0;
  if (a.length < n || b.length < n) return 0;

  const getNgrams = (s: string): Set<string> => {
    const ngrams = new Set<string>();
    for (let i = 0; i <= s.length - n; i++) {
      ngrams.add(s.slice(i, i + n));
    }
    return ngrams;
  };

  const ngramsA = getNgrams(a);
  const ngramsB = getNgrams(b);

  let intersection = 0;
  for (const ng of ngramsA) {
    if (ngramsB.has(ng)) intersection++;
  }

  const union = ngramsA.size + ngramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Determines whether two term strings should be considered a fuzzy match.
 *
 * Uses multiple strategies appropriate to term lengths (exact and substring checks,
 * edit-distance for short tokens, and n-gram similarity for longer tokens) to
 * decide if the terms are plausibly the same or related.
 *
 * @param userTerm - The term coming from the user's message
 * @param indexedTerm - The term stored in the index to compare against
 * @param threshold - Similarity threshold used for n-gram comparison (default: 0.8)
 * @returns `true` if the terms are considered a match, `false` otherwise.
 */
function fuzzyMatch(userTerm: string, indexedTerm: string, threshold: number = 0.8): boolean {
  // Exact match
  if (userTerm === indexedTerm) return true;

  // Substring match (e.g., "react" matches "reactjs")
  if (userTerm.includes(indexedTerm) || indexedTerm.includes(userTerm)) {
    const shorter = Math.min(userTerm.length, indexedTerm.length);
    const longer = Math.max(userTerm.length, indexedTerm.length);
    return shorter / longer > 0.6;
  }

  // Levenshtein for short words (handles typos)
  if (userTerm.length <= 6 && indexedTerm.length <= 6) {
    const maxDistance = userTerm.length <= 4 ? 1 : 2;
    return levenshtein(userTerm, indexedTerm, maxDistance) <= maxDistance;
  }

  // N-gram for longer words
  if (userTerm.length > 4 && indexedTerm.length > 4) {
    return ngramSimilarity(userTerm, indexedTerm, 2) >= threshold;
  }

  return false;
}

// ============================================================================
// TERM EXTRACTION
// ============================================================================

/**
 * Produces a lightweight stem of a word by removing or normalizing common English suffixes.
 *
 * This is a heuristic, not a full linguistic stemmer: words of length three or less are returned unchanged,
 * and common endings such as -ing, -ed, -ly, -ment, -ness, -ation, -tion, -sion, -able, -ible, -ful, and -less
 * are simplified to produce a canonical root useful for approximate matching and indexing.
 *
 * @param word - The input word to stem
 * @returns The stemmed form of `word` suitable for lightweight term normalization
 */
function stem(word: string): string {
  if (word.length <= 3) return word; // Don't stem very short words

  return word
    .replace(/ies$/, 'y')        // "stories" → "story"
    .replace(/ing$/, '')         // "running" → "run"
    .replace(/ed$/, '')          // "walked" → "walk"
    .replace(/ly$/, '')          // "quickly" → "quick"
    .replace(/ment$/, '')        // "development" → "develop"
    .replace(/ness$/, '')        // "happiness" → "happi"
    .replace(/ity$/, '')         // "simplicity" → "simplic"
    .replace(/ation$/, 'ate')    // "validation" → "validate"
    .replace(/tion$/, 't')       // "connection" → "connect"
    .replace(/sion$/, 's')       // "decision" → "decis"
    .replace(/able$/, '')        // "readable" → "read"
    .replace(/ible$/, '')        // "visible" → "vis"
    .replace(/ful$/, '')         // "helpful" → "help"
    .replace(/less$/, '');       // "helpless" → "help"
}

/**
 * Extracts likely proper nouns and recognized technical terms from the given text.
 *
 * The function skips the first token to avoid sentence-start capitalization, strips non-alphanumeric
 * characters from detected proper nouns, and includes technical terms detected by the module's
 * technical-term matcher. The result is deduplicated.
 *
 * @param text - Input text to analyze for proper nouns and technical terms
 * @returns An array of unique terms: detected proper nouns (preserved as extracted) and detected
 * technical terms (normalized to lower case)
 */
function extractProperNouns(text: string): string[] {
  const words = text.split(/\s+/);
  const properNouns: string[] = [];

  // Skip first word (might be capitalized as sentence start)
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z0-9]/g, '');
    if (word.length > 1 && word[0] === word[0].toUpperCase()) {
      properNouns.push(word);
    }
  }

  // Tech terms - single pass with compiled regex
  const matches = text.match(TECH_TERM_REGEX) || [];

  return [...new Set([...properNouns, ...matches.map(m => m.toLowerCase())])];
}

/**
 * Extracts normalized term variants from input text for indexing and matching.
 *
 * Returns a deduplicated set of lowercase tokens derived from the input, including:
 * normalized words (stopwords and short tokens removed), stemmed variants, detected proper nouns,
 * and label bigrams when `isLabel` is true.
 *
 * @param text - The source text or label to extract terms from.
 * @param isLabel - If true, include adjacent-word bigrams to capture phrase signals from labels.
 * @returns A deduplicated array of lowercase term tokens used for matching and indexing.
 */
function extractTerms(text: string, isLabel: boolean): string[] {
  // Step 1: Extract proper nouns BEFORE lowercasing
  const properNouns = extractProperNouns(text);

  // Step 2: Normalize and tokenize
  const normalized = text.toLowerCase()
    .replace(/[^a-z0-9-\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Step 3: Apply stemming
  const stemmed = normalized.map(stem).filter(w => w.length > 2);

  // Step 4: Extract bigrams from labels (higher signal)
  const bigrams: string[] = [];
  if (isLabel && normalized.length >= 2) {
    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.push(`${normalized[i]}_${normalized[i + 1]}`);
    }
  }

  // Step 5: Combine all term variants (deduped)
  return [...new Set([
    ...normalized,                           // Original words
    ...stemmed,                              // Stemmed variants
    ...bigrams,                              // Phrase bigrams
    ...properNouns.map(p => p.toLowerCase()) // Proper nouns
  ])];
}

// ============================================================================
// TERM RELATIONS (Enhancement from Document 2)
// ============================================================================

/**
 * Builds mappings of related and opposing terms derived from claim edges.
 *
 * For edges of type `supports` or `prerequisite`, terms from the source and target claims
 * are recorded as related to each other (bidirectional). For edges of type `conflicts`,
 * terms from the source claim are recorded as opposing the terms in the target claim.
 *
 * @param edges - Array of claim edges that describe relationships between claims
 * @param claimTerms - Map from claim ID to the list of extracted terms for that claim
 * @returns An object with two maps:
 *  - `related`: term -> set of contextually related terms
 *  - `opposing`: term -> set of opposing terms
 */
function buildTermRelations(
  edges: Edge[],
  claimTerms: Map<string, string[]>
): TermRelations {
  const related = new Map<string, Set<string>>();
  const opposing = new Map<string, Set<string>>();

  for (const edge of edges) {
    const termsFrom = claimTerms.get(edge.from) || [];
    const termsTo = claimTerms.get(edge.to) || [];

    if (edge.type === 'supports' || edge.type === 'prerequisite') {
      // Terms in supporting claims are contextually related
      for (const termA of termsFrom) {
        if (!related.has(termA)) related.set(termA, new Set());
        for (const termB of termsTo) {
          if (termA !== termB) related.get(termA)!.add(termB);
        }
      }
      // Bidirectional
      for (const termB of termsTo) {
        if (!related.has(termB)) related.set(termB, new Set());
        for (const termA of termsFrom) {
          if (termA !== termB) related.get(termB)!.add(termA);
        }
      }
    }

    if (edge.type === 'conflicts') {
      // Terms in conflicting claims are opposing
      for (const termA of termsFrom) {
        if (!opposing.has(termA)) opposing.set(termA, new Set());
        for (const termB of termsTo) {
          if (termA !== termB) opposing.get(termA)!.add(termB);
        }
      }
    }
  }

  return { related, opposing };
}

// ============================================================================
// TERM INDEX BUILDER (Updated to include relations)
// ============================================================================

/**
 * Builds a term index and relation mappings from the provided claims and edges.
 *
 * Extracts searchable terms from each claim's label and text, computes a simple
 * IDF-like weight for each term, marks technical proper nouns, and derives
 * related/opposing term relations based on the provided edges.
 *
 * @param claims - Array of enriched claims to extract and index terms from
 * @param edges - Claim edges used to infer related and opposing term relations
 * @returns A TermIndexWithRelations containing:
 *  - `terms`: map of term → TermEntry (canonical form, claim ids, weight, isProperNoun)
 *  - `claimTerms`: map of claim id → list of terms associated with that claim
 *  - `relations`: related and opposing term mappings derived from edges
 */
function buildTermIndex(
  claims: EnrichedClaim[],
  edges: Edge[]
): TermIndexWithRelations {
  const termCounts = new Map<string, Set<string>>();
  const claimTerms = new Map<string, string[]>();

  // Step 1: Extract terms from all claims
  for (const claim of claims) {
    const labelTerms = extractTerms(claim.label, true);
    const textTerms = extractTerms(claim.text, false);

    const allTerms = [...new Set([...labelTerms, ...textTerms])];
    claimTerms.set(claim.id, allTerms);

    for (const term of allTerms) {
      if (!termCounts.has(term)) {
        termCounts.set(term, new Set());
      }
      termCounts.get(term)!.add(claim.id);
    }
  }

  // Step 2: Calculate IDF-like weights
  const totalClaims = claims.length;
  const terms = new Map<string, TermEntry>();

  for (const [term, claimIds] of termCounts) {
    const frequency = claimIds.size / totalClaims;
    const weight = frequency < 0.1 ? 0.5 :
      frequency < 0.3 ? 1.0 :
        frequency < 0.5 ? 0.7 : 0.3;

    terms.set(term, {
      canonical: term,
      claimIds,
      weight,
      isProperNoun: TECH_TERMS.has(term)
    });
  }

  // Step 3: Build term relations from edges
  const relations = buildTermRelations(edges, claimTerms);

  return { terms, claimTerms, relations };
}

// ============================================================================
// MATCHING ENGINE (Updated with relations fallback)
// ============================================================================

/**
 * Incrementally adds weighted score contributions for each claim referenced by a term entry.
 *
 * Applies the term entry's weight scaled by `multiplier` and a proper-noun boost (if the entry is marked as a proper noun)
 * and updates the provided `scores` map in place by adding the computed value to each claim's existing score.
 *
 * @param entry - The term entry containing `claimIds`, `weight`, and `isProperNoun` used to compute contributions
 * @param multiplier - A scalar applied to the term weight to adjust contribution magnitude
 * @param scores - Map from claim ID to accumulated score; this map is mutated by adding contributions for each claim
 */
function addScores(
  entry: TermEntry,
  multiplier: number,
  scores: Map<string, number>
): void {
  const boost = entry.isProperNoun ? 2.0 : 1.0;
  for (const claimId of entry.claimIds) {
    const current = scores.get(claimId) || 0;
    scores.set(claimId, current + entry.weight * multiplier * boost);
  }
}

/**
 * Score claims by matching terms extracted from a user message against a term index.
 *
 * Extracts terms from `userMessage` and for each term attempts, in order: an exact match (weight 1.0),
 * a fuzzy match against indexed terms (weight 0.9), and finally matches against related terms from
 * `termIndex.relations.related` (weight 0.5). Scores from multiple matches accumulate per claim; related-term
 * matches may contribute multiple times.
 *
 * @param userMessage - Free-text input to extract and match terms from
 * @param termIndex - Term index (including relations) used to find matching TermEntry objects
 * @returns A map from claim ID to aggregated score where higher values indicate stronger matches
 */
function matchUserMessage(
  userMessage: string,
  termIndex: TermIndexWithRelations
): Map<string, number> {
  const userTerms = extractTerms(userMessage, false);
  const claimScores = new Map<string, number>();

  for (const userTerm of userTerms) {
    let matched = false;

    // Priority 1: Exact match (weight: 1.0)
    if (termIndex.terms.has(userTerm)) {
      const entry = termIndex.terms.get(userTerm)!;
      addScores(entry, 1.0, claimScores);
      matched = true;
      continue;
    }

    // Priority 2: Fuzzy match (weight: 0.9)
    if (!matched) {
      for (const [term, entry] of termIndex.terms) {
        if (fuzzyMatch(userTerm, term)) {
          addScores(entry, 0.9, claimScores);
          matched = true;
          break;
        }
      }
    }

    // Priority 3: Related term match (weight: 0.5)
    if (!matched) {
      const relatedTerms = termIndex.relations.related.get(userTerm);
      if (relatedTerms) {
        for (const relatedTerm of relatedTerms) {
          if (termIndex.terms.has(relatedTerm)) {
            addScores(termIndex.terms.get(relatedTerm)!, 0.5, claimScores);
            // Don't break - accumulate all related matches
          }
        }
      }
    }
  }

  return claimScores;
}

// ============================================================================
// BRIDGE BUILDER
/**
 * Categorizes a claim's support ratio into a tier label.
 *
 * @param supportRatio - A numeric support ratio, typically between 0 and 1
 * @returns `'peak'` if `supportRatio` > 0.5, `'hill'` if `supportRatio` > 0.25, `'floor'` otherwise
 */

function getTier(supportRatio: number): 'peak' | 'hill' | 'floor' {
  if (supportRatio > 0.5) return 'peak';
  if (supportRatio > 0.25) return 'hill';
  return 'floor';
}

/**
 * Build a concise ReactiveBridge that injects the most relevant claims and edges from a previous analysis into the next prompt based on a user message.
 *
 * @param userMessage - The user's latest message to match against the previous analysis
 * @param previousAnalysis - StoredAnalysis containing `claimsWithLeverage` and `edges` from a prior turn
 * @returns A ReactiveBridge with up to three matched claims, up to four relevant edges, and a formatted context string; `null` if `previousAnalysis` is missing required arrays or no matching claims are found
 */
export function buildReactiveBridge(
  userMessage: string,
  previousAnalysis: StoredAnalysis
): ReactiveBridge | null {
  const claims = previousAnalysis?.claimsWithLeverage;
  const edges = previousAnalysis?.edges;
  if (!Array.isArray(claims) || !Array.isArray(edges)) return null;

  // Step 1: Build term index WITH relations
  const termIndex = buildTermIndex(claims, edges);

  // Step 2: Match user message (now uses relations as fallback)
  const claimScores = matchUserMessage(userMessage, termIndex);

  // Step 3: No matches → no bridge needed
  if (claimScores.size === 0) {
    return null;
  }

  // Step 4: Get top 3 matched claims
  const sortedClaims = [...claimScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const matchedIds = new Set(sortedClaims.map(([id]) => id));

  const matched: MatchedClaim[] = sortedClaims.map(([id, score]) => {
    const claim = claims.find(c => c.id === id);
    if (!claim) return null;
    return {
      id,
      label: claim.label,
      text: claim.text,
      tier: getTier(claim.supportRatio),
      supportRatio: claim.supportRatio,
      matchScore: score
    };
  }).filter((c): c is MatchedClaim => c !== null);

  // Step 5: Get relevant edges (between matched claims or matched → peak)
  const peakIds = new Set(
    claims.filter(c => c.supportRatio > 0.5).map(c => c.id)
  );

  const relevantEdges = edges.filter(e => {
    const fromMatched = matchedIds.has(e.from);
    const toMatched = matchedIds.has(e.to);
    const fromPeak = peakIds.has(e.from);
    const toPeak = peakIds.has(e.to);

    // Edge between matched claims
    if (fromMatched && toMatched) return true;
    // Edge from matched to peak (context)
    if (fromMatched && toPeak) return true;
    // Edge from peak to matched (context)
    if (fromPeak && toMatched) return true;

    return false;
  }).slice(0, 4); // Max 4 edges

  const formattedEdges: RelevantEdge[] = relevantEdges.map(e => ({
    type: e.type,
    fromLabel: claims.find(c => c.id === e.from)?.label || e.from,
    toLabel: claims.find(c => c.id === e.to)?.label || e.to
  }));

  // Step 6: Format context string
  const context = formatBridge(matched, formattedEdges);

  return { matched, edges: formattedEdges, context };
}

/**
 * Builds a compact, human-readable context string representing matched claims and their relationships.
 *
 * @param matched - Matched claims to include; each will appear with a tier icon, its label, and coverage percentage.
 * @param edges - Relevant edges to include; each will be rendered as a single-line relationship between claim labels.
 * @returns A multi-line string suitable for prompt injection containing a header, the matched claim lines, and optional edge lines.
 */
function formatBridge(matched: MatchedClaim[], edges: RelevantEdge[]): string {
  const lines: string[] = ['[Context from prior turn:]'];

  for (const m of matched) {
    const icon = m.tier === 'peak' ? '▲' : m.tier === 'hill' ? '◆' : '○';
    const pct = Math.round(m.supportRatio * 100);
    lines.push(`${icon} "${m.label}" (${pct}%)`);
  }

  if (edges.length > 0) {
    lines.push('');
    for (const e of edges) {
      const verb = e.type === 'conflicts' ? '↔ conflicts' :
        e.type === 'supports' ? '→ supports' :
          e.type === 'tradeoff' ? '⇄ tradeoff' :
            e.type === 'prerequisite' ? '→ requires' : '—';
      lines.push(`  ${e.fromLabel} ${verb} ${e.toLabel}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// CACHING (Performance Optimization)
// ============================================================================

const termIndexCache = new Map<string, TermIndexWithRelations>();

/**
 * Constructs a ReactiveBridge for the given user message using a term index cached by turn to speed repeated queries.
 *
 * @param userMessage - The user's input text to match against the previous analysis
 * @param previousAnalysis - Stored analysis containing `claimsWithLeverage` and `edges` used to build the term index
 * @param turnId - Identifier for the current turn; used as the cache key for reusing a built term index
 * @returns A ReactiveBridge containing matched claims, relevant edges, and a formatted context, or `null` if the input analysis is invalid or no matches were found
 */
export function buildReactiveBridgeCached(
  userMessage: string,
  previousAnalysis: StoredAnalysis,
  turnId: string
): ReactiveBridge | null {
  if (!previousAnalysis || !Array.isArray(previousAnalysis.claimsWithLeverage) || !Array.isArray(previousAnalysis.edges)) {
    return null;
  }
  // Check cache
  let termIndex = termIndexCache.get(turnId);
  if (!termIndex) {
    termIndex = buildTermIndex(previousAnalysis.claimsWithLeverage, previousAnalysis.edges);
    termIndexCache.set(turnId, termIndex);

    // Limit cache size (keep last 5 turns)
    if (termIndexCache.size > 5) {
      const oldestKey = termIndexCache.keys().next().value;
      if (oldestKey) termIndexCache.delete(oldestKey);
    }
  }

  // Use cached index for matching
  const claimScores = matchUserMessage(userMessage, termIndex);

  if (claimScores.size === 0) {
    return null;
  }
const claims = previousAnalysis.claimsWithLeverage;
  const edges = previousAnalysis.edges;

  const sortedClaims = [...claimScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const matchedIds = new Set(sortedClaims.map(([id]) => id));

  const matched: MatchedClaim[] = sortedClaims.map(([id, score]) => {
    const claim = claims.find(c => c.id === id);
    if (!claim) return null;
    return {
      id,
      label: claim.label,
      text: claim.text,
      tier: getTier(claim.supportRatio),
      supportRatio: claim.supportRatio,
      matchScore: score
    };
  }).filter((c): c is MatchedClaim => c !== null);

  const peakIds = new Set(claims.filter(c => c.supportRatio > 0.5).map(c => c.id));

  const relevantEdges = edges.filter(e => {
    const fromMatched = matchedIds.has(e.from);
    const toMatched = matchedIds.has(e.to);
    const fromPeak = peakIds.has(e.from);
    const toPeak = peakIds.has(e.to);
    return (fromMatched && toMatched) || (fromMatched && toPeak) || (fromPeak && toMatched);
  }).slice(0, 4);

  const formattedEdges: RelevantEdge[] = relevantEdges.map(e => ({
    type: e.type,
    fromLabel: claims.find(c => c.id === e.from)?.label || e.from,
    toLabel: claims.find(c => c.id === e.to)?.label || e.to
  }));

  const context = formatBridge(matched, formattedEdges);

  return { matched, edges: formattedEdges, context };
}