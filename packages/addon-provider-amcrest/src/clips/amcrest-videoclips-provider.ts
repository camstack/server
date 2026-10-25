/**
 * The Amcrest `videoclips` provider — ONE source of a camera's clip
 * collection, listed BESIDE the analytics visits and never instead of them
 * (D549 1/2).
 *
 * ## What an empty answer means
 *
 * Never "this camera has no recordings" unless that is what was measured. The
 * honest states on this camera are:
 *
 * - **`no-storage`** — the camera reports no usable card. That read is the
 *   FIRST thing this provider does, it costs one CGI round-trip, and it turns
 *   "no clips" into "no card", which is a different sentence and a different
 *   operator action. It is the SAME read the `recording-onboard` cap makes
 *   (D614): one parser, one meaning, no second opinion about whether the card
 *   is there.
 * - **`index-empty`** — the camera's storage reads healthy and its index
 *   answers nothing ANYWHERE, proved against an unbounded control search. A
 *   defect on the camera, reported as one.
 * - **`unreachable`** — the camera could not be reached, its clock could not
 *   be read, or it answered something this provider could not read.
 * - **`ok`** — and `ok` is MEASURED, never defaulted: the storage question is
 *   asked and the camera's clock is read before anything claims it.
 *
 * `sleeping` is not reachable: this camera is mains-powered, and a state
 * nothing can produce would be a branch nothing tests.
 *
 * ## An empty window is an ANSWER, not a refusal
 *
 * This camera cannot tell "nothing matched" from "your search was malformed":
 * both are `result: false, code 285409284, message ""`. `clip-catalog.ts`
 * settles it with a control search, so a quiet Tuesday lists `[]` with the
 * source still `ok`, and only a camera whose index answers nothing anywhere
 * degrades the source. Getting this wrong in the other direction — gating on
 * `findFile` alone, as the trap list requires — would have drawn "this camera
 * could not be reached" over every empty day.
 *
 * ## Every ask is served the one archived copy, and it SAYS so
 *
 * See `clip-twins.ts`. `served` is `high` on every method that carries it, for
 * every asked profile including an absent one.
 */
import type {
  CamProfile,
  Clip,
  ClipBytesOffer,
  ClipExportFailure,
  ClipPlayback,
  ClipPlaybackOptions,
  ClipSource,
  ClipSourceAvailability,
  ClipStreamAudio,
  ClipStreamAudioReason,
  ClipStreamDial,
  IScopedLogger,
  IVideoclipsProvider,
  PeerBytesTicket,
} from '@camstack/types'
import {
  CLIP_PLAYBACK_OPTIONS,
  clipExportFailure,
  VIDEOCLIPS_MAX_OFFER_BYTES,
  VIDEOCLIPS_MAX_READ_BYTES,
} from '@camstack/types'

import { AMCREST_ADDON_ID } from '../schema.js'
import { CLIP_SOURCE_ONBOARD, clipKeyOf, mintClipId, parseClipId } from './clip-identity.js'
import type { AmcrestClipRow } from './clip-search.js'
import { chooseClipQuality, ClipUpgradeNotes } from './clip-twins.js'
import { narrowClipsToWindow } from './clip-window.js'

/** Everything the clip path needs to know about one camera, with no secrets in
 *  it: the credentials stay inside the service that built the clients. */
export interface ClipDeviceRef {
  readonly deviceId: number
  /** 0-based, as `mediaFileFind` counts. The RTSP channel is this plus one. */
  readonly findChannel: number
}

export interface ReadCatalogInput {
  readonly device: ClipDeviceRef
  readonly sinceMs: number
  readonly untilMs: number
}

export type ReadCatalogOutcome =
  | { readonly kind: 'ok'; readonly rows: readonly AmcrestClipRow[] }
  /** The camera answers searches and this window holds nothing. The source
   *  stays `ok`: an empty window is a complete answer. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'refused'; readonly availability: ClipSourceAvailability }

export interface PrepareClipOfferInput {
  readonly device: ClipDeviceRef
  readonly row: AmcrestClipRow
  readonly maxBytes: number
}

export type PrepareClipOfferOutcome =
  | {
      readonly kind: 'ok'
      readonly ticket: PeerBytesTicket
      /** MEASURED on this pass, or `null`. Never the row's window (D393): the
       *  container runs about 7.5 % shorter than the row says. */
      readonly durationMs: number | null
      readonly bytes: number
    }
  | {
      readonly kind: 'refused'
      readonly code: ClipExportFailure
      readonly detail: string
    }

