/**
 * The recording decision, reduced to a token the export fingerprint can carry.
 *
 * ## Why this exists
 *
 * An accessory is built once, and `computeExportFingerprint` decides whether to
 * rebuild it. Until now that fingerprint covered `{deviceId, deviceType,
 * features}` only — none of which move when a camera's RTSP profiles finally
 * arrive. So a camera whose profiles were not readable at build time was
 * refused HKSV with `no-enabled-stream`, the refusal was recorded, and every
 * later reconcile found the fingerprint unchanged and no-opped. **The refusal
 * was permanent.** Measured on 592 on 2026-09-21: three enabled H.264 profiles
 * live, availability still reading `no-enabled-stream`.
 *
 * The picker was never the problem — {@link pickRecordingSource} chooses the
 * right slot, automatically, and this module does not re-implement one line of
 * it. The problem was that its answer was not part of what the fingerprint
 * describes.
 *
 * ## Why the SLOT and not a boolean
 *
 * The recording child pulls one slot, and the clip inherits that slot's
 * resolution and GOP. A camera that gains a bigger copyable profile should
 * rebuild onto it, so `rec:mid` and `rec:high` must be different fingerprints —
 * not both "recordable".
 *
 * ## Why `null` is a case of its own
 *
 * An unreadable profile list is indistinguishable, by any other signal, from a
 * camera that has no profiles. Folding it into `rec:none` would tear down and
 * republish a working accessory on every transient read failure — the exact
 * churn the fingerprint exists to prevent, and a visible one: a rebuild is a
 * detach, a re-attach and a `c#` bump in HomeKit. `null` means *do not move the
 * fingerprint*; the caller carries the persisted value forward, the same
 * discipline `resolveExportFingerprint` already applies to a not-yet-probed
 * device.
 */
import type { RtspEntryLike } from '@camstack/types'

import type { RecordingSourceOptions } from './recording-source.js'
import { pickRecordingSource } from './recording-source.js'

/** No slot is recordable. A real answer, and a fingerprint-moving one. */
export const RECORDABILITY_NONE = 'rec:none'

/**
 * The slot HKSV would record from, as a fingerprint token.
 *
 * `null` when `entries` is null — the profiles could not be read, which is not
 * a claim about the camera.
 */
export function recordabilityToken(
  entries: readonly RtspEntryLike[] | null,
  options: RecordingSourceOptions = {},
): string | null {
  if (entries === null) return null
  const choice = pickRecordingSource(entries, options)
  // The refusal is deliberately NOT in the token: every refusal means the same
  // thing to the accessory — no recording service — and spelling out which one
  // would rebuild an accessory when a camera merely changed HOW it is
  // unrecordable.
  // The BRANCH is part of the token: a camera that starts being transcoded is
  // a different accessory to run — a permanent encoder instead of a copy — and
  // the operator flipping `allowTranscode` must therefore rebuild it.
  return choice.ok
    ? `rec:${choice.source.profile}${choice.source.transcode ? '+x' : ''}`
    : RECORDABILITY_NONE
}

/** What {@link withRecordabilityToken} needs to decide. */
export interface RecordabilityFingerprintInput {
  /** The device-shape fingerprint, before any recording token. */
  readonly base: string
  /** {@link recordabilityToken}'s answer — `null` when the profiles were unreadable. */
  readonly token: string | null
  /** The fingerprint last ADVERTISED for this device, if any. */
  readonly persisted: string | undefined
}

const TOKEN_SUFFIX = /\|(rec:[^|]*)$/

/**
 * Attach the recording token to a device-shape fingerprint.
 *
 * On an unreadable read the persisted token is carried forward — but only onto
 * the base it was persisted against. If the device's SHAPE also changed, that
 * change is a rebuild in its own right and the token has nothing to say about
 * it; inventing one there would advertise a recording slot nobody read.
 */
export function withRecordabilityToken(input: RecordabilityFingerprintInput): string {
  if (input.token !== null) return `${input.base}|${input.token}`
  const carried = input.persisted?.match(TOKEN_SUFFIX)
  if (carried === null || carried === undefined) return input.base
  return carried.input?.slice(0, carried.index) === input.base
    ? `${input.base}|${carried[1]}`
    : input.base
}

/** What decides whether this camera CAN record, and from where. */
export interface RecordabilityInput {
  /** The per-camera transcode switch. Absent means allowed, as everywhere. */
  readonly allowTranscode?: boolean
  /** The camera's RTSP profiles, or `null` when they could not be read. */
  readonly entries: readonly RtspEntryLike[] | null
}

/**
 * What this camera could record, as one fingerprint token.
 *
 * There used to be an `rec:off` here, for a per-camera switch of ours. That
 * switch is gone (D589): whether HomeKit RECORDS is HomeKit's own persisted
 * characteristic, it does not change the accessory's shape, and a rebuild is
 * about shape. What still belongs here is the CAPABILITY — which slot, and
 * whether serving it means running an encoder — because those are two
 * different accessories to build.
 */
export function recordabilityTokenFor(input: RecordabilityInput): string | null {
  return recordabilityToken(input.entries, { allowTranscode: input.allowTranscode !== false })
}
