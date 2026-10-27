/**
 * NcDispatcher — turns a durable outbox entry into ONE canonical
 * `notification-output.send` RPC.
 *
 * Deps are injected tRPC-shaped closures (the wiring in
 * pipeline-analytics binds them to `ctx.api` / the media store), so the
 * dispatcher is unit-testable with fakes and stays extractable.
 *
 * Responsibilities:
 *  - resolve the outbox entry's `targetId` against the live
 *    `notification-output` target catalog (TTL-cached; the send call is
 *    routed to the owning provider by the target's `addonId`);
 *  - resolve the media attachment per the rule's policy from the media
 *    store BY OWNER at SEND time — D-3 "best media AVAILABLE at the
 *    moment": the drain runs after the persist moment, so late-landing
 *    crops are picked up without ever delaying delivery;
 *  - render the `{{var}}` template (title/body) over the frozen subject;
 *  - map recognized per-target passthrough params onto canonical
 *    Notification fields (level/sound/clickUrl/ttl) — everything else is
 *    the degrade engine's job.
 *
 * Failure semantics: an UNKNOWN target (no longer in the catalog) ⇒ PERMANENT
 * failure (the outbox dead-letters the row — genuine misconfig); a globally
 * DISABLED target (operator kill-switch) ⇒ benign skip (no send, no dead row);
 * transport/backend errors ⇒ transient (retried with backoff).
 */

import {
  eventKindLabel,
  type IScopedLogger,
  type MediaFileBytes,
  NC_CLIP_POST_ROLL_DEFAULT_SEC,
  NC_CLIP_PRE_ROLL_DEFAULT_SEC,
  type NotificationAction,
  type ViewerLinkBase,
} from '@camstack/types'
import { isStateSummaryData } from './state-summary/state-summary-delivery.js'

// The gate's OWN input shape, defined where the gate is. Two copies of a shape
// that must agree is the defect this repo keeps paying for; re-exported here so
// a wiring importing the dispatcher does not have to know which file it is in.
export type { NcConfirmGateInput } from './confirm-gate.js'

import { artifactKindForMediaType, type NcArtifactPublishMeta } from './artifact-index.js'
import { ncClockText } from './clock-text.js'
import { NC_CONFIRM_FALLBACK_TIMEOUT_MS, type NcConfirmGateInput } from './confirm-gate.js'
import { defaultTapUrl } from './default-tap-url.js'
import { footageSourceFor } from './footage-source.js'
import {
  groupedTileEntry,
  groupedTileMembers,
  type NcGroupedMosaicResult,
  type NcGroupedTileMiss,
  type NcGroupedTileSet,
  type NcGroupedTileStill,
} from './grouped/grouped-mosaic.js'
import {
  type NcGroupView,
  type NcOutboxGroupMemberV2,
  readOutboxGroup,
} from './grouped/grouped-payload.js'
import { ncGroupSubjectText } from './grouped/grouped-text.js'
import {
  anchorFellBack,
  mediaAnchor,
  type NcMediaAnchor,
  selfDatingKindOf,
} from './media-anchor.js'
import type {
  NcConfirmTileCounts,
  NcDeliverResult,
  NcOutboxConfirmPolicy,
  NcOutboxConfirmVerdict,
  NcOutboxEntry,
  NcOutboxPayload,
} from './outbox.js'
import { eventMediaScopeOf, type NcEventMediaScope } from './outbox-key.js'
import type {
  NcRecordedClipRefusal,
  NcRecordedClipRequest,
  NcRecordedClipResult,
} from './recorded-clip.js'
import {
  NC_RECORDED_CUT_JOIN_GRACE_MS,
  NC_RECORDER_BUSY_MS,
  NcRecordedCutMemo,
  type NcSharedCut,
  recordedCutKey,
} from './recorded-cut-memo.js'
import type { NcRecordedGifRequest, NcRecordedGifResult } from './recorded-gif.js'
import { renderTemplate, templatePlaceholders } from './render-template.js'
import { NC_RULE_AI_TRACK_FRAMES, pickTrackNarrationFrames, ruleAiWordCap } from './rule-ai.js'
import type {
  NcRuleAiFrame,
  NcRuleAiInput,
  NcRuleAiOutcome,
  NcRuleAiStats,
} from './rule-ai-analyst.js'
import {
  type NcTrackAtInstant,
  NcNotificationImageStage,
  primaryImageCamera,
} from './notification-image.js'
import { cleanSourcePreference, isAnnotatedSceneKind } from './rule-engine.js'
import {
  type MosaicRenderRequest,
  type MosaicRenderResult,
  renderMosaic,
} from './summary/mosaic-renderer.js'
import { NcTextCatalog } from './text-catalog.js'
import {
  ncDetectionSummary,
  ncInZonesText,
  ncOccupancyOp,
  ncSentenceCaseBody,
  ncSubjectText,
} from './text-compose.js'
import {
  type NcSubjectTrailPoint,
  selectTriggerZoneCandidates,
  TRAIL_MATCH_MAX_MS,
} from './trigger-zone-still.js'

/**
 * Re-exported so every existing importer keeps its import path. The function
 * itself now lives in `render-template.ts` — see that module for why.
 */
export { renderTemplate } from './render-template.js'

/**
 * ONE cut of the event, in every container the rule asked for.
 *
 * It is one request and not two on purpose. When the gif and the mp4 were
 * rendered independently they came from different sources and covered different
 * windows — the operator received a gif that wrapped the event and a video that
 * started seven seconds after it. Asking once is what makes "the two
 * attachments show the same thing" a property of the call rather than something
 * two call sites have to keep agreeing about.
 */
export interface NcEventMediaRequest {
  readonly deviceId: number
  readonly aroundMs: number
  /** Attach the video. */
  readonly wantMp4: boolean
  /** Attach the gif — DERIVED from the same cut, never rendered separately. */
  readonly wantGif: boolean
  readonly preRollSec: number
  readonly postRollSec: number
  /** Absent = the cheapest assigned profile (the rule's default). */
  readonly profile?: string
  /** Playback rate from the rule's media policy. Absent = the broker's 2x. */
  readonly speed?: number
}

/** What one cut produced. Either may be null — a notification that lost its
 *  footage is still a notification. */
export interface NcEventMedia {
  readonly mp4: Uint8Array | null
  readonly gif: Uint8Array | null
}

/** The slice of a `notification-output` Target the dispatcher needs. */
export interface NcTargetRef {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
  /** Personal-target owner (`config.ownerUserId`), for rule→user fan-out. */
  readonly ownerUserId?: string
  /**
   * The KIND's declared body budget (`TargetKindCaps.bodyMaxLen`) — the same
   * number the degrade engine truncates the finished body on.
   *
   * Carried here so the AI narration's default WORD CAP can come from the
   * delivery target rather than from a hand-written list of service names that
   * would be free to disagree with it (see `ruleAiWordCap`). Absent = the kind
   * catalog did not answer, which is UNKNOWN and falls back to a push-shaped
   * default — never to "no cap".
   */
  readonly bodyMaxLen?: number
}

/**
 * A finished notification, plus what the AI pass needs to add a sentence to it
 * WITHOUT re-resolving anything.
 *
 * `withAiText` exists because the sentence can only be produced after the
 * picture has been resolved and shown to a model, while the body is composed
 * from the catalog and the rule's template long before that. The alternative —
 * a second body-composition path that only the AI uses — is two recipes for one
 * sentence, and this file has enough of those.
 */
export interface NcBuiltNotification {
  readonly notification: NcNotificationInput
  readonly artifactIds: readonly string[]
  /** Resolved once, here, and reused by the prompt so the model and the
   *  recipient are told the camera is called the same thing. */
  readonly deviceName: string
  /**
   * A grouped row's tiles (D692 §6.2 item 9), resolved ONCE here and shared: the mosaic was
   * composed from exactly these stills, and the confirm gate and the AI analyst judge exactly
   * these — never the composite, never a second read. `null` on every other row.
   */
  readonly grouped: NcGroupedTileSet | null
  /** The SAME notification with the model's sentence placed in its body. `''`
   *  reproduces the body byte-for-byte. */
  readonly withAiText: (aiText: string) => NcNotificationInput
}

/**
 * Where the model's sentence goes.
 *
 * Three cases, and the third is the one that would otherwise be reported as a
 * bug:
 *
 *  - no sentence → the body exactly as it was before this feature existed.
 *  - a template that NAMES `{{ai}}` → left exactly as written; the operator
 *    placed it deliberately.
 *  - anything else → APPENDED on its own line, BELOW the detection line.
 *
 * Below, and not above as the digest does it, and the difference is what gets
 * truncated. A digest's counts are the part you check afterwards, so its
 * sentence leads. A detection body's first line is the fact ("Persona su
 * Front door") and a lock screen cuts from the end — putting a paragraph in front
 * of it would push the fact off the screen on exactly the notifications that
 * matter most.
 */
function composeRuleAiBody(input: NcRuleAiBodyInput): string {
  if (input.aiText.length === 0) return input.body
  if (input.templateNamesAi) return input.body
  return input.body.length === 0 ? input.aiText : `${input.body}\n${input.aiText}`
}

export interface NcRuleAiBodyInput {
  readonly aiText: string
  readonly body: string
  readonly templateNamesAi: boolean
}

/** Canonical notification input handed to `notification-output.send`. */
export interface NcNotificationInput {
  readonly body: string
  readonly title?: string
  readonly priority?: number
  readonly level?: string
  readonly sound?: string
  readonly clickUrl?: string
  readonly ttl?: number
  readonly tag?: string
  readonly deviceId?: number
  readonly eventId?: string
  /**
   * Tap-through buttons, each already carrying a minted single-use callback.
   *
   * Built per DELIVERY, not per notification: the token is spent by the first
   * tap, so two targets sharing one would mean the second person's button was
   * dead before they saw it.
   */
  readonly actions?: ReadonlyArray<NotificationAction>
  readonly attachments?: ReadonlyArray<NcNotificationAttachment>
}

/**
 * One attachment on a canonical notification.
 *
 * Named rather than inline because two producers build one now: the media
 * ladder (bytes, optionally published to a URL) and a frozen artifact link a
 * timelapse row carries (URL only, bytes never held).
 */
export interface NcNotificationAttachment {
  readonly mediaType: 'image' | 'gif' | 'video'
  /**
   * OPTIONAL, because an attachment may be a link the centre never held the
   * bytes of. The wire `AttachmentSchema` has always allowed url-only —
   * "exactly one of `url` or `bytes` MUST be present" — and the degrade engine
   * expresses a url→bytes fetch as the `needsFetch` directive a bytes-only
   * backend runs.
   */
  readonly bytes?: Uint8Array<ArrayBuffer>
  /**
   * Externally-reachable signed link to the SAME bytes, when the artifact
   * plane could mint one. Emitting BOTH lets the degrade engine pick per
   * target: a bytes-mode backend uploads, a url-mode one (WhatsApp, gotify)
   * links — those received no media at all while attachments were
   * bytes-only — and an over-`maxBytes` attachment can degrade to a link
   * instead of being dropped.
   */
  readonly url?: string
  readonly mime?: string
  readonly name?: string
}

/**
 * One attachment the media ladder resolved, bytes in hand.
 *
 * Named because three producers build one (the still ladder, the footage cut,
 * the zone crop) and one consumer counts them for the delivered line.
 */
export interface NcResolvedAttachment {
  readonly mediaType: 'image' | 'gif' | 'video'
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mime: string
  readonly name: string
}

/** Everything `resolveAttachments` produced: what ships, and a grouped row's tiles. */
interface NcResolvedAttachments {
  readonly attachments: readonly NcResolvedAttachment[]
  readonly grouped: NcGroupedTileSet | null
}

/** A grouped row's picture (null: nothing landed) and the stills it was composed from. */
interface NcGroupedMosaicOutcome {
  readonly attachment: NcResolvedAttachment | null
  readonly stills: readonly NcGroupedTileStill[]
}

/**
 * What one footage cut produced, and whether it was even attempted.
 *
 * `attempted` is the load-bearing half: it is what tells the still ladder
 * whether a multi-second wait just happened that it can look again after.
 */
export interface NcFootageResult {
  readonly attempted: boolean
  readonly attachments: readonly NcResolvedAttachment[]
}

/**
 * How an attachment is NAMED on the delivered line — the operator's words, not
 * the wire's: 'still' is what a phone shows as the picture.
 */
export type NcAttachmentKindLabel = 'still' | 'gif' | 'video'

/** What a recorded cut contributes to the notification: a gif derived from
 *  the cut and/or the cut itself (D682, D686). */
export type NcRecordedFootageKind = 'gif' | 'video'

/**
 * Why a rule that asked for a gif gets none from the recordings.
 *
 * - `not-self-dating` — the recorded gif belongs to a kind whose source DATES
 *   its own change: a package PICK-UP (D682) and, since D691, an OCCUPANCY
 *   edge. Every other kind keeps what it had before: the ring's gif, or none.
 * - `moment-unknown` — the pick-up or the occupancy edge could not be dated (a
 *   row with no stored instant, D684; an edge with no `observedAt`), so the
 *   only cut on offer is around the CONCLUSION: the empty doormat D682 exists
 *   to remove, the empty parking space D691 does. No gif beats a gif of the
 *   wrong time.
 * - `no-derive` — nothing wired to turn a cut into a gif.
 */
export type NcRecordedGifRefusal = 'not-self-dating' | 'moment-unknown' | 'no-derive'

/**
 * Why a rule that asked for a video gets none from the recordings.
 *
 * - `moment-unknown` — a package PICK-UP that could not be dated (a row
 *   written before D684): the recorded cut on offer is around the CONCLUSION,
 *   the empty doormat as an mp4. Never footage from the wrong time (D682).
 *
 * Every other kind keeps the recorded video it always had — an occupancy edge
 * that fell back included (logged by the anchor line, unchanged here).
 */
export type NcRecordedVideoRefusal = 'moment-unknown'

/** What the recorded cut for one row contributes, and why a kind it asked for
 *  is not among it. */
export interface NcRecordedFootagePlan {
  readonly kinds: readonly NcRecordedFootageKind[]
  /** Present exactly when a recorded cut is wired, the rule asked for a gif,
   *  and the plan carries none. With no cut wired the plan is `{ kinds: [] }`
   *  and names no reason: there is no recorded cut to refuse. */
  readonly gifRefused?: NcRecordedGifRefusal
  /** Same shape, for a video the rule asked for. */
  readonly videoRefused?: NcRecordedVideoRefusal
}

/**
 * What became of one recorded cut the notification waited for (D686). Every
 * variant but `attached` ships the notification without the footage, and each
 * is a different line: a camera that does not record, a wedged recorder and a
 * failed derive are three different fixes.
 */
export type NcRecordedFootageOutcome =
  | {
      readonly kind: 'attached'
      readonly attachments: readonly NcResolvedAttachment[]
      readonly profile: string
      readonly bytes: number
    }
  | { readonly kind: 'cut-refused'; readonly reason: NcRecordedClipRefusal }
  | { readonly kind: 'no-gif' }
  | { readonly kind: 'threw'; readonly error: string }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'recorder-busy'; readonly busyUntil: number }

/**
 * `work`, or `onTimeout` once `ms` has passed — whichever is first. `work` must
 * never reject. The hard edge of the recorded-footage wait: the recorder's own
 * `deadlineMs` is checked between polls, and an RPC in flight is not.
 */
function settleWithin<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms)
    void work.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/** One end-of-window digest, already rendered. */
export interface NcDigestSendInput {
  readonly snoozeId: string
  readonly targetId: string
  readonly title: string
  readonly body: string
  /** How many notifications the window hid for this target (log only). */
  readonly total: number
}

/**
 * A message the Notification Center composes itself, addressed to one target.
 *
 * NOT an outbox row on purpose. The outbox exists so a notification ABOUT AN
 * EVENT survives a crash — the event happened whether or not the hub was up.
 * An arm announcement is about a state the operator is standing in front of:
 * retrying it four minutes later would tell them the alarm armed long after
 * they stopped caring, and a `reason` in the log is the better record.
 */
export interface NcAnnouncementSendInput {
  /** What this announcement is, for the log line. e.g. `alarm-arm`. */
  readonly reason: string
  readonly targetId: string
  readonly title: string
  readonly body: string
  /** The device the announcement is about, so the line is groupable. */
  readonly deviceId?: number
}

export interface NcSendInput {
  readonly addonId: string
  readonly targetId: string
  readonly notification: NcNotificationInput
}

