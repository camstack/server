/**
 * The Hikvision `videoclips` provider — ONE source of a camera's clip
 * collection, listed BESIDE the analytics visits and never instead of them
 * (D549 1/2).
 *
 * ## What an empty answer means
 *
 * Never "this camera has no recordings" unless that is what was measured. The
 * honest states on this fleet are:
 *
 * - **`no-storage`** — the camera reports no usable card. 1441 and 3831 are
 *   both scheduled to record on MOTION to a card that is not there, so the
 *   two reads that answer this are worth making whether or not clips are ever
 *   played: they turn "no clips" into "no card", which is a different sentence
 *   and a different operator action.
 * - **`unreachable`** — the camera could not be reached, or answered a search
 *   result this provider could not read. Its own words travel verbatim.
 * - **`ok`** — and `ok` is MEASURED, never defaulted: the storage question is
 *   asked and the tracks are read before anything claims it. A default `ok`
 *   plus an empty list is the one sentence this whole line of work exists to
 *   stop a surface from having to guess at.
 *
 * `index-empty` is not answerable here and is deliberately not claimed: this
 * firmware exposes no day CALENDAR to contradict, so there is no second
 * authority to catch disagreeing with the index. `sleeping` is not reachable
 * either — every Hikvision camera on this fleet is mains-powered, and a state
 * nothing can produce would be a branch nothing tests.
 *
 * ## Every ask is served the 4K main copy, and it SAYS so
 *
 * `record/tracks` lists one archived track. There is no sub twin, so `low`,
 * `mid` and `high` are all answered with the same media and `served` says
 * `high` — an UPGRADE, where D599 built the field around downgrades. The
 * broker's own line fires only on a downgrade, so this provider logs the
 * upgrade itself: a `low` ask that cost 4K bytes is a line and not a surprise.
 */
import type {
  CamProfile,
  Clip,
  ClipBytes,
  ClipBytesOffer,
  ClipExportFailure,
  ClipPlayback,
  ClipSource,
  ClipSourceAvailability,
  ClipStreamAudioReason,
  ClipStreamDial,
  IScopedLogger,
  IVideoclipsProvider,
  PeerBytesTicket,
} from '@camstack/types'
import {
  CLIP_PLAYBACK_OPTIONS,
  type ClipPlaybackOptions,
  clipExportFailure,
  VIDEOCLIPS_MAX_OFFER_BYTES,
  VIDEOCLIPS_MAX_READ_BYTES,
} from '@camstack/types'

import { HIKVISION_ADDON_ID } from '../schema.js'
import type { HikvisionClipRow } from './clip-catalog.js'
import { CLIP_SOURCE_ONBOARD, clipKeyFor, mintClipId, parseClipId } from './clip-identity.js'
import type { ClipStreamAudioAsk } from './clip-stream.js'
import { chooseClipQuality } from './clip-twins.js'
import { narrowClipsToWindow } from './clip-window.js'

/** Everything the clip path needs to know about one camera. */
export interface ClipDeviceRef {
  readonly deviceId: number
  /** Which archived track the catalog reads. 101 on this fleet. */
  readonly trackId: number
  /** RTSP host. The ISAPI port is a different, unrelated number. */
  readonly host: string
  readonly username: string
  readonly password: string
}

export interface ReadCatalogInput {
  readonly device: ClipDeviceRef
  readonly sinceMs: number
  readonly untilMs: number
}

export type ReadCatalogOutcome =
  | { readonly kind: 'ok'; readonly rows: readonly HikvisionClipRow[] }
  | { readonly kind: 'refused'; readonly availability: ClipSourceAvailability }

export interface PrepareStreamDialInput {
  readonly device: ClipDeviceRef
  readonly row: HikvisionClipRow
  /**
   * Which audio codec the caller's session negotiated (D600), already narrowed
   * to what this provider can mux — `none` is a real ask and the only one a
   * caller that said nothing gets.
   */
  readonly audio: ClipStreamAudioAsk
}

