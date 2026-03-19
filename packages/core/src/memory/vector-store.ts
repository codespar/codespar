/**
 * Vector Store — Semantic memory for agents using embeddings.
 *
 * MVP: Uses in-memory cosine similarity with deterministic hash-based
 * pseudo-embeddings. No external API calls required.
 * Future: pgvector for persistent storage + real embedding model.
 */

export interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  category: "code" | "conversation" | "pattern" | "incident";
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
}

/** Embedding dimensionality for the hash-based approach. */
const EMBEDDING_DIMS = 128;

export class VectorStore {
  private entries: MemoryEntry[] = [];

  /** Add a memory entry with auto-generated embedding. */
  async add(
    entry: Omit<MemoryEntry, "id" | "embedding" | "createdAt">,
  ): Promise<MemoryEntry> {
    const embedding = await this.generateEmbedding(entry.content);
    const full: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      embedding,
      createdAt: new Date(),
    };
    this.entries.push(full);
    return full;
  }

  /** Search for semantically similar entries using cosine similarity. */
  async search(
    query: string,
    limit: number = 5,
    category?: MemoryEntry["category"],
  ): Promise<SearchResult[]> {
    const queryEmbedding = await this.generateEmbedding(query);

    let candidates = this.entries;
    if (category) {
      candidates = candidates.filter((e) => e.category === category);
    }

    const scored = candidates.map((entry) => ({
      entry,
      score: this.cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Get all entries for a specific agent. */
  getAgentMemories(agentId: string): MemoryEntry[] {
    return this.entries.filter((e) => e.agentId === agentId);
  }

  /** Get memory stats (total count and breakdown by category). */
  getStats(): { total: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const e of this.entries) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    }
    return { total: this.entries.length, byCategory };
  }

  /**
   * Generate a deterministic embedding vector from text.
   *
   * Uses character-level hashing with unigram and bigram features.
   * This gives basic similarity matching without needing an embedding API.
   * The result is L2-normalized so cosine similarity = dot product.
   *
   * Future: Replace with text-embedding-3-small or similar.
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const embedding = new Array(EMBEDDING_DIMS).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const words = normalized.split(/\s+/).filter(Boolean);

    for (const word of words) {
      // Unigram character features
      for (let i = 0; i < word.length; i++) {
        const idx = (word.charCodeAt(i) * (i + 1) * 31) % EMBEDDING_DIMS;
        embedding[idx] += 1;
      }
      // Bigram character features for better discrimination
      for (let i = 0; i < word.length - 1; i++) {
        const bigram = word.charCodeAt(i) * 256 + word.charCodeAt(i + 1);
        embedding[bigram % EMBEDDING_DIMS] += 0.5;
      }
    }

    // L2-normalize to unit vector
    const magnitude =
      Math.sqrt(embedding.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    return embedding.map((v: number) => v / magnitude);
  }

  /** Cosine similarity between two unit vectors (= dot product). */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
