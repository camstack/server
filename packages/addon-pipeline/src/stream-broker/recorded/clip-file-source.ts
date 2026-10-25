import type { CamProfile } from '@camstack/types'
import { indexClipMp4, type ClipIndexRefusalReason, type ClipMp4Index } from './clip-mp4-index.js'
import type { LocateResult } from './recorded-feeder.js'

/**
 * A FILE-backed byte source behind the existing `RecordedFeeder` (D575).
 *
 * The feeder never knew where its bytes came from: `RecordedFeederDeps` takes
 * `locate` / `readBytes` / `readGop` as injected closures, and the broker
 * happens to wire them to the recorder cap. This module is a second
 * implementation of the same two closures over ONE clip file, so a clip is
 * another position of the same source pointer rather than a second player.
 *
 * **The timeline is FILE-RELATIVE.** `epochMs` here is milliseconds from the
 * first sample of the clip, not wall time. That is the whole reason a clip can
 * reuse `seek` / `setRate` / `stepFrame` / `scrubTo` unchanged: they are all
 * pointer moves on whatever axis the source declares, and a clip's axis is its
 * own duration. Nothing downstream adds an epoch base to it.
 *
 * **D9/D18.** The clip crosses the process boundary ONCE, whole and already
 * compressed, by handle (`videoclips.readClipBytes`) — never a frame at a time.
 * After that every byte the feeder reads is in this process's memory, and the
 * decode happens where the feeder already decodes recordings.
 *
 * `readGop` is deliberately NOT offered. See `clip-mp4-index.ts`: a GOP-ranged
 * slice of a progressive MP4 is not standalone-demuxable without a remux, and
 * a clip already resident whole makes the whole-file read its own byte range —
 * the feeder degrades to that path on its own when `readGop` is absent.
 */

/** Which clip, at which twin. `profile` is the vendor's quality selector, not a recorded tier. */
export interface ClipHandle {
  readonly deviceId: number
  readonly clipId: string
  /** The `addonId` holding the bytes. Carried, never derived from the id. */
  readonly provider: string
  /** `null` ⇒ the provider's own default twin. */
  readonly profile: CamProfile | null
}

/** The one by-handle byte fetch. Resolves with the whole clip file. */
export type ClipBytesReader = (args: {
  deviceId: number
  clipId: string
  provider: string
  profile: CamProfile | null
}) => Promise<Uint8Array>

/** Why a clip cannot be played. Every value is reported and logged. */
export type ClipSourceRefusalReason = ClipIndexRefusalReason | 'fetch-failed' | 'too-large'

export class ClipSourceError extends Error {
  constructor(
    readonly reason: ClipSourceRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = 'ClipSourceError'
  }
}

export interface ClipFileSourceDeps {
  readonly handle: ClipHandle
  readonly read: ClipBytesReader
  /** Byte ceiling for one clip. Absent ⇒ {@link CLIP_SOURCE_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Diagnostic seam. A refusal that is not logged reads exactly like a clip
   *  that played — the branch that ACCEPTS work and produces nothing (D391). */
  onLog?(msg: string, data: Record<string, unknown>): void
}

export interface ClipFileSource {
  locate(args: { deviceId: number; profile: string; epochMs: number }): Promise<LocateResult>
  readBytes(args: { deviceId: number; profile: string; startMs: number }): Promise<Uint8Array>
  /** The indexed duration of this clip, in ms. Rejects with the same refusal
   *  `locate` would — the cheap question, asked before any pointer moves. */
  durationMs(): Promise<number>
}

/**
 * 64 MB. Above `VIDEOCLIPS_MAX_READ_BYTES` (50 MB) on purpose: the cap's own
 * bound refuses first and by name, and this one exists so a provider that ever
 * answers larger cannot pin a broker runner's heap. A `high` twin measured
 * 20–35 MB (D570 § 9.6).
 */
export const CLIP_SOURCE_MAX_BYTES = 64 * 1024 * 1024

interface ResolvedClip {
  readonly bytes: Uint8Array
  readonly index: ClipMp4Index
}

export function createClipFileSource(deps: ClipFileSourceDeps): ClipFileSource {
  const maxBytes = deps.maxBytes ?? CLIP_SOURCE_MAX_BYTES
  const { deviceId, clipId, provider, profile } = deps.handle
  let resolved: ResolvedClip | null = null
  let inFlight: Promise<ResolvedClip> | null = null
  /**
   * A refusal that can never change for this file — it is unindexable, or it
   * is over the bound. Cached so a drag does not re-fetch a 35 MB file per
   * pointer move. A FETCH failure is deliberately NOT cached: a sleeping
   * battery camera is a transient no, and the operator's retry must reach it.
   */
  let terminal: ClipSourceError | null = null

  const refuse = (
    reason: ClipSourceRefusalReason,
    message: string,
    data: Record<string, unknown>,
  ) => {
    const err = new ClipSourceError(reason, message)
    deps.onLog?.(message, { deviceId, clipId, provider, profile, reason, ...data })
    return err
  }

  const load = async (): Promise<ResolvedClip> => {
    let bytes: Uint8Array
    try {
      bytes = await deps.read({ deviceId, clipId, provider, profile })
    } catch (err) {
      throw refuse('fetch-failed', 'clip playback: byte fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (bytes.length > maxBytes) {
      terminal = refuse('too-large', 'clip playback: clip exceeds the broker byte bound', {
        bytes: bytes.length,
        maxBytes,
      })
      throw terminal
    }
    const index = indexClipMp4(bytes)
    if (index.kind === 'refused') {
      terminal = refuse(
        index.reason,
        'clip playback: clip cannot be indexed — it will not play in the recorded path',
        { bytes: bytes.length },
      )
      throw terminal
    }
    return { bytes, index }
  }

  const ensure = async (): Promise<ResolvedClip> => {
    if (terminal) throw terminal
    if (resolved) return resolved
    if (!inFlight) {
      inFlight = load()
        .then((r) => {
          resolved = r
          return r
        })
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  return {
    async locate(args) {
      const { index, bytes } = await ensure()
      if (args.epochMs >= index.durationMs) {
        return { kind: 'gap', nearestEdgeMs: null, prevEndMs: index.durationMs }
      }
      if (args.epochMs < index.firstSyncMs) {
        return { kind: 'gap', nearestEdgeMs: index.firstSyncMs, prevEndMs: null }
      }
      return { kind: 'segment', startMs: 0, durMs: index.durationMs, bytes: bytes.length }
    },
    async readBytes() {
      // The clip is ONE segment: `startMs` can only ever be its own start, so
      // the whole file is the answer and there is no range to honour.
      return (await ensure()).bytes
    },
    async durationMs() {
      return (await ensure()).index.durationMs
    },
  }
}
