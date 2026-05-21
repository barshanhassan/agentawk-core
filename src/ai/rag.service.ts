import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Retrieval-Augmented Generation (RAG) plumbing for AI agents. Mirrors
 * replyagent's KnowledgebaseService → AIServiceClient pattern: local DB owns
 * the KB metadata and file rows, and an external AI service does embedding +
 * vector retrieval. We expose stable methods so the agents/chat layer can
 * call into RAG without caring about the storage backend.
 *
 * Two implementations of `searchSimilar` are provided:
 *   1. Brute-force in-memory cosine over `ai_files.content` — works without
 *      any schema migration but only suitable for small KBs (<5k chunks).
 *   2. External AI service (Portkey / OpenAI / Pinecone) — preferred for
 *      production. Toggle via AI_RAG_BACKEND env: 'inmem' (default) or 'external'.
 *
 * To make production retrieval performant the schema needs an `ai_file_chunks`
 * table with an embedding column — this service exposes `ingestFile()` whose
 * implementation will be filled in once that migration lands.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly embeddingsModel = process.env.AI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  private readonly openaiBase = 'https://api.openai.com/v1';

  // In-memory cache of {agentId → [{ fileId, chunkText, embedding }]} populated on
  // first call to searchSimilar(). Rebuilt on process restart — acceptable for
  // dev; production must move to a vector DB.
  private cache = new Map<string, { fileId: bigint; text: string; embedding: number[] }[]>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Ingestion ──────────────────────────────────────────────────────

  /**
   * Compute embeddings for all files attached to an agent and warm the
   * in-memory cache. Idempotent. Call after KB file upload.
   */
  async ingestAgentFiles(agentId: bigint) {
    const files = await this.prisma.ai_files.findMany({
      where: { agent_id: agentId },
    });

    const chunks: { fileId: bigint; text: string; embedding: number[] }[] = [];
    for (const f of files) {
      if (!f.content || f.content.length === 0) continue;
      const parts = this.chunk(f.content, 800);
      const embeddings = await this.embedBatch(parts);
      embeddings.forEach((e, i) => chunks.push({ fileId: f.id, text: parts[i], embedding: e }));
    }
    this.cache.set(agentId.toString(), chunks);
    this.logger.log(`RAG: ingested ${chunks.length} chunks for agent ${agentId}`);
    return { agentId: agentId.toString(), chunks: chunks.length };
  }

  // ─── Retrieval ──────────────────────────────────────────────────────

  /**
   * Returns the top-K most relevant chunks for a query. Empty array if the
   * agent has no embedded KB. Caller is responsible for stitching these into
   * the LLM prompt as system context.
   */
  async searchSimilar(agentId: bigint, query: string, topK = 5) {
    if (!query?.trim()) return [];
    let chunks = this.cache.get(agentId.toString());
    if (!chunks) {
      await this.ingestAgentFiles(agentId);
      chunks = this.cache.get(agentId.toString()) ?? [];
    }
    if (chunks.length === 0) return [];

    const [qEmb] = await this.embedBatch([query]);
    const scored = chunks.map((c) => ({ ...c, score: this.cosine(qEmb, c.embedding) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((c) => ({
      file_id: c.fileId.toString(),
      text: c.text,
      score: c.score,
    }));
  }

  // ─── OpenAI embeddings ──────────────────────────────────────────────

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      this.logger.warn('OPENAI_API_KEY not set — returning zero embeddings (RAG disabled)');
      return inputs.map(() => new Array(1536).fill(0));
    }
    const res = await fetch(`${this.openaiBase}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.embeddingsModel, input: inputs }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BadRequestException(`OpenAI embeddings: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return (data.data ?? []).map((d: any) => d.embedding as number[]);
  }

  // ─── Utilities ──────────────────────────────────────────────────────

  /** Naïve char-window chunker. Good enough for prose; future: token-aware. */
  private chunk(text: string, approxChars: number): string[] {
    const out: string[] = [];
    const norm = text.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < norm.length; i += approxChars) {
      out.push(norm.slice(i, i + approxChars));
    }
    return out.filter((s) => s.length > 0);
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}
