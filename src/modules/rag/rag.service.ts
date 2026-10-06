import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
/** Pinecone dense upsert batch size. */
const UPSERT_BATCH = 50;

export type RagPassage = { text: string; score: number };

/**
 * Optional RAG layer for tax_code_delta:
 * OpenAI embeddings + Pinecone store/search.
 * No-ops cleanly when PINECONE_API_KEY / PINECONE_INDEX are unset.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private openai: OpenAI | null = null;
  private pinecone: Pinecone | null = null;

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    const apiKey = this.config.get<string>('pinecone.apiKey') ?? '';
    const index = this.config.get<string>('pinecone.index') ?? '';
    const openaiKey = this.config.get<string>('openai.apiKey') ?? '';
    return Boolean(apiKey.trim() && index.trim() && openaiKey.trim());
  }

  /**
   * Chunk + embed + upsert extracted research text into a per-session namespace.
   * Returns number of chunks indexed (0 if disabled or on failure).
   */
  async indexSessionText(
    sessionId: string,
    text: string,
    metadata?: Record<string, string>,
  ): Promise<number> {
    if (!this.isEnabled()) {
      return 0;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return 0;
    }

    try {
      const openai = this.requireOpenAi();
      const pinecone = this.requirePinecone();
      const indexName = this.config.get<string>('pinecone.index') ?? '';
      const index = pinecone.index(indexName);
      const namespace = sessionNamespace(sessionId);

      const records: Array<{
        id: string;
        values: number[];
        metadata: Record<string, string>;
      }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const values = await this.embed(openai, chunk);
        if (values.length === 0) {
          continue;
        }
        records.push({
          id: `${sessionId}-${i}-${Date.now()}`,
          values,
          metadata: {
            sessionId,
            chunkIndex: String(i),
            text: chunk.slice(0, 8000),
            ...metadata,
          },
        });
      }

      for (let i = 0; i < records.length; i += UPSERT_BATCH) {
        const batch = records.slice(i, i + UPSERT_BATCH);
        await index.namespace(namespace).upsert({ records: batch });
      }

      this.logger.log(
        `Indexed ${records.length} chunk(s) for session ${sessionId}`,
      );
      return records.length;
    } catch (err) {
      this.logger.warn(
        `RAG index failed for session ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /**
   * Embed query and return top matching passages for this session.
   */
  async retrieve(
    sessionId: string,
    query: string,
    topK = 5,
  ): Promise<RagPassage[]> {
    if (!this.isEnabled()) {
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const openai = this.requireOpenAi();
      const pinecone = this.requirePinecone();
      const indexName = this.config.get<string>('pinecone.index') ?? '';
      const vector = await this.embed(openai, trimmed);
      if (vector.length === 0) {
        return [];
      }

      const result = await pinecone
        .index(indexName)
        .namespace(sessionNamespace(sessionId))
        .query({
          vector,
          topK,
          includeMetadata: true,
        });

      return (result.matches ?? [])
        .map((match) => ({
          text:
            typeof match.metadata?.text === 'string' ? match.metadata.text : '',
          score: match.score ?? 0,
        }))
        .filter((row) => row.text.length > 0);
    } catch (err) {
      this.logger.warn(
        `RAG retrieve failed for session ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  private requireOpenAi(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: this.config.get<string>('openai.apiKey') ?? '',
      });
    }
    return this.openai;
  }

  private requirePinecone(): Pinecone {
    if (!this.pinecone) {
      this.pinecone = new Pinecone({
        apiKey: this.config.get<string>('pinecone.apiKey') ?? '',
      });
    }
    return this.pinecone;
  }

  private async embed(openai: OpenAI, text: string): Promise<number[]> {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: this.config.get<number>('pinecone.dimension'),
    });
    return res.data[0]?.embedding ?? [];
  }
}

export function chunkText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function sessionNamespace(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `session-${safe}`;
}
