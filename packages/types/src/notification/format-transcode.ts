/**
 * Pure format transcoding for the notification degrade engine (Apprise-style).
 * No I/O — used by both the system `notifiers` addon and the HA addon (which
 * may not cross-import), so it lives in `@camstack/types`.
 */
import type { NotificationFormat } from '../capabilities/notification-output.cap.js'

export type { NotificationFormat }

/** Strip a small, safe subset of Markdown down to plain text. */
export function markdownToText(md: string): string {
  return (
    md
      // images ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // links [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // bold / italic **x** __x__ *x* _x_
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // inline code `x`
      .replace(/`([^`]*)`/g, '$1')
      // headings + blockquotes at line start
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      // unordered / ordered list markers
      .replace(/^\s{0,3}[-*+]\s+/gm, '')
      .replace(/^\s{0,3}\d+\.\s+/gm, '')
      .trim()
  )
}

const HTML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
]

/** Strip HTML tags, decode a few entities, map block/br elements to newlines. */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  for (const [re, rep] of HTML_ENTITIES) out = out.replace(re, rep)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

const HTML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#39;'],
]

function escapeHtml(text: string): string {
  let out = text
  for (const [re, rep] of HTML_ESCAPES) out = out.replace(re, rep)
  return out
}

/** Plain text → HTML-lite (escape + newlines to <br>). */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/** Markdown → HTML-lite (bold/italic/code/links; used e.g. for Pushover). */
export function markdownToHtmlLite(md: string): string {
  return escapeHtml(md)
    .replace(/(\*\*|__)(.*?)\1/g, '<b>$2</b>')
    .replace(/(\*|_)(.*?)\1/g, '<i>$2</i>')
    .replace(/`([^`]*)`/g, '<code>$1</code>')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br>')
}

/**
 * Preference order when the source format is NOT supported — first supported
 * entry wins. Encodes the Apprise-style "degrade DOWN, but preserve rendering
 * where a richer target exists" policy:
 *   - markdown → html (html-lite) before text (strip)
 *   - html     → text before markdown
 *   - text     → markdown before html (text is valid markdown)
 */
const DEGRADE_ORDER: Record<NotificationFormat, readonly NotificationFormat[]> = {
  text: ['text', 'markdown', 'html'],
  markdown: ['markdown', 'html', 'text'],
  html: ['html', 'text', 'markdown'],
}

/**
 * Pick the best target format the kind supports for a given source format.
 *
 * TOLERANT of a source outside the union. `NotificationSchema.format` carries
 * `.default('text')`, but that default only runs where the schema is PARSED —
 * the tRPC router. A cap call arriving from another addon (`ctx.api`) skips
 * that parse, so `format` reaches here `undefined`, and the bare
 * `DEGRADE_ORDER[source]` threw `is not iterable`. That broke the one promise
 * the degrade path makes ("never throws — degradation is reported, never
 * surfaced as an error") and dead-lettered every Notification-Center delivery
 * for a day (2026-07-30). An unknown source degrades like `text`.
 */
export function resolveFormat(
  source: NotificationFormat,
  supported: readonly NotificationFormat[],
): NotificationFormat {
  for (const candidate of DEGRADE_ORDER[source] ?? DEGRADE_ORDER.text) {
    if (supported.includes(candidate)) return candidate
  }
  return supported[0] ?? 'text'
}

/** Transcode a body between formats. */
export function transcodeBody(
  body: string,
  from: NotificationFormat,
  to: NotificationFormat,
): string {
  if (from === to) return body
  if (to === 'text') {
    if (from === 'markdown') return markdownToText(body)
    if (from === 'html') return htmlToText(body)
  }
  if (to === 'html') {
    if (from === 'text') return textToHtml(body)
    if (from === 'markdown') return markdownToHtmlLite(body)
  }
  if (to === 'markdown') {
    if (from === 'text') return body // plain text is valid markdown
    if (from === 'html') return htmlToText(body) // no html→md converter — degrade to text
  }
  return body
}