export type PrepareStreamDialOutcome =
  | { readonly kind: 'ok'; readonly url: string; readonly expiresAtMs: number }
  | { readonly kind: 'refused'; readonly code: ClipExportFailure; readonly detail: string }

export interface PrepareClipBytesInput {
  readonly device: ClipDeviceRef
  readonly row: HikvisionClipRow
  readonly maxBytes: number
}

export type PrepareClipBytesOutcome =
  | {
      readonly kind: 'ok'
      readonly bytes: Buffer
      /** MEASURED on this pass, or `null`. Never the row's span (D393). */
      readonly durationMs: number | null
    }
  | { readonly kind: 'refused'; readonly code: ClipExportFailure; readonly detail: string }

/**
 * What {@link HikvisionVideoclipsDeps.prepareOffer} is asked, and answers.
 *
 * The outcome carries a TICKET rather than bytes: this provider's fetch path
 * already lands the clip in a scratch FILE, so the offer streams that file and
 * nothing is read into memory on either side (D613).
 */
export interface PrepareClipOfferInput {
  readonly device: ClipDeviceRef
  readonly row: HikvisionClipRow
  readonly maxBytes: number
}

export type PrepareClipOfferOutcome =
  | {
      readonly kind: 'ok'
      readonly ticket: PeerBytesTicket
      /** MEASURED on this pass, or `null`. Never the row's span (D393). */
      readonly durationMs: number | null
      readonly bytes: number
    }
  | { readonly kind: 'refused'; readonly code: ClipExportFailure; readonly detail: string }

