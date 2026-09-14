import type { OutlineTopic, ShareDetail, Utterance } from "./shareClient.js";

/** Rendering helpers for archived transcripts. Pure functions, easy to test. */

/** Milliseconds (or seconds) offset -> `h:mm:ss` / `mm:ss`. */
export function timecode(value: number | undefined, { assumeSeconds = false } = {}): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "--:--";
  const totalSeconds = Math.floor(assumeSeconds ? value : value / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Duration in ms -> "10m 35s" / "1h 04m". */
export function humanDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "unknown length";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** `[mm:ss] Speaker: text`, one utterance per line. */
export function transcriptToText(utterances: Utterance[] | undefined): string {
  if (!utterances?.length) return "";
  return utterances
    .map((u) => {
      const who = u.speaker || u.original_speaker || "Speaker";
      const text = (u.content ?? "").trim();
      return `[${timecode(u.start_time)}] ${who}: ${text}`;
    })
    .join("\n");
}

export function outlineToText(topics: OutlineTopic[] | undefined): string {
  if (!topics?.length) return "";
  return topics.map((t) => `- [${timecode(t.start_time)}] ${(t.topic ?? "").trim()}`).join("\n");
}

/** A readable markdown archive of everything the share exposed. */
export function detailToMarkdown(detail: ShareDetail, sourceLabel: string): string {
  const f = detail.data_file ?? {};
  const started = f.start_time ? new Date(f.start_time).toISOString() : "unknown";
  const lines: string[] = [
    `# ${f.filename?.trim() || "Untitled recording"}`,
    "",
    `- Source: Plaud share ${sourceLabel}`,
    `- Recorded: ${started}`,
    `- Length: ${humanDuration(f.duration)}`,
    `- Language: ${f.file_language ?? "unknown"}`,
    detail.owner_name ? `- Shared by: ${detail.owner_name}` : "",
    "",
  ].filter(Boolean);

  for (const note of f.notes_list ?? []) {
    const body = (note.data_content ?? "").trim();
    if (!body) continue;
    lines.push(`## ${note.data_title?.trim() || note.data_tab_name?.trim() || "Notes"}`, "", body, "");
  }

  const outline = outlineToText(f.outline_result);
  if (outline) lines.push("## Outline", "", outline, "");

  const polished = transcriptToText(f.transaction_polish);
  const raw = transcriptToText(f.trans_result);
  if (polished) lines.push("## Transcript (AI-polished)", "", polished, "");
  if (raw) lines.push(polished ? "## Transcript (original)" : "## Transcript", "", raw, "");

  return lines.join("\n") + "\n";
}

/** Filesystem-safe slug from a recording title. Never lets a title escape the archive dir. */
export function slugify(title: string | undefined, fallback = "recording"): string {
  const slug = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || fallback;
}