export interface PrepareClipBytesInput {
  readonly device: ClipDeviceRef
  readonly row: AmcrestClipRow
  readonly maxBytes: number
}

export type PrepareClipBytesOutcome =
  | {
      readonly kind: 'ok'
      readonly bytes: Buffer
      /** MEASURED on this pass, or `null`. Never the row's window (D393). */
      readonly durationMs: number | null
    }
  | {
      readonly kind: 'refused'
      readonly code: ClipExportFailure
      readonly detail: string
    }

export interface PrepareStreamDialInput {
  readonly device: ClipDeviceRef
  readonly row: AmcrestClipRow
  /** What the caller's session negotiated. `none` is a real ask (D600). */
  readonly audio: ClipStreamAudio
}

export type PrepareStreamDialOutcome =
  | { readonly kind: 'ok'; readonly url: string; readonly expiresAtMs: number }
  | {
      readonly kind: 'refused'
      readonly code: ClipExportFailure
      readonly detail: string
    }

export interface AmcrestVideoclipsDeps {
  readonly now: () => number
  readonly logger: IScopedLogger
  /** `null` when this device is not an Amcrest camera this addon owns. */
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
  /** The clip's bytes in hand, for the broker's file feeder. */
  prepareBytes(input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome>
  /** The same clip, offered over the addon→addon byte transport (D613). */
  prepareOffer(input: PrepareClipOfferInput): Promise<PrepareClipOfferOutcome>
  /**
   * A one-shot URL on this addon's own listener, from which the clip streams
   * forward-only (D597). No camera call happens here — the replay opens when
   * the broker dials.
   */
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
 * The camera's own file name is `10.23.27-10.24.41[M][0@0][0].mp4` — square
 * brackets, an `@`, and a clock with no date. Every one of those is a hazard in
 * a downloads folder and none of them says WHEN. So the name is minted from the
 * window, in ISO, and the extension is re-stated because what we hand over is
 * an MP4 whatever the camera called it.
 */
export function clipFileLabel(row: AmcrestClipRow): string {
  const stamp = new Date(row.startMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `amcrest_${stamp}.mp4`
}

/**
 * What the camera's own event strings mean in the cap's vocabulary.
 *
 * `VideoMotion` is the only value 60 of 60 measured rows carried, so this is a
 * mapping written against ONE observed string and it says so. Everything else
 * is `native` — the camera's words survive verbatim on `nativeTypes`, which is
 * the lossless copy D549 20 requires precisely because this table is lossy.
 */
function clipKindFor(row: AmcrestClipRow): Clip['kind'] {
  if (row.events.some((event) => event.toLowerCase().includes('motion'))) return 'motion'
  return 'native'
}

export function createAmcrestVideoclipsProvider(deps: AmcrestVideoclipsDeps): IVideoclipsProvider {
  /** Last known availability per device, written by every read. */
  const health = new Map<number, ClipSourceAvailability>()
  /** Every row this provider has listed, by `deviceId|clipKey`, so a byte
   *  offer resolves without re-searching the camera. */
  const rowsByKey = new Map<string, AmcrestClipRow>()
  const upgrades = new ClipUpgradeNotes()

  const rowKey = (deviceId: number, clipKey: string): string => `${String(deviceId)}|${clipKey}`

  const remember = (deviceId: number, rows: readonly AmcrestClipRow[]): void => {
    for (const row of rows) rowsByKey.set(rowKey(deviceId, row.clipKey), row)
  }

  /**
   * ASYNC, because the still is vouched by a `stat` and a vouch that guessed
   * would be worse than no still at all.
   */
  const toClip = async (
    deviceId: number,
    row: AmcrestClipRow,
    catalogAsOf: number,
  ): Promise<Clip> => {
    const id = mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      startMs: row.startMs,
      endMs: row.endMs,
    })
    return {
      id,
      source: CLIP_SOURCE_ONBOARD,
      kind: clipKindFor(row),
      timeRange: { startMs: row.startMs, endMs: row.endMs },
      // The camera's OWN strings, unmapped. `Summary` is NEVER read: every row
      // carries a fabricated `TrafficCar` with a blank plate and a constant
      // 60 km/h, on a camera with no ANPR licence.
      ...(row.events.length > 0 ? { nativeTypes: [...row.events] } : {}),
      // Exactly ONE of three, never two (D315):
      //   • `thumbnailUnavailable` — the answer is already KNOWN and it is no.
      //     One case reaches it: a row whose window spans nothing has no
      //     midpoint to cut, so `no-keyframe` is the truth and a mint could
      //     only rediscover it at the cost of a camera dial.
      //   • `thumbnail` — a JPEG is really on disk, vouched by a `stat`.
      //   • `thumbnailMint` — an OFFER: the route answers 200 with the image
      //     or 204 with a reason a tile can read. It is honoured by dialling
      //     the clip's own `/cam/playback` at its MIDPOINT, measured at
      //     1 388–2 313 ms of this camera's replay budget (`clip-still.ts`).
      // Absence of a still is never asserted before anybody has asked for one.
      // This camera has no sleeping state and no wake to pay.
      ...(await stillFieldFor(deviceId, row)),
      catalogAsOf,
      // ONE archived copy, and it is the main. A `streams` block with a `sub`
      // that is really the main file is the silent substitution D576 forbids,
      // stated as data — and this pair is what the viewer's quality picker
      // already reads to decide there is no choice to offer.
      streams: {
        main: {
          id,
          ...(row.sizeBytes !== null ? { bytes: row.sizeBytes } : {}),
        },
      },
      supportSub: false,
    }
  }

  /**
   * Which of the three still fields this row carries, and never two.
   *
   * The known-no comes FIRST and costs nothing: a mint for a row with no
   * window would take the camera's replay lane only to refuse, and a tile
   * would show LOADING for the length of that round trip to learn what the
   * row already said.
   */
  const stillFieldFor = async (
    deviceId: number,
    row: AmcrestClipRow,
  ): Promise<Pick<Clip, 'thumbnail' | 'thumbnailMint' | 'thumbnailUnavailable'>> => {
    if (row.endMs - row.startMs <= 0) {
      return { thumbnailUnavailable: { reason: 'no-keyframe' } }
    }
    return (await deps.hasVouchedStill(deviceId, row.clipKey))
      ? { thumbnail: deps.stillUrl(deviceId, row.clipKey) }
      : { thumbnailMint: deps.stillUrl(deviceId, row.clipKey) }
  }

  const noteUpgrade = (deviceId: number, profile: CamProfile | undefined): void => {
    if (profile === undefined) return
    const note = upgrades.note(deviceId, profile)
    if (note.kind !== 'say') return
    deps.logger.warn(
      'videoclips: this camera archives only the main copy — every ask is served it',
      {
        tags: { deviceId },
        meta: {
          branch: 'quality-upgraded',
          asked: profile,
          served: 'high',
          // Said ONCE per camera per asked profile; this is where the
          // suppressed repeats are counted so the quiet has a denominator.
          note: 'further upgraded asks for this camera and profile are not logged',
        },
      },
    )
  }

  return {
    listSources: async ({ deviceId }): Promise<readonly ClipSource[]> => {
      const device = await deps.resolveDevice(deviceId)
      // Not this provider's camera. `[]` is cheap and honest — it is the
      // provider's own device knowledge doing the gating (D554).
      if (device === null) return []
      const availability = await deps.probeAvailability(device)
      health.set(deviceId, availability)
      return [
        {
          source: CLIP_SOURCE_ONBOARD,
          addonId: AMCREST_ADDON_ID,
          label: 'Camera storage',
          availability,
        },
      ]
    },

    listClips: async ({ deviceId, since, until, limit }): Promise<readonly Clip[]> => {
      const device = await deps.resolveDevice(deviceId)
      if (device === null) return []
      const tags = { deviceId }

      const outcome = await deps.readCatalog({
        device,
        sinceMs: since,
        untilMs: until,
      })
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
      if (outcome.kind === 'empty') {
        // A COMPLETE answer, proved against a control search. The source stays
        // `ok` and the surface may draw "no clips in this window" — which is
        // the one sentence that would have been a guess without the control.
        deps.logger.info('videoclips: the window holds no clips', {
          tags,
          meta: {
            branch: 'empty-window',
            source: CLIP_SOURCE_ONBOARD,
            since,
            until,
          },
        })
        return []
      }

      // REMEMBER every row the read really produced, then answer with the ones
      // the window asked for. An id outlives the listing that made it (a deep
      // link, a queued export), and a row this runner has forgotten comes back
      // `catalog-miss` — "I have never heard of it".
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
      deps.logger.info('videoclips: listed an Amcrest catalog', {
        tags,
        meta: {
          source: CLIP_SOURCE_ONBOARD,
          clips: capped.length,
          truncated: limit !== undefined && ordered.length > limit,
          findChannel: device.findChannel,
        },
      })
      return await Promise.all(capped.map(async (row) => await toClip(deviceId, row, catalogAsOf)))
    },

    /**
     * The player's URL — a finished, `moov`-first MP4 on this addon's own
     * media plane, with `Range`, because the surface hands it to a `<video>`
     * element that has to show a duration and seek.
     */
    getClipPlayback: async ({ deviceId, clipId, profile }): Promise<ClipPlayback> => {
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        throw new Error(`videoclips: clip id "${clipId}" was not minted by the Amcrest provider`)
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        throw new Error(`videoclips: device ${String(deviceId)} is not an Amcrest camera`)
      }
      const clipKey = clipKeyOf(parsed)
      if (!rowsByKey.has(rowKey(deviceId, clipKey))) {
        // The window in the id is enough to BUILD a URL and deliberately not
        // enough to be given one: a caller could otherwise mint an id for a
        // window nobody checked exists.
        throw new Error(
          clipExportFailure(
            'catalog-miss',
            `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
              'list the window that holds it first',
          ),
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, profile)
      return {
        playbackUrl: deps.playbackUrl(deviceId, clipKey),
        format: 'mp4',
        served: quality.served,
      }
    },

    /**
     * This clip's BYTES, base64, bounded — the broker's file feeder (D575).
     *
     * **It is wired, and it will refuse about a fifth of this camera's
     * catalog, by name.** Ten measured clips ran 33.4–72.9 MiB and 2 of them
     * exceed `VIDEOCLIPS_MAX_READ_BYTES` (50 MiB); the worst the camera can
     * structurally produce — one motion episode cut at the 5-minute
     * `PacketLength` cap, at the peak achieved 6.64 Mbit/s — is 238 MiB. The
     * envelope is unary, so that payload is held at ~1.33× in the provider AND
     * in the caller, on a hub this repo has already OOM'd (D9/D18), and the
     * bound is not going to move for an inline read.
     *
     * It is wired anyway, and the alternative was measured rather than
     * assumed: the broker's `chooseClipPath` reads whether *the broker* has a
     * file read wired, not whether this provider implements one. Leaving the
     * method off would make the broker choose the file path and then call a
     * method that answers `NOT_IMPLEMENTED` — an unnamed failure in place of
     * the named refusal this returns. A named `too-large-to-transfer` that an
     * operator can read is strictly better than an error nobody can, and it is
     * also the honest measurement that argues for the camera's own
     * forward-only replay as the next slice.
     *
     * {@link offerClipBytes} is the path an EXPORT takes, holds nothing on
     * either side, and reaches 500 MiB — every clip this camera can make.
     *
     * The cheap questions come first and none of them touches the camera: the
     * id, the row, and the SIZE the catalog already declared (D54).
     */
    readClipBytes: async ({ deviceId, clipId, profile, maxBytes }) => {
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
        return refuse('catalog-miss', `device ${String(deviceId)} is not an Amcrest camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Amcrest provider`,
          {},
        )
      }
      const clipKey = clipKeyOf(parsed)
      const row = rowsByKey.get(rowKey(deviceId, clipKey))
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, profile)
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_READ_BYTES, VIDEOCLIPS_MAX_READ_BYTES)
      if (row.sizeBytes !== null && row.sizeBytes > bound) {
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
        // The listed size under-declares what the re-index produced. Half a
        // video is worse than an honest refusal, so it is dropped, never
        // truncated.
        return refuse(
          'too-large-to-transfer',
          `clip "${clipId}" re-indexed to ${String(outcome.bytes.byteLength)} bytes, over the ` +
            `${String(bound)}-byte bound for an inline read`,
          { clipKey, bytes: outcome.bytes.byteLength, bound },
        )
      }
      deps.logger.info('videoclips: served an Amcrest clip inline', {
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
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * Where this clip's finished bytes can be TAKEN (D613) — the by-handle
     * read a clip EXPORT pulls.
     *
     * {@link readClipBytes} with the envelope removed, and on this camera that
     * is the difference between exporting a fifth of the catalog and all of
     * it: the bound here is `VIDEOCLIPS_MAX_OFFER_BYTES` (500 MiB), which
     * every measured clip (33.4–72.9 MiB) and the worst structurally possible
     * one (238 MiB) fit with room. Nothing is held on either side — the bytes
     * leave over a one-shot loopback socket, straight off the scratch file.
     *
     * The cheap questions come first and none of them touches the camera: the
     * id, the row, and the SIZE the catalog already declared (D54).
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
        return refuse('catalog-miss', `device ${String(deviceId)} is not an Amcrest camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Amcrest provider`,
          {},
        )
      }
      const clipKey = clipKeyOf(parsed)
      const row = rowsByKey.get(rowKey(deviceId, clipKey))
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, profile)
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_OFFER_BYTES, VIDEOCLIPS_MAX_OFFER_BYTES)
      if (row.sizeBytes !== null && row.sizeBytes > bound) {
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
      deps.logger.info('videoclips: offered an Amcrest clip by handle', {
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
        // Absent when nothing measured it — never zero, which would say the
        // file is empty, and never the row's window, which runs ~7.5 % long.
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * What a surface may DRAW for this camera's clips (D612).
     *
     * A CONSTANT, and one of the three the contract spells — a provider never
     * composes an envelope of its own. `realtimeStream`, because playback
     * reaches the peer through `dialClipStream` and the source runs at the
     * speed the recording was made: measured ~1.1× on 3836 (about 600 video
     * RTP per second against a 51 s clip), which is exactly the constraint
     * `CLIP_REALTIME_SOURCE_RATES` exists for. Nothing above 1× can be
     * delivered from a socket that supplies one second of media per second,
     * and D612's rule is that a rate which cannot be delivered is never
     * offered.
     *
     * **`seek` is `forward`, and that is a MEASUREMENT this provider has not
     * made rather than a property of the camera.** `/cam/playback` honours a
     * repositioning `PLAY Range` and answers where it landed (`npt=17.500` →
     * `npt=17.000`), which would be `free`. But nobody has decoded the RTP
     * timestamps back to a wall-clock offset to check that the answer is TRUE,
     * this repo has been lied to by a declared field twice, and the shipped
     * envelope for a realtime source says `forward`. Declaring `free` would
     * mean minting a fourth envelope on the strength of a status line. When
     * the delivered position is measured, that is the change to make.
     *
     * The FILE path is still wired and is still what an EXPORT takes
     * ({@link offerClipBytes}) — it is the one route that yields a whole,
     * `stbl`-indexed MP4 with sound. It is not what a PLAYBACK takes any more,
     * and the reason is a measurement: the same 51-second clip costs 74 475 ms
     * of `RPC_Loadfile` before its first frame and 1 352 ms over
     * `/cam/playback`.
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
        return refuse('catalog-miss', `device ${String(deviceId)} is not an Amcrest camera`, {})
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Amcrest provider`,
          {},
        )
      }
      const clipKey = clipKeyOf(parsed)
      const row = rowsByKey.get(rowKey(deviceId, clipKey))
      if (row === undefined) {
        // The window in the id is enough to BUILD a replay URL and
        // deliberately not enough to be given one: a caller could otherwise
        // mint an id for a window nobody checked exists, and this camera
        // answers a window with no footage with the same 404 it answers a
        // bogus path with.
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${String(deviceId)} — ` +
            'list the window that holds it first',
          { clipKey },
        )
      }
      const quality = chooseClipQuality(profile)
      if (quality.upgraded) noteUpgrade(deviceId, profile)

      // An ask this provider cannot mux is refused BY NAME on the answer, not
      // silently downgraded — the audio shape of `served` (D600). Absent is
      // `none` (D382: an unstated ask is zero), which is what a broker older
      // than the field sends, and it keeps the video-only stream it had.
      const askedAudio: ClipStreamAudio = audio ?? 'none'
      const audioReason: ClipStreamAudioReason | null =
        askedAudio === 'none' ? 'not-requested' : null
      const outcome = await deps.prepareStreamDial({
        device,
        row,
        audio: askedAudio,
      })
      if (outcome.kind === 'refused') {
        return refuse(outcome.code, outcome.detail, { clipKey })
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
