/**
 * A tRPC error line about a camera has to say WHICH camera.
 *
 * Sibling of `trpc-error-principal.ts`, and the same failure one field over.
 * That one exists because a refusal did not say WHO; this one because a refusal
 * did not say WHAT. On 2026-08-29 a scoped user was refused four times on
 * `intercom.startSession`, and the four lines carried code, path, principal and
 * message — but no `deviceId`. "Is talk-back broken on every camera, or on the
 * doorbell?" is the first question asked, and the log could not answer it. The
 * repo rule is unconditional: every log line about a device carries
 * `tags: { deviceId }` with the numeric id.
 *
 * The deviceIds are read from the request input through the SAME codegen'd
 * selector table the scope matcher uses (`METHOD_DEVICE_SELECTORS`, via
 * `referencedDeviceIds`), so a path that gains or loses a `deviceId` field
 * cannot leave the log tag behind.
 *
 * A request naming several devices tags the FIRST and records the count —
 * `tags` is a flat index-friendly map, and a batch refusal is one event about
 * one call, not N events. `deviceCount` is what tells a reader the line is
 * about a batch rather than a single camera.
 */

import type { LogTags } from '@camstack/types'
import { referencedDeviceIds } from './scope-access.js'

/**
 * Log tags for one tRPC error, empty when the call names no device.
 *
 * Extends {@link LogTags} rather than restating a shape: these values go
 * straight into `logger.warn(..., { tags })`, and `deviceId` there is already
 * spelled and typed — numeric id, never a name, never a stableId.
 */
export interface TrpcErrorDeviceTags extends LogTags {
  readonly deviceId?: number
  /** Present only when the refused call named more than one device. */
  readonly deviceCount?: number
}

/**
 * Device tags for a tRPC error line. Returns `{}` — never a partial or a
 * placeholder id — when the path names no device: a system-scope call is not
 * "about device 0".
 */
export function trpcErrorDeviceTags(path: string | undefined, input: unknown): TrpcErrorDeviceTags {
  if (path === undefined) return {}
  const ids = referencedDeviceIds(path, input)
  const first = ids[0]
  if (first === undefined) return {}
  return ids.length > 1 ? { deviceId: first, deviceCount: ids.length } : { deviceId: first }
}