export interface HikvisionVideoclipsDeps {
  readonly now: () => number
  readonly logger: IScopedLogger
  /** `null` when this device is not a Hikvision camera this addon owns. */
  resolveDevice(deviceId: number): Promise<ClipDeviceRef | null>
  /** Probe what this source can say RIGHT NOW — measured, never defaulted. */
  probeAvailability(device: ClipDeviceRef): Promise<ClipSourceAvailability>
  readCatalog(input: ReadCatalogInput): Promise<ReadCatalogOutcome>
  /** The player's URL, on this addon's own media plane. */
  playbackUrl(deviceId: number, clipKey: string): string
  /**
   * Is a still REALLY on disk for this clip?
   *
   * A `stat`, every time, never a memory of having minted one: the claim has
   * to survive a restart, an eviction and a half-finished write. It is what
   * separates `thumbnail` (a vouch) from `thumbnailMint` (an offer).
   */
  hasVouchedStill(deviceId: number, clipKey: string): Promise<boolean>
  /** The still route, on this addon's own thumb plane. */
  stillUrl(deviceId: number, clipKey: string): string
  prepareBytes(input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome>
  /** The same clip, offered over the addon→addon byte transport (D613). */
  prepareOffer(input: PrepareClipOfferInput): Promise<PrepareClipOfferOutcome>
  /** A one-shot URL for this clip's STREAM (D597), touching no camera. */
  prepareStreamDial(input: PrepareStreamDialInput): Promise<PrepareStreamDialOutcome>
}

/** What a refused read puts on its log line, beside the branch. */
interface ClipReadMeta {
  readonly clipKey?: string
  readonly listedBytes?: number
  readonly bytes?: number
  readonly bound?: number
}

/**
 * The name an export carries away.
 *
 * The camera's own handle is a bare counter (`ch01_00000000136000401`), which
 * says nothing to an operator looking at a downloads folder, so the start
 * stamp leads and the handle follows it. The extension is re-stated because
 * what we produce is an MP4 whatever the camera called its file.
 */
export function clipFileLabel(row: HikvisionClipRow): string {
  const stamp = new Date(row.startMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${stamp}_${row.fileName}.mp4`
}

export function createHikvisionVideoclipsProvider(
  deps: HikvisionVideoclipsDeps,
): IVideoclipsProvider {
  /** Last known availability per device, written by every read. */
  const health = new Map<number, ClipSourceAvailability>()
  /** Every row this provider has listed, by `deviceId|clipKey`, so playback
   *  and the dial resolve without re-searching the camera. */
  const rowsByKey = new Map<string, HikvisionClipRow>()

  const remember = (deviceId: number, rows: readonly HikvisionClipRow[]): void => {
    for (const row of rows) rowsByKey.set(`${String(deviceId)}|${row.clipKey}`, row)
  }

  /**
   * ASYNC, because the still is vouched by a `stat` and a vouch that guessed
   * would be worse than no still at all.
   */
  const toClip = async (
    deviceId: number,
    row: HikvisionClipRow,
    catalogAsOf: number,
  ): Promise<Clip> => ({
    id: mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      trackId: row.trackId,
      fileName: row.fileName,
    }),
    source: CLIP_SOURCE_ONBOARD,
    kind: row.recordTypes.includes('motion') ? 'motion' : 'native',
    timeRange: { startMs: row.startMs, endMs: row.endMs },
    // The camera's OWN type strings, unmapped. A firmware inventing a type
    // must not vanish: the mapping into our vocabulary is lossy on purpose and
    // this is the lossless copy (D549 20).
    ...(row.recordTypes.length > 0 ? { nativeTypes: [...row.recordTypes] } : {}),
    // Exactly ONE of three, never two (D315):
    //   • `thumbnail`  — a JPEG is really on disk, vouched by a `stat`.
    //   • `thumbnailMint` — an OFFER: the route answers 200 with the image or
    //     204 with a reason a tile can read. It is honoured by cutting a frame
    //     from the clip's own archived copy, which this provider already
    //     fetches once for the player, the export and the byte offer (D558).
    // There is no third branch here: absence of a still is never asserted
    // before anybody has asked for one. This camera has no sleeping state and
    // no wake to pay, so an offer costs at most the fetch the operator's next
    // tap would have paid anyway.
    ...((await deps.hasVouchedStill(deviceId, row.clipKey))
      ? { thumbnail: deps.stillUrl(deviceId, row.clipKey) }
      : { thumbnailMint: deps.stillUrl(deviceId, row.clipKey) }),
    catalogAsOf,
    // ONE archived track, so ONE stream — and it is the main copy. A `streams`
    // block with a `sub` that is really the main file is the 33x lie D576
    // forbids, stated as data.
    streams: {
      main: {
        id: mintClipId({
          source: CLIP_SOURCE_ONBOARD,
          trackId: row.trackId,
          fileName: row.fileName,
        }),
        ...(row.sizeBytes !== undefined ? { bytes: row.sizeBytes } : {}),
      },
    },
    supportSub: false,
  })

  const resolveRow = (deviceId: number, clipId: string): HikvisionClipRow | undefined => {
    const parsed = parseClipId(clipId)
    if (parsed === null) return undefined
    return rowsByKey.get(`${String(deviceId)}|${clipKeyFor(parsed.trackId, parsed.fileName)}`)
  }

  const noteUpgrade = (deviceId: number, clipId: string, profile: CamProfile | undefined): void => {
    deps.logger.warn('videoclips: this camera archives only the main copy — serving it', {
      tags: { deviceId },
      meta: { clipId, branch: 'quality-upgraded', asked: profile ?? null, served: 'high' },
    })
  }

  return {
    listSources: async ({ deviceId }): Promise<readonly ClipSource[]> => {
      const device = await deps.resolveDevice(deviceId)
      // Not this provider's camera. `[]` is cheap and honest — it is the
      // provider's own device knowledge doing the gating (D554).
      if (device === null) return []
      const known = health.get(deviceId)
      const availability = known ?? (await deps.probeAvailability(device))
      health.set(deviceId, availability)
      return [
        {
          source: CLIP_SOURCE_ONBOARD,
          addonId: HIKVISION_ADDON_ID,
          label: 'Camera storage',
          availability,
        },
      ]
    },

    listClips: async ({ deviceId, since, until, limit }): Promise<readonly Clip[]> => {
      const device = await deps.resolveDevice(deviceId)
      if (device === null) return []
      const tags = { deviceId }

      const outcome = await deps.readCatalog({ device, sinceMs: since, untilMs: until })
      if (outcome.kind === 'refused') {
        health.set(deviceId, outcome.availability)
        // An empty list is an answer only when the source could ANSWER.
        // Flattening a refusal into `[]` is "this camera has no recordings",
        // which is the one sentence this line of work exists to prevent.
        deps.logger.warn('videoclips: nothing to list, and the source cannot answer', {
          tags,
          meta: {
            branch: 'refused-empty',
            state: outcome.availability.state,
            reason: outcome.availability.reason ?? null,
          },
        })
        throw new Error(
          `videoclips: device ${String(deviceId)} listed no clips, and that is not an empty ` +
            `window — the source is "${outcome.availability.state}"` +
            (outcome.availability.reason !== undefined ? `: ${outcome.availability.reason}` : '.'),
        )
      }

      const catalogAsOf = deps.now()
      health.set(deviceId, { state: 'ok', catalogAsOf })
      // REMEMBER every row the read really produced, then answer with the ones
      // the window asked for. The two are different questions, and collapsing
      // them costs the honest refusal: an id outlives the listing that made it
      // (a deep link, a queued export), and a row this runner has forgotten
      // comes back `catalog-miss` — "I have never heard of it".
      remember(deviceId, outcome.rows)

      const narrowed = narrowClipsToWindow(outcome.rows, { since, until })
      if (narrowed.outOfWindow > 0) {
        deps.logger.info('videoclips: narrowed a listing to the window it was asked for', {
          tags,
          meta: {
            branch: 'listing-narrowed',
            listed: outcome.rows.length,
            kept: narrowed.kept.length,
            outOfWindow: narrowed.outOfWindow,
            since,
            until,
          },
        })
      }
      const ordered = narrowed.kept.toSorted((a, b) => b.startMs - a.startMs)
      const capped = limit !== undefined ? ordered.slice(0, limit) : ordered
      deps.logger.info('videoclips: listed a Hikvision catalog', {
        tags,
        meta: {
          source: CLIP_SOURCE_ONBOARD,
          clips: capped.length,
          truncated: limit !== undefined && ordered.length > limit,
          trackId: device.trackId,
        },
      })
      return await Promise.all(
        capped.map(async (row) => await toClip(device.deviceId, row, catalogAsOf)),
      )
    },

    /**
     * The player's URL — a finished MP4 on this addon's own media plane, with
     * `Range`, because the surface hands it to a `<video>` element that has to
     * show a duration and seek. The STREAM is the broker's path (D597/D599)
     * and is forward-only; the two are different consumers, not two classes of
     * ask.
     */
    getClipPlayback: async ({ deviceId, clipId, profile }): Promise<ClipPlayback> => {
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        throw new Error(`videoclips: clip id "${clipId}" was not minted by the Hikvision provider`)
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        throw new Error(`videoclips: device ${String(deviceId)} is not a Hikvision camera`)
      }
      const clipKey = clipKeyFor(parsed.trackId, parsed.fileName)
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, clipId, profile)
      return {
        playbackUrl: deps.playbackUrl(deviceId, clipKey),
        format: 'mp4',
        served: quality.served,
      }
    },

    /**
     * This clip's BYTES, base64, bounded — the by-handle read a clip EXPORT
     * pulls (D558).
     *
     * The cheap questions come first and none of them touches the camera: the
     * id, the row, and the SIZE the catalog already declared. A segment over
     * the bound is refused for nothing — no session, no transfer, no mux —
     * which is the rule bulk work over stored media already follows (D54).
     */
    readClipBytes: async ({ deviceId, clipId, profile, maxBytes }): Promise<ClipBytes> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip byte read', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        return refuse('catalog-miss', `device ${String(deviceId)} is not a Hikvision camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Hikvision provider`,
          {},
        )
      }
      const clipKey = clipKeyFor(parsed.trackId, parsed.fileName)
      const row = rowsByKey.get(`${String(deviceId)}|${clipKey}`)
      if (row === undefined) {
        // From cold — a redeploy, a restart, a runner that has listed another
        // window — this provider holds no row, and the camera's playback
        // handle lives only on the row. There is nothing to guess.
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, clipId, profile)

      // The caller's bound, capped by the ceiling whatever it passes: the
      // envelope is unary, so the payload is held whole in the provider AND in
      // the caller, on a hub this repo has already OOM'd (D9/D18).
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_READ_BYTES, VIDEOCLIPS_MAX_READ_BYTES)
      if (row.sizeBytes !== undefined && row.sizeBytes > bound) {
        return refuse(
          'too-large-to-transfer',
          `the camera lists clip "${clipId}" as ${String(row.sizeBytes)} bytes, over the ` +
            `${String(bound)}-byte bound for an inline read — play it from its playback URL instead`,
          { clipKey, listedBytes: row.sizeBytes, bound },
        )
      }

      const outcome = await deps.prepareBytes({ device, row, maxBytes: bound })
      if (outcome.kind === 'refused') {
        // Already logged, with its branch, by the producer.
        throw new Error(clipExportFailure(outcome.code, outcome.detail))
      }
      if (outcome.bytes.byteLength > bound) {
        // The listed size under-declares what a remux produces. Half a video
        // is worse than an honest refusal, so it is dropped, not truncated.
        return refuse(
          'too-large-to-transfer',
          `clip "${clipId}" muxed to ${String(outcome.bytes.byteLength)} bytes, over the ` +
            `${String(bound)}-byte bound for an inline read`,
          { clipKey, bytes: outcome.bytes.byteLength, bound },
        )
      }
      deps.logger.info('videoclips: served a Hikvision clip inline', {
        tags,
        meta: {
          clipId,
          clipKey,
          served: quality.served,
          asked: profile ?? null,
          bytes: outcome.bytes.byteLength,
          durationMs: outcome.durationMs,
        },
      })
      return {
        base64: outcome.bytes.toString('base64'),
        contentType: 'video/mp4',
        name: clipFileLabel(row),
        bytes: outcome.bytes.byteLength,
        served: quality.served,
        // Absent when nothing measured it — never zero, which would say the
        // file is empty, and never the row's span, which is a projection.
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * The same clip, over the addon→addon byte transport (D613).
     *
     * ONE difference from {@link readClipBytes}: the bytes leave over a
     * one-shot loopback socket instead of inside a base64 field, so neither
     * this process nor the caller holds the payload. On this vendor nothing is
     * held at all — the fetch path already lands the clip in a scratch FILE
     * and the offer streams that file.
     *
     * The cheap questions come first and none of them touches the camera: the
     * id, the row, and the SIZE the catalog already declared — the rule bulk
     * work over stored media already follows (D54). The bound is
     * {@link VIDEOCLIPS_MAX_OFFER_BYTES} and it is a statement about what a
     * PRODUCER holds, which here is nothing; it is applied anyway so the
     * ceiling is one number across vendors rather than a per-vendor guess.
     */
    offerClipBytes: async ({ deviceId, clipId, profile, maxBytes }): Promise<ClipBytesOffer> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip byte offer', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        return refuse('catalog-miss', `device ${String(deviceId)} is not a Hikvision camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Hikvision provider`,
          {},
        )
      }
      const clipKey = clipKeyFor(parsed.trackId, parsed.fileName)
      const row = rowsByKey.get(`${String(deviceId)}|${clipKey}`)
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, clipId, profile)
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_OFFER_BYTES, VIDEOCLIPS_MAX_OFFER_BYTES)
      if (row.sizeBytes !== undefined && row.sizeBytes > bound) {
        return refuse(
          'too-large-to-transfer',
          `the camera lists clip "${clipId}" as ${String(row.sizeBytes)} bytes, over the ` +
            `${String(bound)}-byte bound for one transfer`,
          { clipKey, listedBytes: row.sizeBytes, bound },
        )
      }
      const outcome = await deps.prepareOffer({ device, row, maxBytes: bound })
      if (outcome.kind === 'refused') {
        // Already logged, with its branch, by the producer.
        throw new Error(clipExportFailure(outcome.code, outcome.detail))
      }
      deps.logger.info('videoclips: offered a Hikvision clip by handle', {
        tags,
        meta: {
          clipId,
          clipKey,
          served: quality.served,
          asked: profile ?? null,
          bytes: outcome.bytes,
          durationMs: outcome.durationMs,
          expiresInMs: outcome.ticket.expiresAtMs - deps.now(),
        },
      })
      return {
        ticket: outcome.ticket,
        contentType: 'video/mp4',
        name: clipFileLabel(row),
        served: quality.served,
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * What a surface may DRAW for this camera's clips (D612).
     *
     * A CONSTANT, and it has to be: this method is asked per camera, and the
     * answer is a fact about which accessors this provider wires, not about
     * the camera. Every clip here reaches the player over
     * {@link dialClipStream}'s forward-only stream, so every clip gets the
     * `stream` envelope — measured, not assumed: the broker's `chooseClipPath`
     * reads only whether the dial and the file read are wired, and never the
     * clip or the profile.
     *
     * The rates are the broker's re-pacing ladder CAPPED AT REALTIME, because
     * this camera's replay is not a fetch: it delivers the recording at the
     * speed it was recorded (1.01× measured on 1436, 2026-09-23 — 176 access
     * units in 14.27 s at 12.5 fps). The pacer consumes `rate` seconds of
     * media per second while the socket supplies one, so anything above 1
     * empties a buffer that never had the rest of the clip in it. Below 1 is
     * free. See `CLIP_REALTIME_SOURCE_RATES` for the full measurement; this is
     * D612's own rule reaching the case it did not yet have.
     *
     * The camera's own `Scale` header is a different mechanism and is
     * deliberately unreachable from this provider (`rtsp-replay-session.ts`):
     * the feasibility note measured `Scale: 8.0` answering 200 and silently
     * corrupting the media.
     */
    getPlaybackOptions: async (): Promise<ClipPlaybackOptions> =>
      CLIP_PLAYBACK_OPTIONS.realtimeStream,

    /**
     * Where this clip's STREAM is dialled (D597) — the same questions
     * `readClipBytes` asks before the camera is touched, the same vocabulary,
     * and NO fetch: the URL is one shot on this provider's own listener and
     * the camera is opened when the broker dials it.
     */
    dialClipStream: async ({ deviceId, clipId, profile, audio }): Promise<ClipStreamDial> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip stream dial', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        return refuse('catalog-miss', `device ${String(deviceId)} is not a Hikvision camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Hikvision provider`,
          {},
        )
      }
      const row = resolveRow(deviceId, clipId)
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey: clipKeyFor(parsed.trackId, parsed.fileName) },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, clipId, profile)

      // An ask this provider cannot mux is refused BY NAME on the answer, not
      // silently downgraded — the audio shape of `served` (D600). Absent is
      // `none` (D382: an unstated ask is zero), which is what a broker older
      // than the field sends, and it keeps the video-only stream it had.
      const askedAudio: ClipStreamAudioAsk = audio ?? 'none'
      const audioReason: ClipStreamAudioReason | null =
        askedAudio === 'none' ? 'not-requested' : null
      const outcome = await deps.prepareStreamDial({ device, row, audio: askedAudio })
      if (outcome.kind === 'refused') {
        return refuse(outcome.code, outcome.detail, { clipKey: row.clipKey })
      }
      return {
        url: outcome.url,
        expiresAtMs: outcome.expiresAtMs,
        transport: 'forward-only',
        // What the stream WILL carry, not what was asked.
        served: quality.served,
        // The codec, promised. Whether the RECORDING has sound is not knowable
        // before its first audio frame arrives, so that answer is in the
        // stream's own `moov` and the broker reads it there.
        servedAudio: askedAudio,
        ...(audioReason !== null ? { audioReason } : {}),
      }
    },
  }
}
