import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { CamProfileSchema } from './schemas/streaming-shared.js'
import { PeerBytesTicketSchema } from '../interfaces/addon-peer-bytes.js'
import {
  type CapabilityDefinition,
  type InferProvider,
  method,
  optionalMethod,
} from './capability-definition.js'

/**
 * `videoclips` — the unified, navigable-clip surface for a camera.
 *
 * A device-scoped wrapper COLLECTION (D549 decision 2, D554): every provider a
 * camera has is a SOURCE, and they are listed beside each other — never one
 * substituted for another, and none of them privileged by name. One source,
 * `analytics`, is registered by the RECORDER — the addon that owns the
 * footage, D560 — and composes the analytics event log (markers + thumbnails,
 * read over `ctx.api`) with the recorder's own `getPlaybackManifest`: a clip
 * is a time-WINDOW over existing footage, never a separate file. A camera that
 * exposes NATIVE onboard clips (Reolink SD card, a hub's storage, HKSV) adds
 * its own catalog ALONGSIDE that one. (`defaultActive` above is the CAP's
 * auto-bind to cameras, not a ranking among these sources — there is none.)
 *
 * The mount stays per-device (`resolveCapMount` → `device-scoped`), and a
 * device's SOURCES are its BINDINGS: `deviceManager.getBindings(deviceId)` is
 * what says a provider serves this camera, never the set of addons that
 * happen to have registered the capability somewhere in the cluster. That is
 * what stopped one addon appearing three times on 107 — as the device's
 * native provider, as the hub-local registration and as an
 * `<addonId>@<nodeId>` one (D554 amended 2026-09-20).
 *
 * `listClips` is asked of ONE provider at a time, and NAMING it is REQUIRED
 * ({@link videoclipsCapability.methods.listClips} `provider`, D554 amended). It is not
 * a union over everything a camera has: *"l'utilizzatore è uno solo"* [there is only one user]. There
 * is no default, because a collection cap's binding set is DERIVED and PLURAL
 * (D554 amended, `getBindings` step 0) — "the bound one" does not exist to
 * resolve to, and the one thing that could take its place is a second
 * authority naming a provider per camera, which D554 decision 3 rejected.
 * The pick is a SURFACE's to make, from the {@link ClipSourceSchema} rows it
 * already holds, and it says which one it made (D569 § 1–3).
 * {@link videoclipsCapability.methods.listSources} is the method that fans out
 * — one row per source, by construction.
 * {@link videoclipsCapability.methods.getClipPlayback} dispatches by the
 * source namespace inside the clip id, which is why ids are self-contained.
 *
 * A `Clip` is purely time-based (subtree-blind): playback resolves segments by
 * temporal overlap, so the API never decides `continuous` vs `events`.
 */
/**
 * Ceiling on `Clip.eventIds`. A visit is annotated by its events; it is not a
 * transport for them. At ~39 wire bytes per uuid this keeps a clip row inside
 * the 1.5 KB budget (`docs/design/2026-08-17-videoclips-implementation.md` §7.2)
 * while preserving `eventIds[0]` — the surface's thumbnail fallback.
 */
export const MAX_CLIP_EVENT_IDS = 24

/** Cap on {@link ClipSchema.labels} — the ribbon row has space for ~3 words. */
export const MAX_CLIP_LABELS = 3

/**
 * Every reason a still-mint route may refuse, as a TOKEN — never prose.
 *
 * The route also sends the prose (`x-camstack-reason`), because a firmware's
 * own words are the only thing that explains a `camera-refused`. But the token
 * is what a surface may key a table on, and the code and the prose are
 * separate headers precisely because they had been the same one: the route
 * sent `queue-full: 16 thumbnail mints already waiting for host …` and the
 * surface's table was keyed by `queue-full`, so every refusal on this fleet
 * rendered as `Refused: <prose>`.
 */
export const ClipStillRefusalCodeSchema = z.enum([
  /** The host's one CoverPreview lane is full. The clip is still coming. */
  'queue-full',
  /** The host refused a CoverPreview recently and is backing off. */
  'camera-backoff',
  /** A standalone battery camera: a still would cost a wake (D549 4). */
  'sleeping',
  /** The camera answered the CoverPreview with a refusal. */
  'camera-refused',
  /** The window holds no decodable I-frame. */
  'no-keyframe',
  /**
   * OUR decoder failed — not the camera's answer.
   *
   * A Hikvision still is cut from the clip's own archived MP4 with ffmpeg
   * (there is no playback-still endpoint on that firmware), so the mint has a
   * failure mode Reolink's single `CoverPreview` command does not: a binary
   * that will not spawn, a decode that errors, a file half written. Folding
   * those into `camera-refused` would send an operator to a camera that
   * answered perfectly.
   */
  'decode-failed',
  /** Nothing in the catalog answers to this key — list the day first. */
  'no-catalog-row',
  /** This source cannot mint stills at all. */
  'unsupported',
  /** The id does not resolve to a camera this provider serves. */
  'unknown-device',
  /** A hub child whose uid is not known yet. */
  'uid-missing',
])
export type ClipStillRefusalCode = z.infer<typeof ClipStillRefusalCodeSchema>

/**
 * Whether a refusal is "not yet" or "never" — decided by the BRANCH that
 * refused and carried on the wire, never inferred by the client from the code.
 *
 * `deferred` means the work is queued or the host is resting: the surface
 * shows LOADING and comes back, under a bound. `final` means no retry can
 * change the answer: the surface shows the reason and stops.
 *
 * A response that carries no disposition is read as `final`, which is exactly
 * how every build before this one behaved — an old provider under a new
 * surface keeps the old, safe behaviour rather than gaining a retry loop.
 */
export const ClipStillDispositionSchema = z.enum(['deferred', 'final'])
export type ClipStillDisposition = z.infer<typeof ClipStillDispositionSchema>

/** The camera's / provider's own words. Kept verbatim, never parsed. */
export const CLIP_STILL_REASON_HEADER = 'x-camstack-reason'

/** Longest reason a header carries. Beyond this the sentence is cut. */
export const CLIP_REASON_HEADER_MAX = 500

/**
 * Make a refusal sentence safe to put in an HTTP header.
 *
 * **An HTTP header value is Latin-1.** Node throws `Invalid character in
 * header content` on anything above U+00FF, the handler dies mid-response,
 * and the client gets a socket hang up — no status, no reason, nothing. The
 * mechanism that exists to EXPLAIN a refusal is then the thing that silences
 * it, and the surface shows "nothing happened".
 *
 * That is not hypothetical: measured 2026-09-23 on 1436, a Hikvision replay
 * refusal read `SETUP of the video track answered 500 — the camera refused
 * this replay`, and the EM DASH in it threw on every clip the operator
 * opened. This repository writes its refusals in prose, and its prose uses
 * `—`, `’` and `…` everywhere, so every reason string is a candidate.
 *
 * Substitutes rather than strips: an operator reading a log or a response
 * should get a readable sentence, not one with holes in it. The typographic
 * characters this repo actually writes have exact ASCII equivalents; anything
 * else non-Latin-1 becomes `?`, which is visible rather than silent. Control
 * characters go too — a newline in a header value is a response-splitting
 * bug, not a formatting one.
 */
