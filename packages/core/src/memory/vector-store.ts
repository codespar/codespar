/**
 * Vector Store — Semantic memory for agents using TF-IDF embeddings.
 *
 * Uses Term Frequency-Inverse Document Frequency (TF-IDF) vectors with
 * cosine similarity for search. Captures word-level semantics without
 * external API dependencies.
 *
 * Vocabulary is built incrementally and TF-IDF vectors are recomputed
 * when the vocabulary grows significantly (every REINDEX_THRESHOLD entries).
 *
 * Future: pgvector for persistent storage + real embedding model.
 */

/** Categories for memory entries. */
type MemoryCategory = "code" | "conversation" | "pattern" | "incident";

export interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  category: MemoryCategory;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * Internal representation storing raw content alongside its TF-IDF vector.
 * The `tfidf` field is recomputed when vocabulary changes.
 */
interface VectorEntry {
  id: string;
  agentId: string;
  content: string;
  category: MemoryCategory;
  metadata: Record<string, unknown>;
  createdAt: Date;
  tokens: string[];
  tfidf: number[];
}

/** How many new entries before triggering a full TF-IDF reindex. */
const REINDEX_THRESHOLD = 50;

// -- Stopwords ----------------------------------------------------------------

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
]);

// -- Tokenizer ----------------------------------------------------------------

/**
 * Tokenize text into stemmed, lowercased terms with stopword removal.
 *
 * Applies basic suffix stripping (ing, tion, ed, ly, es, s) to collapse
 * word forms without needing a full stemmer library.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => stem(w));
}

/** Basic suffix stemmer — good enough for TF-IDF without external deps. */
function stem(word: string): string {
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

// -- TF-IDF helpers -----------------------------------------------------------

/**
 * Compute term frequency map for a token list.
 * TF = (count of term in doc) / (total terms in doc)
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * L2-normalize a vector in place and return it.
 * Returns a zero vector unchanged rather than producing NaN.
 */
function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  if (sumSq === 0) return vec;
  const mag = Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) {
    vec[i] /= mag;
  }
  return vec;
}

// -- VectorStore --------------------------------------------------------------

export class VectorStore {
  private entries: VectorEntry[] = [];

  /**
   * Global vocabulary: maps each unique stem to a stable column index.
   * Grows as new entries are added.
   */
  private vocab: Map<string, number> = new Map();

  /**
   * Inverse document frequency cache.
   * idf(t) = log(N / (1 + df(t)))   where df = # docs containing t.
   * Recomputed on reindex.
   */
  private idfCache: Map<string, number> = new Map();

  /** Document frequency: how many entries contain each term. */
  private df: Map<string, number> = new Map();

  /** Counter of entries added since the last full reindex. */
  private sinceLastReindex = 0;

  // -- Public API (unchanged signatures) ------------------------------------

  /** Add a memory entry with auto-generated TF-IDF embedding. */
  async add(
    entry: Omit<MemoryEntry, "id" | "embedding" | "createdAt">,
  ): Promise<MemoryEntry> {
    const tokens = tokenize(entry.content);

    // Update vocabulary and document-frequency counts
    const seenTerms = new Set(tokens);
    for (const term of seenTerms) {
      if (!this.vocab.has(term)) {
        this.vocab.set(term, this.vocab.size);
      }
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }

    const ve: VectorEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      tokens,
      tfidf: [], // computed below
    };

    this.entries.push(ve);
    this.sinceLastReindex++;

    // Reindex all vectors when vocabulary has grown enough, otherwise
    // just compute the new entry's vector with current IDF values.
    if (this.sinceLastReindex >= REINDEX_THRESHOLD) {
      this.reindex();
    } else {
      this.updateIdfCache();
      ve.tfidf = this.computeTfidf(ve.tokens);
    }

    return this.toMemoryEntry(ve);
  }

  /** Search for semantically similar entries using cosine similarity. */
  async search(
    query: string,
    limit: number = 5,
    category?: MemoryEntry["category"],
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryVec = this.computeTfidf(queryTokens);

    let candidates = this.entries;
    if (category) {
      candidates = candidates.filter((e) => e.category === category);
    }

    const scored: SearchResult[] = candidates.map((ve) => ({
      entry: this.toMemoryEntry(ve),
      score: this.cosineSimilarity(queryVec, ve.tfidf),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Get all entries for a specific agent. */
  getAgentMemories(agentId: string): MemoryEntry[] {
    return this.entries
      .filter((e) => e.agentId === agentId)
      .map((e) => this.toMemoryEntry(e));
  }

  /** Get memory stats (total count and breakdown by category). */
  getStats(): { total: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const e of this.entries) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    }
    return { total: this.entries.length, byCategory };
  }

  // -- Internal ---------------------------------------------------------------

  /**
   * Full reindex: recompute IDF values and all entry TF-IDF vectors.
   * Called every REINDEX_THRESHOLD additions so older entries benefit
   * from updated IDF weights.
   */
  private reindex(): void {
    this.updateIdfCache();
    for (const entry of this.entries) {
      entry.tfidf = this.computeTfidf(entry.tokens);
    }
    this.sinceLastReindex = 0;
  }

  /** Recompute IDF cache from current document-frequency counts. */
  private updateIdfCache(): void {
    const n = this.entries.length;
    this.idfCache.clear();
    for (const [term, docFreq] of this.df) {
      // Smooth IDF: log(N / (1 + df)) — avoids division by zero and
      // dampens very common terms.
      this.idfCache.set(term, Math.log(n / (1 + docFreq)));
    }
  }

  /**
   * Compute a TF-IDF vector for the given token list against the
   * current vocabulary and IDF cache.
   *
   * The vector has one dimension per vocabulary term and is L2-normalized
   * so that cosine similarity reduces to a dot product.
   */
  private computeTfidf(tokens: string[]): number[] {
    const vocabSize = this.vocab.size;
    if (vocabSize === 0) return [];

    const vec = new Array<number>(vocabSize).fill(0);
    const tf = termFrequency(tokens);

    for (const [term, tfVal] of tf) {
      const idx = this.vocab.get(term);
      if (idx === undefined) continue; // query term not in vocab
      const idf = this.idfCache.get(term) ?? 0;
      vec[idx] = tfVal * idf;
    }

    return l2Normalize(vec);
  }

  /** Convert internal VectorEntry to public MemoryEntry. */
  private toMemoryEntry(ve: VectorEntry): MemoryEntry {
    return {
      id: ve.id,
      agentId: ve.agentId,
      content: ve.content,
      category: ve.category,
      embedding: ve.tfidf,
      metadata: ve.metadata,
      createdAt: ve.createdAt,
    };
  }

  /** Cosine similarity between two L2-normalized vectors (= dot product). */
  private cosineSimilarity(a: number[], b: number[]): number {
    // Handle mismatched lengths gracefully (vocab may have grown since
    // b was computed — extra dimensions in a are effectively zero in b).
    const len = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