export interface NcDispatcherDeps {
  readonly logger: IScopedLogger
  /**
   * Every word this dispatcher can print.
   *
   * OPTIONAL, and the default is the real thing rather than a stub: a catalog
   * constructed with no snapshot IS the shipped English bundle, which is a
   * complete text set. A wiring that has not read the hub's language setting
   * yet therefore speaks English instead of speaking nothing — the same
   * degrade the store's failure path chooses, for the same reason.
   */
  readonly texts?: NcTextCatalog
  /**
   * Class → palette hex for boxes on a notification picture. Absent: the
   * bundled CamStack preset. The live painter says so when the cap is unknown.
   */
  readonly paintClass?: (kind: string) => string
  /** `notification-output.listTargets` (cluster catalog, concat-fanned). */
  readonly listTargets: () => Promise<readonly NcTargetRef[]>
  /**
   * How many seconds THIS camera's clip ring is holding — the retention its own
   * notification rules asked for (`clip-retention-ask.ts`).
   *
   * A camera whose rules never cut footage is asked to retain nothing, and a
   * camera with an occupancy rule holds a full minute: a single global number
   * is wrong for both of them, in opposite directions, and the one that used to
   * sit here was also stale. Absent ⇒ {@link NC_CLIP_RING_RETENTION_SEC}.
   */
  readonly ringRetentionSecFor?: (deviceId: number) => number
  /** Normalized polygons of the given admin zones (zone-crop attachments).
   *  Best-effort — null/empty skips the crop, never fails the send. */
  readonly getZonePolygons?: (
    deviceId: number,
    zoneIds: readonly string[],
  ) => Promise<ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>>
  /**
   * The device's admin zones, for rendering `{{zones}}` / `{{zone}}` as NAMES.
   *
   * `subject.zones` carries zone IDs — the same ids the rule's `zones.ids`
   * condition matches on, which is correct for matching and unreadable in a
   * body. Before this, a delivered notification read "person on Camera
   * front door in cfeec78c-8d69-…, fa03b60a-5669-…".
   *
   * Rendering-only: conditions keep matching on ids, because a name is not a
   * stable identifier. Best-effort — an unresolvable id renders as the id.
   */
  readonly getZoneNames?: (
    deviceId: number,
  ) => Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>>
  /**
   * Cut the event's footage ONCE, in every container the rule asked for.
   *
   * The implementation picks the source (the warm fMP4 seam when the camera has
   * one, the broker's clip ring otherwise) and derives the gif from the video's
   * own bytes, so both attachments always share a window and a resolution. The
   * dispatcher deliberately cannot ask for them separately — that is the defect
   * this shape exists to make unrepresentable.
   *
   * Neither source is the recording: recorded segments are only addressable
   * once finalized, so a segment-cut clip shows the seconds BEFORE the trigger
   * — and a camera that is not recording produced nothing at all. That holds
   * for a LIVE moment, which is every moment this dep is asked about; an
   * anchored moment old enough to be outside the ring is served by
   * {@link cutRecordedClip} instead, where finalization is long done.
   */
  readonly renderEventMedia?: (input: NcEventMediaRequest) => Promise<NcEventMedia>
  /**
   * Cut the clip out of the RECORDINGS, for a moment the ring can no longer
   * serve (`recorded-clip.ts`, bound by the wiring to `recording` +
   * `recording-export`).
   *
   * AWAITED on the delivery path, under {@link NC_RECORDED_FOOTAGE_WAIT_MS}
   * (D686): a notifier is one-shot, so the footage rides the one message or
   * does not ride at all. The bound is handed down as `deadlineMs`, so a render
   * the dispatcher stopped waiting for is abandoned rather than left running.
   *
   * Optional: a wiring without it ships the notification without the footage
   * and the ring refusal says `next: no-clip`.
   */
  readonly cutRecordedClip?: (input: NcRecordedClipRequest) => Promise<NcRecordedClipResult>
  /**
   * Derive the notification gif from a RECORDED clip's bytes (`recorded-gif.ts`,
   * D682) — the same filter chain the broker applies to a ring cut, so a gif of
   * an old moment looks like a gif of a live one.
   *
   * Only ever called after {@link cutRecordedClip} produced the one cut, and
   * inside the same bound. Optional: without it a gif-only rule whose moment
   * the ring lost orders no cut at all, and says so (`no-derive`).
   */
  readonly deriveGifFromClip?: (input: NcRecordedGifRequest) => Promise<NcRecordedGifResult>
  /**
   * Publish attachment bytes as a signed, externally-reachable URL (the
   * artifact plane). Returns null when no usable base URL exists — the
   * attachment then ships bytes-only, exactly as before. Optional: an older
   * wiring simply has no URLs. `deviceId` says which camera bucket the bytes
   * file under in the eventMedia class — null when the subject has none.
   */
  readonly publishArtifact?: (
    bytes: Uint8Array,
    mime: string,
    deviceId: number | null,
  ) => Promise<string | null>
  /**
   * Publish attachment bytes AND file them in the viewer's artefact gallery.
   * Returns the signed URL (null on a LAN-only host) plus the artefact id so
   * a gif/mp4 can name the still as its poster. Optional: older wirings only
   * have {@link publishArtifact} and do not index.
   */
  readonly indexArtifact?: (
    bytes: Uint8Array,
    mime: string,
    meta: NcArtifactPublishMeta,
  ) => Promise<{ url: string | null; artifactId: string | null }>
  /**
   * Mint this delivery's tap-through buttons.
   *
   * Injected rather than reached for, and for the same reason the snooze gate
   * is: the dispatcher knows the rule, the device and WHO this delivery is for,
   * which is everything a token needs — and keeping the registry out of here
   * leaves the minting testable and the dispatcher ignorant of how a callback
   * is authorised. Optional: a wiring without a reachable public URL simply has
   * no buttons.
   */
  readonly buildActions?: (input: NcMintButtonsInput) => Promise<readonly NotificationAction[]>
  /** `notification-output.send`, routed by `addonId`. */
  readonly send: (
    input: NcSendInput,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>
  /** Media-store `listByOwner` (base64-carrying files). */
  /**
   * The `publicEndpoint` base (D734) — the same ladder the artifact and
   * action planes mint on, so buttons, media and the admin page a system
   * event taps into all resolve on ONE host. Optional: absent ⇒ no default
   * tap URL, authored `clickUrl` params still pass through.
   */
  readonly publicUrlBase?: () => Promise<string | null>
  /**
   * The `notificationTaps` role (D709, D734; admin Network page,
   * `local-network.getNotificationEndpoint`) as a link base: the CamStack app
   * link with the `hub=` it carries, or the hub address flagged for taps. A
   * read that fails is logged and the camera tap opens the hub viewer on the
   * public endpoint, which still opens. Absent ⇒ the same.
   */
  readonly tapBase?: () => Promise<ViewerLinkBase>
  // D476: `'object'`, not `'event'` — the only event-like owner a subject
  // ever carries is an OBJECT event id (see `rule-engine.ts`'s
  // `cleanSourcePreference` for why).
  //
  // `eventScope` is the GENERATION of the event an `'object'` owner id names
  // (`NcEventMediaScope`: camera + the event's own timestamp). Required for
  // `'object'` (D694): an event id is a rowid a deleted record hands to the
  // next insert, so the id alone can name another record's crops. The
  // production reader (`nc-owner-media-reader.ts`) keeps only the rows of that
  // generation and REFUSES an unscoped object read. A track id is random and
  // never reused, and a track-owned read may cross cameras on purpose (a
  // linked camera's still), so it is left unscoped.
  // D694: an `'object'` owner MUST carry its generation at the call site.
  // The production reader (`nc-owner-media-reader.ts`) REFUSES an unscoped
  // object read (empty + ERROR) — the type stays a single signature so the
  // centre wrapper and fakes can share one implementation; the guard
  // `check-object-media-scope-required` keeps the unscoped list path out.
  readonly getMediaForOwner: (
    ownerKind: 'object' | 'track',
    ownerId: string,
    eventScope?: NcEventMediaScope,
  ) => Promise<readonly MediaFileBytes[]>
  /**
   * Where the subject was, over the life of the record — NORMALIZED 0..1, the
   * same space {@link getZonePolygons} answers in, so the dispatcher never has
   * to know a frame's dimensions.
   *
   * Read only for a row that froze `triggerZoneIds`, and only to DROP the
   * candidate stills that show the subject outside the zone that fired the rule
   * (`trigger-zone-still.ts`). Best-effort in every direction: no dep, an empty
   * trail or a throw all leave the ladder exactly as it was.
   */
  readonly getSubjectTrail?: (
    deviceId: number,
    trackId: string,
  ) => Promise<readonly NcSubjectTrailPoint[]>
  /**
   * Every track visible on a camera at an instant (± `toleranceMs`), each with
   * its NORMALISED trail box at that instant — what a `scene-boxes` picture
   * draws thin around its subject (D897). Best-effort: absent or throwing, the
   * picture carries the subject's box alone.
   */
  readonly getTracksAt?: (
    deviceId: number,
    timestamp: number,
    toleranceMs: number,
  ) => Promise<readonly NcTrackAtInstant[]>
  /** Device display name for templating; null when unknown. */
  readonly getDeviceName: (deviceId: number) => Promise<string | null>
  /**
   * The camera's operator-authored location label (`DeviceInfo.location`),
   * read only for the AI narration pass (`NcRuleAiInput.location`) — WHERE
   * the picture was taken, next to WHICH camera took it. Optional and
   * nullable: an absent dep, a `null` answer or a throw all cost the label
   * and nothing else. Wired off the SAME TTL device-facts cache as
   * {@link getDeviceName} — never a second lookup path.
   */
  readonly getDeviceLocation?: (deviceId: number) => Promise<string | null>
  readonly now?: () => number
  /**
   * Wait, for the bounded still poll ({@link NC_STILL_WAIT_MS}). Injected so a
   * test can drive the poll without spending real seconds; production simply
   * sleeps.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * The mosaic renderer for a grouped row (D692 §6.2). Injected so a test can make the
   * composition fail; production uses `renderMosaic` (`summary/mosaic-renderer.ts`).
   */
  readonly renderMosaic?: (
    request: MosaicRenderRequest,
    logger: IScopedLogger,
  ) => Promise<MosaicRenderResult>
  /** Target catalog cache TTL (ms). */
  readonly targetCacheTtlMs?: number
  /**
   * Per-target opt-out check (rule.disabledTargetIds). Optional; absent =
   * never opted out. A true result skips the send BENIGNLY — a suppressed
   * target is not a dead-letter (the user asked not to be notified).
   */
  readonly isRuleTargetDisabled?: (ruleId: string, targetId: string) => Promise<boolean> | boolean
  /**
   * Snooze gate. Returns the id of the window silencing this delivery — which
   * is also the moment it is COUNTED for that window's digest — or null.
   *
   * Injected rather than reached for: the dispatcher knows the recipient
   * (`target.ownerUserId`) and the rule, which is everything the decision
   * needs, and keeping the store out of here leaves the gate testable with a
   * function. Optional: an older wiring simply has no snoozes.
   */
  readonly snoozeGate?: (input: NcSnoozeGateInput) => Promise<string | null>
  /**
   * AI CONFIRM gate. Injected for the same reason the snooze gate is — and
   * called from a different place for a reason that matters: AFTER the
   * notification is built, on the image it is about to ship.
   *
   * That costs a media resolve for a notification that may be suppressed,
   * which is the opposite trade from the snooze gate. It is the right one:
   * there is nothing to judge before the picture exists, and judging a
   * different crop than the one the recipient sees would make every verdict
   * unfalsifiable (D52).
   *
   * Optional: a wiring without the `llm` cap simply has no gate.
   */
  readonly confirmGate?: (input: NcConfirmGateInput) => Promise<NcOutboxConfirmVerdict>
  /**
   * AI NARRATION — `NcRuleAiAnalyst.analyse`, injected.
   *
   * Runs on the finished notification for the confirm gate's reason (the
   * picture described is the picture shipped) and AFTER it for one more: a
   * suppressed notification must not cost a vision call for a sentence nobody
   * will read.
   *
   * Optional: a wiring without the `llm` cap has no analyst, and every rule
   * delivers exactly as it did before the feature existed.
   */
  readonly ruleAi?: (input: NcRuleAiInput) => Promise<NcRuleAiOutcome>
  /** The analyst's counters, ridden out on the delivery line — `failedOpen`
   *  climbing while `described` stays at zero is the shape of a broken pass. */
  readonly ruleAiStats?: () => NcRuleAiStats
  /**
   * Give back the cooldown window a suppressed fire consumed.
   *
   * The cooldown is spent at ENQUEUE, long before the model has an opinion. A
   * suppressed notification that kept it would leave the camera silent for a
   * window opened on a subject the model rejected — so the next, real one is
   * swallowed. Synchronous and best-effort: the map it edits is in this
   * process, and a rollback that fails costs one window, never a delivery.
   */
  readonly releaseCooldown?: (input: NcCooldownRelease) => void
  /** Gate outcome counters, folded into the delivery line — a gate that always
   *  fails open is invisible without them. */
  readonly confirmStats?: () => NcConfirmOutcomeCounts
}

/** The cooldown window a suppressed delivery gives back. */
export interface NcCooldownRelease {
  readonly key: string
  readonly at: number
  readonly ruleId: string
  readonly deviceId: number
}

export interface NcConfirmOutcomeCounts {
  readonly confirmed: number
  readonly suppressed: number
  readonly failedOpen: number
}

/**
 * What the button minter is told about ONE delivery.
 *
 * `ownerUserId` and `className` are here for the snooze button and are the two
 * halves of the window it would open: WHOSE silence it is (frozen at mint —
 * the tapper is never identified, so the recipient is the only honest answer),
 * and about WHAT. A target nobody owns gets no snooze button at all rather
 * than a button that would open a window for nobody.
 */
export interface NcMintButtonsInput {
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  readonly targetId: string
  /** The recipient. Absent for a shared destination nobody owns. */
  readonly ownerUserId?: string
  /** The subject's class, when it has one. */
  readonly className?: string
  /**
   * The system event this notification reports, FROZEN — the row's own
   * `subject.systemEvent`, handed over whole and joined with nothing.
   *
   * It was the `kind` alone until 2026-08-31, which was everything the alarm
   * buttons need (a "disarmed" notification must offer Arm and an "armed" one
   * must offer Disarm) and nothing the UPDATE button needs. That one applies
   * the packages the row named on the node it named, and neither is derivable
   * from a kind. Passing the object rather than growing a second and third
   * scalar keeps the D305 property intact: everything a button acts on is on
   * the row, so a row that drains days late still names the right subject.
   */
  readonly systemEvent?: NcOutboxSystemEvent
}

/** The frozen system event as it sits on a durable row. */
export type NcOutboxSystemEvent = NonNullable<NcOutboxPayload['subject']['systemEvent']>

/** A target's owner as the send gate would read it — or why it could not be read. */
export type NcSnoozeOwnerRead =
  | { readonly known: true; readonly ownerUserId?: string }
  | { readonly known: false; readonly reason: string }

/** What the snooze gate decides on. */
export interface NcSnoozeGateInput {
  readonly ruleId: string
  readonly ruleName: string
  readonly targetId: string
  readonly deviceId: number
  /** The target's owner. Absent for a shared destination nobody owns — only a
   *  GLOBAL window can silence one of those. */
  readonly ownerUserId?: string
  /**
   * The subject's class, when it has one.
   *
   * A window is about a camera and a KIND of thing, so the gate cannot decide
   * without it; and a subject that carries none (a device event, a system
   * event) must be visible AS none — a missing field read as "matches every
   * class" would let "silence the cat" swallow a doorbell press.
   */
  readonly className?: string
  /**
   * A GROUPED row's distinct member classes (D692 C4). When present and non-empty the gate
   * judges EVERY one of them and a class-scoped snooze silences the row only if it covers
   * all of them; `className` is then just the primary's. Absent on every other row.
   */
  readonly classNames?: readonly string[]
  readonly at: number
}

const DEFAULT_TARGET_CACHE_TTL_MS = 60_000

/**
 * A grouped tile is not started with less than this left of the pass budget (or a quarter of
 * the budget, when that is smaller): a call handed ~0 ms can only time out, and would be
 * counted as a no-answer from a model that was never really asked (review T13 L-A).
 */
const NC_CONFIRM_TILE_FLOOR_MS = 1_000

/*
 * The clip window a rule that stores no roll gets is
 * `NC_CLIP_PRE_ROLL_DEFAULT_SEC` / `NC_CLIP_POST_ROLL_DEFAULT_SEC` in
 * `@camstack/types` (4 / 6) — ONE owner, read by every editor too (D654). It is
 * passed to the broker explicitly even though the addon link fills declared
 * cap defaults: a product decision of the notification, not a coincidence of
 * the broker's own.
 */

/**
 * How long the broker retains the footage window a notification is cut from,
 * when nothing more specific is known about the camera.
 *
 * It used to be a hand-kept MIRROR of `CLIP_RETENTION_SEC` in the stream-broker
 * manager, and it drifted the day that constant moved (25 here against 60
 * there) — which is the whole defect this file's `ringRetentionSecFor` dep
 * removes. Retention is now per camera and DERIVED from the rules
 * (`clip-retention-ask.ts`), so the dispatcher asks for the number that camera
 * actually got instead of restating a global one. This constant survives only
 * as the answer for a wiring that supplies no lookup (a test, a dispatcher
 * built before the plan exists): the smallest window any rule can ask for
 * (4 + 6 + 10), so a fallback can only ever be pessimistic — it can send a cut
 * to the recordings that the ring could still have served, never the reverse.
 */
export const NC_CLIP_RING_RETENTION_SEC = 20

/**
 * How long a notification whose moment the ring has lost waits for its
 * RECORDED cut (and the gif derived from it) before it ships without (D686).
 *
 * The notification is HELD for this: a notifier is one-shot, so the footage
 * rides the single message or does not ride at all. Measured on the
 * 2026-09-30 pick-up on 101: export 1 s, derive 262 ms — so the bound is
 * almost never reached, and when it is the render is queued behind something
 * that holds the recorder's one ffmpeg lane for minutes (a timelapse), which
 * no wait worth holding a notification for would outlast.
 *
 * Why not longer: the outbox drains rows ONE AT A TIME, so this is also the
 * worst case by which every row queued behind this one is delayed. A ring cut
 * of a live moment already blocks the drain for its post-roll (6 s) plus the
 * render; 30 s is the ceiling on top of that, reached only when the recorder
 * is wedged. Why not shorter: a moment that reaches this path is already
 * older than the ring (≥ 20 s, a pick-up ≥ 5 min), so a few more seconds cost
 * the operator nothing, and a bound under ~10 s would drop the gif whenever
 * the recorder is merely busy.
 */
export const NC_RECORDED_FOOTAGE_WAIT_MS = 30_000

export { NC_RECORDER_BUSY_MS } from './recorded-cut-memo.js'

/**
 * The bounded wait for a still when the rule asked for NO footage.
 *
 * Track media lands 1.5–5.5 s after the trigger (device 101, 2026-08-12), so a
 * notification built at the instant of the trigger routinely resolves nothing.
 * A rule that also wants footage gets this for free — the render already blocks
 * 7–8 s and the still is re-resolved after it. A rule that wants only a picture
 * has nothing to piggyback on, so it polls: 3 s at 500 ms, then it ships
 * text-only rather than holding the alarm any longer.
 */
export const NC_STILL_WAIT_MS = 3_000
export const NC_STILL_WAIT_INTERVAL_MS = 500

/**
 * How far a still's OWN instant may sit from the trigger and still count as
 * being ABOUT the trigger, for a `delivery: 'immediate'` rule.
 *
 * Derived from {@link TRAIL_MATCH_MAX_MS} rather than repeated: that constant
 * already answers "can the subject's trail speak for this instant", and the two
 * gates run back to back on the same candidate list (moment, then place). If
 * they disagreed, a frame could be judged in-zone for a moment the age gate had
 * already ruled a different one.
 *
 * The value is measured, not chosen: on the 54 live fires of 'Persona su Uscio'
 * a full-scene frame within ±1 s of the trigger existed for 52 (96%) and within
 * ±2 s for 53 (98%), while the frame that produced the operator's report was
 * +4901 ms. Widening this to 5 s would re-admit exactly that frame.
 *
 * It is NOT the ladder's top rung that has to be in band — that rung is the
 * native keyFrame, whose capture misses and retries (36 misses over 105 track
 * starts on device 101 in 6 h), so it is in band only 46% of the time. Holding
 * out for the KIND the rule asked for would wait for the late frame. The gate
 * is the instant; the ladder then runs among the frames that are about it.
 */
export const NC_TRIGGER_STILL_MAX_AGE_MS = TRAIL_MATCH_MAX_MS

/**
 * Which stills a resolve is willing to consider.
 *
 * `trigger-only` is the poll's own standard — a frame from the trigger instant
 * or nothing, so a poll that has not found one yet keeps waiting instead of
 * settling. `any` is the give-up pass: a real picture beats no picture, and the
 * degrade is logged with the frame's age.
 */
export type NcStillFreshness = 'trigger-only' | 'any'

/**
 * Past this age the poll is pointless and only adds latency: the seconds in
 * which this subject's media was being written are long gone, so a row that has
 * been sitting in the outbox (a retry, an unreachable target, a restart) either
 * has its media already or never will.
 */
export const NC_STILL_WAIT_MAX_AGE_MS = 30_000

/**
 * Whether this row's subject can still be photographed AGAIN after its trigger.
 *
 * The one thing that separates a row worth waiting for from a row whose only
 * frame already exists. A live visual track keeps writing media for as long as
 * it is open — its first frame, its periodic snapshots, its last frame all land
 * after the instant a zone condition fired. Every other record is photographed
 * once: an audio window, a device event and a package event are served by the
 * still shelf, which D178 makes take ONE picture for a whole burst, and a
 * `track-end` row is by definition past the last of them.
 *
 * Waiting on the wrong side of this line has cost both ways in production — 3 s
 * of latency on a scream when nothing more was coming, and an empty doorstep on
 * 'Persona su Uscio' when something was.
 */
function canStillGainMedia(entry: NcOutboxEntry): boolean {
  return entry.recordKind === 'object-event'
}

/**
 * One ANSWERED target catalog, as the delivery path cached it — what the
 * deleted-target prune reads instead of fanning out a catalog read of its own.
 * `generation` moves on every successful, non-empty refresh, so two snapshots
 * with different generations are two independent answers.
 */
export interface NcTargetCatalogSnapshot {
  readonly generation: number
  readonly at: number
  readonly targets: readonly NcTargetRef[]
}

export class NcDispatcher {
  private targetCache: ReadonlyMap<string, NcTargetRef> | null = null
  private targetCacheAt = 0
  private targetCacheGeneration = 0
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly targetCacheTtlMs: number
  /** The ONE render stage of every notification picture (D897). */
  private readonly imageStage: NcNotificationImageStage
  private readonly texts: NcTextCatalog
  /** One recorded cut per moment, and the recorder-busy breaker (D686). */
  private readonly recordedCuts = new NcRecordedCutMemo()