export function clipReasonHeaderValue(reason: string): string {
  const folded = reason
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
  let out = ''
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0
    // Control characters (including CR/LF) and anything a Latin-1 header
    // cannot carry.
    if (code < 0x20 || code === 0x7f) out += ' '
    else if (code > 0xff) out += '?'
    else out += ch
  }
  return out.slice(0, CLIP_REASON_HEADER_MAX).trim()
}
/** One {@link ClipStillRefusalCodeSchema} token, alone. */
export const CLIP_STILL_REASON_CODE_HEADER = 'x-camstack-reason-code'
/** One {@link ClipStillDispositionSchema} token, alone. */
export const CLIP_STILL_DISPOSITION_HEADER = 'x-camstack-disposition'
/**
 * The clip STREAM route's own statement of what it is (D597): the value is
 * `forward-only`. A producer writes it on the 200; a consumer that dials a
 * URL and does not read it back refuses to play, because a progressive file
 * through a forward-only feeder looks like it worked until the first seek.
 * Named here because BOTH the provider and the broker spell it, and two
 * copies of a header name is how one of them stops being checked.
 */
export const CLIP_STREAM_TRANSPORT_HEADER = 'x-camstack-clip-transport'

export const ClipSchema = z.object({
  /** Opaque, provider-namespaced id. The default provider encodes the time
   *  window so `getClipPlayback` is self-contained (no event re-query). */
  id: z.string(),
  /** Which provider produced it (`analytics` | `native:<vendor>` | …). */
  source: z.string(),
  kind: z.enum(['motion', 'object', 'audio', 'native']),
  timeRange: z.object({ startMs: z.number(), endMs: z.number() }),
  /**
   * Distinct object classes attached to this visit (`person`, `car`, …),
   * dominant first, capped at {@link MAX_CLIP_LABELS}. The ribbon renders these
   * instead of the bare kind — "Object" tells the operator nothing a colour bar
   * did not. Absent (never empty) when the visit attached no classified object
   * event, so a motion/audio-only visit keeps its kind label.
   */
  labels: z.array(z.string()).max(MAX_CLIP_LABELS).optional(),
  /**
   * Lazy thumbnail URL, never inlined.
   *
   * Recording-derived clips (events-mode keep-window, and the prepared
   * continuous event+fragment visit) MUST use the snapshot of the **main
   * event of the interval** — `getEventMedia({ eventId, kind: 'snapshot' })`
   * of the event that owns `kind` (object > motion > audio). Do not extract
   * a keyframe from the recorded segments. Other providers (onboard, HKSV)
   * mint their own stills.
   *
   * **VOUCHED, never fabricated.** A provider emits this only for an event it
   * has CONFIRMED owns at least one media row (its own, or its owning track's).
   * Absent is meaningful — "this visit has no event still" — never "we did not
   * look". Stamping it from a URL template made 35% of one camera's clips point
   * at a 404 (device 3836, 2026-08-17: 64 of 179 clips dead, 63 of them motion).
   * A read that FAILS drops the claim; it never invents it.
   */
  thumbnail: z.string().optional(),
  /**
   * An instant INSIDE this visit's footage, hole-safe, where a recorded still
   * can be decoded. Present whenever the visit came from recorded availability;
   * absent on a per-event padded window (there is no footage to promise).
   *
   * This is not a thumbnail and not a second byte path: it is the argument to
   * the recorder's existing still route. The surface — never the provider —
   * decides whether to use it. It is the midpoint of the visit's LONGEST
   * contiguous range, not of the visit: a visit spans its holes by
   * construction, so a naive midpoint lands in dead air.
   */
  stillAtMs: z.number().optional(),
  /**
   * Analytics event ids that overlap this visit — a BOUNDED sample, newest
   * first within kind (object → motion → audio), capped at
   * {@link MAX_CLIP_EVENT_IDS}. Empty on footage-only clips.
   *
   * Bounded because it is not a payload the surface pages through: one visit on
   * device 101 carried 2 345 ids, and `eventIds` was 99% of a 153 KB
   * camera-day. Read {@link eventCount} for the true total.
   */
  eventIds: z.array(z.string()).optional(),
  /** How many analytics events actually overlap this visit. Differs from
   *  `eventIds.length` exactly when the sample was capped — so a truncated
   *  list is never mistaken for a quiet visit. */
  eventCount: z.number().int().nonnegative().optional(),
  /** Intra-visit footage holes (GOP rolls, discarded segments) still shorter
   *  than `VISIT_MERGE_GAP_MS`. Playback concatenates around them; the timeline
   *  bar keeps showing them via `recording.getAvailability`. */
  holes: z.array(z.object({ startMs: z.number(), endMs: z.number() })).optional(),
  /**
   * A URL that MAY produce this clip's still, asked only for rows actually on
   * screen. The opposite of {@link ClipSchema.thumbnail}: that one is VOUCHED
   * (a JPEG is already on disk), this one is an offer. The route answers 200
   * with the image, or 204 with `x-camstack-reason` when it could not mint one
   * — a surface latches that refusal to the instant rather than retrying.
   *
   * Never both: a clip with a vouched `thumbnail` needs no mint.
   */
  thumbnailMint: z.string().optional(),
  /**
   * Why no still will be produced for this clip RIGHT NOW — set when the
   * provider already knows, so the surface draws the glyph and the reason
   * instead of firing a mint that cannot succeed.
   *
   * `sleeping` — a standalone battery camera; a read would be a wake (D549 4).
   * `camera-refused` — the camera answered the CoverPreview with a refusal.
   * `no-keyframe` — the window holds no decodable I-frame (an event that sits
   *   inside no file is the measured case).
   * `unsupported` — this source cannot mint stills at all.
   */
  thumbnailUnavailable: z
    .object({ reason: z.enum(['sleeping', 'camera-refused', 'no-keyframe', 'unsupported']) })
    .optional(),
  /**
   * When the catalog this row came from was last CONFIRMED against the device.
   * Absent means "this row was read live". A persisted catalog served while a
   * camera sleeps carries the age it really has — a cached list is never drawn
   * as current (D549 13).
   */
  catalogAsOf: z.number().optional(),
  /**
   * The camera's OWN type strings for this clip, all of them, unmapped
   * (`md`, `people`, `dog_cat`, `sched`, …). Kept beside {@link labels}
   * because a firmware inventing a type must not vanish: the mapping into our
   * filter vocabulary is lossy on purpose and this is the lossless copy
   * (D549 20).
   */
  nativeTypes: z.array(z.string()).optional(),
  /**
   * What the subject DID — `crossline`, `intrude`, `loitering`. A behaviour
   * travels BESIDE a class, never instead of one, and the class filter ignores
   * it: "a person crossed a line" is still a person (D549 20).
   */
  behaviours: z.array(z.string()).optional(),
  /**
   * The same recording as two files — the sub twin (what the row and its
   * thumbnail are) and its main twin, matched at listing time so a quality
   * change never re-searches the camera (D549 15). `getClipPlayback`'s
   * `profile` picks between them: `low | mid` → sub, `high` → main.
   */
  streams: z
    .object({
      sub: z.object({ id: z.string(), bytes: z.number().optional() }).optional(),
      main: z.object({ id: z.string(), bytes: z.number().optional() }).optional(),
    })
    .optional(),
  /** The camera says it holds a sub-stream copy of this recording. */
  supportSub: z.boolean().optional(),
  /**
   * Whether this row has bytes behind it. ABSENT means yes — every clip that
   * IS a file is playable, and only a source that lists EVENTS can produce a
   * row with nothing to play (the measured case: 1 of 29 hub events on 3628
   * fell inside no file). Such a row is shown, never dropped and never offered
   * as playable-then-failing (D549 19).
   */
  playable: z.boolean().optional(),
  /** Why {@link playable} is false, verbatim (`no-file-for-window`). */
  unplayableReason: z.string().optional(),
  /**
   * This clip is STILL BEING WRITTEN, so {@link ClipSchema.timeRange}`.endMs`
   * is not its end.
   *
   * Absent — the common case — means the row is closed and its `endMs` is the
   * end of the recording. Present and `true` means the source told us the file
   * has no end yet, and the `endMs` we carry is whatever the camera's index
   * entry happened to hold: on a Reolink E1 Outdoor PoE (592, measured
   * 2026-09-20) the newest file `…_192927_000000_…_0.mp4` reported an `endTime`
   * of 19:29:56 and STILL reported it eight minutes later, while the file went
   * on growing. A surface that drew 29 s there was lying about a clip that
   * plays for minutes, on the one row the operator looks at first.
   *
   * `endMs` is deliberately still a number: it is the best bound anything has
   * for a mint window or a byte fetch, and every consumer already requires it.
   * This flag says what it is WORTH, and a duration is not drawn from it.
   */
  inProgress: z.boolean().optional(),
})
export type Clip = z.infer<typeof ClipSchema>

