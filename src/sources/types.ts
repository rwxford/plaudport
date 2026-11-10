/**
 * Source adapter interface (PRD FR2; P0-PLAN §5). `pull` talks only to this;
 * which backend answers (official MCP, reverse-engineered web API, a drop
 * folder, a share link) is the adapter's business.
 */

export interface RecordingSummary {
  id: string;
  name: string | null;
  startAt: string; // ISO 8601, UTC
  createdAt: string; // ISO 8601, UTC (sync time)
  durationMs: number | null;
  serialNumber: string | null;
  /** The listing item as Plaud returned it, for meta.json (archive only). */
  raw: unknown;
}

export interface RecordingDetail extends RecordingSummary {
  /** Presigned audio URL. Never persisted, never logged. */
  audioUrl: string | null;
  /** When we obtained the URL — the 23 h freshness rule keys off this. */
  audioUrlIssuedAt: string;
  /** get_file minus presigned_url / data_link, for meta.json. */
  rawDetail: unknown;
}

export type TranscriptBlockName = "transaction" | "transaction_polish" | "outline" | "mark_memo";
export interface TranscriptBlock {
  block: TranscriptBlockName;
  items: unknown[];
  /**
   * `items`: content returned. `empty`: the block exists and Plaud says it is
   * empty (for highlights, a legitimate final answer). `unavailable`: no such
   * block yet — still pending.
   */
  status: "items" | "empty" | "unavailable";
}
export interface PlaudText {
  transcript: TranscriptBlock[];
  note: unknown[] | null;
}

export interface SourceStats {
  requests: number;
  rateLimited: number;
  retries: number;
}

export interface RecordingSource {
  readonly name: "plaud-mcp" | "plaud-web" | "file" | "share";
  list(window: { from: string; to: string }, page: { page: number; pageSize: number }): Promise<RecordingSummary[]>;
  detail(id: string): Promise<RecordingDetail>;
  /** All four transcript blocks (every cursor page) plus the note. */
  text(id: string): Promise<PlaudText>;
  health(): Promise<{ ok: boolean; note: string }>;
  stats(): SourceStats;
  close(): Promise<void>;
}

/** Credentials missing/expired. The message is the owner's next step. */
export class AuthError extends Error {
  readonly kind = "auth";
}

/** A source call failed in a way worth retrying later (network, 5xx, 429 exhausted). */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly errorClass: string,
  ) {
    super(message);
  }
}

export class NotImplemented extends Error {}