  constructor(private readonly deps: NcDispatcherDeps) {
    this.now = deps.now ?? ((): number => Date.now())
    this.sleep =
      deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
    this.targetCacheTtlMs = deps.targetCacheTtlMs ?? DEFAULT_TARGET_CACHE_TTL_MS
    this.texts = deps.texts ?? new NcTextCatalog()
    this.imageStage = new NcNotificationImageStage({
      logger: deps.logger,
      now: this.now,
      ...(deps.getSubjectTrail !== undefined ? { getSubjectTrail: deps.getSubjectTrail } : {}),
      ...(deps.getTracksAt !== undefined ? { getTracksAt: deps.getTracksAt } : {}),
      ...(deps.getZonePolygons !== undefined ? { getZonePolygons: deps.getZonePolygons } : {}),
      ...(deps.paintClass !== undefined ? { paintClass: deps.paintClass } : {}),
    })
  }

  /**
   * Drop held recorded cuts past their TTL (re-review R4). Driven by the
   * notification centre's drain tick, so a clip's bytes do not stay resident
   * after the last row that could use them.
   */
  sweepRecordedCuts(now: number): void {
    this.recordedCuts.evictAged(now)
  }

  /** How many recorded cuts are held — diagnostics and tests. */
  recordedCutsHeld(): number {
    return this.recordedCuts.size()
  }

  /** The outbox `deliver` executor. */
  async deliver(entry: NcOutboxEntry): Promise<NcDeliverResult> {
    // Per-target opt-out (rule.disabledTargetIds) is a benign send-time skip:
    // no catalog fetch, no outbox dead-letter row — the user opted THIS target
    // out of THIS rule. (The target-level `!enabled` kill-switch below is the
    // separate global opt-out and still dead-letters.)
    if (this.deps.isRuleTargetDisabled !== undefined) {
      const disabled = await this.deps.isRuleTargetDisabled(entry.ruleId, entry.targetId)
      if (disabled) {
        this.deps.logger.debug('notification skipped: target opted out of rule', {
          meta: { ruleId: entry.ruleId, targetId: entry.targetId },
        })
        return { ok: true }
      }
    }
    const target = await this.resolveTarget(entry.targetId)
    if (target === null) {
      // A target that no longer resolves in the catalog is a GENUINE misconfig
      // (deleted/renamed while a row was in flight) → permanent dead-letter.
      return { ok: false, error: `target not found: ${entry.targetId}`, permanent: true }
    }
    if (!target.enabled) {
      // The target still EXISTS but the operator flipped its own `enabled: false`
      // global kill-switch (muted the destination). That is a deliberate, benign
      // suppression — dead-lettering it would flood history with dead rows and
      // emit a WARN per event forever. Skip benignly (debug), never a dead-letter.
      // Distinct path from the per-rule opt-out gate above, which short-circuits
      // before the catalog is ever fetched.
      this.deps.logger.debug('notification skipped: target globally disabled', {
        meta: { ruleId: entry.ruleId, targetId: target.id, target: target.name },
      })
      return { ok: true }
    }
    // Snooze — checked HERE, after the target resolves (the window may be
    // personal, and only the target knows whose delivery this is) and BEFORE
    // the notification is built: a silenced notification must not cost a clip
    // render. A silenced send is benign, never a dead-letter — the operator
    // asked for this silence and it ends by itself.
    if (this.deps.snoozeGate !== undefined) {
      const memberClasses = groupMemberClasses(entry)
      const snoozeId = await this.deps.snoozeGate({
        ruleId: entry.ruleId,
        ruleName: entry.payload.ruleName,
        targetId: target.id,
        deviceId: entry.deviceId,
        ...(target.ownerUserId !== undefined ? { ownerUserId: target.ownerUserId } : {}),
        ...(entry.payload.subject.className !== undefined
          ? { className: entry.payload.subject.className }
          : {}),
        // A grouped row is judged by ALL its member classes, exactly as the close
        // judged it — the primary's class alone would let a `person` snooze silence a
        // person+dog message (D692 C4, review T9a M-2).
        ...(memberClasses.length >= 2 ? { classNames: memberClasses } : {}),
        at: this.now(),
      })
      if (snoozeId !== null) {
        // A dropped branch that logs nothing reads as "never happened", and a
        // snooze is exactly when someone will ask why a camera went quiet.
        this.deps.logger.info('notification suppressed by snooze', {
          tags: { deviceId: entry.deviceId },
          meta: {
            snoozeId,
            ruleId: entry.ruleId,
            targetId: target.id,
            target: target.name,
            eventId: entry.recordId,
            // WHICH subject was silenced. A window can now be class-scoped, so
            // "why is 102 quiet" has a second half — quiet about WHAT — and a
            // line that omits it cannot tell a cat window from a whole-camera
            // one.
            class: entry.payload.subject.className ?? null,
            ...(memberClasses.length >= 2 ? { classes: memberClasses } : {}),
          },
        })
        return { ok: true }
      }
    }
    const built = await this.buildNotification(entry, target)
    const artifactIds = built.artifactIds
    // AI CONFIRM — the last gate, and the only one that runs on the finished
    // notification: it judges the image this send is about to carry.
    const verdict = await this.runConfirmGate(entry, built)
    if (verdict !== null && verdict.decision === 'suppressed') {
      // Named, at INFO, with the model's own words. "Why did I not get a
      // notification" is asked per camera, and a gate that silences without a
      // line is indistinguishable from a camera that stopped detecting.
      this.deps.logger.info('notification suppressed by AI confirm', {
        tags: { deviceId: entry.deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          targetId: target.id,
          eventId: entry.recordId,
          reason: verdict.reason,
          ...(verdict.count !== undefined ? { count: verdict.count } : {}),
          ...(verdict.tiles !== undefined ? { tiles: verdict.tiles } : {}),
          ...(verdict.model !== undefined ? { model: verdict.model } : {}),
          ...(verdict.failOpen !== undefined ? { cause: verdict.failOpen } : {}),
          latencyMs: verdict.latencyMs,
          ...this.deps.confirmStats?.(),
        },
      })
      this.releaseCooldown(entry)
      return { ok: true, confirm: verdict }
    }
    // AI NARRATION — after the gate, so a suppressed notification costs no
    // vision call, and on the SAME picture the gate judged and the recipient
    // will see. Its only possible output is a sentence: it never suppresses.
    const narration = await this.runRuleAi(entry, built, target)
    const notification =
      narration === null ? built.notification : built.withAiText(narration.text ?? '')
    try {
      const result = await this.deps.send({
        addonId: target.addonId,
        targetId: target.id,
        notification,
      })
      if (!result.success) {
        return { ok: false, error: result.error ?? 'send failed', permanent: false }
      }
      const shipped = attachedKinds(notification.attachments)
      const dropped = droppedKinds(entry, shipped)
      this.deps.logger.info('notification delivered', {
        tags: { deviceId: entry.deviceId },
        meta: {
          ruleId: entry.ruleId,
          target: target.name,
          kind: target.kind,
          recordKind: entry.recordKind,
          // The gate's verdict rides out WITH the delivery, counters included:
          // `failedOpen` climbing while `suppressed` stays at zero is the only
          // way a permanently-open gate is distinguishable from a working one.
          ...(verdict !== null
            ? {
                confirm: verdict.decision,
                confirmReason: verdict.reason,
                ...(verdict.failOpen !== undefined ? { confirmCause: verdict.failOpen } : {}),
                ...(verdict.model !== undefined ? { confirmModel: verdict.model } : {}),
                ...(verdict.tiles !== undefined ? { confirmTiles: verdict.tiles } : {}),
                confirmMs: verdict.latencyMs,
                ...this.deps.confirmStats?.(),
              }
            : {}),
          // The narration's outcome rides out the same way and for the same
          // reason: a pass that always fails open is otherwise invisible on
          // every line this delivery produces.
          ...(narration !== null
            ? {
                aiShape: entry.payload.ai?.shape,
                aiImages: narration.images,
                aiChars: narration.text?.length ?? 0,
                ...(narration.failure !== undefined ? { aiCause: narration.failure } : {}),
                ...(narration.model !== undefined ? { aiModel: narration.model } : {}),
                ...(narration.agreed !== undefined ? { aiAgreed: narration.agreed } : {}),
                ...(narration.observedCount !== undefined
                  ? { aiCount: narration.observedCount }
                  : {}),
                aiMs: narration.latencyMs,
                ...this.deps.ruleAiStats?.(),
              }
            : {}),
          // Provenance — see the matching line in the center. The outbox entry
          // has carried these all along; only the log omitted them.
          eventId: entry.recordId,
          ...(entry.trackId !== undefined ? { trackId: entry.trackId } : {}),
          // WHAT arrived, and what the rule asked for and did not get. Without
          // these two the only way to tell a gif-only notification from a
          // complete one was to open the phone: the audit that produced this
          // change had to reconstruct 15 deliveries from media rows by hand.
          attachments: shipped,
          ...(dropped.length > 0 ? { dropped } : {}),
        },
      })
      return {
        ok: true,
        ...(verdict !== null ? { confirm: verdict } : {}),
        // The ids THIS send actually shipped — never re-derived, so a row can
        // only ever name an artefact its own delivery produced.
        ...(artifactIds.length > 0 ? { artifactIds } : {}),
      }
    } catch (err) {
      return { ok: false, error: String(err), permanent: false }
    }
  }