export const ClipPlaybackSchema = z.object({
  /**
   * A media URL through the hub data-plane. {@link ClipPlaybackSchema.format}
   * says what kind — an HLS master playlist for a recording-derived clip, a
   * progressive MP4 for a native file the vendor addon muxed and serves with
   * `Range`. The URL is NOT a credential: both planes are registered
   * `access: 'authenticated'` and the hub's `/addon/<id>/<prefix>` proxy takes
   * the session cookie, so nothing is appended to it (D549 22).
   */
  playbackUrl: z.string(),
  /**
   * How to play {@link playbackUrl}. Absent means `hls` — the shape every
   * existing consumer already assumes. A player that branches on this is the
   * one change a native clip needs; a player that ignores it will hand an MP4
   * to hls.js and fail parsing it as a manifest.
   */
  format: z.enum(['hls', 'mp4']).optional(),
  /**
   * Which twin was actually served. A clip that holds only one stream answers
   * with the one it has, and the surface SAYS so — a missing main twin is
   * never served silently as if it were the asked-for quality (D549 15).
   */
  served: CamProfileSchema.optional(),
  /** Optional LAN/remote alternates for the same clip. */
  playbackEndpoints: z.array(z.string()).optional(),
  token: z.string().optional(),
})
export type ClipPlayback = z.infer<typeof ClipPlaybackSchema>

/**
 * Why a source cannot answer right now — per SOURCE, never fleet-wide.
 *
 * `ok` is the only state whose clip list may be read as complete. The other
 * three exist because an empty list from a sleeping camera reads as "this
 * camera has no recordings", which is the defect this whole line of work is
 * about: a battery camera nobody woke (`sleeping`), a camera that could not be
 * reached at all (`unreachable`, also what a provider that THREW reports), a
 * camera whose SD card is not mounted (`no-storage`, measured on 106 —
 * `HddInfo mount 0`, honestly nothing to list rather than "no clips"), and a
 * camera whose OWN index disagrees with its OWN calendar (`index-empty`,
 * measured on 618: the calendar marks 3–20 September, days 6–20 list zero
 * files on both streams and both filters, with 177 GB free). That last one is
 * a defect ON THE CAMERA, and the only honest thing a provider can do is say
 * which days it asked for and got nothing — "no clips" would be a lie about a
 * card that is full of them.
 */
/**
 * The operator's authorisation to WAKE a sleeping camera for one clip read.
 *
 * ONE value, absent by default, and it is a `force`-shaped operator signal in
 * exactly the sense `snapshot-wake-gate.ts` uses the word: *"`snapshot.getSnapshot`'s
 * `force` flag, and nothing else… a background caller must never set it…
 * Stale but honest beats woken"*. A scheduler, a retry, a reconcile and a
 * prefetch never set it; a surface sets it only behind the same confirm the
 * "Wake and refresh" gesture uses, and it is refused below 15 % battery
 * exactly as that gesture is.
 *
 * The gate is decided BEFORE `getApi()`, because on UDP the login IS the wake
 * (D549) — a read that opened a session and then checked would have woken the
 * camera to find out it was not allowed to.
 *
 * **One authorised yes is one wake.** `next-natural` — take the clip the next
 * time the camera is awake for its own reasons — is deliberately not a member:
 * it was proposed, it is free on the battery, and the operator declined it on
 * 2026-09-20 (*"Quando un export viene richiesto si sveglia la camera."* [When an export is requested the camera wakes up],
 * D558 "Considered and not taken").
 */
export const ClipWakeSchema = z.enum(['authorised'])
export type ClipWake = z.infer<typeof ClipWakeSchema>

/**
 * Hard ceiling on ONE {@link videoclipsCapability.methods.readClipBytes} — the
 * same 50 MiB `RECORDING_EXPORT_MAX_READ_BYTES` uses, and for the same second
 * reason: the envelope is unary, so a base64 payload is held whole (~1.33× its
 * size) in the provider AND in the caller, on a hub this repo has already
 * OOM'd once (D9/D18).
 *
 * Measured clips sit far below it — 92 KB–2.29 MB for a sub twin, 455 KB for a
 * 16 s main clip — so the bound bites rarely. "Rarely" is not "never": a long
 * 4K main twin can exceed it, and above the bound the provider REFUSES with
 * the size in the message, never truncates. Half a video is worse than an
 * honest refusal.
 *
 * **Superseded as the way a clip export gets its bytes** (D613). The bound is
 * a property of the ENVELOPE, not of clips, so the cure was a transport with
 * no envelope: {@link videoclipsCapability.methods.offerClipBytes} hands back
 * a one-shot `peerBytes` ticket and the consumer streams it straight to disk,
 * holding nothing. This method stays for a consumer that genuinely wants the
 * bytes in hand, and for a provider not yet redeployed — with this bound,
 * which for an inline read is not going to move.
 */
