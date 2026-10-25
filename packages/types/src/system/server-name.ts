import { z } from 'zod'

/**
 * The hub's human name (D861): ONE `system-settings` row, `server.name`.
 *
 * Nothing writes it by itself. An unset name is not an error and not a stored
 * default: every reader falls back to the machine hostname and says so with
 * `isDefault: true`, so a consumer can tell a name somebody chose from one the
 * hub made up.
 */

/** The `system-settings` key of the stored name. */
export const SERVER_NAME_SETTING_KEY = 'server.name'

/** The longest a name may be, after trimming. */
export const SERVER_NAME_MAX_LENGTH = 48

/** C0 controls, DEL and the C1 range: none of them belongs in a name. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/** A name an operator may save: trimmed, 1-48 characters, no control characters. */
export const ServerNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'The server name cannot be empty')
      .max(
        SERVER_NAME_MAX_LENGTH,
        `The server name is at most ${SERVER_NAME_MAX_LENGTH} characters`,
      )
      .refine((value) => !hasControlCharacter(value), {
        message: 'The server name cannot contain control characters',
      }),
  )

/** What every reader gets: the name to show, and whether the hub chose it itself. */
export const ServerNameInfoSchema = z.object({
  name: z.string(),
  /** `true` when nobody named the hub: `name` is the machine hostname. */
  isDefault: z.boolean(),
})
export type ServerNameInfo = z.infer<typeof ServerNameInfoSchema>

/** What an unset name shows when the hostname says nothing about the hub. */
export const SERVER_NAME_FALLBACK = 'CamStack'

/** A container id: Docker's default hostname (12 hex chars, or the full 64). */
const CONTAINER_ID_PATTERN = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/

/**
 * The hostname without its domain (`nas.lan.example` becomes `nas`). A hostname
 * that names nothing (empty, `localhost`, a container id) yields
 * {@link SERVER_NAME_FALLBACK}.
 */
export function shortHostname(hostname: string): string {
  const first = hostname.trim().split('.')[0] ?? ''
  if (first.length === 0 || first.toLowerCase() === 'localhost') return SERVER_NAME_FALLBACK
  if (CONTAINER_ID_PATTERN.test(first)) return SERVER_NAME_FALLBACK
  return first
}

/**
 * Resolve a stored value (whatever the row held, `undefined` when unset) and the
 * machine hostname into what readers show. A stored value that does not
 * validate is treated as unset: a damaged row must not title the hub.
 */
export function resolveServerName(stored: unknown, hostname: string): ServerNameInfo {
  const parsed = ServerNameSchema.safeParse(stored)
  if (parsed.success) return { name: parsed.data, isDefault: false }
  return { name: shortHostname(hostname), isDefault: true }
}