  /**
   * Ask the AI confirm gate about THIS notification, or `null` when the row
   * carries no policy / the gate is not wired.
   *
   * The image handed over is the first IMAGE attachment of the finished
   * notification — which is the zone crop when the rule asked for one, and the
   * policy still otherwise, because that is the order `resolveAttachments`
   * built them in. No second selection ladder: a gate with its own idea of
   * "the best picture" is a gate judging something the recipient never sees.
   *
   * A GROUPED row (two or more members) never reaches that path: it is judged
   * on the tiles its mosaic was composed from ({@link judgeGrouped}), and the
   * composite is never a model input (D52, D154) — not even as a fallback.
   *
   * A `null` image is passed THROUGH rather than short-circuited: whether "no
   * picture" means fire or suppress belongs to the policy, and the row must
   * still record that the gate ran.
   *
   * Never throws. A gate that explodes delivers — the same fail-open posture
   * the gate applies internally, applied once more at the seam, because a
   * programming error here would otherwise mute every camera at once.
   */
  private async runConfirmGate(
    entry: NcOutboxEntry,
    built: NcBuiltNotification,
  ): Promise<NcOutboxConfirmVerdict | null> {
    const gate = this.deps.confirmGate
    const confirm = entry.payload.confirm
    if (gate === undefined || confirm === undefined) return null
    if (built.grouped !== null) return this.judgeGrouped(entry, confirm, built.grouped)
    // BYTES, specifically. An attachment may be a URL the centre never held
    // (the timelapse artifact shape), and a gate cannot judge a link.
    const image = built.notification.attachments?.find(
      (a) => a.mediaType === 'image' && a.bytes !== undefined && a.bytes.byteLength > 0,
    )
    const bytes = image?.bytes
    try {
      return await gate(
        this.confirmInput(
          entry,
          confirm,
          bytes === undefined ? null : { bytes, mime: image?.mime ?? 'image/jpeg' },
          entry.payload.subject.className,
        ),
      )
    } catch (err) {
      this.deps.logger.warn('confirm gate threw — delivering unjudged', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, eventId: entry.recordId, error: String(err) },
      })
      return null
    }
  }

  private confirmInput(
    entry: NcOutboxEntry,
    confirm: NcOutboxConfirmPolicy,
    image: NcConfirmGateInput['image'],
    className: string,
  ): NcConfirmGateInput {
    return {
      ruleId: entry.ruleId,
      ruleName: entry.payload.ruleName,
      deviceId: entry.deviceId,
      recordId: entry.recordId,
      className,
      confirm,
      image,
    }
  }

  /**
   * A grouped row's confirm (D692 §6.2 item 9): the tiles the mosaic was composed from.
   *
   * No tile landed ⇒ ONE call with NO image, so the gate's own no-image policy decides —
   * never the composite (there is none to ship, and a composite is disqualified as model
   * input anyway), and never a second media read that could find a different picture. One
   * tile landed ⇒ that still is what ships (a mosaic of one is the still), and judging it is
   * judging what ships.
   */
  private async judgeGrouped(
    entry: NcOutboxEntry,
    confirm: NcOutboxConfirmPolicy,
    grouped: NcGroupedTileSet,
  ): Promise<NcOutboxConfirmVerdict | null> {
    if (grouped.stills.length > 0) return this.judgeTiles(entry, confirm, grouped.stills)
    const gate = this.deps.confirmGate
    if (gate === undefined) return null
    if (entry.payload.media === 'none') {
      // No tile was sought: "no raw tile landed" would be untrue of a rule that ships none.
      this.deps.logger.debug('grouped confirm: the rule ships no picture', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, rule: entry.payload.ruleName, eventId: entry.recordId },
      })
    } else {
      this.deps.logger.info('grouped confirm: no raw tile landed — the composite is never judged', {
        tags: { deviceId: entry.deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          windowKey: grouped.windowKey,
          eventId: entry.recordId,
          members: grouped.members,
          tiles: 0,
          media: entry.payload.media,
        },
      })
    }
    try {
      return await gate(this.confirmInput(entry, confirm, null, entry.payload.subject.className))
    } catch (err) {
      this.deps.logger.warn('confirm gate threw — delivering unjudged', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, eventId: entry.recordId, error: String(err) },
      })
      return null
    }
  }

  /**
   * ANY tile confirmed ⇒ confirmed (the first one ends the pass); suppressed only when every
   * tile answered no (or gave no answer the row's `onTimeout: 'suppress'` turns into a no).
   * A tile the gate could not judge and that fails open — a fail-open verdict, a throw, or a
   * tile the budget never reached under the default policy — is not a rejection: the
   * message goes out, with a failed-open verdict that carries the counts.
   *
   * ONE `confirm.timeoutMs` bounds the WHOLE pass, not each tile (review T13 H-1): the outbox
   * drains serially, so six tiles at a full timeout each would hold every row behind this
   * one for six times the bound. Each tile is given what is left of the budget as its own
   * timeout, and no tile starts once it is spent. Tiles run one after another, so one row
   * never exceeds the gate's per-device pending bound. Each tile is asked about ITS member's
   * class (review T13 H-2).
   */
  private async judgeTiles(
    entry: NcOutboxEntry,
    confirm: NcOutboxConfirmPolicy,
    stills: readonly NcGroupedTileStill[],
  ): Promise<NcOutboxConfirmVerdict | null> {
    const gate = this.deps.confirmGate
    if (gate === undefined) return null
    const startedAt = this.now()
    const budgetMs = confirm.timeoutMs ?? NC_CONFIRM_FALLBACK_TIMEOUT_MS
    const suppressesNoAnswer = confirm.onTimeout === 'suppress'
    let confirmed = 0
    let rejected = 0
    let noAnswer = 0
    let unjudged = 0
    let untried = 0
    let firstRejected: NcOutboxConfirmVerdict | undefined
    let firstNoAnswer: NcOutboxConfirmVerdict | undefined
    let firstFailedOpen: NcOutboxConfirmVerdict | undefined
    let threw = 0
    const counts = (): NcConfirmTileCounts => ({ confirmed, rejected, noAnswer, unjudged, untried })
    for (const [index, still] of stills.entries()) {
      const remainingMs = budgetMs - (this.now() - startedAt)
      if (remainingMs < Math.min(NC_CONFIRM_TILE_FLOOR_MS, budgetMs / 4)) {
        untried = stills.length - index
        if (suppressesNoAnswer) noAnswer += untried
        else unjudged += untried
        this.deps.logger.warn('grouped confirm: the pass budget is spent — tiles left unjudged', {
          tags: { deviceId: entry.deviceId },
          meta: {
            ruleId: entry.ruleId,
            rule: entry.payload.ruleName,
            eventId: entry.recordId,
            budgetMs,
            judged: index,
            untried,
            onTimeout: suppressesNoAnswer ? 'suppress' : 'fire',
          },
        })
        break
      }
      let verdict: NcOutboxConfirmVerdict
      try {
        verdict = await gate(
          this.confirmInput(
            entry,
            { ...confirm, timeoutMs: remainingMs },
            { bytes: still.bytes, mime: still.mime },
            still.className,
          ),
        )
      } catch (err) {
        unjudged += 1
        threw += 1
        this.deps.logger.warn('confirm gate threw on a tile — that tile is not a rejection', {
          tags: { deviceId: entry.deviceId },
          meta: {
            ruleId: entry.ruleId,
            eventId: entry.recordId,
            trackId: still.trackId,
            error: String(err),
          },
        })
        continue
      }
      if (verdict.decision === 'confirmed') {
        confirmed += 1
        return { ...verdict, latencyMs: this.now() - startedAt, at: startedAt, tiles: counts() }
      }
      if (verdict.decision === 'suppressed' && verdict.failOpen !== undefined) {
        // The gate got NO answer and the row asked a no-answer to suppress: it suppresses,
        // but it is not a model saying no (review T13 L-5).
        noAnswer += 1
        firstNoAnswer ??= verdict
      } else if (verdict.decision === 'suppressed') {
        rejected += 1
        firstRejected ??= verdict
      } else {
        unjudged += 1
        firstFailedOpen ??= verdict
      }
    }
    const tiles = counts()
    const latencyMs = this.now() - startedAt
    this.deps.logger.debug('grouped confirm judged every tile without a confirmation', {
      tags: { deviceId: entry.deviceId },
      meta: { ruleId: entry.ruleId, eventId: entry.recordId, ...tiles, latencyMs },
    })
    if (unjudged > 0) {
      // Something could not be judged and fails open: the message goes out, and the row
      // records that the gate RAN and what it saw — never "no verdict" (review T13 M-2).
      return firstFailedOpen !== undefined
        ? { ...firstFailedOpen, latencyMs, at: startedAt, tiles }
        : {
            decision: 'failed-open',
            reason:
              threw > 0
                ? `the gate threw on ${String(threw)} of ${String(stills.length)} tiles`
                : `the pass budget of ${String(budgetMs)}ms was spent before ${String(untried)} of ${String(stills.length)} tiles`,
            failOpen: threw > 0 ? 'error' : 'timeout',
            latencyMs,
            at: startedAt,
            tiles,
          }
    }
    // A model that said no outranks a tile that gave no answer as the row's representative.
    const representative = firstRejected ?? firstNoAnswer
    return representative !== undefined
      ? { ...representative, latencyMs, at: startedAt, tiles }
      : {
          decision: 'suppressed',
          reason: `the pass budget of ${String(budgetMs)}ms was spent before any tile answered`,
          failOpen: 'timeout',
          latencyMs,
          at: startedAt,
          tiles,
        }
  }

  /**
   * Ask the AI analyst to describe THIS notification, or `null` when the row
   * carries no policy, no analyst is wired, or there is NOTHING TO LOOK AT.
   *
   * ## Zero frames skips the pass entirely
   *
   * Not "asks about zero pictures and fails open" — skips. A text-only
   * notification is the ordinary outcome for a doorbell whose snapshot timed
   * out, a sound whose camera did not answer, or an emptied occupancy scope,
   * and an analyst asked about no images confabulates. It is also not a
   * failure, so it must not climb the fail-open counter that exists to make a
   * genuinely broken model visible.
   *
   * ## The two detection paths get DIFFERENT inputs
   *
   * An `immediate` row is one moment, so it gets THE frame the recipient is
   * about to see — the confirm gate's rule (D52), for the same reason: a
   * sentence about a different rectangle is a sentence about a different
   * notification.
   *
   * A GROUPED row (D692) is several subjects at one moment, so it gets one
   * frame per subject: the tiles its mosaic was composed from, each named by
   * its class — never the composite, and nothing at all when no tile landed.
   *
   * A `track-end` row is a passage that has CLOSED, so it gets the passage:
   * up to {@link NC_RULE_AI_TRACK_FRAMES} whole-scene frames spanning the
   * track, oldest first. Handing it the single shipped still would ask "what
   * happened" of one instant, which is the immediate question wearing the
   * track prompt.
   *
   * Never throws. The analyst fails open internally; this catch covers the
   * TRANSPORT (the AI addon not installed, a runner respawning mid-call),
   * because a throw here would otherwise cost the notification.
   */
  private async runRuleAi(
    entry: NcOutboxEntry,
    built: NcBuiltNotification,
    target: NcTargetRef,
  ): Promise<NcRuleAiOutcome | null> {
    const analyse = this.deps.ruleAi
    const policy = entry.payload.ai
    if (analyse === undefined || policy === undefined) return null
    const grouped = policy.shape === 'detection-track' ? null : built.grouped
    const frames = await this.ruleAiFrames(entry, built, policy.shape)
    if (frames.length === 0) {
      // Named, at DEBUG: it is not a fault, but "why did my AI rule say
      // nothing" is asked per camera and silence is not an answer. A grouped row
      // whose every tile failed to land says so: it is never narrated from the
      // composite (D52, D154), so the reason is not "text-only".
      this.deps.logger.debug('notification AI skipped — no picture to describe', {
        tags: { deviceId: entry.deviceId },
        meta: {
          ruleId: entry.ruleId,
          eventId: entry.recordId,
          shape: policy.shape,
          ...(grouped !== null
            ? { reason: 'grouped-no-raw-tile', windowKey: grouped.windowKey }
            : {}),
        },
      })
      return null
    }
    // A grouped row of two or more landed tiles names each still's class, in order; one
    // landed tile is what ships, and it is asked about as the plain still of ITS subject.
    const groupedStills = grouped?.stills ?? []
    const soleStill = groupedStills.length === 1 ? groupedStills[0] : undefined
    // WHERE the camera is — best-effort, and only the label is at stake: a
    // port that is absent, answers null or throws leaves the field off the
    // input, which renders the prompt exactly as before the label existed.
    const locate = this.deps.getDeviceLocation
    const location = locate === undefined ? null : await locate(entry.deviceId).catch(() => null)
    const input: NcRuleAiInput = {
      ruleId: entry.ruleId,
      ruleName: entry.payload.ruleName,
      deviceId: entry.deviceId,
      deviceName: built.deviceName,
      ...(location !== null && location.trim().length > 0 ? { location } : {}),
      recordId: entry.recordId,
      className: soleStill?.className ?? entry.payload.subject.className,
      ...(groupedStills.length >= 2 ? { subjects: groupedStills.map((t) => t.className) } : {}),
      policy,
      // The rule's language, else the one this hub's texts are served in —
      // which IS the rule owner's language, because that is the only language
      // this hub has. Never per recipient: one notification, one generation.
      language: policy.language ?? this.texts.language,
      // THE TARGET decides the default. `bodyMaxLen` is what the kind declares
      // and what the degrade engine truncates on, so asking for more words than
      // it can carry is asking to be cut mid-word.
      maxWords: ruleAiWordCap(policy.maxWords, target.bodyMaxLen),
      frames,
    }
    try {
      return await analyse(input)
    } catch (err) {
      this.deps.logger.warn('notification AI threw — delivering without its sentence', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, eventId: entry.recordId, error: String(err) },
      })
      return null
    }
  }

  /**
   * The pictures the analyst is shown — never a composite (D52, D154):
   *  - `detection-track`: the passage, oldest first;
   *  - a GROUPED row: the tiles its mosaic was composed from, resolved once
   *    ({@link NcBuiltNotification.grouped}); none landed ⇒ none, never the shipped picture;
   *  - a linked set: its raw per-camera tiles (ADR 0632); none landed ⇒ the shipped picture;
   *  - anything else: the picture that ships.
   */
  private async ruleAiFrames(
    entry: NcOutboxEntry,
    built: NcBuiltNotification,
    shape: NcRuleAiInput['policy']['shape'],
  ): Promise<readonly NcRuleAiFrame[]> {
    if (shape === 'detection-track') return this.trackNarrationFrames(entry)
    if (built.grouped !== null) {
      return built.grouped.stills.map((t) => ({ bytes: t.bytes, mime: t.mime }))
    }
    const tiles = await this.linkedAnalysisFrames(entry)
    return tiles.length > 0 ? tiles : shippedFrames(built.notification)
  }

  /** A linked set's raw per-camera tiles (`subject.analysisTiles`), in
   *  camera order — one frame per camera whose picture landed. Best-effort: an
   *  owner that answers nothing or throws is left out (a blank frame is never
   *  handed to a model), and no owners at all is `[]`. */
  private async linkedAnalysisFrames(entry: NcOutboxEntry): Promise<readonly NcRuleAiFrame[]> {
    const tiles = entry.payload.subject.analysisTiles ?? []
    const frames: NcRuleAiFrame[] = []
    for (const { ownerId, cameraId } of tiles) {
      const file = await this.linkedStillFile(entry, ownerId, cameraId)
      const bytes = file === undefined ? null : decodeStillBytes(file.base64)
      if (bytes !== null) frames.push({ bytes, mime: 'image/jpeg' })
    }
    return frames
  }

  /** One linked-camera shelf owner's still — `keyFrameSmall`, else whatever it
   *  holds. `undefined` when it holds nothing or the read throws (said at DEBUG
   *  on `cameraId`, the camera the picture is of: the caller decides whether
   *  the absence is worth a line of its own). */
  private async linkedStillFile(
    entry: NcOutboxEntry,
    ownerId: string,
    cameraId: number,
  ): Promise<MediaFileBytes | undefined> {
    try {
      const files = await this.deps.getMediaForOwner('track', ownerId)
      return files.find((f) => f.kind === 'keyFrameSmall') ?? files[0]
    } catch (err) {
      this.deps.logger.debug('linked camera picture read failed', {
        tags: { deviceId: cameraId },
        meta: { recordId: entry.recordId, ownerId, error: String(err) },
      })
      return undefined
    }
  }

  /** The whole-scene frames spanning a CLOSED track, oldest first. Best-effort
   *  in every direction: no track id, a throwing read or an empty store all
   *  leave the pass with nothing, which skips it. */
  private async trackNarrationFrames(entry: NcOutboxEntry): Promise<readonly NcRuleAiFrame[]> {
    const trackId = entry.payload.subject.trackId
    if (trackId === undefined) return []
    try {
      const files = await this.deps.getMediaForOwner('track', trackId)
      return pickTrackNarrationFrames(files, NC_RULE_AI_TRACK_FRAMES).flatMap((file) => {
        const bytes = decodeStillBytes(file.base64)
        return bytes === null ? [] : [{ bytes, mime: 'image/jpeg', atMs: file.timestamp }]
      })
    } catch (err) {
      this.deps.logger.debug('track narration media read failed', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, trackId, error: String(err) },
      })
      return []
    }
  }

  /**
   * Hand back the cooldown windows a suppressed delivery consumed: the single `cooldown` of
   * a plain row AND every per-class stamp of a grouped one (D692 §3.6). Each key goes
   * through the same dep, which releases it only if no later fire has replaced it, and one
   * key that fails never keeps the others consumed.
   */
  private releaseCooldown(entry: NcOutboxEntry): void {
    const release = this.deps.releaseCooldown
    if (release === undefined) return
    const stamps = [
      ...(entry.payload.cooldown !== undefined ? [entry.payload.cooldown] : []),
      ...(entry.payload.cooldowns ?? []),
    ]
    for (const stamp of stamps) {
      try {
        release({
          key: stamp.key,
          at: stamp.at,
          ruleId: entry.ruleId,
          deviceId: entry.deviceId,
        })
      } catch (err) {
        this.deps.logger.warn('cooldown rollback failed — the window stays consumed', {
          tags: { deviceId: entry.deviceId },
          meta: { ruleId: entry.ruleId, key: stamp.key, error: String(err) },
        })
      }
    }
  }

  /**
   * Deliver ONE end-of-window snooze digest to one target.
   *
   * Best-effort by design, and the return value says which it was rather than
   * throwing: the caller marks the window handled either way, because a digest
   * retried every drain tick for hours is worse than a digest missed once — and
   * a partially-delivered one must never be re-sent to the targets that already
   * have it. A failure is logged with the window id, so a missing summary is a
   * findable line rather than a silence inside a silence.
   *
   * The digest carries no media and no `tag`: it is not an event, and tagging
   * it with a rule id would let a phone collapse it into the very
   * notifications it is reporting on.
   */
  async deliverDigest(input: NcDigestSendInput): Promise<boolean> {
    let target: NcTargetRef | null
    try {
      target = await this.resolveTarget(input.targetId)
    } catch (err) {
      this.deps.logger.warn('snooze digest: target catalog unreachable', {
        meta: { snoozeId: input.snoozeId, targetId: input.targetId, error: String(err) },
      })
      return false
    }
    if (target === null || !target.enabled) {
      this.deps.logger.warn('snooze digest: target gone or disabled', {
        meta: { snoozeId: input.snoozeId, targetId: input.targetId },
      })
      return false
    }
    try {
      const result = await this.deps.send({
        addonId: target.addonId,
        targetId: target.id,
        notification: { title: input.title, body: input.body, priority: 2 },
      })
      if (!result.success) {
        this.deps.logger.warn('snooze digest send failed', {
          meta: { snoozeId: input.snoozeId, targetId: target.id, error: result.error },
        })
        return false
      }
      this.deps.logger.info('snooze digest delivered', {
        meta: { snoozeId: input.snoozeId, target: target.name, hidden: input.total },
      })
      return true
    } catch (err) {
      this.deps.logger.warn('snooze digest send threw', {
        meta: { snoozeId: input.snoozeId, targetId: target.id, error: String(err) },
      })
      return false
    }
  }

  /**
   * Send a Notification-Center-composed message to ONE target.
   *
   * Never throws and never retries — see {@link NcAnnouncementSendInput}. Every
   * way of not delivering produces a line: an announcement that silently did
   * not arrive is indistinguishable from the alarm not having armed, which is
   * the exact confusion this feature exists to remove.
   */
  async deliverAnnouncement(input: NcAnnouncementSendInput): Promise<boolean> {
    const tags = input.deviceId !== undefined ? { deviceId: input.deviceId } : undefined
    let target: NcTargetRef | null
    try {
      target = await this.resolveTarget(input.targetId)
    } catch (err) {
      this.deps.logger.warn('announcement: target catalog unreachable', {
        ...(tags !== undefined ? { tags } : {}),
        meta: { reason: input.reason, targetId: input.targetId, error: String(err) },
      })
      return false
    }
    if (target === null || !target.enabled) {
      this.deps.logger.warn('announcement: target gone or disabled', {
        ...(tags !== undefined ? { tags } : {}),
        meta: { reason: input.reason, targetId: input.targetId },
      })
      return false
    }
    try {
      const result = await this.deps.send({
        addonId: target.addonId,
        targetId: target.id,
        notification: {
          title: input.title,
          body: input.body,
          priority: 2,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        },
      })
      if (!result.success) {
        this.deps.logger.warn('announcement send failed', {
          ...(tags !== undefined ? { tags } : {}),
          meta: { reason: input.reason, targetId: target.id, error: result.error },
        })
        return false
      }
      this.deps.logger.info('announcement delivered', {
        ...(tags !== undefined ? { tags } : {}),
        meta: { reason: input.reason, target: target.name },
      })
      return true
    } catch (err) {
      this.deps.logger.warn('announcement send threw', {
        ...(tags !== undefined ? { tags } : {}),
        meta: { reason: input.reason, targetId: target.id, error: String(err) },
      })
      return false
    }
  }

  /** Device display names for a set of ids, for the digest's lines. */
  async resolveDeviceNames(deviceIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
    const out = new Map<number, string>()
    for (const id of new Set(deviceIds)) {
      const name = await this.deps.getDeviceName(id).catch(() => null)
      if (name !== null) out.set(id, name)
    }
    return out
  }

  /**
   * The owner the send gate passes for this target (D692 C4): the grouped close asks the
   * snooze verdict per target with exactly this, so "snoozed at close" is judged for the
   * same person the send would be. Resolved through the same catalog read as a send. A
   * read that cannot answer is said as such (`known: false`), never as "unowned".
   */
  async snoozeOwnerOf(targetId: string): Promise<NcSnoozeOwnerRead> {
    try {
      const target = await this.resolveTarget(targetId)
      if (target === null) return { known: false, reason: 'target-not-found' }
      return {
        known: true,
        ...(target.ownerUserId !== undefined ? { ownerUserId: target.ownerUserId } : {}),
      }
    } catch (err) {
      return { known: false, reason: String(err) }
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  private async resolveTarget(targetId: string): Promise<NcTargetRef | null> {
    const cached = this.cachedTarget(targetId)
    if (cached !== null) return cached
    // Miss or stale cache → one forced refresh before declaring the
    // target gone (a just-created target must not dead-letter its rows).
    let targets: readonly NcTargetRef[]
    try {
      targets = await this.deps.listTargets()
    } catch (err) {
      this.deps.logger.warn('target catalog refresh failed', { meta: { error: String(err) } })
      // Catalog unreachable is TRANSIENT — surface as unknown-but-retryable
      // by throwing (the outbox treats a thrown deliver as transient).
      throw err instanceof Error ? err : new Error(String(err))
    }
    // An EMPTY catalog is indistinguishable from a broken transport, so it is
    // NEVER evidence that a target was deleted. Treating the two as the same
    // answer is what turned a collection-cap routing gap into permanent loss:
    // every notification this engine ever produced dead-lettered as "target
    // not found" while the target sat healthy in the hub's catalog
    // (2026-07-30). Transient — and NOT cached, so a recovered transport is
    // picked up on the next attempt rather than after the TTL.
    if (targets.length === 0) {
      this.deps.logger.warn('target catalog came back EMPTY — treating as transient', {
        meta: { targetId },
      })
      throw new Error(`target catalog empty (transient) while resolving ${targetId}`)
    }
    this.targetCache = new Map(targets.map((t) => [t.id, t]))
    this.targetCacheAt = this.now()
    this.targetCacheGeneration += 1
    return this.targetCache.get(targetId) ?? null
  }

  /**
   * The cached catalog while it is FRESH (within the cache TTL), else `null`.
   * Never reads: a consumer that finds nothing simply waits for the delivery
   * path to refresh it.
   */
  catalogSnapshot(): NcTargetCatalogSnapshot | null {
    if (this.targetCache === null) return null
    if (this.now() - this.targetCacheAt > this.targetCacheTtlMs) return null
    return {
      generation: this.targetCacheGeneration,
      at: this.targetCacheAt,
      targets: [...this.targetCache.values()],
    }
  }

  private cachedTarget(targetId: string): NcTargetRef | null {
    if (this.targetCache === null) return null
    if (this.now() - this.targetCacheAt > this.targetCacheTtlMs) return null
    return this.targetCache.get(targetId) ?? null
  }

  /**
   * This delivery's buttons, or none.
   *
   * Never throws. A notification that arrives without its buttons is a
   * degraded notification; one that does not arrive because the token registry
   * hiccupped is a missed event. The failure is logged rather than swallowed —
   * a button the operator authored and never saw is exactly the silence this
   * repo keeps paying for.
   */
  /**
   * The `notificationTaps` base of a camera tap (D734). A failing read is
   * `null` — the tap then opens the hub viewer on the public endpoint — and is
   * logged, so a tap that lands somewhere other than the flagged address has a
   * line saying why.
   */
  private async resolveTapBase(): Promise<ViewerLinkBase | null> {
    const read = this.deps.tapBase
    if (read === undefined) return null
    try {
      return await read()
    } catch (err) {
      this.deps.logger.warn('notification tap address unreadable — tap uses the public endpoint', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private async mintActions(
    entry: NcOutboxEntry,
    target: NcTargetRef,
  ): Promise<readonly NotificationAction[]> {
    if (this.deps.buildActions === undefined) return []
    try {
      return await this.deps.buildActions({
        ruleId: entry.ruleId,
        ruleName: entry.payload.ruleName,
        deviceId: entry.deviceId,
        targetId: target.id,
        ...(target.ownerUserId !== undefined ? { ownerUserId: target.ownerUserId } : {}),
        ...(entry.payload.subject.className !== undefined
          ? { className: entry.payload.subject.className }
          : {}),
        ...(entry.payload.subject.systemEvent !== undefined
          ? { systemEvent: entry.payload.subject.systemEvent }
          : {}),
      })
    } catch (err) {
      this.deps.logger.warn('notification buttons could not be minted — sending without them', {
        tags: { deviceId: entry.deviceId },
        meta: { ruleId: entry.ruleId, targetId: target.id, error: String(err) },
      })
      return []
    }
  }

  /**
   * One text, resolved in the order the operator expects: HIS template, then
   * the catalog, then the sentence the row was FROZEN with.
   *
   * The last step is the additive read that makes this change safe to deploy
   * (the `artifacts`/`artifact` precedent). A system-event row enqueued before
   * this deploy carries a title and a body and no key; a row enqueued after
   * carries a key and the params to fill it. Both are in SQLite at the same
   * time, one of them possibly for days behind an unreachable target, and
   * neither may render blank. A key that resolves wins — so re-wording the
   * catalog reaches an old row too — and a key nothing carries falls back to
   * the words the row was born with rather than to nothing.
   */
  private renderText(input: NcRowTextInput): string {
    return renderRowText(this.texts, input)
  }

  /**
   * Builds the notification AND returns the artefact ids its media resolve
   * indexed — see {@link withArtifactUrls}. A tuple rather than a field on
   * `NcNotificationInput`: the ids are internal (outbox provenance), never
   * part of what `notification-output` sends to a backend.
   */
  private async buildNotification(
    entry: NcOutboxEntry,
    target: NcTargetRef,
  ): Promise<NcBuiltNotification> {
    const subject = entry.payload.subject
    const systemEvent = subject.systemEvent
    const deviceName = await notificationDeviceName(entry, this.deps.getDeviceName)
    // Zone IDs are what the conditions match on; names are what a human reads.
    // A system event has no zones of its own — except the COMBINED alarm row,
    // whose body IS the triggering rule's detection line and therefore ends in
    // "in gate" exactly as that rule's own notification would have.
    const alarmSource = systemEvent?.alarmSource
    const zoneLabels =
      systemEvent === undefined
        ? await resolveZoneLabels(this.deps.getZoneNames, subject.deviceId, subject.zones)
        : alarmSource?.zones !== undefined && alarmSource.zones.length > 0
          ? await resolveZoneLabels(this.deps.getZoneNames, alarmSource.deviceId, alarmSource.zones)
          : []
    const vars = buildTemplateVars(this.texts, entry, deviceName, zoneLabels)
    // The count a system sentence pluralises on, frozen at intake — "3 cameras
    // armed" is one row's fact, and re-counting anything at delivery would let
    // a row held overnight report this morning's number.
    const systemCount = systemEvent?.textCount !== undefined ? { count: systemEvent.textCount } : {}
    const title = renderRowTitle(this.texts, entry, vars)
    // Does the operator's own template PLACE the model's sentence? Asked of the
    // rule's template only — a catalog key names no `{{ai}}`, and one that did
    // would be the catalog deciding a rule's layout.
    const authoredBody = entry.payload.template?.body
    const templateNamesAi =
      authoredBody !== undefined && templatePlaceholders(authoredBody).includes('ai')
    /**
     * The body, for a given AI sentence — `''` when there is none, which is
     * every row today and every row whose model said nothing.
     *
     * A closure and not a second render path: the sentence only exists AFTER
     * the picture has been resolved and shown to a model, so the body is either
     * built twice from one recipe or built once from two. One recipe.
     */
    const renderBody = (aiText: string): string => {
      const rendered = this.renderText({
        template: authoredBody,
        key: bodyKeyFor(entry),
        vars: { ...vars, ai: aiText },
        ...systemCount,
        ...(systemEvent?.body !== undefined ? { frozen: systemEvent.body } : {}),
      })
      // THE TEST MARKER, in the body and only in the body.
      //
      // A test notification is byte-for-byte an ordinary one — that is what
      // makes it worth sending — and the operator on the receiving end has no
      // way to tell it from the real thing. Which is fine at 15:00 when they
      // pressed the button, and is an alarm they act on at 03:00 when somebody
      // else did. The marker is a catalog key like every other word here, so it
      // is translated and re-wordable; the TITLE is left alone because a
      // notifier's title is what a lock screen truncates to, and the rule's own
      // words must survive there. Absent `synthetic` = an ordinary row,
      // unchanged byte for byte.
      const marked =
        entry.payload.synthetic === true
          ? // `frozen` is the un-marked body: a catalog that cannot resolve the
            // key must cost the marker, never the notification.
            this.renderText({ key: 'test.prefix', vars: { body: rendered }, frozen: rendered })
          : rendered
      // Capitalise the first letter of the finished body only — catalogs and
      // placeholders stay lowercase. After AI append so a leading AI line
      // (empty detection body) still gets the lift.
      return ncSentenceCaseBody(composeRuleAiBody({ aiText, body: marked, templateNamesAi }))
    }
    const body = renderBody('')
    const resolved = await this.resolveAttachments(entry)
    const resolvedMedia = await this.withArtifactUrls(entry, resolved.attachments)
    const attachments: readonly NcNotificationAttachment[] = [
      ...resolvedMedia.attachments,
      ...frozenArtifactAttachments(entry),
    ]
    const params = pickParams(entry.payload.params)
    // Default tap target: the camera AT the event instant (operator decision,
    // 2026-08-18 — D1 of the click-actions design), or — for a SYSTEM event —
    // the admin page where the operator can act on it (2026-08-30, see
    // `system-event-tap-url.ts`). An authored clickUrl in the rule's params
    // always wins; an unknown camera and a kind with no action get none.
    // Best-effort: a ladder that cannot answer costs the tap, never the
    // notification. The ids come off the FROZEN subject, so a row delivered
    // days late still names the device and node the event was about.
    const publicUrlBase = this.deps.publicUrlBase
    const tapUrl =
      params.clickUrl === undefined && publicUrlBase !== undefined
        ? defaultTapUrl({
            deviceId: systemEvent !== undefined ? 0 : subject.deviceId,
            timestampMs: subject.timestamp,
            publicBaseUrl: await publicUrlBase().catch(() => null),
            // Admin destinations never take the app form — only a camera tap
            // asks which address the operator chose for taps (D709, D734).
            tap: systemEvent === undefined ? await this.resolveTapBase() : null,
            ...(systemEvent !== undefined
              ? {
                  systemEvent: {
                    kind: systemEvent.kind,
                    ...(systemEvent.deviceId !== undefined
                      ? { deviceId: systemEvent.deviceId }
                      : {}),
                    ...(systemEvent.deviceType !== undefined
                      ? { deviceType: systemEvent.deviceType }
                      : {}),
                    ...(systemEvent.nodeId !== undefined ? { nodeId: systemEvent.nodeId } : {}),
                    ...summarySectionOf(systemEvent.data),
                  },
                }
              : {}),
          })
        : null
    // Per DELIVERY: each target's buttons carry their own single-use token, so
    // one person tapping cannot leave another person's button already spent.
    // Best-effort — a mint that fails costs the buttons, never the
    // notification about the event.
    const actions = await this.mintActions(entry, target)
    const notification: NcNotificationInput = {
      body,
      title,
      priority: clampPriority(
        paramNumber(entry.payload.params, 'priority') ?? entry.payload.priority,
      ),
      ...params,
      ...(tapUrl !== null ? { clickUrl: tapUrl } : {}),
      // No row carries a push tag (D686, D692): a notifier is one-shot.
      ...(systemEvent !== undefined
        ? systemEvent.deviceId !== undefined
          ? { deviceId: systemEvent.deviceId }
          : {}
        : { deviceId: subject.deviceId }),
      ...(subject.eventId !== undefined ? { eventId: subject.eventId } : {}),
      ...(systemEvent !== undefined
        ? {
            metadata: {
              systemEventKind: systemEvent.kind,
              subject: systemEvent.subject,
              ...systemEvent.data,
            },
          }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    }
    return {
      notification,
      artifactIds: resolvedMedia.artifactIds,
      deviceName,
      grouped: resolved.grouped,
      // Immutable: a new notification, never a mutated one. The AI pass runs
      // after this returns and must not be able to edit a value the confirm
      // gate has already judged.
      withAiText: (aiText) => ({ ...notification, body: renderBody(aiText) }),
    }
  }

  /**
   * Resolve ONE image attachment per the rule's media policy, best
   * AVAILABLE at send time. Preference order comes from the pure
   * {@link attachmentKindPreference} / {@link bestMatchingKindPreference};
   * the event owner is tried first for `immediate` entries, falling back to
   * the parent track's media set. `best-matching` leads with the crop that
   * explains the fired condition (`faceCrop`/`plateCrop`, both event-owned)
   * then degrades to the plain `best` → `keyFrame` ladders.
   */
  /**
   * Mint a signed URL for each attachment, alongside the bytes it already
   * carries. Best-effort per attachment: a failed mint leaves that one
   * bytes-only rather than costing the notification. Without this a url-mode
   * target (WhatsApp, gotify) silently received NO media — the degrade engine
   * drops a bytes-only attachment for them (`attachment:noUrl`).
   */
  /**
   * A failed footage render is best-effort — ship the still, skip the video.
   *
   * There is nothing to wait for: the clip ring only grows FORWARD, so a window
   * it does not already cover will never be covered by retrying. (An earlier
   * revision deferred delivery here, when clips were cut from finalized
   * recording segments; retrying under the pre-buffer would just age the
   * pre-roll out of the ring.)
   *
   * WARN, not debug. This is a branch that silently drops work the operator
   * explicitly asked for, and at debug it produced no line at all in the
   * default configuration — a notification arriving without the gif its rule
   * requested looked, in the log, exactly like a rule that never wanted one.
   */
  private notePendingFootage(entry: NcOutboxEntry, err: unknown, what: 'gif' | 'clip'): void {
    this.deps.logger.warn(`${what} attachment render failed — shipping without it`, {
      tags: { deviceId: entry.payload.subject.deviceId },
      meta: {
        ruleId: entry.ruleId,
        eventId: entry.recordId,
        error: String(err),
        action: 'send-without-video',
      },
    })
  }

  /**
   * What one delivery's media resolve produced: the attachments ready to ship
   * (bytes plus a signed url when the plane could mint one) and the ids the
   * artefact INDEX assigned them, in the same order — still first, then gif,
   * then clip. The ids never ride on the attachment objects themselves: those
   * cross to `notification-output` and a notifier backend has no use for an
   * internal store id, only for `url`/`bytes`.
   *
   * `artifactIds` is what lets a delivery's outbox row later answer "which
   * artefact was this trigger's picture" (`getHistory.artifactIds`) without a
   * second write path — the outbox writes back exactly the ids this method
   * handed to a SUCCESSFUL send, never re-deriving them.
   */
  private async withArtifactUrls(
    entry: NcOutboxEntry,
    attachments: ReadonlyArray<{
      mediaType: 'image' | 'gif' | 'video'
      bytes: Uint8Array<ArrayBuffer>
      mime: string
      name: string
    }>,
  ): Promise<{
    readonly attachments: Array<{
      mediaType: 'image' | 'gif' | 'video'
      bytes: Uint8Array<ArrayBuffer>
      mime: string
      name: string
      url?: string
    }>
    readonly artifactIds: readonly string[]
  }> {
    const index = this.deps.indexArtifact
    const publish = this.deps.publishArtifact
    if (index === undefined && publish === undefined) {
      return { attachments: [...attachments], artifactIds: [] }
    }
    const out: Array<{
      mediaType: 'image' | 'gif' | 'video'
      bytes: Uint8Array<ArrayBuffer>
      mime: string
      name: string
      url?: string
    }> = []
    const artifactIds: string[] = []
    let posterId: string | null = null
    const deviceId = entry.payload.subject.deviceId
    const common: Omit<NcArtifactPublishMeta, 'kind' | 'posterArtifactId'> = {
      deviceId: deviceId > 0 ? deviceId : null,
      // A linked set's artefact is about EVERY camera it shows (ADR 0632).
      deviceIds:
        entry.payload.subject.linkedCameraIds !== undefined
          ? [...entry.payload.subject.linkedCameraIds]
          : deviceId > 0
            ? [deviceId]
            : [],
      capturedAt: entry.payload.subject.timestamp,
      ruleId: entry.ruleId,
      ruleName: entry.payload.ruleName,
    }
    for (const att of attachments) {
      if (index !== undefined) {
        const kind = artifactKindForMediaType(att.mediaType)
        const meta: NcArtifactPublishMeta = {
          ...common,
          kind,
          ...(posterId !== null && kind !== 'event-still' ? { posterArtifactId: posterId } : {}),
        }
        const pub = await index(att.bytes, att.mime, meta).catch(() => ({
          url: null,
          artifactId: null,
        }))
        if (kind === 'event-still' && pub.artifactId !== null) posterId = pub.artifactId
        if (pub.artifactId !== null) artifactIds.push(pub.artifactId)
        out.push(pub.url === null ? { ...att } : { ...att, url: pub.url })
        continue
      }
      const url = await publish!(att.bytes, att.mime, common.deviceId).catch(() => null)
      out.push(url === null ? { ...att } : { ...att, url })
    }
    return { attachments: out, artifactIds }
  }

  /** The full attachment list: the policy still (zone-cropped when the rule
   *  froze zone ids) plus the footage cut from the broker's clip ring when
   *  requested. Each part is best-effort — a failed crop falls back to the
   *  uncropped still, a failed render just omits the video. A grouped row also
   *  hands back the tiles its mosaic was composed from, for the gate and the
   *  analyst to judge ({@link NcBuiltNotification.grouped}). */
  private async resolveAttachments(entry: NcOutboxEntry): Promise<NcResolvedAttachments> {
    const out: Array<{
      mediaType: 'image' | 'gif' | 'video'
      bytes: Uint8Array<ArrayBuffer>
      mime: string
      name: string
    }> = []
    // THE POLL WAITS FOR ABSENCE, NOT FOR IMPROVEMENT — but "absence" is about
    // the frame the rule NEEDS, and only a record that can still gain one is
    // allowed to wait for it.
    //
    // Asking `trigger-only` unconditionally cost a live alarm 3 s for nothing.
    // Device 107, 22:26:34: a second scream inside `NC_STILL_SHELF_REUSE_MS`
    // names a new owner id pointing at the FIRST scream's photograph (D178 —
    // photographed once by one shelf), so its instant is 6.1 s before this
    // trigger and no second capture was ever going to happen. The bound was
    // spent polling for a frame that did not exist, on a notification about a
    // crying child.
    //
    // Asking `any` unconditionally then reopened the case it was meant to fix,
    // because the fix was justified by an assumption rather than a check —
    // *"tracks are unaffected: at first look their media has not landed at
    // all"*. On a doorstep camera it has: a person walks up the drive before
    // reaching the door, so the track is seconds old and already carries its
    // best shot when the zone condition fires. Device 101, 'Persona su Uscio',
    // track 98184eb9 (27/08): the first look found the keyFrame from −5965 ms —
    // subject on the road, doorstep empty — degraded both gates, shipped it,
    // and never spent the bound. `firstFrame` (+203 ms, 37.5% inside Uscio)
    // landed 200 ms later.
    //
    // So the discriminator is the RECORD, not the frame: a live visual track
    // accretes media after its trigger, and nothing else does.
    // D692 §6.2: a grouped row of two or more members gets a MOSAIC, one tile per
    // subject, with its own shared still wait. A group of one is a plain row: null here,
    // and the single-still path below runs byte for byte.
    const groupView = readOutboxGroup(entry.payload.group)
    const groupMembers = groupedTileMembers(groupView)
    const groupTiles = entry.payload.media === 'none' ? null : groupMembers
    const memberTrackIds = (groupView?.members ?? []).map((m) => m.trackId)
    const firstLook =
      groupTiles !== null
        ? null
        : await this.resolveAttachment(entry, canStillGainMedia(entry) ? 'trigger-only' : 'any')
    // TWO MEDIA, TWO CLOCKS — and the slower one does not get to choose the
    // faster one's content.
    //
    // The still used to be re-resolved AFTER the footage render. The render
    // blocks 7-8 s (a 6 s post-roll plus the cut), and by then the ladder is
    // reading a track that has walked away: its first rung is the track's best
    // shot, which is a frame from seconds later. That is how a notification
    // called 'Persona su Uscio' shipped an empty doorstep (operator report,
    // 2026-08-21; the frame that shipped was +4901 ms).
    //
    // So the render is STARTED here and awaited at the end, while the still
    // polls on its own bound and freezes at the first frame that is about the
    // trigger. The wait the re-read used to piggyback on (D58: gate on whether
    // the media LANDED, never on how long we happened to take) is still there —
    // it is just the poll's own, and it stops at the first landing rather than
    // taking whatever is best when the render happens to finish.
    const footagePending = this.renderFootage(entry)
    const mosaic =
      groupView !== undefined && groupTiles !== null
        ? await this.groupedMosaic(entry, groupView, groupTiles)
        : null
    const still =
      mosaic !== null
        ? mosaic.attachment
        : firstLook !== null || entry.payload.media === 'none'
          ? firstLook
          : await this.waitForStill(entry)
    // EVERY row of a group of two or more carries its tile set — empty when the rule ships no
    // media or nothing landed — so the gate and the analyst can never fall back to whatever
    // else ships (D692 §6.2 item 9).
    const grouped: NcGroupedTileSet | null =
      groupView !== undefined && groupMembers !== null
        ? {
            windowKey: groupView.key,
            members: groupView.members.length,
            stills: mosaic?.stills ?? [],
          }
        : null
    const footage = await footagePending
    // Read after the footage await, which gives the shelf's composition more
    // time; decided BEFORE the text-only line, which they can make untrue.
    const extras = await this.linkedExtraStills(entry)
    if (still !== null) {
      // Rendered by the image stage already (D897) — a mosaic is composed of
      // stage-rendered tiles.
      out.push(still)
    } else if (entry.payload.media !== 'none' && extras.length > 0) {
      // `each`: the primary's still is missing but other cameras' landed —
      // not text-only, and not the same question for the operator.
      this.deps.logger.info(
        "no still of the primary camera could be resolved — the other linked cameras' stills ship without it",
        {
          tags: { deviceId: entry.payload.subject.deviceId },
          meta: {
            recordKind: entry.recordKind,
            recordId: entry.recordId,
            policy: entry.payload.media,
            ...(entry.payload.subject.trackId !== undefined
              ? { owner: `track:${entry.payload.subject.trackId}` }
              : {}),
            otherCameras: extras.length,
          },
        },
      )
    } else if (entry.payload.media !== 'none') {
      // The rule asked for a picture and the ladder found none. Named rather
      // than silent: this is the whole difference between "the media never
      // landed" and "the notification never wanted one", and it is the line
      // that answers a device event arriving text-only even though its marker
      // track exists (the marker landed WITHOUT its snapshot).
      this.deps.logger.info('no still could be resolved — this notification ships text-only', {
        tags: { deviceId: entry.payload.subject.deviceId },
        meta: {
          recordKind: entry.recordKind,
          recordId: entry.recordId,
          policy: entry.payload.media,
          ...(entry.payload.mediaImage !== undefined ? { image: entry.payload.mediaImage } : {}),
          // A mosaic row owns one track per member: name them all (owners below is the
          // primary's alone).
          ...(memberTrackIds.length > 1 ? { memberTrackIds } : {}),
          // Which owners were tried at all. An EMPTY list is the other failure:
          // the payload froze no media owner for this record.
          owners: [
            // D476: always an OBJECT event id — see `NcDispatcherDeps.getMediaForOwner`.
            ...(entry.payload.subject.eventId !== undefined
              ? [`object:${entry.payload.subject.eventId}`]
              : []),
            ...(entry.payload.subject.trackId !== undefined
              ? [`track:${entry.payload.subject.trackId}`]
              : []),
          ],
        },
      })
    }
    // The PRIMARY camera's footage keeps its precedence over the other
    // cameras' stills: they come last and fill whatever room the target has
    // left (the degrade engine drops by position).
    out.push(...footage.attachments)
    out.push(...extras)
    return { attachments: out, grouped }
  }

  /**
   * `each` (ADR 0632): the OTHER linked cameras' stills, in camera order —
   * AFTER the primary still and the primary's footage, so a target with little
   * room keeps both and the other cameras fill only what is left (the degrade
   * engine drops by position). A camera whose picture never landed is skipped
   * and named ON THAT CAMERA: a blank attachment would read as a broken camera.
   * The camera is the one the row CARRIES with each still (the one the shelf
   * photographed) — never inferred from a position in `linkedCameraIds`, which
   * a mute between capture and evaluation shifts. Named `camera-<id>.jpg`.
   */
  private async linkedExtraStills(entry: NcOutboxEntry): Promise<NcResolvedImage[]> {
    const subject = entry.payload.subject
    const out: NcResolvedImage[] = []
    for (const { ownerId, cameraId } of subject.extraStills ?? []) {
      const file = await this.linkedStillFile(entry, ownerId, cameraId)
      const bytes = file === undefined ? null : decodeStillBytes(file.base64)
      if (file === undefined || bytes === null) {
        this.deps.logger.info('linked camera picture missing at send — skipped', {
          tags: { deviceId: cameraId },
          meta: { recordId: entry.recordId, ruleId: entry.ruleId, ownerId },
        })
        continue
      }
      // The same stage as the primary still (D897): this camera's tracks at
      // the photograph's instant, the row's own mode. No subject of its own —
      // the sensor's subject is not on this camera.
      const image = await this.imageStage.notificationImage({
        entry,
        source: {
          bytes,
          kind: file.kind,
          timestamp: file.timestamp,
          annotated: isAnnotatedSceneKind(file.kind),
        },
        camera: cameraId,
        withSubject: false,
        locale: this.texts.language,
      })
      if (image === null) continue
      out.push({
        mediaType: 'image',
        bytes: image.bytes,
        mime: 'image/jpeg',
        name: `camera-${String(cameraId)}.jpg`,
      })
    }
    return out
  }

  /**
   * Footage — ONE cut, every container the rule asked for.
   *
   * The gif is derived from the video's own bytes downstream, so the two
   * attachments cannot disagree about what they show; asking for them
   * separately is what produced a gif around the event and a video after it.
   * Fail-closed: a moment no source covers contributes nothing, never a failed
   * notification. The degrade engine drops video per-target for backends that
   * take none and the still survives, so asking for one is always safe.
   *
   * `attempted` says whether this call BLOCKED — the caller re-resolves the
   * still afterwards only when it did, because that is the wait it is
   * piggybacking on.
   */
  /** The retention THIS camera's ring was asked for — see
   *  {@link NcDispatcherDeps.ringRetentionSecFor}. */
  private ringRetentionSec(deviceId: number): number {
    const asked = this.deps.ringRetentionSecFor?.(deviceId)
    return asked === undefined || !Number.isFinite(asked) ? NC_CLIP_RING_RETENTION_SEC : asked
  }

  /**
   * Where this row's footage is centred (§6.3). A v2 grouped row is about the WINDOW: its
   * footage is cut around the moment the window OPENED, so the first subject's arrival is in
   * the clip (pre- and post-roll are the rule's, unchanged). Every other row — a plain one, a
   * legacy D143 burst revision (it has no window time) — keeps the subject's own anchor.
   */
  private footageAnchorOf(entry: NcOutboxEntry): NcMediaAnchor {
    const view = readOutboxGroup(entry.payload.group)
    const subject = entry.payload.subject
    if (view === undefined || view.openedAt === undefined) return mediaAnchor(subject)
    this.deps.logger.debug('grouped row: footage anchored on the window opening', {
      tags: { deviceId: subject.deviceId },
      meta: {
        ruleId: entry.ruleId,
        rule: entry.payload.ruleName,
        windowKey: view.key,
        anchor: 'group-opened',
        anchorMs: view.openedAt,
      },
    })
    return {
      atMs: view.openedAt,
      source: 'observed',
      lagMs: Math.max(0, subject.timestamp - view.openedAt),
    }
  }

  private async renderFootage(entry: NcOutboxEntry): Promise<NcFootageResult> {
    const wantGif = entry.payload.mediaGif === true
    const wantMp4 = entry.payload.mediaClip === true
    if ((!wantGif && !wantMp4) || this.deps.renderEventMedia === undefined) {
      return { attempted: false, attachments: [] }
    }
    const preRollSec = entry.payload.mediaClipPreRollSec ?? NC_CLIP_PRE_ROLL_DEFAULT_SEC
    // WHERE THE CUT IS CENTRED — the moment the event HAPPENED when the source
    // could date it, not the moment it was concluded (`media-anchor.ts`). An
    // occupancy edge is concluded minutes after the fact, and anchoring on the
    // conclusion is what put an empty parking space in the "posto libero" clip.
    const anchor = this.footageAnchorOf(entry)
    const selfDating = selfDatingKindOf(entry.payload.subject)
    if (anchorFellBack(anchor, selfDating !== null)) {
      // A branch that quietly produces the WRONG window is a branch that drops
      // work: the clip ships, it just shows the aftermath. Say so, per camera.
      // A package PICK-UP is the same news since D682: a pick-up row written
      // before D684 stores no instant, and its gif would be the doormat.
      this.deps.logger.warn(
        `${selfDating ?? 'occupancy'} footage anchored on the conclusion — moment unknown`,
        {
          tags: { deviceId: entry.payload.subject.deviceId },
          meta: {
            ruleId: entry.ruleId,
            eventId: entry.recordId,
            reason: anchor.fallback ?? 'unknown',
            anchorMs: anchor.atMs,
            consequence: 'clip covers the moment the change was concluded, not when it happened',
          },
        },
      )
    }
    // A row that sat in the outbox across a restart (or a long retry) is asking
    // for a window the ring no longer holds — BOTH cut sources read the same
    // retained buffer, so this render can only fail, twice, in two log lines
    // that describe a broker fault rather than the queueing delay that actually
    // happened. Say the true thing once and ship what there is. Measured from
    // the ANCHOR: an observed moment that predates the ring is exactly as
    // uncuttable as a queued row, and refusing it is what keeps the anchor from
    // silently becoming "the oldest frame the ring still holds".
    const ageMs = this.now() - anchor.atMs
    if (
      footageSourceFor({
        anchorMs: anchor.atMs,
        nowMs: this.now(),
        preRollSec,
        ringRetentionSec: this.ringRetentionSec(entry.payload.subject.deviceId),
      }) === 'recordings'
    ) {
      // TWO different faults land here and they are not the same news. A row
      // that waited is a queueing delay. An OBSERVED anchor that predates the
      // ring is the event itself being older than anything the broker retains
      // — a departure confirmed minutes after the car left has no footage at
      // all, and the honest answer is none rather than a cut of the aftermath.
      // Naming the right one is the difference between chasing a broker fault
      // and reading the true cause.
      const why =
        anchor.source === 'observed'
          ? 'footage window predates the clip ring — the moment is older than the ring holds'
          : 'footage window expired while queued — shipping without'
      this.deps.logger.warn(why, {
        tags: { deviceId: entry.payload.subject.deviceId },
        meta: {
          ruleId: entry.ruleId,
          eventId: entry.recordId,
          ageSec: Math.round(ageMs / 1000),
          anchoredOn: anchor.source,
          preRollSec,
          retentionSec: this.ringRetentionSec(entry.payload.subject.deviceId),
          wanted: [...(wantGif ? ['gif'] : []), ...(wantMp4 ? ['video'] : [])],
          // What happens NEXT, so the line is not read as the end of the story.
          next: this.recordedFootagePlan(entry).kinds.length > 0 ? 'recorded-cut' : 'no-clip',
        },
      })
      return this.cutRecordedFootage(entry, anchor, preRollSec)
    }
    const attachments: NcResolvedAttachment[] = []
    try {
      const media = await this.deps.renderEventMedia({
        deviceId: entry.payload.subject.deviceId,
        aroundMs: anchor.atMs,
        wantGif,
        wantMp4,
        preRollSec,
        postRollSec: entry.payload.mediaClipPostRollSec ?? NC_CLIP_POST_ROLL_DEFAULT_SEC,
        ...(entry.payload.mediaProfile !== undefined
          ? { profile: entry.payload.mediaProfile }
          : {}),
        ...(entry.payload.mediaClipSpeed !== undefined
          ? { speed: entry.payload.mediaClipSpeed }
          : {}),
      })
      // GIF first, mp4 second — the order the degrade engine and the existing
      // attachment expectations were written against.
      if (media.gif !== null && media.gif.byteLength > 0) {
        attachments.push({
          mediaType: 'gif',
          bytes: copyBytes(media.gif),
          mime: 'image/gif',
          name: 'event.gif',
        })
      }
      if (media.mp4 !== null && media.mp4.byteLength > 0) {
        attachments.push({
          mediaType: 'video',
          bytes: copyBytes(media.mp4),
          mime: 'video/mp4',
          name: 'event.mp4',
        })
      }
    } catch (err) {
      this.notePendingFootage(entry, err, wantMp4 ? 'clip' : 'gif')
    }
    return { attempted: true, attachments }
  }

  /**
   * Cut the footage from the RECORDINGS, for a moment the ring could not
   * serve, and hand it to the ONE notification this row sends (D686).
   *
   * ## Why the notification waits for it
   *
   * A notifier is one-shot. The earlier design (D682) sent the alert first and
   * the recorded footage as a SECOND send with the same `tag`, on the promise
   * that "a phone collapses the two" — Zentik honours no tag, so every such
   * row reached the operator as two messages (101, 2026-09-30). A moment that
   * reaches this path is already older than the ring (a pick-up is concluded
   * minutes after it happened), so waiting a few more seconds costs nothing;
   * a second message costs the operator a duplicate every time.
   *
   * The wait is bounded by {@link NC_RECORDED_FOOTAGE_WAIT_MS} and the bound is
   * handed to the recorder as `deadlineMs`, so a render nobody waits for any
   * more is abandoned, not left running. A cut that fails, throws or is not
   * ready in time costs the footage and never the notification — it ships
   * with the still, and the reason is logged per camera.
   *
   * A GIF rule is served here too (D682): the gif is derived from THIS cut's
   * bytes (`deriveGifFromClip`) — one cut, never a second renderer — and a
   * moment the recordings cannot serve ships NO gif, by named reason, rather
   * than a gif of the wrong time.
   *
   * `footageSourceFor` already said `recordings` for this row: the caller asks
   * it once, and this runs only on that answer.
   */
  private async cutRecordedFootage(
    entry: NcOutboxEntry,
    anchor: NcMediaAnchor,
    preRollSec: number,
  ): Promise<NcFootageResult> {
    const plan = this.recordedFootagePlan(entry)
    this.reportRecordedRefusals(entry, plan, anchor)
    const cut = this.deps.cutRecordedClip
    if (cut === undefined || plan.kinds.length === 0) return { attempted: false, attachments: [] }
    const startedAt = this.now()
    const videoSpeed = entry.payload.mediaClipSpeed
    const window = {
      deviceId: entry.payload.subject.deviceId,
      aroundMs: anchor.atMs,
      preRollSec,
      postRollSec: entry.payload.mediaClipPostRollSec ?? NC_CLIP_POST_ROLL_DEFAULT_SEC,
      ...(videoSpeed !== undefined ? { speed: videoSpeed } : {}),
      recordId: entry.recordId,
    }
    const key = recordedCutKey(window)
    // ONE cut per moment: every target row of this record, and every retry,
    // shares it (review H2/L3). A held cut is used even while the recorder is
    // busy — it is already here.
    let shared = this.recordedCuts.find(key, startedAt)
    let boundMs = NC_RECORDED_FOOTAGE_WAIT_MS
    if (shared !== null && !shared.settled) {
      // JOINING a cut still in flight (re-review R1). The breaker applies to
      // it as to a new cut, and the wait is only what the cut has left: a
      // fresh 30 s per extra target row is the aggregate this memo removes.
      if (this.recordedCuts.isBusy(startedAt)) {
        const outcome: NcRecordedFootageOutcome = {
          kind: 'recorder-busy',
          busyUntil: this.recordedCuts.busyUntilMs(),
        }
        this.reportRecordedOutcome(entry, plan.kinds, anchor, outcome, startedAt)
        return { attempted: false, attachments: [] }
      }
      boundMs = Math.min(
        NC_RECORDED_FOOTAGE_WAIT_MS,
        shared.deadlineMs + NC_RECORDED_CUT_JOIN_GRACE_MS - startedAt,
      )
      if (boundMs <= 0) {
        this.reportRecordedOutcome(entry, plan.kinds, anchor, { kind: 'timed-out' }, startedAt)
        return { attempted: false, attachments: [] }
      }
    }
    if (shared === null) {
      if (this.recordedCuts.isBusy(startedAt)) {
        const outcome: NcRecordedFootageOutcome = {
          kind: 'recorder-busy',
          busyUntil: this.recordedCuts.busyUntilMs(),
        }
        this.reportRecordedOutcome(entry, plan.kinds, anchor, outcome, startedAt)
        return { attempted: false, attachments: [] }
      }
      const deadlineMs = startedAt + NC_RECORDED_FOOTAGE_WAIT_MS
      shared = this.recordedCuts.start(key, startedAt, deadlineMs, () =>
        cut({ ...window, ruleId: entry.ruleId, deadlineMs }),
      )
    }
    const work = this.attachRecordedCut(entry, plan.kinds, shared)
    const outcome = await settleWithin(work, boundMs, {
      kind: 'timed-out',
    } satisfies NcRecordedFootageOutcome)
    if (outcome.kind === 'timed-out') this.recordedCuts.noteTimedOut(this.now())
    this.reportRecordedOutcome(entry, plan.kinds, anchor, outcome, startedAt)
    return {
      attempted: true,
      attachments: outcome.kind === 'attached' ? outcome.attachments : [],
    }
  }

  /** The shared cut, then this row's containers of it — never rejects. */
  private async attachRecordedCut(
    entry: NcOutboxEntry,
    wanted: readonly NcRecordedFootageKind[],
    shared: NcSharedCut,
  ): Promise<NcRecordedFootageOutcome> {
    const result = await shared.cut
    if (result.kind === 'threw') return { kind: 'threw', error: result.error }
    if (result.kind === 'refused') return { kind: 'cut-refused', reason: result.result.reason }
    try {
      const attachments = await this.recordedAttachments(entry, wanted, result.mp4, shared)
      if (attachments.length === 0) return { kind: 'no-gif' }
      return {
        kind: 'attached',
        attachments,
        profile: result.profile,
        bytes: result.mp4.byteLength,
      }
    } catch (err) {
      return { kind: 'threw', error: String(err) }
    }
  }

  /**
   * Why a kind the rule asked for is not cut from the recordings — said per
   * camera, because "where is my gif" is always asked about a camera.
   * `no-derive` included: a wiring seam, but a silent one is a dropped gif.
   */
  private reportRecordedRefusals(
    entry: NcOutboxEntry,
    plan: NcRecordedFootagePlan,
    anchor: NcMediaAnchor,
  ): void {
    const common = {
      ruleId: entry.ruleId,
      eventId: entry.recordId,
      targetId: entry.targetId,
      anchoredOn: anchor.source,
      ...(anchor.fallback !== undefined ? { anchorFallback: anchor.fallback } : {}),
      next: plan.kinds,
    }
    const tags = { deviceId: entry.payload.subject.deviceId }
    if (plan.gifRefused !== undefined) {
      this.deps.logger.info('recorded gif: none — the gif is not cut from the recordings', {
        tags,
        meta: { ...common, reason: plan.gifRefused },
      })
    }
    if (plan.videoRefused !== undefined) {
      // A pick-up with no moment would be cut around its conclusion — the
      // doormat as an mp4. None, by name.
      this.deps.logger.info('recorded video: none — the video is not cut from the recordings', {
        tags,
        meta: { ...common, reason: plan.videoRefused },
      })
    }
  }

  /** One line per recorded cut, whatever became of it, tagged per camera. The
   *  ring line said `next: recorded-cut`; this is where that story ends. */
  private reportRecordedOutcome(
    entry: NcOutboxEntry,
    wanted: readonly NcRecordedFootageKind[],
    anchor: NcMediaAnchor,
    outcome: NcRecordedFootageOutcome,
    startedAt: number,
  ): void {
    const tags = { deviceId: entry.payload.subject.deviceId }
    const common = {
      ruleId: entry.ruleId,
      eventId: entry.recordId,
      targetId: entry.targetId,
      wanted,
      anchoredOn: anchor.source,
    }
    switch (outcome.kind) {
      case 'attached':
        this.deps.logger.info('recorded footage attached', {
          tags,
          meta: {
            ...common,
            profile: outcome.profile,
            bytes: outcome.bytes,
            attachments: outcome.attachments.map((a) => a.mediaType),
            waitedMs: this.now() - startedAt,
          },
        })
        return
      case 'cut-refused':
        // `cutRecordedClip` already named the cause in its own words; this
        // line says the notification ships without the footage.
        this.deps.logger.info('recorded footage: none — the recorded cut failed', {
          tags,
          meta: { ...common, reason: outcome.reason },
        })
        return
      case 'no-gif':
        // Only reachable for a gif-only rule whose derive failed — the derive
        // logged its own reason.
        this.deps.logger.info('recorded footage: none — the gif could not be derived', {
          tags,
          meta: { ...common, reason: 'gif-derive-failed' },
        })
        return
      case 'threw':
        this.deps.logger.warn('recorded footage: none — the recorded cut threw', {
          tags,
          meta: { ...common, reason: 'threw', error: outcome.error },
        })
        return
      case 'timed-out':
        this.deps.logger.warn('recorded footage: none — not ready inside the bound', {
          tags,
          meta: {
            ...common,
            reason: 'timed-out',
            boundMs: NC_RECORDED_FOOTAGE_WAIT_MS,
            // The breaker this opened: recorded rows skip the wait until then.
            busyForMs: NC_RECORDER_BUSY_MS,
          },
        })
        return
      case 'recorder-busy':
        // A recent cut timed out: this row does not wait out the bound again
        // behind the same wedged recorder. Dropped footage, named per camera.
        this.deps.logger.info('recorded footage: none — the recorder is busy', {
          tags,
          meta: { ...common, reason: 'recorder-busy', busyUntil: outcome.busyUntil },
        })
        return
    }
  }

  /**
   * What the recorded cut for this row would CARRY — the one answer both the
   * ring line (`next`) and the cut read, so the log cannot promise a cut the
   * dispatcher will not order.
   *
   * A video when the rule asked for one. A gif only for a SELF-DATING kind
   * whose moment is KNOWN — a package pick-up (D682) or an occupancy edge
   * (D691): the gif is derived from the recorded cut's own bytes, the same way
   * the broker derives it from a ring cut — one cut, two containers, never a
   * second renderer.
   *
   * Narrow on purpose. Those are the kinds whose moment is routinely outside
   * the ring (a pick-up always; a departure whose commit waited for a sample);
   * every other kind keeps the gif behaviour it had (the ring's, or none)
   * rather than silently gaining a recorder export per notification. This
   * runs only on `footageSourceFor === 'recordings'`, so an occupancy edge the
   * ring still holds never reaches it. And
   * a pick-up that fell back to its conclusion gets no recorded footage at all,
   * gif OR video — cutting the recordings there is exactly the doormat D682
   * removed (see {@link NcRecordedGifRefusal}, {@link NcRecordedVideoRefusal}).
   */
  private recordedFootagePlan(entry: NcOutboxEntry): NcRecordedFootagePlan {
    if (this.deps.cutRecordedClip === undefined) return { kinds: [] }
    const gifRefused = this.recordedGifRefusal(entry)
    const videoRefused = this.recordedVideoRefusal(entry)
    const kinds: NcRecordedFootageKind[] = []
    if (entry.payload.mediaGif === true && gifRefused === undefined) kinds.push('gif')
    if (entry.payload.mediaClip === true && videoRefused === undefined) kinds.push('video')
    return {
      kinds,
      ...(gifRefused !== undefined ? { gifRefused } : {}),
      ...(videoRefused !== undefined ? { videoRefused } : {}),
    }
  }

  /** Why this row's video is not cut from the recordings, or `undefined` when
   *  it is (or when the rule asked for no video). */
  private recordedVideoRefusal(entry: NcOutboxEntry): NcRecordedVideoRefusal | undefined {
    if (entry.payload.mediaClip !== true) return undefined
    const subject = entry.payload.subject
    if (selfDatingKindOf(subject) !== 'package pick-up') return undefined
    if (anchorFellBack(mediaAnchor(subject), true)) return 'moment-unknown'
    return undefined
  }

  /** Why this row's gif is not cut from the recordings, or `undefined` when it
   *  is (or when the rule asked for no gif). */
  private recordedGifRefusal(entry: NcOutboxEntry): NcRecordedGifRefusal | undefined {
    if (entry.payload.mediaGif !== true) return undefined
    if (this.deps.deriveGifFromClip === undefined) return 'no-derive'
    const subject = entry.payload.subject
    if (selfDatingKindOf(subject) === null) return 'not-self-dating'
    if (anchorFellBack(mediaAnchor(subject), true)) return 'moment-unknown'
    return undefined
  }

  /**
   * The recorded attachments, gif first and video second — the order the ring
   * path ships them in. A gif that could not be derived is left out (its
   * reason already logged); the video, when asked for, still ships. A derive
   * is not started once the bound has passed: nobody would wait for it.
   */
  private async recordedAttachments(
    entry: NcOutboxEntry,
    wanted: readonly NcRecordedFootageKind[],
    mp4: Uint8Array<ArrayBuffer>,
    shared: NcSharedCut,
  ): Promise<NcResolvedAttachment[]> {
    const out: NcResolvedAttachment[] = []
    const derive = this.deps.deriveGifFromClip
    if (wanted.includes('gif') && derive !== undefined) {
      // ONE derive per cut, shared like the cut. Not started once the bound
      // has passed: nobody would wait for it.
      if (shared.gif === null && this.now() < shared.deadlineMs) {
        shared.gif = derive({
          deviceId: entry.payload.subject.deviceId,
          mp4,
          ...(entry.payload.mediaClipSpeed !== undefined
            ? { videoSpeed: entry.payload.mediaClipSpeed }
            : {}),
          ruleId: entry.ruleId,
          recordId: entry.recordId,
        })
      }
      const gif = shared.gif === null ? null : await shared.gif
      // COPIED per row, like the ring path (re-review R3): the bytes are
      // shared by every row of the moment, and a consumer that transfers or
      // mutates one row's buffer must not corrupt the next row's.
      if (gif !== null && gif.ok) {
        out.push({
          mediaType: 'gif',
          bytes: copyBytes(gif.gif),
          mime: 'image/gif',
          name: 'event.gif',
        })
      }
    }
    if (wanted.includes('video')) {
      out.push({ mediaType: 'video', bytes: copyBytes(mp4), mime: 'video/mp4', name: 'event.mp4' })
    }
    return out
  }

  /**
   * Poll the still ladder for {@link NC_STILL_WAIT_MS}, then give up.
   *
   * Runs for EVERY rule now, footage or not, and concurrently with the render:
   * the still's deadline is its own. Track media lands 1.5–5.5 s after the
   * trigger, so a notification built at the instant of the trigger routinely
   * resolves nothing and this is what recovers it.
   *
   * Each attempt asks for a frame from the trigger instant and nothing else, so
   * a poll that has not found one keeps waiting rather than settling for a
   * later frame that happens to be ranked higher. The give-up pass is the one
   * place a later frame is accepted, and it says so.
   *
   * Bounded and then abandoned — a text-only notification about a person at the
   * door beats a punctual one nobody received.
   */
  private async waitForStill(entry: NcOutboxEntry): Promise<NcResolvedAttachment | null> {
    const subject = entry.payload.subject
    // An aged row does not POLL — its media either exists already or never
    // will — but it still resolves. Returning null here would have been a
    // regression the moment the first look started asking for the trigger
    // instant only: a retried row whose only frame is from later would ship
    // text-only, where before it shipped that frame.
    if (this.now() - subject.timestamp > NC_STILL_WAIT_MAX_AGE_MS) {
      return this.resolveAttachment(entry, 'any')
    }
    // Nothing to wait FOR: the payload froze no media owner for this record, so
    // there is no row that could land. (The distinction the text-only line
    // already draws — an empty `owners` list is a different failure from an
    // owner that never got its picture.)
    if (subject.eventId === undefined && subject.trackId === undefined) return null
    const attempts = Math.floor(NC_STILL_WAIT_MS / NC_STILL_WAIT_INTERVAL_MS)
    for (let i = 0; i < attempts; i += 1) {
      await this.sleep(NC_STILL_WAIT_INTERVAL_MS)
      const still = await this.resolveAttachment(entry, 'trigger-only')
      if (still !== null) {
        this.deps.logger.info('the still landed during the bounded wait', {
          tags: { deviceId: entry.payload.subject.deviceId },
          meta: {
            ruleId: entry.ruleId,
            eventId: entry.recordId,
            waitedMs: (i + 1) * NC_STILL_WAIT_INTERVAL_MS,
            kind: still.name,
          },
        })
        return still
      }
    }
    // The give-up pass: the bound is spent, so a frame from later is better
    // than no frame at all. `narrowToTriggerInstant` reports the age it settled
    // for — this is the one branch that ships a picture of a different moment,
    // and it is never silent.
    return this.resolveAttachment(entry, 'any')
  }

  /**
   * The grouped MOSAIC (D692 §6.2): one tile per member, at most
   * {@link NC_GROUPED_MOSAIC_MAX_TILES}, composed at SEND and returned as BYTES only — a
   * composite never enters the media store (it is disqualified as model input, D154).
   *
   * Zero stills → no attachment (the caller's text-only line). One still → that still, as
   * is: a mosaic of one is a picture with a border. A composition that throws, or that drops
   * every tile, ships the FIRST subject's still and says so (§6.2 item 8).
   *
   * The stills come back WITH the picture, whatever it turned out to be: they are the raw
   * tiles the confirm gate and the AI analyst judge, so the crop judged is the crop shipped
   * (D52) and the members' media is read once per delivery, not once per consumer.
   */
  private async groupedMosaic(
    entry: NcOutboxEntry,
    view: NcGroupView,
    tiles: readonly NcOutboxGroupMemberV2[],
  ): Promise<NcGroupedMosaicOutcome> {
    const deviceId = entry.payload.subject.deviceId
    const capped = view.members.length > tiles.length
    if (capped) {
      this.deps.logger.info('grouped mosaic: tiles capped', {
        tags: { deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          windowKey: view.key,
          members: view.members.length,
          tiles: tiles.length,
        },
      })
    }
    const { stills, misses } = await this.groupedTileStills(entry, tiles)
    for (const miss of misses) {
      // Still COUNTED in the sentence — the text is built from the members, not the tiles.
      this.deps.logger.info('grouped mosaic: no still for a member — tile omitted', {
        tags: { deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          windowKey: view.key,
          trackId: miss.trackId,
          reason: miss.reason,
        },
      })
    }
    const first = stills[0]
    if (first === undefined) return { attachment: null, stills }
    const firstStill: NcResolvedAttachment = {
      mediaType: 'image',
      bytes: first.bytes,
      mime: first.mime,
      name: first.name,
    }
    if (stills.length === 1) return { attachment: firstStill, stills }
    const render = this.deps.renderMosaic ?? renderMosaic
    try {
      const rendered = await render(
        {
          purpose: 'grouped',
          // No words in the pixels (D121): names live in the text, in tile order.
          captions: 'none',
          tiles: stills.map((still) => ({
            jpeg: Buffer.from(still.bytes),
            deviceId,
            sourceId: still.trackId,
          })),
        },
        this.deps.logger,
      )
      if (rendered.droppedTiles >= stills.length) {
        throw new Error(`no tile could be decoded (${stills.length} offered)`)
      }
      // The picture holds the tiles the renderer COULD read; those are the ones judged.
      const composed = stills.filter((still) => rendered.composedSourceIds.includes(still.trackId))
      const result: NcGroupedMosaicResult = {
        jpeg: rendered.jpeg,
        tiles: stills.length - rendered.droppedTiles,
        omitted: misses.length + rendered.droppedTiles,
        capped,
      }
      this.deps.logger.info('grouped mosaic composed', {
        tags: { deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          windowKey: view.key,
          members: view.members.length,
          tiles: result.tiles,
          omitted: result.omitted,
          capped: result.capped,
        },
      })
      // Copy into a fresh ArrayBuffer-backed view — the send input's exact type (a sharp
      // Buffer may sit on a pooled ArrayBufferLike).
      const bytes = new Uint8Array(result.jpeg.byteLength)
      bytes.set(result.jpeg)
      return {
        attachment: { mediaType: 'image', bytes, mime: 'image/jpeg', name: 'mosaic.jpg' },
        stills: composed,
      }
    } catch (err) {
      this.deps.logger.warn('grouped mosaic could not be composed — shipping the first subject', {
        tags: { deviceId },
        meta: {
          ruleId: entry.ruleId,
          rule: entry.payload.ruleName,
          windowKey: view.key,
          trackId: first.trackId,
          offered: stills.length,
          error: String(err),
        },
      })
      // What ships is the first subject's still alone, so that is the only tile judged.
      return { attachment: firstStill, stills: [first] }
    }
  }

  /**
   * ONE shared still wait across the tiled members (§6.2 item 4): every still-missing
   * member is asked together on each attempt, so three members cost
   * {@link NC_STILL_WAIT_MS}, never three times it. The same shape as
   * {@link waitForStill} — a trigger-instant look, the bounded poll, then one give-up pass
   * that accepts a later frame — over a derived entry per member
   * ({@link groupedTileEntry}: its own track, generation, zones and `matchedOn`, cropped).
   * A member aged past {@link NC_STILL_WAIT_MAX_AGE_MS} is not polled: its media exists
   * already or never will.
   */
  private async groupedTileStills(
    entry: NcOutboxEntry,
    tiles: readonly NcOutboxGroupMemberV2[],
  ): Promise<{
    readonly stills: readonly NcGroupedTileStill[]
    readonly misses: readonly NcGroupedTileMiss[]
  }> {
    const entries = tiles.map((m) => groupedTileEntry(entry, m))
    const found = new Map<number, NcGroupedTileStill>()
    const look = async (freshness: NcStillFreshness, indexes: readonly number[]): Promise<void> => {
      await Promise.all(
        indexes.map(async (index) => {
          const tileEntry = entries[index]
          const m = tiles[index]
          if (tileEntry === undefined || m === undefined) return
          // `resolveAttachment` answers null, never throws: it catches every owner read
          // itself, so there is no failure to tell apart from "nothing landed".
          const still = await this.resolveAttachment(tileEntry, freshness)
          if (still !== null) {
            found.set(index, {
              trackId: m.trackId,
              className: m.className,
              bytes: still.bytes,
              mime: still.mime,
              name: still.name,
            })
          }
        }),
      )
    }
    const missing = (): number[] => tiles.flatMap((_, index) => (found.has(index) ? [] : [index]))
    const pollable = (): number[] =>
      missing().filter((index) => {
        const ts = entries[index]?.payload.subject.timestamp
        return ts !== undefined && this.now() - ts <= NC_STILL_WAIT_MAX_AGE_MS
      })
    await look('trigger-only', pollable())
    const attempts = Math.floor(NC_STILL_WAIT_MS / NC_STILL_WAIT_INTERVAL_MS)
    for (let i = 0; i < attempts && pollable().length > 0; i += 1) {
      await this.sleep(NC_STILL_WAIT_INTERVAL_MS)
      await look('trigger-only', pollable())
    }
    // The give-up pass: the bound is spent, a later frame beats no tile at all.
    await look('any', missing())
    const stills: NcGroupedTileStill[] = []
    const misses: NcGroupedTileMiss[] = []
    tiles.forEach((m, index) => {
      const still = found.get(index)
      if (still !== undefined) stills.push(still)
      else misses.push({ trackId: m.trackId, reason: 'no-still' })
    })
    return { stills, misses }
  }

  /**
   * Drop the candidate stills that show the subject OUTSIDE the zone that fired
   * the rule. A filter, never a re-rank: the ladder still decides which kind of
   * picture the rule gets, among the frames that are about the right thing.
   *
   * Every unanswerable case returns the list untouched — no frozen zones, no
   * track to trail, no dep wired, no polygon resolved, an empty trail, or a
   * throw. And when nothing qualifies, the full list comes back: a real picture
   * beats no picture (the same rule D212 settled for the best shot).
   */
  private async narrowToTriggerZone(
    entry: NcOutboxEntry,
    ordered: readonly MediaFileBytes[],
    freshness: NcStillFreshness,
  ): Promise<readonly MediaFileBytes[]> {
    const zoneIds = entry.payload.triggerZoneIds
    const trackId = entry.payload.subject.trackId
    const getTrail = this.deps.getSubjectTrail
    const deviceId = entry.payload.subject.deviceId
    // `ordered.length < 2` used to stand down here too: with one candidate
    // there is nothing to CHOOSE between. Under `trigger-only` there still is
    // something to decide — whether that one candidate is about the right
    // place, or whether the poll should keep waiting for one that is.
    const strict = freshness === 'trigger-only'
    if (
      zoneIds === undefined ||
      zoneIds.length === 0 ||
      trackId === undefined ||
      getTrail === undefined ||
      (ordered.length < 2 && !strict)
    ) {
      return ordered
    }
    try {
      const [polygons, trail] = await Promise.all([
        this.deps.getZonePolygons?.(deviceId, zoneIds) ?? Promise.resolve([]),
        getTrail(deviceId, trackId),
      ])
      const kept = selectTriggerZoneCandidates({
        candidates: ordered,
        trail,
        polygons,
        triggerAt: entry.payload.subject.timestamp,
        strict,
      })
      if (kept.length === 0) {
        // Not a drop — a DEFERRAL, and the bounded wait is what makes it one.
        // Named because the alternative is a poll nobody can explain: this is
        // the line that says the frames on disk were about the wrong place.
        this.deps.logger.debug('no still from the zone that fired the rule — still waiting', {
          tags: { deviceId },
          meta: {
            ruleId: entry.ruleId,
            trackId,
            zoneIds: zoneIds.join(','),
            rejected: ordered.length,
          },
        })
        return kept
      }
      if (kept.length === ordered.length) return kept
      // The branch CHANGES what the operator receives, so it is never silent:
      // this is the line that answers "why did my notification show a different
      // frame than the event detail does".
      this.deps.logger.info('still narrowed to the zone that fired the rule', {
        tags: { deviceId },
        meta: {
          ruleId: entry.ruleId,
          trackId,
          zoneIds: zoneIds.join(','),
          // What the ladder WOULD have shipped, and what it ships instead.
          was: ordered[0]?.kind ?? null,
          wasOffsetMs:
            ordered[0] !== undefined
              ? ordered[0].timestamp - entry.payload.subject.timestamp
              : null,
          now: kept[0]?.kind ?? null,
          nowOffsetMs:
            kept[0] !== undefined ? kept[0].timestamp - entry.payload.subject.timestamp : null,
          dropped: ordered.length - kept.length,
        },
      })
      return kept
    } catch (err) {
      this.deps.logger.debug('trigger-zone still narrowing failed — shipping the plain ladder', {
        tags: { deviceId },
        meta: { ruleId: entry.ruleId, error: String(err) },
      })
      return ordered
    }
  }

  /**
   * Keep only the stills that are ABOUT the trigger instant.
   *
   * Applies to `delivery: 'immediate'` and nothing else: a track-end rule is
   * legitimately about the whole track, and a system event has no instant of
   * its own to be near. Under `any` the list is never emptied — the best
   * out-of-band frame ships instead, and the degrade is REPORTED, because
   * "the picture is from nine seconds later" is the difference between a
   * notification that is late and one that is about something else.
   */
  private narrowToTriggerInstant(
    entry: NcOutboxEntry,
    ordered: readonly MediaFileBytes[],
    freshness: NcStillFreshness,
  ): readonly MediaFileBytes[] {
    if (entry.payload.delivery !== 'immediate' || ordered.length === 0) return ordered
    const triggerAt = entry.payload.subject.timestamp
    const inBand = ordered.filter(
      (file) => Math.abs(file.timestamp - triggerAt) <= NC_TRIGGER_STILL_MAX_AGE_MS,
    )
    if (inBand.length > 0 || freshness === 'trigger-only') return inBand
    const chosen = ordered[0]
    if (chosen !== undefined) {
      this.deps.logger.info('no still from the trigger instant — shipping a later frame', {
        tags: { deviceId: entry.payload.subject.deviceId },
        meta: {
          ruleId: entry.ruleId,
          recordId: entry.recordId,
          // A grouped tile's derived entry shares the primary's recordId: the TRACK says
          // which member degraded (absent on a subject that has none).
          ...(entry.payload.subject.trackId !== undefined
            ? { trackId: entry.payload.subject.trackId }
            : {}),
          kind: chosen.kind,
          offsetMs: chosen.timestamp - triggerAt,
          boundMs: NC_TRIGGER_STILL_MAX_AGE_MS,
          waitedMs: NC_STILL_WAIT_MS,
        },
      })
    }
    return ordered
  }

  /**
   * The row's still: the CLEAN source frame of the trigger moment, rendered by
   * the row's picture mode (D897, `notification-image.ts`).
   *
   * The source ladder is the same for every mode — `cleanSourcePreference`,
   * the track owner first (the scene frames live there), then the object
   * event's — and MOMENT then PLACE filter it exactly as before. What the
   * rule asked to SEE is decided once, by the render, never by which stored
   * kind happened to land.
   */
  private async resolveAttachment(
    entry: NcOutboxEntry,
    freshness: NcStillFreshness = 'any',
  ): Promise<{
    mediaType: 'image'
    bytes: Uint8Array<ArrayBuffer>
    mime: string
    name: string
  } | null> {
    if (entry.payload.media === 'none') return null
    const subject = entry.payload.subject
    // D476: `subject.eventId` is always an OBJECT event id — see the note on
    // `NcDispatcherDeps.getMediaForOwner`. The scene frames live on the TRACK.
    const owners: Array<{ kind: 'object' | 'track'; id: string }> = []
    if (subject.trackId !== undefined) owners.push({ kind: 'track', id: subject.trackId })
    if (subject.eventId !== undefined) owners.push({ kind: 'object', id: subject.eventId })
    for (const owner of owners) {
      try {
        // D694: an event id is a reusable rowid — read THIS record's generation.
        const files =
          owner.kind === 'object'
            ? await this.deps.getMediaForOwner(owner.kind, owner.id, eventMediaScopeOf(subject))
            : await this.deps.getMediaForOwner(owner.kind, owner.id)
        if (files.length === 0) continue
        // The ladder, flattened: every file whose kind the preference names, in
        // preference order and — within one kind — in the order the store
        // returned them.
        const ordered: MediaFileBytes[] = []
        for (const kind of cleanSourcePreference(owner.kind)) {
          for (const file of files) if (file.kind === kind) ordered.push(file)
        }
        // MOMENT first, then PLACE, then KIND. The age gate empties the pool
        // when nothing is about the trigger yet, which is what lets the poll
        // keep waiting instead of settling for a later frame.
        const inBand = this.narrowToTriggerInstant(entry, ordered, freshness)
        if (inBand.length === 0) continue
        const shortlist = await this.narrowToTriggerZone(entry, inBand, freshness)
        if (shortlist.length === 0) continue
        for (const file of shortlist) {
          const bytes = decodeStillBytes(file.base64)
          if (bytes === null) continue
          const image = await this.imageStage.notificationImage({
            entry,
            source: {
              bytes,
              kind: file.kind,
              timestamp: file.timestamp,
              annotated: isAnnotatedSceneKind(file.kind),
            },
            camera: primaryImageCamera(entry.payload),
            withSubject: true,
            locale: this.texts.language,
          })
          if (image === null) return null
          return { mediaType: 'image', bytes: image.bytes, mime: 'image/jpeg', name: image.name }
        }
      } catch (err) {
        this.deps.logger.debug('attachment media read failed', {
          meta: { owner: owner.kind, ownerId: owner.id, error: String(err) },
        })
      }
    }
    return null
  }
}

// ── Template rendering ──────────────────────────────────────────────

/**
 * Map admin zone IDs to their display names for rendering only.
 *
 * Order follows `zoneIds` (the order the track visited them), not the zone
 * catalog. Every failure mode degrades to the ID rather than dropping the
 * zone: an unknown id, a blank name, a throwing lookup, or no lookup wired at
 * all. A body that silently loses a zone is worse than one that shows a UUID.
 */
export async function resolveZoneLabels(
  getZoneNames: NcDispatcherDeps['getZoneNames'],
  deviceId: number,
  zoneIds: readonly string[],
): Promise<readonly string[]> {
  if (zoneIds.length === 0) return []
  if (getZoneNames === undefined) return [...zoneIds]
  try {
    const zones = await getZoneNames(deviceId)
    const byId = new Map(zones.map((z) => [z.id, z.name]))
    return zoneIds.map((id) => {
      const name = byId.get(id)
      return name !== undefined && name.trim().length > 0 ? name : id
    })
  } catch {
    // Rendering must never fail a send — the ids are still true, just ugly.
    return [...zoneIds]
  }
}

/** `{{confidence}}` as a whole percent, or empty when nothing measured one. */
function percentOf(confidence: number | undefined): string {
  return confidence !== undefined ? `${Math.round(confidence * 100)}%` : ''
}

/** What `{{camera}}` renders on a system row that names no device. */
export const NC_DEVICELESS_CAMERA_NAME = 'system'

/**
 * The name `{{camera}}` renders for a row — the ONE derivation, shared by the
 * dispatcher and the template-variable parity spec.
 *
 * A system row that names no device (a node, a backup, an update) renders the
 * filler {@link NC_DEVICELESS_CAMERA_NAME}: there is no camera to name, which
 * is why the catalog offers `{{camera}}` on a system rule only for the kinds
 * that carry a device (template-vars.ts). Everything else asks the directory,
 * and falls back to `camera <id>` when it cannot answer.
 */
export async function notificationDeviceName(
  entry: NcOutboxEntry,
  getDeviceName: NcDispatcherDeps['getDeviceName'],
): Promise<string> {
  const subject = entry.payload.subject
  const systemEvent = subject.systemEvent
  if (systemEvent !== undefined && systemEvent.deviceId === undefined) {
    return NC_DEVICELESS_CAMERA_NAME
  }
  const displayDeviceId = systemEvent?.deviceId ?? subject.deviceId
  return (await getDeviceName(displayDeviceId).catch(() => null)) ?? `camera ${displayDeviceId}`
}

/** The distinct member classes of a v2 grouped row, in member order; empty for any other. */
function groupMemberClasses(entry: NcOutboxEntry): readonly string[] {
  const view = readOutboxGroup(entry.payload.group)
  if (view === undefined || view.legacy) return []
  return [...new Set(view.members.map((m) => m.className))]
}

/** Class composition of a group, busiest classes in first-seen order. */
function classCounts(
  members: readonly { readonly className: string }[],
): readonly { readonly className: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const m of members) counts.set(m.className, (counts.get(m.className) ?? 0) + 1)
  return [...counts].map(([className, count]) => ({ className, count }))
}

/**
 * The variable map ONE render pass sees: scalars, then the composites built
 * from them, then the params a system-event row froze at intake.
 *
 * The three groups are layered in that order deliberately. A composite
 * (`{{subject}}`, `{{inZones}}`, `{{op}}`) is a finished phrase and must not be
 * visible to the fragments it was built from — that is the depth bound, and it
 * is enforced by `text-compose.ts` never being handed this map. The frozen
 * params go last because they are the row's own truth about a system event and
 * outrank the live vocabulary for exactly those names.
 */
/** Intake-only keys for body variant selection — not operator template vars (D934). */
function systemEventParamsForTemplate(
  params: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (params === undefined) return {}
  const { form: _form, attention: _attention, ...rest } = params
  return rest
}

export function buildTemplateVars(
  texts: NcTextCatalog,
  entry: NcOutboxEntry,
  deviceName: string,
  zoneLabels: readonly string[],
  timeZone?: string,
): Readonly<Record<string, string>> {
  const subject = entry.payload.subject
  const occupancy = subject.occupancy
  const systemEvent = subject.systemEvent
  // THE COMBINED ALARM ROW speaks the triggering rule's detection vocabulary,
  // not the panel's: its body is `detection.body`, and every variable that
  // sentence reads comes off the fire ref frozen at intake. Without this the
  // composite `{{subject}}` falls through to the system event's DEDUP SLOT and
  // the operator is sent "alarm:42 su Front door" at three in the morning.
  //
  // Gated on the class, exactly like the intake's key selection: a fire ref
  // without one (a device-event match, or any row enqueued before this deploy)
  // still carries the alarm's own frozen sentence, which needs the slot.
  const detection =
    systemEvent?.alarmSource?.className !== undefined ? systemEvent.alarmSource : undefined
  const group = readOutboxGroup(entry.payload.group)
  // Placeholders that are human-readable names stay lowercase in the body;
  // identity / plate labels are NOT passed through here (they ride `subject`).
  const locale = texts.language
  const cameraName = deviceName.toLocaleLowerCase(locale)
  const zonesLower = zoneLabels.map((z) => z.toLocaleLowerCase(locale))
  return {
    camera: cameraName,
    // `subject.className` is a REQUIRED field even on a plain system event,
    // where the enqueue path fills it with the literal filler `'event'`
    // (index.ts) — never a real detected class. `{{class}}` must stay empty
    // there, or the catalog would have to advertise a variable whose only
    // possible value on that kind is a word nobody chose. A COMBINED alarm
    // row is unaffected: `detection` (the triggering rule's own class) wins
    // first, exactly as it already did.
    // Wire id vs human label — always both. `{{class}}` stays the raw
    // vocabulary the rule matched; `{{classLabel}}` is EVENT_KIND_LABELS in
    // the hub language, lowercased for NC (viewer keeps Title Case). Empty
    // class ⇒ empty label, so a system row never invents a noun.
    class: detection?.className ?? (systemEvent !== undefined ? '' : subject.className),
    classLabel: (() => {
      const wire = detection?.className ?? (systemEvent !== undefined ? '' : subject.className)
      return wire.length === 0 ? '' : eventKindLabel(wire, locale).toLocaleLowerCase(locale)
    })(),
    label: detection?.label ?? subject.label ?? '',
    zones: zonesLower.join(', '),
    // COMPOSITES — rendered from their own fragment keys, injected here as
    // plain strings. `renderTemplate` never re-scans a replacement, so these
    // cannot start a second substitution round however they were worded.
    subject:
      detection?.className !== undefined
        ? ncSubjectText(texts, {
            className: detection.className,
            ...(detection.label !== undefined ? { label: detection.label } : {}),
          })
        : // A GROUPED row speaks for several subjects: "Bob, Dave e 1
          // altra persona". Composed, never concatenated — the names, the
          // plurals and the conjunction are all the catalog's.
          //
          // It sits BELOW the combined-alarm branch on purpose: an alarm row
          // speaks the triggering rule's vocabulary about ONE detection, and a
          // group has nothing to add to a panel going off. Gated on the system event
          // too: an alarm row's group (D705) is its PICTURE, and a classless source
          // (a sensor) keeps the alarm's own subject rather than "2 events".
          ((systemEvent === undefined && group !== undefined && group.members.length > 1
            ? ncGroupSubjectText(texts, { members: group.members })
            : undefined) ??
          systemEvent?.subject ??
          ncSubjectText(texts, {
            className: subject.className,
            ...(subject.label !== undefined ? { label: subject.label } : {}),
            ...(subject.labelKind !== undefined ? { labelKind: subject.labelKind } : {}),
          })),
    // `{{detectionSummary}}` — the class composition of a group, so an operator
    // can word their own template as "3 persone su {{camera}}" if they prefer
    // the count to the names. Empty on every ungrouped row, like every other
    // variable that has nothing to say.
    detectionSummary:
      group !== undefined && group.members.length > 1
        ? ncDetectionSummary(texts, classCounts(group.members))
        : '',
    inZones: ncInZonesText(texts, zonesLower),
    // OCCUPANCY scope: a frame-scoped edge carries no zone name, and the camera
    // stands in for it so the body never starts blank (the `{{zone}}` VAR still
    // renders empty there, per the missing-var rule). GATED on occupancy being
    // present — `deviceName` is always truthy, so an unconditional fallback
    // would put the camera name behind `{{scope}}` on every OTHER kind too,
    // duplicating `{{camera}}` under a name the catalog reserves for occupancy.
    scope: occupancy !== undefined ? (occupancy.zone?.toLocaleLowerCase(locale) ?? cameraName) : '',
    // OCCUPANCY: the admin `zones` array is deliberately EMPTY on an occupancy
    // subject (zone scoping lives inside the condition), so the zone name comes
    // off the frozen edge. A frame-scoped edge carries none → renders empty.
    zone: (occupancy?.zone ?? zoneLabels[0] ?? '').toLocaleLowerCase(locale),
    confidence: percentOf(detection?.confidence ?? subject.confidence),
    time: ncClockText(texts.language, subject.timestamp, timeZone),
    // SOUND — what was heard. Empty on every other row, per the missing-var rule.
    sounds: subject.audio?.labels.join(', ') ?? '',
    hitPercent:
      subject.audio?.hitPercent !== undefined ? `${Math.round(subject.audio.hitPercent)}` : '',
    db: subject.audio?.peakDbfs !== undefined ? `${Math.round(subject.audio.peakDbfs)}` : '',
    // DEVICE-EVENT — the device's own token for what happened.
    eventType: subject.eventType ?? '',
    rule: entry.payload.ruleName,
    // The CONFIRMED observed count at the edge vs the rule's configured
    // capacity — two different numbers. Empty on every non-occupancy row.
    // Occupancy's confirmed count, or — on a grouped row — how many subjects
    // the notification is about. They cannot both be present: an occupancy edge
    // carries no track and is therefore never a group member.
    count:
      occupancy !== undefined
        ? `${occupancy.count}`
        : group !== undefined && group.members.length > 1
          ? `${group.members.length}`
          : '',
    capacity: occupancy !== undefined ? `${occupancy.capacity}` : '',
    op: occupancy !== undefined ? ncOccupancyOp(texts, occupancy.occupied) : '',
    // A STATE SUMMARY (D647) is about every kind of its rule at once — no one
    // kind is its event, so the variable is empty on it.
    eventKind:
      systemEvent === undefined || isStateSummaryData(systemEvent.data) ? '' : systemEvent.kind,
    node: systemEvent?.nodeId ?? '',
    package: systemEvent?.packageName ?? '',
    currentVersion:
      typeof systemEvent?.data['currentVersion'] === 'string'
        ? systemEvent.data['currentVersion']
        : '',
    latestVersion:
      typeof systemEvent?.data['latestVersion'] === 'string'
        ? systemEvent.data['latestVersion']
        : '',
    // IN-FLIGHT ROW RESCUE. A system row enqueued before the catalog started
    // naming devices froze `{{deviceId}}` and nothing else, and the sentence it
    // will now be rendered with asks for `{{deviceName}}` — a missing var
    // renders EMPTY by design, so that row would drain as "La camera  è
    // offline". The id is the same last resort the intake uses when a name is
    // unknown, so an old row degrades to exactly the sentence it was written
    // for. Overridden below by a row that froze a real name.
    ...(systemEvent?.deviceId !== undefined ? { deviceName: String(systemEvent.deviceId) } : {}),
    // Same rescue for a node sentence: rows frozen before `{{nodeName}}`
    // existed carry only the id, which is also the name of last resort.
    ...(systemEvent?.nodeId !== undefined &&
    (systemEvent.kind === 'node-online' || systemEvent.kind === 'node-offline')
      ? { nodeName: systemEvent.nodeId }
      : {}),
    // FROZEN at intake, last word on the names it carries: a system event's
    // sentence is about the state of the world at the moment it happened, and
    // the live vocabulary would be answering a different question by the time a
    // held row drains. Absent on every row enqueued before this deploy, and on
    // every row that is not a system event.
    ...systemEventParamsForTemplate(systemEvent?.textParams),
  }
}

/**
 * Which catalog key supplies the DEFAULT body for a row.
 *
 * A system event names its own at intake (the variant selection — profiled or
 * not, agent or worker, on a node or not — happens where the data is, so the
 * catalog stays a flat list of finished sentences). Everything else is
 * occupancy, a closed visit, or a plain detection.
 */
function bodyKeyFor(entry: NcOutboxEntry): string {
  const subject = entry.payload.subject
  // A system-event row without a key is a PRE-CATALOG row. The empty key
  // resolves to nothing, which is exactly what sends `renderText` to the
  // sentence frozen on the row — a system row must never borrow the detection
  // default, which would deliver the rule's name in place of the event.
  if (subject.systemEvent !== undefined) return subject.systemEvent.bodyKey ?? ''
  if (subject.occupancy !== undefined) return 'occupancy.body'
  // A parcel has two halves and they are not the same news. Without this the
  // pick-up rendered word-for-word as the delivery, so the operator read one
  // parcel notified twice. A row with no phase is PRE-CATALOG — it keeps the
  // detection default it was enqueued under.
  if (subject.packagePhase === 'delivered' && subject.packagePossible === true) {
    return 'package.delivered.possible.body'
  }
  if (subject.packagePhase !== undefined) return `package.${subject.packagePhase}.body`
  return entry.recordKind === 'track-end' ? 'detection.body.trackEnd' : 'detection.body'
}

/** A per-section state-summary row's section, as the tap mapping reads it (D708). */
function summarySectionOf(data: Readonly<Record<string, unknown>>): {
  readonly summarySection?: string
} {
  const section = data['section']
  return isStateSummaryData(data) && typeof section === 'string' ? { summarySection: section } : {}
}

/** One text of a row: the authored template, else the catalog key, else the frozen words. */
export interface NcRowTextInput {
  readonly template?: string
  readonly key: string
  readonly vars: Readonly<Record<string, string>>
  readonly count?: number
  readonly frozen?: string
}

/**
 * The one render recipe. A key that resolves wins over the frozen words, so a
 * re-worded catalog reaches an old row too; a key nothing carries falls back
 * to the words the row was born with rather than to nothing.
 */
function renderRowText(texts: NcTextCatalog, input: NcRowTextInput): string {
  const fromTemplate = renderTemplate(input.template, input.vars)
  if (fromTemplate !== null) return fromTemplate
  if (texts.has(input.key)) {
    return texts.text({
      key: input.key,
      vars: input.vars,
      ...(input.count !== undefined ? { count: input.count } : {}),
    })
  }
  return input.frozen ?? ''
}

/**
 * The TITLE a row is sent with — the dispatcher's and history's one recipe
 * (D708: history rendered `{{rule}}: {{summaryCount}}` from the frozen params
 * alone and showed ": 17" for a summary the phone titled "Stato: 17").
 *
 * D706: an alarm rule's push during an intrusion is titled with WHERE, never
 * with the rule's name or its authored title — the title is the one line a
 * lock screen keeps.
 */
export function renderRowTitle(
  texts: NcTextCatalog,
  entry: NcOutboxEntry,
  vars: Readonly<Record<string, string>>,
): string {
  const systemEvent = entry.payload.subject.systemEvent
  const intrusion = entry.payload.alarmIntrusion
  const count = systemEvent?.textCount
  return renderRowText(texts, {
    template: intrusion !== undefined ? undefined : entry.payload.template?.title,
    key: titleKeyFor(entry),
    vars: intrusion !== undefined ? { ...vars, locations: intrusion.locations.join(', ') } : vars,
    ...(count !== undefined ? { count } : {}),
    frozen: systemEvent?.title ?? entry.payload.ruleName,
  })
}

/** The default TITLE key — same shape, same pre-catalog reasoning. */
function titleKeyFor(entry: NcOutboxEntry): string {
  const systemEvent = entry.payload.subject.systemEvent
  if (systemEvent !== undefined) return systemEvent.titleKey ?? ''
  // D706: an alarm rule's push during the entry delay or after the trigger.
  if (entry.payload.alarmIntrusion !== undefined) return 'alarm.intrusion.title'
  // The rule's own name titles a detection, and for a parcel that name is
  // written for the DELIVERY ("Consegna pacco") — reusing it on the pick-up is
  // what made the second notification unreadable as a pick-up at all.
  const packagePhase = entry.payload.subject.packagePhase
  if (packagePhase === 'delivered' && entry.payload.subject.packagePossible === true) {
    return 'package.delivered.possible.title'
  }
  if (packagePhase !== undefined) return `package.${packagePhase}.title`
  return 'detection.title'
}

/**
 * The attachments a row was CREATED with, in order.
 *
 * Url-only by construction: the bytes were never in this process (a timelapse
 * is rendered by the recorder and republished on the artifact plane), and a
 * durable outbox row must never carry an mp4. The degrade engine turns this
 * into an upload for a bytes-only backend and a plain link for a url-mode one
 * — which is the whole reason a url-mode target now receives the video at all.
 */
function frozenArtifactAttachments(entry: NcOutboxEntry): readonly NcNotificationAttachment[] {
  // `artifacts` (plural) is what a row written since the timelapse gained its
  // preview carries; `artifact` is the single-media shape rows enqueued before
  // that deploy still hold, and it is read — not migrated — because an outbox
  // row is durable and one waiting on an unreachable target would otherwise
  // lose its video on the way through.
  const frozen = entry.payload.artifacts ?? toList(entry.payload.artifact)
  return frozen.map((artifact) => ({
    mediaType: artifact.mediaType,
    url: artifact.url,
    mime: artifact.mime,
    name: artifact.name,
  }))
}

/** `x | undefined` → `[x] | []`, so the legacy read has no branch of its own. */
function toList<T>(value: T | undefined): readonly T[] {
  return value === undefined ? [] : [value]
}

/**
 * THE picture this send is about to carry, as the analyst's frame list.
 *
 * BYTES, specifically — the confirm gate's rule, for the same reason: an
 * attachment may be a URL the centre never held (the timelapse artifact shape),
 * and a model cannot look at a link. Empty when the notification ships
 * text-only, which is what SKIPS the pass.
 */
function shippedFrames(notification: NcNotificationInput): readonly NcRuleAiFrame[] {
  const image = notification.attachments?.find(
    (a) => a.mediaType === 'image' && a.bytes !== undefined && a.bytes.byteLength > 0,
  )
  const bytes = image?.bytes
  if (bytes === undefined) return []
  return [{ bytes, mime: image?.mime ?? 'image/jpeg' }]
}

// ── What the delivered line reports ─────────────────────────────────

/** The kinds that actually left, in the order the notification carries them. */
function attachedKinds(
  attachments: ReadonlyArray<NcNotificationAttachment> | undefined,
): readonly NcAttachmentKindLabel[] {
  return (attachments ?? []).map((a) => (a.mediaType === 'image' ? 'still' : a.mediaType))
}

/**
 * What the RULE asked for and this delivery did not carry.
 *
 * Read off the frozen payload, not off any in-flight state: the row says what
 * the operator configured, so the difference is exactly the promise that was
 * not kept. Empty is the normal case and is omitted from the line entirely.
 */
function droppedKinds(
  entry: NcOutboxEntry,
  shipped: readonly NcAttachmentKindLabel[],
): readonly NcAttachmentKindLabel[] {
  const wanted: NcAttachmentKindLabel[] = []
  if (entry.payload.media !== 'none') wanted.push('still')
  if (entry.payload.mediaGif === true) wanted.push('gif')
  if (entry.payload.mediaClip === true) wanted.push('video')
  return wanted.filter((kind) => !shipped.includes(kind))
}

// ── Per-target passthrough params ───────────────────────────────────

interface RecognizedParams {
  readonly level?: string
  readonly sound?: string
  readonly clickUrl?: string
  readonly ttl?: number
}

function pickParams(params: Readonly<Record<string, unknown>> | undefined): RecognizedParams {
  if (params === undefined) return {}
  const out: { level?: string; sound?: string; clickUrl?: string; ttl?: number } = {}
  if (typeof params['level'] === 'string') out.level = params['level']
  if (typeof params['sound'] === 'string') out.sound = params['sound']
  if (typeof params['clickUrl'] === 'string') out.clickUrl = params['clickUrl']
  if (typeof params['ttl'] === 'number' && Number.isFinite(params['ttl'])) out.ttl = params['ttl']
  return out
}

function paramNumber(
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const v = params?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function clampPriority(priority: number): number {
  return Math.max(1, Math.min(5, Math.round(priority)))
}

/**
 * A copy backed by its own `ArrayBuffer`.
 *
 * The attachment types demand `Uint8Array<ArrayBuffer>`, and a view handed over
 * by an assembler may sit on a shared buffer. Copying is cheap next to the
 * encode that produced it and removes a whole class of aliasing question.
 */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  return out
}

/** One still attachment as `resolveAttachments` builds it. */
interface NcResolvedImage {
  readonly mediaType: 'image'
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mime: string
  readonly name: string
}

/**
 * A stored file's base64 as bytes backed by their OWN `ArrayBuffer`, or `null`
 * when it decodes to nothing (a blank picture is never a picture).
 *
 * The copy is the point: a pooled `Buffer` view throws `Trying to deserialize
 * unknown typed array` on the far side of a transport, and the attachment and
 * frame types both demand `Uint8Array<ArrayBuffer>`.
 */
function decodeStillBytes(base64: string): Uint8Array<ArrayBuffer> | null {
  const raw = Buffer.from(base64, 'base64')
  return raw.byteLength === 0 ? null : copyBytes(raw)
}