export const VIDEOCLIPS_MAX_READ_BYTES = 50 * 1024 * 1024

/**
 * Hard ceiling on ONE {@link videoclipsCapability.methods.offerClipBytes}
 * transfer — ten times {@link VIDEOCLIPS_MAX_READ_BYTES}, and the reasoning is
 * not "ten times more comfortable".
 *
 * The inline bound is set by what is HELD: a base64 envelope is the payload at
 * ~1.33× in the provider AND the same again in the caller, so 50 MiB of clip
 * is ~133 MiB of heap across two processes. Over `peerBytes` the consumer
 * holds one socket chunk at a time and writes straight through to the export
 * file, so its contribution is flat whatever the clip weighs. What is left is
 * the PRODUCER's own copy, and that is a property of how each provider makes a
 * clip rather than of this transport: Hikvision's fetch writes to a scratch
 * FILE and offers it (nothing is held), Reolink's cmd-5 transfer is collected
 * in memory and offered from there (one copy, the one it already had).
 *
 * So this number bounds the worst provider, not the transport, and it is named
 * separately so that lifting it is a statement about a provider rather than
 * about clips. Above it the provider REFUSES with the size in the message and
 * never truncates: half a video is worse than an honest refusal.
 */
export const VIDEOCLIPS_MAX_OFFER_BYTES = 500 * 1024 * 1024

/**
 * A clip's finished bytes, inline — the twin of `recordingExport.readExportBytes`.
 *
 * `bytes` is the DECODED length, so nobody infers it from the base64 length,
 * and `served` says which twin the caller actually got.
 */
export const ClipBytesSchema = z.object({
  base64: z.string(),
  contentType: z.string(),
  /** Suggested filename, extension included. */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  /**
   * Which twin was actually served — the same contract
   * {@link ClipPlaybackSchema.served} carries, and REQUIRED here because the
   * export record persists it: a row read a week later must say the same thing
   * the panel said at the moment of the tap. A missing main twin is never
   * served silently as if it were the asked-for quality (D549 15).
   */
  served: CamProfileSchema,
  /**
   * The DECODED duration of the delivered file, when the fetch measured one.
   *
   * A clip fetch verifies its own completion against the catalog row and
   * retries a materially short pass (D568); this is that measurement, carried
   * so a consumer can say the same thing rather than re-deriving it. Absent
   * when the producer did not measure — never zero, which would say the file
   * is empty.
   */
  durationMs: z.number().positive().optional(),
})
export type ClipBytes = z.infer<typeof ClipBytesSchema>

/**
 * Where a clip's finished bytes can be TAKEN (D613) — the answer to
 * {@link videoclipsCapability.methods.offerClipBytes}.
 *
 * Everything {@link ClipBytesSchema} carries except the bytes themselves, plus
 * the one-shot ticket that leads to them. The metadata is answered BEFORE the
 * transfer on purpose: a consumer learns which twin it got, what to call the
 * file and how long the clip runs without having to read a byte, so a decision
 * it would make on that metadata (a wrong twin, an implausible duration) costs
 * no transfer at all.
 */
export const ClipBytesOfferSchema = z.object({
  /**
   * One shot, seconds-long, loopback, on the PROVIDER's own host. Open it with
   * `ctx.peerBytes.open(...)`, which refuses a ticket from another node by
   * name rather than dialling a port that means something else here.
   */
  ticket: PeerBytesTicketSchema,
  contentType: z.string(),
  /** Suggested filename, extension included. */
  name: z.string(),
  /** Which twin was actually served — see {@link ClipBytesSchema.served}. */
  served: CamProfileSchema,
  /** See {@link ClipBytesSchema.durationMs}. Absent when nothing measured it. */
  durationMs: z.number().positive().optional(),
})
export type ClipBytesOffer = z.infer<typeof ClipBytesOfferSchema>

/**
 * Where a clip's STREAM can be dialled (D597) — the answer to
 * {@link videoclipsCapability.methods.dialClipStream}.
 *
 * `url` is plain `http://` on the provider's own token-gated listener, one
 * shot, short-lived. It is NOT the hub-proxied `/addon/<id>/clip-stream/…`
 * path: that plane takes only a user credential, which an addon does not
 * hold, and the framework offers no addon→addon byte transport — the one
 * precedent is the broker's own restream URLs (`getStreamWithCodec`), which
 * a consumer dials directly, and this is that precedent one addon over.
 */
/**
 * The audio a clip stream can be asked for, and the audio it carries.
 *
 * The camera stores AAC and no WebRTC session speaks it, so a stream that
 * carries sound carries it TRANSCODED, muxed as a second track beside the
 * video by the one ffmpeg the provider already runs (D600). `opus` is
 * 48 kHz mono, `pcmu` is 8 kHz µ-law — the two codecs a broker session
 * negotiates — and `none` is a stream asked for, or served, without sound.
 */
export const ClipStreamAudioSchema = z.enum(['opus', 'pcmu', 'none'])
export type ClipStreamAudio = z.infer<typeof ClipStreamAudioSchema>

/**
 * Why a stream that was ASKED for sound is not carrying it (D600).
 *
 * Only ever set beside `servedAudio: 'none'` after a non-`none` ask. Absent
 * means the ask was honoured, or there was no ask.
 *
 * - `not-requested` — the caller asked for `none`.
 * - `unsupported-ask` — the provider cannot produce that codec.
 *
 * Whether the RECORDING has sound at all is not knowable here: the camera
 * declares no audio track before its first frame arrives. That answer is in
 * the stream itself — an fMP4 with no audio track — and the broker reads it
 * there. A dial that says `opus` promises the codec, never the content.
 */
export const ClipStreamAudioReasonSchema = z.enum(['not-requested', 'unsupported-ask'])
export type ClipStreamAudioReason = z.infer<typeof ClipStreamAudioReasonSchema>

export const ClipStreamDialSchema = z.object({
  url: z.string().min(1),
  /** After this the token is gone and the URL answers 404 `dial-expired`. */
  expiresAtMs: z.number(),
  /** What the stream IS — a consumer that cannot honour it must not dial. */
  transport: z.literal('forward-only'),
  /**
   * Which twin the stream ACTUALLY carries — not what was asked for.
   *
   * The stream serves every profile (D599), and a recording whose main twin
   * does not exist is streamed as its sub copy, which this field reports as
   * `low`. That is the whole reason the dial no longer refuses `high`:
   * stating what was served is what makes accepting honest, where a silent
   * substitution would be the 33x lie D576 forbids. Stated rather than
   * assumed, the way {@link ClipPlaybackSchema.served} is (D549 15).
   */
  served: CamProfileSchema,
  /**
   * Which audio the stream will ACTUALLY carry — `served`'s companion for
   * sound, and the same reasoning (D599, D600).
   *
   * The broker asks for the codec its WebRTC session negotiated, and the
   * provider either muxes that codec or carries none. Stating it is what
   * lets the broker wire the matching sink before the first byte, and what
   * keeps a session from being handed a codec it cannot send — the audio
   * shape of the substitution `served` exists to prevent.
   *
   * It is a promise about the CODEC, not about the content: a recording with
   * no microphone track answers `opus` here and then arrives with no audio
   * track at all. That second answer is in the stream, and the broker reads
   * it from the `moov`.
   */
  servedAudio: ClipStreamAudioSchema,
  /** Why `servedAudio` is `none` although sound was asked for. */
  audioReason: ClipStreamAudioReasonSchema.optional(),
})
export type ClipStreamDial = z.infer<typeof ClipStreamDialSchema>

