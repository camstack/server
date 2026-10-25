/**
 * The rotated-file cursor (D898): a byte position in one daily file.
 *
 * Files are append-only, so a position never moves while the file grows —
 * that is the whole reason a cursor can be a byte offset. It is opaque to
 * every caller (`w1.` + base64url JSON) and validated on the way back in: a
 * cursor is client input, and its file name reaches `path.join`.
 */
import { z } from 'zod'

/** `camstack-YYYY-MM-DD.log`, as `winston-daily-rotate-file` names them. */
export const LOG_FILE_NAME_RE: RegExp = /^camstack-\d{4}-\d{2}-\d{2}\.log$/

const CURSOR_PREFIX = 'w1.'

/** A position in one daily file. */
export interface FileCursor {
  /** The daily file's name (never a path). */
  readonly f: string
  /** A line-start byte offset in that file. */
  readonly o: number
}

const FileCursorSchema: z.ZodType<FileCursor> = z.object({
  /** The daily file's name (never a path). */
  f: z.string().regex(LOG_FILE_NAME_RE),
  /** A line-start byte offset in that file. */
  o: z.number().int().nonnegative(),
})

export function encodeFileCursor(cursor: FileCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

/** Null for anything this provider did not mint. */
export function decodeFileCursor(raw: string): FileCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX)) return null
  try {
    const json: unknown = JSON.parse(
      Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    )
    const parsed = FileCursorSchema.safeParse(json)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