/**
 * The playback rates the broker can pace over media it HOLDS, ascending,
 * always with `1` — and the WIDEST ladder there is. It is the domain the
 * broker's `clampPlaybackRate` is derived from, at both ends.
 *
 * These are the BROKER's: it re-paces frames it has already demuxed — the
 * `MonotonicClock` divides source elapsed time by the factor and the pacer
 * pushes that much faster. `1.5` is in it because a re-pacer has no reason to
 * refuse it.
 *
 * **`8` is here since D621, and it is the pacer's, not a camera's.** D620
 * measured the thing that was assumed for a year and was never true: a
 * Reolink `<playSpeed>` does not time-compress anything. At 1, 2, 4 and 8 the
 * transfer is byte-identical — same 947 472 bytes, same 594 access units,
 * same 39.855 s presentation span, same 624 AAC frames — and only the wall
 * clock moves. It buys SUPPLY, never speed. So there was never a second
 * mechanism to wire for 8×: there is one, this one, and what it needs is
 * media in hand and a clamp that does not move the number.
 *
 * **`16` is deliberately NOT here, and will not join by widening this array.**
 * The camera's `playSpeed 16` is not a rate at all but an I-frame-only MODE —
 * measured on 592: 10 access units for a whole 36.3 s sub clip, 20 for the
 * main twin at a 2 025 ms median spacing, and no audio track. That is
 * different CONTENT, a stream of its own, and the honest broker-side twin of
 * it would be a pacer that DROPS whole GOPs rather than one that pushes 16×
 * the bitrate at a live WebRTC track. Neither exists. A `16` in this array
 * today would be a rate accepted and delivered at 8 — D612's defect, which
 * this list exists to end, one number further along.
 *
 * Every entry must survive the broker's `clampPlaybackRate` unchanged. Since
 * D621 that is structural rather than a discipline: the clamp reads this
 * array's own ends. What still has to be proved behaviourally — and is, in
 * the broker's `clip-stream-feeder.spec` — is that the PACER really empties a
 * clip `rate` times faster, because a clamp agreeing with a ladder is a
 * constant compared against itself.
 *
 * Narrower ladders exist for transports whose SUPPLY is bounded; they are
 * subsets of this one ({@link CLIP_STREAM_SOURCE_RATES},
 * {@link CLIP_REALTIME_SOURCE_RATES}).
 */
export const CLIP_BROKER_PACED_RATES: readonly number[] = [0.25, 0.5, 1, 1.5, 2, 4, 8]

/**
 * The rates a provider-STREAMED clip can be delivered at — a subset of
 * {@link CLIP_BROKER_PACED_RATES}, and frozen below it on purpose (D621).
 *
 * A `stream` clip's media does not exist yet: it arrives on a socket from the
 * camera while the pacer consumes it. The pacer takes `rate` seconds of media
 * per second of wall clock, so the ceiling is whatever the SOURCE supplies,
 * and that is a measurement per vendor rather than a preference.
 *
 * Reolink, the one provider on this envelope, was measured on 592
 * (2026-09-23, D620): with the `<ReplaySeek>` that 0.11.1 sends before every
 * replay, a sub clip arrives at **1.2×** and a main twin at **1.37×**. The
 * ladder below is therefore ALREADY beyond this transport above 1 — the D612
 * defect returned through a door nobody opened — and D620 fixed the repair
 * order: the supply first, the ladder after. So this array does not move with
 * the broker's, and it does not gain `8`; what it gains, when the library
 * forwards a `<playSpeed>` large enough to feed the rate being paced over it,
 * is the right to be widened on a measurement rather than shortened on one.
 */
export const CLIP_STREAM_SOURCE_RATES: readonly number[] = [0.25, 0.5, 1, 1.5, 2, 4]

/**
 * The rates a REALTIME-BOUND stream can be delivered at.
 *
 * **Measured, and it is the whole reason this second ladder exists.** A
 * Hikvision RTSP replay is not a fast fetch: it delivers the recording at the
 * speed it was recorded. On 1436, 2026-09-23, one stream carried 176 access
 * units in 14 274 ms of wall clock at a measured 12.5 fps — 14.08 s of media
 * in 14.27 s, **1.01× realtime** — and a whole 18 s clip took 22.3 s to fetch
 * end to end. Reolink's cmd-5 transfer, which {@link CLIP_BROKER_PACED_RATES}
 * was written for, lands the same bytes at 49–62× and therefore has the entire
 * clip in hand within the first second.
 *
 * The broker's pacer consumes `rate` seconds of media per second of wall
 * clock while the socket supplies one. So at any rate above 1 the buffer
 * drains at `(rate − 1)×` and a stream that is only seconds old runs dry
 * almost at once — the viewer stops, the queue empties, and the provider's
 * own drain gate eventually reports `peer-stalled`. Nothing about that is a
 * bug to be fixed with a bigger buffer: there is no buffer, because the bytes
 * do not exist yet.
 *
 * So the honest answer is the DECLARATION (D612's own rule, applied to the
 * case it did not yet have): a rate this transport cannot deliver is never
 * offered. Below 1 is free — a slower pacer only lets the buffer grow.
 *
 * When a clip is served from a FILE the constraint is gone with the transport,
 * which is why `file` keeps the full ladder.
 */
export const CLIP_REALTIME_SOURCE_RATES: readonly number[] = [0.25, 0.5, 1]

/**
 * What a surface may DRAW for this provider's clips — the answer to
 * {@link videoclipsCapability.methods.getPlaybackOptions} (D612).
 *
 * The envelope is a PROVIDER fact, not a clip fact, and that is measured, not
 * assumed: the broker's `chooseClipPath` reads exactly two inputs — whether
 * `dialClipStream` and `readClipBytes` are wired — and both are constants of
 * the broker's own closure over the provider's methods. The `profile` it is
 * handed is explicitly not read. So every clip of a provider is served the
 * same way, and a per-clip channel carried a value that could not vary. The
 * per-clip `clipTransport` server message was removed for exactly that reason.
 *
 * Queried per camera, before a clip is picked, so a control is rendered or
 * DISABLED rather than offered and refused at play time (D62: a disabled
 * control reads as unavailable, one that undoes the gesture reads as broken).
 */
export const ClipPlaybackOptionsSchema = z.object({
  /**
   * How this provider's clips reach the player. `stream` is the provider's
   * forward-only fMP4 (D597); `file` is one bounded by-handle fetch of the
   * whole clip, `stbl` indexed (D575).
   */
  transport: z.enum(['stream', 'file']),
  /** `forward` = only ahead of the playhead. `free` = anywhere. */
  seek: z.enum(['forward', 'free']),
  /** Frame-step BACKWARD is meaningful. Forward always is. */
  stepBack: z.boolean(),
  /** Whether the scrub gesture is served, as opposed to refused by name. */
  scrub: z.boolean(),
  /**
   * The rates that can be delivered, ascending, always containing `1`. The
   * viewer draws its picker from this and from nothing else — a constant it
   * keeps instead is the second authority that produced the defect: `8` and
   * `16` were offered, the broker clamped them to `4`, and no line anywhere
   * said so. `0` is not a member: pause is the absence of a rate.
   */
  rates: z.array(z.number().positive()).min(1).readonly(),
})
export type ClipPlaybackOptions = z.infer<typeof ClipPlaybackOptionsSchema>

export const ClipSourceAvailabilitySchema = z.object({
  state: z.enum(['ok', 'sleeping', 'unreachable', 'no-storage', 'index-empty']),
  /** Free text, shown verbatim. Names the camera's own refusal when there is one. */
  reason: z.string().optional(),
  /** When this source's catalog was last CONFIRMED. A cached list is never
   *  drawn as current: the surface shows the age whenever it is older than the
   *  refresh interval. */
  catalogAsOf: z.number().optional(),
})
export type ClipSourceAvailability = z.infer<typeof ClipSourceAvailabilitySchema>

/**
 * One SOURCE of clips for a camera — a row of the picker, and the namespace
 * every clip id from it is prefixed with (`analytics`,
 * `native:reolink:onboard`, `hksv`, …).
 *
 * A provider lists the sources IT serves for that device, and answers for each
 * of them whether it can answer at all. A provider with nothing to offer on a
 * camera returns `[]` — it is not that camera's business.
 */
export const ClipSourceSchema = z.object({
  /** The value this source stamps on {@link ClipSchema.source}, and the prefix
   *  of every clip id it mints. `getClipPlayback` routes on it. */
  source: z.string(),
  /** Operator-facing name of the source ("CamStack recordings", "SD card"). */
  label: z.string(),
  /**
   * The addon that SERVES this row.
   *
   * A surface cannot otherwise resolve a source to who answers it, and the
   * alternative — a `native:reolink:* → provider-reolink` table inside the
   * widget — is a second authority on provider identity living in the one
   * package with no business knowing it, wrong the day a third source appears
   * (D557). One addon may serve SEVERAL sources, which is why the per-device
   * switch is keyed by SOURCE and not by this (D555) — `addon-provider-reolink`
   * served a hub child two of them until the two views were measured to be one
   * store read twice (D555) and then read ONE way (D565).
   *
   * Optional for version skew only. The collection dispatcher stamps it from
   * the registry, so a row that travelled through the fan-out carries the
   * authoritative id whatever the provider filled in.
   */
  addonId: z.string().optional(),
  availability: ClipSourceAvailabilitySchema,
})
export type ClipSource = z.infer<typeof ClipSourceSchema>

export const videoclipsCapability = {
  name: 'videoclips',
  scope: 'device',
  // Several sources per camera, listed beside each other (D549 decision 2).
  // The mount stays `device-scoped` — see `resolveCapMount`'s ordering and
  // D554: per-device wins over the global collection fan-out.
  mode: 'collection',
  kind: 'wrapper',
  defaultActive: true,
  /** A clip is a window over a camera's footage — the cap is meaningless on a
   *  sensor, a button or an event emitter, and the `defaultActive` auto-bind
   *  reads this to decide which devices it may claim. */
  deviceTypes: [DeviceType.Camera],
  /**
   * The Clips section of a camera's device details is FRAMEWORK-DERIVED (D14):
   * the aggregator turns this declaration into the `type:'widget'` section and
   * `DeviceDetail.tsx` is never edited. `videoclips` is the first WRAPPER cap
   * to declare one — every previous `host/` widget cap is `deviceNative` — so
   * `device-config-widget-wrapped-binding.spec.ts` pins that a `kind:'wrapped'`
   * binding entry derives the same section a native one does.
   *
   * **It is a SECTION of the Recording tab, at the end of it — not a tab of
   * its own.** It shipped as a `clips` top-tab and the operator rejected the
   * placement: *"utilizzerei la stessa tab recordings, lì abbiamo già tutto il
   * necessario, una nuova sezione alla fine per le clips"* [I would use the same recordings tab, there we already have everything necessary, a new section at the end for the clips]. The Recording tab
   * already holds the recorder's panel, the schedule bands and the unified
   * retention policy; footage the camera itself holds is the same question,
   * asked of a different store. `order: 100` puts it after all of them with
   * room left in front. The `clips` entry in `WELL_KNOWN_TABS` went with it —
   * a well-known id nobody declares is an invitation to mint the tab again.
   *
   * `topTab` stays: the browser owns a pane (a day's tiles, a source list and
   * a player) and the Config tab's inner bar has no room for one. The widget
   * itself is `host/clips-browser` in ui-library's `HOST_WIDGETS`, and because
   * the admin Recordings page renders every `location:'top-tab'` +
   * `tab:'recording'` section behind its camera picker
   * (`CameraRecordingSettingsSection`), this declaration lands the section on
   * BOTH surfaces with no second wiring.
   */
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/clips-browser',
      tab: 'recording',
      topTab: true,
      label: 'Clips',
      order: 100,
    },
  },
  methods: {
    listClips: method(
      z.object({
        deviceId: z.number(),
        since: z.number(),
        until: z.number(),
        limit: z.number().int().positive().optional(),
        /**
         * WHICH provider to ask — the `addonId` a {@link ClipSourceSchema} row
         * carries, never a source id and never a list. **Required** (D554 amended).
         *
         * A provider the device is not bound to is refused by name rather than
         * answered by another one (D552's `rejectUnresolvedAddonPin` rule).
         *
         * It was optional, documented as "absent means the device's BOUND
         * provider, which is CamStack on every camera". No code implemented
         * that. Measured on the live hub 2026-09-20 — device 107, bound to
         * `recorder` AND `provider-reolink` — a bare call with `limit: 3`
         * answered SIX rows, three from each source, merged newest-first:
         * `device-collection-dispatch.ts` simply left the fan-out un-narrowed,
         * so absence bought the union this method exists not to be, and
         * `limit` meant `limit × sources`.
         *
         * There is nothing to restore the default to. `getBindings` answers a
         * collection cap with a DERIVED, PLURAL set (D554 amended, step 0);
         * `setWrapperActive` — the singleton authority that could name one —
         * throws for a collection cap by design. Naming CamStack here instead
         * would privilege one addon by id inside a surface whose premise is
         * that sources are peers, and would be wrong on the first camera with
         * no recorder binding. So absence is REFUSED, in the schema, where the
         * generated types make it unomittable rather than merely discouraged.
         *
         * The default belongs to the SURFACE, which has the `listSources` rows
         * and can say which one it picked (D569 § 1–3; the viewer already
         * always sends this).
         *
         * It replaced `sources?: string[]`, a VIEW filter over source ids that
         * assumed the answer was a fan-out over everything a camera has. The
         * operator settled otherwise on 2026-09-20 — *"l'utilizzatore è uno
         * solo"* [there is only one user] — so the list is asked of one provider at a time and there is
         * nothing to filter out of it.
         */
        provider: z.string().min(1),
      }),
      z.array(ClipSchema).readonly(),
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * The sources this camera has, WITH the reason any of them cannot answer.
     *
     * Asked separately from `listClips` because an empty clip list is
     * ambiguous and this is the only place the ambiguity is resolved: every
     * bound provider contributes its own rows, and a provider that could not
     * be reached at all still produces one row saying so. A surface that draws
     * "no clips" without reading this is drawing a guess.
     */
    listSources: method(z.object({ deviceId: z.number() }), z.array(ClipSourceSchema).readonly(), {
      kind: 'query',
      auth: 'protected',
    }),
    getClipPlayback: method(
      z.object({
        deviceId: z.number(),
        clipId: z.string(),
        /**
         * Which twin to serve, on the ONE quality scale the system already has
         * (`CamProfileSchema`). `low | mid` → the sub file, `high` → the main
         * twin; both ids are already on the row so this never re-searches the
         * camera. Absent means the provider's own default (the sub file, which
         * every source is measured to hold).
         *
         * `auto` is deliberately NOT accepted here: a stored file has no
         * broker session, so the adaptive tier cannot be resolved for it. The
         * viewer resolves `auto` to a profile the same way live does, before
         * it calls (D549 15).
         */
        profile: CamProfileSchema.optional(),
      }),
      ClipPlaybackSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * This clip's BYTES, base64, bounded — the by-handle read a clip EXPORT
     * pulls once (D558).
     *
     * `getClipPlayback` is the right answer for a player: it hands back a URL
     * on a plane the hub serves `access:'authenticated'`, which a browser and a
     * viewer session satisfy. It is the wrong answer for another ADDON: the
     * hub's proxy in front of that plane takes only a user credential, which
     * an addon does not hold, so a recorder that wants a camera's clip cannot
     * fetch that URL. This method is the shape that answer forced — the same
     * one (and the same bound) as `recordingExport.readExportBytes`.
     *
     * **It is no longer the only seam.** Until D613 there was no addon→addon
     * byte transport at all; there is now
     * ({@link offerClipBytes}, over `ctx.peerBytes`), it holds nothing on
     * either side, and it is what a clip EXPORT uses. This method remains for
     * a consumer that genuinely wants the bytes in hand, and as the named
     * fallback for a provider not yet redeployed.
     *
     * Routing needs no `provider` pin: the id is source-prefixed and
     * self-contained, so `device-collection-dispatch.ts` rule 3 hands the call
     * to the source that claims it — and an id nobody claims is REFUSED rather
     * than answered by another source.
     *
     * The producer reuses the fetch path it already has, completion rules
     * included: a clip is taken by cmd 5 and finished on a short idle window
     * whose result is PROVED against the catalog row's own span, retried once
     * when it comes up materially short, and served-and-named when it is still
     * short (D568). A second fetch with different completion rules is exactly
     * the second authority D558 refuses to create.
     *
     * Every refusal THROWS with its reason and none of them is silent — the
     * sleep gate (decided before `getApi()`, liftable only by
     * {@link ClipWakeSchema}), a catalog row nobody claims, a clip with no
     * bytes behind it, a mux that failed, and the size bound. The caller turns
     * that reason into an operator-facing one; a truncated file is never an
     * answer.
     */
    readClipBytes: optionalMethod(
      z.object({
        deviceId: z.number(),
        clipId: z.string().min(1),
        /**
         * WHICH provider holds the bytes — the `addonId` a
         * {@link ClipSourceSchema} row carries. **Required**, for the reason
         * `listClips` states one method above and for a second one this method
         * learned the hard way.
         *
         * The caller is the stream broker, and the broker lives in
         * `addon-pipeline` — the same addon that registers the RECORDER's
         * videoclips provider. With no provider named, the in-process
         * resolution handed it its own sibling, which implements this method
         * solely to explain that an analytics visit has no file behind it. So
         * every onboard clip answered with that sentence, a flash of video and
         * nothing more, while the SAME call from outside the addon reached the
         * right provider and returned the bytes (measured on 3628,
         * 2026-09-21).
         */
        provider: z.string().min(1),
        /**
         * Which twin to fetch, on the mapping D549 15 already fixed:
         * `low | mid` → the sub file, `high` → the main twin. `auto` is not
         * accepted here for the same reason it is not accepted by
         * `getClipPlayback` — a stored file has no broker session, so the
         * adaptive tier cannot be resolved for it.
         */
        profile: CamProfileSchema.optional(),
        /**
         * The CALLER's byte bound, so an over-size clip is refused before it is
         * read and encoded rather than after. Capped by
         * {@link VIDEOCLIPS_MAX_READ_BYTES} whatever is passed; absent means
         * that ceiling.
         */
        maxBytes: z.number().int().positive().optional(),
        /**
         * The operator's authorisation to wake a sleeping camera for this
         * read. Absent — the default — means a sleeping standalone battery
         * camera is REFUSED by name, before any session is opened.
         */
        wake: ClipWakeSchema.optional(),
      }),
      ClipBytesSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * Where this clip's finished bytes can be TAKEN — the by-handle read a
     * clip EXPORT pulls, over the addon→addon byte transport (D613).
     *
     * This is {@link readClipBytes} with the envelope removed. Same gates,
     * same vocabulary, same completion rules, same `served` contract — the
     * only difference is that the bytes travel over a one-shot loopback
     * socket instead of inside a base64 field, so neither side holds the
     * payload whole and the 50 MiB refusal on a long `high` twin stops
     * existing. The bound that remains is
     * {@link VIDEOCLIPS_MAX_OFFER_BYTES}, and it bounds the PRODUCER's own
     * copy rather than the transport.
     *
     * **The ticket is loopback and same-host.** A provider on an agent mints a
     * URL that means nothing on the hub, and `ctx.peerBytes.open` refuses it
     * `cross-node` by name rather than dialling whatever else holds that port
     * here. A consumer that can be on the other side of a node boundary from
     * its provider must be able to read that refusal and say so; it must not
     * treat it as "no bytes".
     *
     * **A ticket is a one-shot bearer credential with a seconds-long life.**
     * Take it immediately, never persist it, never log its `url`. An untaken
     * ticket costs the provider one map entry until its TTL, and outstanding
     * tickets are bounded — which is also what makes a per-frame misuse of
     * this method refuse by name rather than work slowly (D9/D18: this is a
     * by-handle fetch of finished media, not a frame pipe).
     *
     * Optional on the provider for the same reason `readClipBytes` is: a
     * source with no camera socket behind it has no bytes. A provider that
     * predates this method answers `NOT_IMPLEMENTED`, and a consumer may fall
     * back to `readClipBytes` — but it says so in the log, with the deploy
     * hint, because that fallback re-imposes the 50 MiB refusal and an
     * operator who sees `too-large-to-transfer` after this shipped is looking
     * at a stale addon, not at a clip that cannot be exported.
     */
    offerClipBytes: optionalMethod(
      z.object({
        deviceId: z.number(),
        clipId: z.string().min(1),
        /** WHICH provider holds the bytes — see `readClipBytes.provider`. */
        provider: z.string().min(1),
        /** Which twin — `low | mid` → the sub file, `high` → the main twin. */
        profile: CamProfileSchema.optional(),
        /**
         * The CALLER's byte bound, so an over-size clip is refused before the
         * camera is touched rather than after. Capped by
         * {@link VIDEOCLIPS_MAX_OFFER_BYTES} whatever is passed; absent means
         * that ceiling.
         */
        maxBytes: z.number().int().positive().optional(),
        /**
         * The operator's authorisation to wake a sleeping camera for this
         * read. Absent — the default — means a sleeping standalone battery
         * camera is REFUSED by name, before any session is opened.
         */
        wake: ClipWakeSchema.optional(),
      }),
      ClipBytesOfferSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * Where this clip's STREAM can be dialled (D597) — the forward-only
     * fMP4 the provider writes from the first muxed byte, for the broker to
     * play through the same WebRTC session as recorded footage, with the
     * first frame at the first fragment instead of after the last byte.
     *
     * Nothing is fetched here: the answer is a one-shot URL on the
     * provider's own listener, and the camera is touched when it is dialled.
     * The gates the file path runs (`readClipBytes`) run on the dial too —
     * the id, the row, a clip still being written — and refuse in the same
     * vocabulary, THROWN with `clipExportFailure(<token>, <prose>)`. Every
     * profile is served (D599) and the answer states which twin it carries;
     * `high` is not refused. Optional on the provider for the same reason
     * `readClipBytes` is: a source with no camera socket behind it (the
     * recorder's analytics window, a HomeKit tee) has no stream.
     */
    dialClipStream: optionalMethod(
      z.object({
        deviceId: z.number(),
        clipId: z.string().min(1),
        /** WHICH provider holds the camera — see `readClipBytes.provider`. */
        provider: z.string().min(1),
        /** Which twin — `high` → the main file, everything else the sub (D599). */
        profile: CamProfileSchema.optional(),
        /**
         * Which audio codec the caller's session negotiated, so the provider
         * can mux it (D600). The ask travels on the DIAL because the mux is
         * spawned once, before the first byte, and cannot gain a track later.
         *
         * ABSENT IS `none`, never a guess: a caller that does not state an
         * ask is served the video-only stream that shipped first, so a broker
         * older than this field keeps working unchanged (D382 — an unstated
         * ask is zero).
         */
        audio: ClipStreamAudioSchema.optional(),
      }),
      ClipStreamDialSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * What a surface may DRAW for this provider's clips: the rates it can be
     * played at, whether scrub is served, how far a position may be moved,
     * and whether a backward frame-step means anything (D612).
     *
     * **The only authority.** The per-clip `clipTransport` server message
     * that used to carry the same answer was removed: the broker's transport
     * choice reads nothing that varies per clip, so the clip level had no
     * information the provider does not already have, and two channels that
     * can disagree are worse than one (D62).
     *
     * Asked per camera and per provider, so it must stay CHEAP — it is a
     * statement about wiring, answered from a constant, never a call to the
     * camera. A provider answers with one of {@link CLIP_PLAYBACK_OPTIONS}
     * and never composes an envelope of its own.
     *
     * Optional, and absence is load-bearing: a provider that has not answered
     * has not restricted anything, and a viewer reads it as the freedom it
     * always had. See D612 on the rollout order that absence implies.
     */
    getPlaybackOptions: optionalMethod(
      z.object({
        deviceId: z.number(),
        /** WHICH provider to ask — the `addonId` a {@link ClipSourceSchema}
         *  row carries. Required for the same reason `listClips` requires it:
         *  a collection cap has no "the bound one" to resolve to (D554). */
        provider: z.string().min(1),
      }),
      ClipPlaybackOptionsSchema,
      { kind: 'query', auth: 'protected' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IVideoclipsProvider = InferProvider<typeof videoclipsCapability>

/**
 * NOTE ON PLACEMENT: this block lives AFTER the capability definition on
 * purpose. `scripts/lib/parse-cap.ts` finds a cap by the FIRST
 * `export const <X> = {` in the file, so an object literal declared above
 * `videoclipsCapability` is silently taken for the capability itself and
 * codegen emits a `DeviceProxy` entry that does not type-check. Found the
 * hard way, 2026-09-23.
 */
/**
 * The two envelopes, spelled ONCE.
 *
 * A provider answers with the entry for the transport its own wiring buys —
 * `stream` if it implements `dialClipStream`, `file` if it implements only
 * `readClipBytes` — and never composes one of its own. One table is what
 * makes "the provider may not promise what no clip can be given" structural
 * instead of a discipline: there is nothing else to promise.
 */
export const CLIP_PLAYBACK_OPTIONS = {
  stream: {
    transport: 'stream',
    // The bytes behind the head were never kept and the camera offers no
    // replay-from-offset, so every backward move is refused by name.
    seek: 'forward',
    stepBack: false,
    scrub: false,
    rates: CLIP_STREAM_SOURCE_RATES,
  },
  /**
   * A `stream` whose SOURCE runs at realtime — a Hikvision RTSP replay.
   *
   * Same verbs as `stream`, a shorter rate ladder, and the difference is a
   * measurement rather than a preference: see
   * {@link CLIP_REALTIME_SOURCE_RATES}. A third entry rather than a parameter,
   * because a provider must still be able to do nothing but NAME one of these.
   */
  realtimeStream: {
    transport: 'stream',
    seek: 'forward',
    stepBack: false,
    scrub: false,
    rates: CLIP_REALTIME_SOURCE_RATES,
  },
  file: {
    transport: 'file',
    // The whole clip is in hand and `stbl` reaches anywhere in it.
    seek: 'free',
    stepBack: true,
    scrub: true,
    // The media is HELD, so the pacer's only bound is the bitrate it pushes
    // at — this is the one envelope that carries the broker's full ladder,
    // 8 included (D621).
    rates: CLIP_BROKER_PACED_RATES,
  },
} as const satisfies Record<string, ClipPlaybackOptions>
