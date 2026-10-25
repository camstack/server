/**
 * NcOutbox — the durable delivery outbox of the Notification Center (D8:
 * a missed notification is a bug, so the trigger→delivery handoff is a
 * persisted row, never a bus event).
 *
 * State machine (per row):
 *
 *   enqueue ──▶ pending ──deliver ok──────────────▶ sent          (terminal)
 *                  │
 *                  ├─deliver fail (permanent)─────▶ dead          (terminal)
 *                  │
 *                  └─deliver fail (transient)──┐
 *                        attempts < max        │ attempts ≥ max
 *                        nextAttemptAt =       ▼
 *                        now + backoff       dead                 (terminal)
 *                        (stays pending)
 *
 * Backoff: `baseMs · 2^(attempts-1)` capped at `capMs` (defaults 5 s → 5 min,
 * 8 attempts). Rows are keyed by the DEDUP id `(ruleId, dedupRef, targetId)`
 * — for immediate rules `dedupRef` is the trackId, which IS the durable
 * `maxPerTrack: 1` guarantee (D-3): re-enqueueing the same (rule, track,
 * target) is a silent no-op whatever the row's status. A record keyed on a
 * reusable event ROWID carries its generation instead (D694). The id is built
 * ONLY in `outbox-key.ts`.
 *
 * Boot watermark: `getWatermark`/`setWatermark` persist the last-processed
 * persist-moment timestamp (meta collection). On start the owner scans
 * records newer than the watermark and re-evaluates them — idempotent
 * thanks to the dedup key — closing the crash gap between a record's
 * persist and its outbox insert.
 */

import type {
  IScopedLogger,
  NcConfirmExpect,
  NcMediaImage,
  NcSystemEventKind,
  RecordKindHandle,
} from '@camstack/types'
import type { DurableLedgerBody } from '../durable/durable-record-body.js'
import type { DurableKindDeps } from '../durable/durable-wiring.js'
import { collectRecordPages, RANGE_FLOOR } from '../durable/query-pages.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'
import type { NcRuleAiLanguage, NcRuleAiShape } from './rule-ai.js'
import type { NcPackagePhase, NcRuleFireRef } from './rule-engine.js'
import type { NcOutboxGroup } from './grouped/grouped-payload.js'
import type { NcLastRunRead, NcLastRunRow } from './rule-last-runs.js'
import {
  hasRecordTimestamp,
  isSameOutboxRecord,
  legacyOutboxEntryId,
  type NcOutboxSupersedeInput,
  outboxEntryId,
  outboxRecordIdentity,
  translatedLegacyEntryId,
} from './outbox-key.js'

/**
 * @durable class=ledger owner=notification-center database=events
 *   write="one row per (rule, dedupRef, target) the evaluator matched, inserted in the
 *     same persist moment as the triggering record and re-enqueued as a silent no-op
 *     thereafter; every delivery attempt rewrites it (status, attempts, nextAttemptAt,
 *     lastError, confirm verdict)"
 *   retention="delivery does NOT remove a row — success flips it to 'sent' and history is
 *     a read-only view over the same table. Only two things delete: the boot pass
 *     `pruneBefore(now - 7d)` in `NotificationCenter.start`, which drops TERMINAL
 *     (sent/dead) rows older than 7 days, ≤5,000 per pass and only at boot; and
 *     `supersede`, which drops still-PENDING rows an alarm's combined delivery replaced.
 *     A pending row is never aged out — it retries to `dead` (8 attempts) first."
 */
export const NC_OUTBOX_COLLECTION = 'notification-center:outbox'

/**
 * The bound on one recent-rows read (`tryQueryRecentPersisted`: the boot hydration and the
 * cooldown reseed). Newest first, so a read that hits it drops the OLDEST rows — and says so.
 */
export const NC_OUTBOX_RECENT_QUERY_LIMIT = 10_000

/**
 * @durable class=ledger owner=notification-center
 *   write="one row, key `watermark`: the boot-reconcile cursor. Advanced to `now` at the
 *     end of every `reconcile()` (each boot) and every 15th drain tick (~30 s) while
 *     evaluation is live — while this node is alive every persisted record has already
 *     been evaluated in-process, so `now` is correct"
 *   retention="none — one fixed key, overwritten in place, never deleted. Losing it costs
 *     a bounded re-scan: the reconcile falls back to the 15-minute window and the replay
 *     is idempotent through the outbox dedup id."
 */
export const NC_META_COLLECTION = 'notification-center:meta'
const NC_WATERMARK_KEY = 'watermark'

export type NcOutboxStatus = 'pending' | 'sent' | 'dead'

/** The evaluated record kind an outbox row descends from (one per trigger).
 *  `audio-event` is an INTERNAL engine kind (classified-audio, immediate
 *  delivery) — the durable row records it faithfully; the cap-facing history
 *  projection downgrades it to `object-event` until the wire enum ships. */
export type NcOutboxRecordKind =
  | 'object-event'
  | 'track-end'
  | 'device-event'
  | 'package-event'
  | 'audio-event'
  /**
   * A CONFIRMED audio sampling window (`audio-rule-matcher.ts`) — sustained
   * sound, not one classified sample. Internal for the same reason
   * `audio-event` is: `NcHistoryRecordKindSchema` does not carry it, so the
   * cap-facing history projection downgrades it while the durable row keeps
   * the true kind.
   */
  | 'audio-window'
  | 'system-event'
  /**
   * A scheduled timelapse for one camera and one CLOSED schedule window.
   *
   * Internal, like `audio-event`: `NcHistoryRecordKindSchema` does not carry
   * it, so the cap-facing history projection downgrades it (see
   * `notification-center/index.ts`). The durable row keeps the true kind — the
   * alternative is a row that lies about what produced it, which is the one
   * thing this table exists to prevent.
   */
  | 'timelapse'
  /**
   * A multi-camera DIGEST for one closed window of one summary rule.
   *
   * Internal for the same reason as `timelapse`, and CROSS-CAMERA unlike every
   * other kind here: one row per target, never one per camera. The row's
   * `deviceId` is the rule's first camera — a filing address, not a subject.
   */
  | 'ai-summary'
  /**
   * A scheduled calendar-events digest for one closed schedule window.
   * Internal like `timelapse` / `ai-summary`; files under the system device.
   */
  | 'calendar-events'

/**
 * OCCUPANCY: the count-edge slice frozen onto the payload subject at enqueue —
 * the source of the dispatcher's `{{zone}}`/`{{count}}`/`{{capacity}}` template
 * vars. Present ONLY on rows descending from an occupancy edge.
 *
 * `count` is the CONFIRMED observed count at the edge; `capacity` is the RULE's
 * own `occupancy.count` threshold — two different numbers. `capacity` is frozen
 * from the rule (not from the edge's key threshold) because a `<=C` rule keys on
 * threshold `C+1`, so the key threshold is NOT the operator-configured capacity.
 *
 * `zone` is the occupancy zone NAME: the admin `zones` array is deliberately
 * empty on an occupancy subject (zone scoping lives inside the condition), so
 * the zone name has to ride here. Absent for a frame-scoped edge.
 */
export interface NcOutboxOccupancySubject {
  readonly zone?: string
  readonly count: number
  readonly capacity: number
  readonly occupied: boolean
}

/**
 * SOUND: what was heard, frozen at intake — the source of the dispatcher's
 * `{{sounds}}` / `{{hitPercent}}` / `{{db}}` template vars. Present ONLY on
 * rows descending from an `audio-window` subject (`NcAudioWindowSubject`,
 * `rule-engine.ts`).
 *
 * `hitPercent` is LEVEL mode only (a LABEL-mode confirmation names labels,
 * never a window share) — absent there, per the missing-var rule.
 */
export interface NcOutboxAudioSubject {
  readonly labels: readonly string[]
  /** Level mode only. */
  readonly hitPercent?: number
  readonly peakDbfs?: number
}

/**
 * AI CONFIRM: the gate's policy, frozen from the rule at enqueue.
 *
 * Its PRESENCE is what switches the gate on — `enabled` is not carried,
 * because a row that says "gate: off" and a row with no gate are the same
 * delivery and only one of them needs a field. Every knob is optional: a row
 * enqueued before a knob existed reads it as the gate's own fallback rather
 * than as zero.
 */
export interface NcOutboxConfirmPolicy {
  readonly profileId?: string
  readonly prompt?: string
  readonly expect?: NcConfirmExpect
  readonly timeoutMs?: number
  readonly onTimeout?: 'fire' | 'suppress'
  readonly maxImagePx?: number
}

/**
 * AI NARRATION: the analyst's policy, frozen from the rule at enqueue.
 *
 * The sibling of {@link NcOutboxConfirmPolicy} and it obeys the same two rules:
 * its PRESENCE is what switches the pass on (`enabled` is not carried — a row
 * that says "ai: off" and a row with no ai are the same delivery), and every
 * knob is optional so a row enqueued before a knob existed reads it as the
 * analyst's own fallback rather than as zero.
 *
 * `shape` is the exception and is REQUIRED: it says which of the three
 * questions this row is worth asking, it is derived from the row itself
 * (`rule-ai-policy.ts`), and a row that could not say would have to guess.
 *
 * `maxWords` is absent whenever the operator did not author one — the default
 * belongs to the delivery TARGET, and one row fans out to targets with
 * different budgets, so it can only be resolved at send time.
 */
export interface NcOutboxAiPolicy {
  readonly shape: NcRuleAiShape
  readonly profileId?: string
  readonly prompt?: string
  readonly language?: NcRuleAiLanguage
  readonly maxWords?: number
  readonly maxImagePx?: number
  readonly timeoutMs?: number
  /** OCCUPANCY only: the count the notification CLAIMS — what the model is
   *  asked to agree or disagree with. */
  readonly claimedCount?: number
  /** OCCUPANCY only: the zone the count is about, when the edge had one. */
  readonly zone?: string
}

/** One camera's still on a linked-set sensor row (ADR 0632) — the owner, and
 *  the camera the shelf photographed for it. */
export interface NcLinkedCameraStill {
  /** The linked-camera shelf owner that serves the picture. */
  readonly ownerId: string
  /** The camera the shelf photographed for that owner. */
  readonly cameraId: number
}

/**
 * What the gate DECIDED, written back onto the durable row after the fact.
 *
 * The audit half of the feature: "why did I not get a notification at 04:12"
 * is answerable from SQLite instead of from a log line that has since rotated,
 * and `failOpen` distinguishes "the model looked and disagreed" from "the
 * model never answered" — which the delivery outcome alone cannot.
 */
export interface NcOutboxConfirmVerdict {
  readonly decision: 'confirmed' | 'suppressed' | 'failed-open'
  readonly reason: string
  /** Present when no usable verdict was obtained, naming WHY. */
  readonly failOpen?: 'timeout' | 'error' | 'no-image' | 'busy' | 'unparseable'
  readonly count?: number
  readonly model?: string
  /**
   * A GROUPED row is judged tile by tile (D692 §6.2 item 9): what each tile's judgement came
   * to before the pass settled. Absent on every other row.
   */
  readonly tiles?: NcConfirmTileCounts
  /** On a grouped row, the WHOLE pass (every tile it judged), never one tile's call. */
  readonly latencyMs: number
  readonly at: number
}

/**
 * One grouped confirm pass, counted per tile (D692). The five are disjoint except `untried`,
 * which is ALSO counted in `noAnswer` (row `onTimeout: 'suppress'`) or in `unjudged`
 * (fail-open, the default): a tile the pass budget left no time for is a no-answer like any
 * other, and the row's own no-answer policy decides which.
 */
export interface NcConfirmTileCounts {
  /** The gate said yes — the first one ends the pass. */
  readonly confirmed: number
  /** The model ANSWERED no. */
  readonly rejected: number
  /** No answer, and the row's policy (`onTimeout: 'suppress'`) makes a no-answer suppress. */
  readonly noAnswer: number
  /** No answer that fails open: the gate failed open on the tile, or threw. */
  readonly unjudged: number
  /** Never asked: the pass budget (`confirm.timeoutMs`) was spent before the tile's turn. */
  readonly untried: number
}

/** The notification intent snapshot frozen at enqueue time. */
// The grouped payload's shapes live with their one reader (D692).
export type {
  NcGroupView,
  NcOutboxGroup,
  NcOutboxGroupLegacy,
  NcOutboxGroupMemberV2,
  NcOutboxGroupV2,
} from './grouped/grouped-payload.js'

/** What an intrusion push names (D706): the distinct locations of the devices that matched. */
export interface NcOutboxAlarmIntrusion {
  readonly locations: readonly string[]
}

export interface NcOutboxPayload {
  readonly ruleName: string
  readonly delivery:
    | 'immediate'
    | 'track-end'
    | 'device-event'
    | 'package-event'
    | 'system-event'
    /** Fired on a SCHEDULE BOUNDARY, not on a persisted record. `NcDelivery`
     *  is frozen, so this is internal-only and projected down for the cap. */
    | 'timelapse'
    /** Fired when a digest WINDOW closes and its tracks have settled. Internal
     *  and projected down for the cap, exactly like `timelapse`. */
    | 'ai-summary'
    /** Fired on a schedule boundary with upcoming calendar events. Internal. */
    | 'calendar-events'
  /**
   * The row came from an operator-injected SYNTHETIC event (the rule tester),
   * not from a persisted pipeline/sensor record.
   *
   * Frozen here and nowhere else, and only when true — an absent field is the
   * ordinary case, so every row written before the tester existed still reads
   * exactly as it did. Nothing in the delivery path branches on it: the
   * dispatcher, the degrade engine and the notifier see an ordinary row, which
   * is the whole point of testing through them. It exists so that a support
   * question three weeks later ("did I really get a notification at 04:12?")
   * has an answer in the durable record rather than in someone's memory.
   */
  readonly synthetic?: true
  readonly priority: number
  readonly template?: { readonly title?: string; readonly body?: string }
  /**
   * `'none'` = this row ships no still. Any other value means it does; WHAT the
   * still shows is {@link mediaImage} (D897). Rows written before D897 carry
   * the legacy attach policy here and no `mediaImage` — `payloadImageMode`
   * reads both.
   */
  readonly media: 'best' | 'best-matching' | 'keyFrame' | 'none'
  /**
   * D897: how the still is rendered from the clean source frame — frozen from
   * the rule's `media.image` at enqueue. Absent on a row written before D897.
   */
  readonly mediaImage?: NcMediaImage
  /**
   * D897: draw the zones in {@link triggerZoneIds} on the picture (a scene
   * mode only). Frozen only when the rule asked AND its trigger is a zone.
   */
  readonly mediaShowTriggerZone?: true
  /**
   * D903: draw the subject's path on the picture (every mode a subject is
   * drawn on, a crop included). Frozen when the rule asked and ships a still.
   */
  readonly mediaShowSubjectPath?: true
  /** LEGACY — read, never written (D897). Zone ids a pre-D897 `zoneCrop` row
   *  cropped to; `payloadImageMode` reads it as `clean` + the zone drawn. */
  readonly mediaZoneIds?: readonly string[]
  /**
   * THE ZONES THAT FIRED THIS ROW — frozen at enqueue from the rule's zone
   * condition, whether or not `zoneCrop` was asked for.
   *
   * The still ladder narrows to the frames whose subject was inside one of
   * them (`trigger-zone-still.ts`): a rule named "Persona su Uscio" whose
   * picture shows the person on the road is a notification that lies about its
   * own reason, and it happened on 17% of that rule's live fires. Distinct from
   * {@link mediaZoneIds}, which says "cut the picture down to this zone" —
   * this one says "the picture must be ABOUT this zone".
   *
   * Absent on every row a zone-less rule produced, and on every row written
   * before this field, so both read exactly as before.
   */
  readonly triggerZoneIds?: readonly string[]
  /**
   * The zone(s) of {@link triggerZoneIds} THIS event actually triggered — the
   * subject's membership plus the zone it crossed, at the instant the rule
   * matched. The only zones the {@link mediaShowTriggerZone} overlay draws:
   * a rule on Aiuola OR Uscio whose dog was in Uscio outlines Uscio alone.
   * Absent on a zone-less rule and on a row written before the field; an
   * overlay row without it draws no zone (never all of them).
   */
  readonly matchedZoneIds?: readonly string[]
  /** LEGACY — read, never written (D897): a pre-D897 row's frame choice,
   *  mapped by `payloadImageMode`. */
  readonly mediaFrame?: 'cropped' | 'full' | 'boxed'
  /** Attach a GIF cut from the broker's clip ring around the subject timestamp. */
  readonly mediaGif?: boolean
  /** Rule asked for an MP4 clip too (best-effort, like the gif). */
  readonly mediaClip?: boolean
  /** Stream profile to cut footage from. Absent = the cheapest assigned. */
  readonly mediaProfile?: string
  readonly mediaClipPreRollSec?: number
  /** Playback rate for the attached gif / clip. Absent = the broker's 2x. */
  readonly mediaClipSpeed?: number
  readonly mediaClipPostRollSec?: number
  /**
   * The matched-condition ids frozen at enqueue (from the rule evaluation) —
   * the `best-matching` media policy reads this to attach the media that
   * explains WHY the rule fired (`identities` → face crop, `plates` → plate
   * crop). Absent when the rule carried no conditions. Never changes after
   * enqueue, like {@link ruleName}.
   */
  readonly matchedOn?: readonly string[]
  /**
   * The GROUPED window this row speaks for (D692): the v2 shape a grouped close writes,
   * or a D143 burst revision still pending at deploy (read, never written). Absent on every
   * row of a non-grouped rule. Every read goes through `readOutboxGroup`
   * (`grouped/grouped-payload.ts`); the push carries no `tag`.
   */
  readonly group?: NcOutboxGroup
  /**
   * D706: this alarm rule's push went out while the alarm was in its entry delay or had
   * triggered. Its TITLE is the intrusion line naming these locations (`alarm.intrusion.title`)
   * in place of the rule's name or authored title; the body is unchanged. Frozen at enqueue —
   * a location renamed later does not rewrite what the alarm said. Absent on every other row.
   */
  readonly alarmIntrusion?: NcOutboxAlarmIntrusion
  /**
   * ALREADY-PUBLIC links to media this row was created with, attached
   * verbatim by the dispatcher, IN ORDER — the image first, so a notifier that
   * shows only one attachment shows the picture.
   *
   * Distinct from every other media field here: those name a POLICY the
   * dispatcher resolves against the media store at send time (D-3 "best media
   * available at the moment"), because an event's crops keep landing after the
   * row is written. A timelapse has no such story — the video is finished
   * before the row exists and will never improve — so the row names the
   * artefact itself.
   *
   * A URL and never bytes: this payload is durable JSON rewritten on every
   * delivery attempt, and an mp4 on it would be a multi-megabyte row.
   */
  readonly artifacts?: ReadonlyArray<{
    readonly mediaType: 'image' | 'gif' | 'video'
    readonly url: string
    readonly mime: string
    readonly name: string
  }>
  /**
   * LEGACY single artifact — read, never written.
   *
   * {@link NcOutboxPayload.artifacts} replaced it when a timelapse gained its
   * preview still, and outbox rows are DURABLE: a row enqueued before the
   * deploy is still in SQLite waiting for its target to come back. Dropping
   * this would silently strip the video off exactly those rows. New rows carry
   * `artifacts`; this key disappears on its own once the last old row drains.
   */
  readonly artifact?: {
    readonly mediaType: 'image' | 'gif' | 'video'
    readonly url: string
    readonly mime: string
    readonly name: string
  }
  /**
   * Ids of the artefacts (still, then gif, then clip) THIS row's successful
   * delivery indexed in the artefact library (`NcArtifactIndex`) — a
   * REFERENCE, never the bytes. Written back onto the row by
   * {@link NcOutbox.attempt} from the `NcDeliverResult` the dispatcher
   * returned for the attempt that actually shipped, exactly like
   * {@link confirmVerdict}: one write path, so history can never name an
   * artefact a delivery did not produce.
   *
   * Absent on: a row still pending/dead, a row delivered before this field
   * shipped, a wiring with no artefact index configured, or a delivery whose
   * media resolve found nothing to attach. `getHistory` projects it straight
   * through as `NcHistoryEntry.artifactIds`; resolving an id to a fetchable
   * URL is a SEPARATE call (`notificationRules.resolveArtifactUrl`) — an id
   * outlives the URL's own TTL, and a caller that wants a fresh link mints
   * one on demand rather than trusting one frozen at delivery time.
   */
  readonly artifactIds?: readonly string[]
  /** AI CONFIRM policy — see {@link NcOutboxConfirmPolicy}. Absent = no gate. */
  readonly confirm?: NcOutboxConfirmPolicy
  /** AI NARRATION policy — see {@link NcOutboxAiPolicy}. Absent = no pass, and
   *  the body is byte-for-byte what it was before the feature existed. */
  readonly ai?: NcOutboxAiPolicy
  /** The gate's verdict, written back after it ran. Absent = it has not. */
  readonly confirmVerdict?: NcOutboxConfirmVerdict
  /**
   * The cooldown window this fire CONSUMED, frozen only when a confirm gate
   * could later cancel the delivery.
   *
   * A suppressed notification must not leave the camera silent for the
   * cooldown it never used — the next subject would be swallowed by a window
   * opened for a subject the model rejected. The instant is carried alongside
   * the key so the rollback can refuse to touch a window a LATER fire has
   * since opened.
   */
  readonly cooldown?: { readonly key: string; readonly at: number }
  /**
   * D692 §3.6: a GROUPED row stamps one cooldown key per member class at its close; this
   * is the list of those stamps, frozen (like {@link cooldown}) only when a confirm gate
   * could later cancel the delivery. The rollback restores each key only if no LATER fire
   * has replaced it (Task 13).
   */
  readonly cooldowns?: readonly NcCooldownStamp[]
  /** Per-target passthrough params from the rule target. */
  readonly params?: Readonly<Record<string, unknown>>
  readonly subject: {
    readonly deviceId: number
    readonly trackId?: string
    /**
     * SENSOR rows of a linked set in `each` mode (ADR 0632): the other cameras'
     * stills, in camera order, after {@link trackId}'s — each with the camera
     * the shelf PHOTOGRAPHED, carried rather than inferred from its index (a
     * mute between capture and evaluation shifts {@link linkedCameraIds}).
     * They ship after the primary's still AND footage, in whatever room the
     * target has left. Absent everywhere else.
     */
    readonly extraStills?: readonly NcLinkedCameraStill[]
    /**
     * SENSOR rows of a linked set (ADR 0632): the raw per-camera stills the
     * AI narration reads, in camera order, each with its camera — never the
     * composed mosaic (D154's reason: a composite is a worse input than its
     * parts). Absent everywhere else.
     */
    readonly analysisTiles?: readonly NcLinkedCameraStill[]
    /** SENSOR rows of a linked set: every camera the row shows, primary first. */
    readonly linkedCameraIds?: readonly number[]
    readonly eventId?: string
    readonly className: string
    readonly label?: string
    /**
     * WHAT {@link label} is, when the pipeline said so — a recognised person or
     * a read plate. It picks the SENTENCE: "Alice è arrivato" and "Veicolo
     * AB123CD" are different catalog keys, and one `{{label}}` slot cannot word
     * both. Absent on a sub-class, an unattributed legacy label, and every row
     * written before this field.
     */
    readonly labelKind?: 'identity' | 'plate'
    readonly confidence?: number
    readonly zones: readonly string[]
    readonly timestamp: number
    /**
     * WHEN THE CHANGE HAPPENED, frozen at enqueue, when the source could date
     * it earlier than {@link timestamp} (occupancy edges — see
     * `NcRuleSubject.observedAt`). The footage cut is anchored on it
     * (`media-anchor.ts`), so it has to survive the outbox: a row may drain a
     * retry later and must still ask for the window it was written for.
     *
     * Absent on every row written before this field and on every source that
     * cannot date its own change — which the anchor reads as UNKNOWN and
     * answers with `timestamp`, out loud.
     */
    readonly observedAt?: number
    /** OCCUPANCY rows only — see {@link NcOutboxOccupancySubject}. */
    readonly occupancy?: NcOutboxOccupancySubject
    /**
     * PACKAGE rows only: which half of the parcel's life this row is.
     *
     * It picks the SENTENCE. Without it both phases rendered through
     * `detection.title` / `detection.body`, so a pick-up arrived titled with
     * the delivery rule's own name and worded identically to the delivery —
     * the operator read his two notifications as the same one sent twice
     * (2026-09-08). Absent on every row enqueued before this field, which is
     * why the dispatcher still falls back to the detection keys: a durable row
     * must drain with the words it was written for.
     */
    readonly packagePhase?: NcPackagePhase
    /**
     * PACKAGE rows only: the delivery was not confirmed by the vision model.
     * Picks the "possible" sentence. Absent on every row written before this
     * field, which keeps the ordinary delivery words.
     */
    readonly packagePossible?: boolean
    /** SOUND rows only: what was heard, frozen at intake for `{{sounds}}`,
     *  `{{hitPercent}}` and `{{db}}`. */
    readonly audio?: NcOutboxAudioSubject
    /** DEVICE-EVENT rows only: the device's raw event token (`press`, `open`),
     *  for `{{eventType}}`. Absent when the device sends none. */
    readonly eventType?: string
    /** Infrastructure/liveness/update event normalized at intake. */
    readonly systemEvent?: {
      readonly kind: NcSystemEventKind
      readonly subject: string
      /** Catalog keys + their params, frozen at intake — see
       *  `NcSystemEventSubject` (rule-engine.ts) for why the key and not the
       *  sentence. */
      readonly titleKey?: string
      readonly bodyKey?: string
      readonly textParams?: Readonly<Record<string, string>>
      /** LEGACY frozen sentences on rows enqueued before the catalog. Read,
       *  never written — a durable row must not drain blank. */
      readonly title?: string
      readonly body?: string
      /** The count the sentence pluralises on, frozen at intake. Absent on
       *  every sentence that does not count anything. */
      readonly textCount?: number
      /** `alarm-triggered` rows the pipeline set off — see
       *  {@link NcRuleFireRef}. Its presence is what makes this row the
       *  COMBINED delivery: alarm words, the triggering rule's pictures. */
      readonly alarmSource?: NcRuleFireRef
      /** The incident's other subjects (D705) — see `NcSystemEventSubject`. */
      readonly alarmFollowers?: readonly NcRuleFireRef[]
      readonly deviceId?: number
      /**
       * The device's `DeviceType` at intake. Frozen here — not looked up at
       * delivery — because the row may drain days later, by which time the
       * device can have been deleted; and because a cap mount may not compose
       * addon output with backend state (CLAUDE.md). The tap URL reads it to
       * decide whether the device page's Stream Broker tab is a tab this
       * device even has (`system-event-tap-url.ts`).
       *
       * Absent on a row enqueued before the intake stamped it, and on a device
       * the mirror could not name. Absence means "not known to be a camera",
       * never "not a camera".
       */
      readonly deviceType?: string
      readonly nodeId?: string
      readonly packageName?: string
      /**
       * Every node / package the row names, when the intake batched more than
       * one — the same two fields `NcSystemEventSubject` carries.
       *
       * Declared here to be READ BACK, exactly as `deviceType` was (D305): the
       * enqueue spreads the whole `systemEvent` onto the payload, so live rows
       * have carried both since the batching intake landed and nothing
       * migrates. `packageNames` is what the "apply these updates" button
       * applies; `nodeId` (singular, above) is what makes it mintable at all.
       */
      readonly nodeIds?: readonly string[]
      readonly packageNames?: readonly string[]
      readonly data: Readonly<Record<string, unknown>>
    }
  }
}

export interface NcOutboxEntry {
  readonly id: string
  readonly ruleId: string
  readonly targetId: string
  readonly deviceId: number
  readonly recordKind: NcOutboxRecordKind
  readonly recordId: string
  readonly trackId?: string
  readonly status: NcOutboxStatus
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastError?: string
  readonly payload: NcOutboxPayload
}

/** Enqueue input — everything but the lifecycle bookkeeping. */
export interface NcOutboxEnqueueInput {
  readonly ruleId: string
  readonly targetId: string
  readonly deviceId: number
  readonly recordKind: NcOutboxRecordKind
  readonly recordId: string
  readonly trackId?: string
  /**
   * Override the dedup key's middle segment. Absent = `trackId ?? recordId`,
   * which is the `maxPerTrack: 1` guarantee and stays the default for every
   * ordinary fire.
   *
   * It exists for a notification that speaks for MORE than one track: a grouped window
   * (D692) is keyed by its `windowKey`, so a replay of the same window after a respawn
   * lands on the same id and is swallowed by the guarantee that makes the first send
   * exactly-once. Bounded: ONE row per (rule, window, target).
   */
  readonly dedupRef?: string
  readonly payload: NcOutboxPayload
}

/** One cooldown window a fire consumed: its key and the instant it was stamped. */
export interface NcCooldownStamp {
  readonly key: string
  readonly at: number
}

/** Filter for {@link NcOutbox.queryHistory} (already validated by the cap). */
export interface NcHistoryQuery {
  readonly ruleId?: string
  readonly deviceId?: number
  readonly status?: NcOutboxStatus
  /** Inclusive lower bound on the fire time (`createdAt`, epoch ms). */
  readonly since?: number
  /** Inclusive upper bound on the fire time (`createdAt`, epoch ms). */
  readonly until?: number
  readonly limit: number
}

export type NcDeliverResult =
  /**
   * `confirm` is the AI gate's verdict, carried back so the OUTBOX writes it
   * onto the durable row. The dispatcher has no store and the row is written
   * exactly once per attempt — returning the verdict is how the audit trail
   * gets there without a second write path that could disagree with delivery
   * state (the same reason history is a view over this table and not a
   * separate log).
   *
   * `artifactIds` is the same pattern for the media this attempt indexed —
   * see {@link NcOutboxPayload.artifactIds}.
   */
  | {
      readonly ok: true
      readonly confirm?: NcOutboxConfirmVerdict
      readonly artifactIds?: readonly string[]
    }
  | { readonly ok: false; readonly error: string; readonly permanent: boolean }

export interface NcOutboxDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  /** Delivery executor (the dispatcher). Injected so the outbox stays
   *  transport-agnostic and unit-testable with a fake. */
  readonly deliver: (entry: NcOutboxEntry) => Promise<NcDeliverResult>
  readonly now?: () => number
  readonly backoffBaseMs?: number
  readonly backoffCapMs?: number
  readonly maxAttempts?: number
  /** Max deliveries attempted per drain tick (fairness bound). */
  readonly drainBatchSize?: number
}

const DEFAULT_BACKOFF_BASE_MS = 5_000
const DEFAULT_BACKOFF_CAP_MS = 300_000
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_DRAIN_BATCH = 20
/** Dedup ids remembered at boot — bounded to recent rows (dedup horizon). */
const DEDUP_HYDRATE_WINDOW_MS = 7 * 24 * 3600_000

export class NcOutbox {
  private readonly pending = new Map<string, NcOutboxEntry>()
  /** Every id ever enqueued within the dedup horizon (incl. sent/dead). */
  private readonly knownIds = new Set<string>()
  /** The `outbox` records kind (events.db) — every node reaches it through `ctx.records`. */
  private readonly rows: RecordKindHandle<DurableLedgerBody>
  /** The `meta` records kind (camstack.db): the boot-reconcile watermark. */
  private readonly meta: RecordKindHandle<DurableLedgerBody>
  private readonly logger: IScopedLogger
  private readonly deliver: NcOutboxDeps['deliver']
  private readonly now: () => number
  private readonly backoffBaseMs: number
  private readonly backoffCapMs: number
  private readonly maxAttempts: number
  private readonly drainBatchSize: number
  private drainInFlight = false
  /**
   * Has {@link load} landed?
   *
   * The load moved OFF the boot critical path (see
   * `NotificationCenter.runBootBackfill`), so for the first seconds of a boot
   * the centre evaluates and enqueues with an EMPTY `knownIds` — and
   * `knownIds` is the dedup ledger. Until this flips, {@link enqueue} asks the
   * store itself instead. False is therefore not "the load failed", it is
   * "the horizon is not authoritative yet"; a load that FAILED leaves it false
   * forever, which keeps the per-enqueue guard on, which is exactly right.
   */
  private horizonLoaded = false

  constructor(deps: NcOutboxDeps) {
    this.rows = deps.records.kind(ncDurableRecordKinds.outbox)
    this.meta = deps.records.kind(ncDurableRecordKinds.meta)
    this.logger = deps.logger
    this.deliver = deps.deliver
    this.now = deps.now ?? ((): number => Date.now())
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    this.backoffCapMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.drainBatchSize = deps.drainBatchSize ?? DEFAULT_DRAIN_BATCH
  }

  /**
   * Hydrate pending rows + the dedup id horizon. Best-effort.
   *
   * **Runs OFF the boot critical path** (2026-08-17: 743 rows over the UDS
   * store client, ~50 s, inside the `initialize()` that publishes the runner's
   * capability manifest). So it lands against a centre that has already been
   * evaluating, enqueueing and DELIVERING for as long as the query took — and
   * the rows it is holding are a snapshot taken before all of that.
   *
   * That is why an id this process already knows is SKIPPED rather than
   * applied. `knownIds` is only ever written by an in-process {@link enqueue}
   * or by this method, so an id already in it at apply time is one whose live
   * state (pending, or absent because it went terminal) is strictly newer than
   * the snapshot. Applying the snapshot over it would put a row that has
   * already been DELIVERED back into `pending`, and the operator would receive
   * the same notification twice.
   *
   * Nothing is lost by the same token: this method only ADDS to `pending`, so
   * a row enqueued while the query was in flight is untouched.
   */
  async load(): Promise<void> {
    try {
      const { rows } = await collectRecordPages(
        this.rows,
        { where: { createdAt: { gte: this.now() - DEDUP_HYDRATE_WINDOW_MS } } },
        100_000,
      )
      let superseded = 0
      let translated = 0
      for (const row of rows) {
        const entry = rowToEntry(row.id, row.data)
        // A row written before D694 under the record-id-only spelling: the id
        // it would have today joins the horizon too, so a replay of ITS record
        // (built with today's key) is still a dedup hit — and a different
        // record that reused the rowid is not. The row keeps its stored id.
        const current = entry === null ? null : this.translateLegacy(row.id, entry)
        // See the docblock: this process moved past this id while the query
        // was in flight, and RAM is the authority for it.
        if (this.knownIds.has(row.id) || (current !== null && this.knownIds.has(current))) {
          superseded += 1
          continue
        }
        this.knownIds.add(row.id)
        if (current !== null) {
          this.knownIds.add(current)
          translated += 1
        }
        if (entry !== null && entry.status === 'pending') this.pending.set(entry.id, entry)
      }
      this.horizonLoaded = true
      this.logger.info('notification outbox loaded', {
        meta: { pending: this.pending.size, known: this.knownIds.size, superseded, translated },
      })
    } catch (err) {
      // The horizon stays COLD deliberately — every enqueue keeps asking the
      // store per id, which is slower and correct, rather than silently
      // becoming a centre with no dedup ledger at all.
      this.logger.warn('notification outbox load failed', { meta: { error: String(err) } })
    }
  }

  /** Is the dedup horizon authoritative? See {@link horizonLoaded}. */
  hydrated(): boolean {
    return this.horizonLoaded
  }

  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Durably enqueue a batch of delivery intents. Returns the number of
   * rows actually inserted (dedup-key hits are silent no-ops). Called in
   * the SAME persist moment as the triggering record write.
   */
  async enqueue(inputs: readonly NcOutboxEnqueueInput[]): Promise<number> {
    const now = this.now()
    let inserted = 0
    for (const input of inputs) {
      const id = outboxEntryId(input)
      if (this.knownIds.has(id)) continue
      if (!this.horizonLoaded && (await this.alreadyStored(id, input))) {
        // Not a loss: the row is already there, in whatever state it reached.
        this.knownIds.add(id)
        this.logger.info('outbox enqueue deduped against the store — the horizon is still cold', {
          tags: { deviceId: input.deviceId },
          meta: { id, ruleId: input.ruleId, targetId: input.targetId },
        })
        continue
      }
      const entry: NcOutboxEntry = {
        id,
        ruleId: input.ruleId,
        targetId: input.targetId,
        deviceId: input.deviceId,
        recordKind: input.recordKind,
        recordId: input.recordId,
        ...(input.trackId !== undefined ? { trackId: input.trackId } : {}),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
        payload: input.payload,
      }
      try {
        await this.persist(entry)
        this.knownIds.add(id)
        this.pending.set(id, entry)
        inserted += 1
      } catch (err) {
        // A duplicate-PK race (another enqueue of the same intent) is a
        // dedup hit, not a loss; other errors are logged and the intent
        // recovered by the boot reconcile.
        this.knownIds.add(id)
        this.logger.warn('outbox enqueue persist failed', {
          meta: { id, error: String(err) },
        })
      }
    }
    return inserted
  }

  /**
   * One drain pass: attempt every due pending row (bounded batch,
   * oldest-first). Single-flight — a call while a drain is running
   * returns immediately (the interval picks the rows up next tick).
   */
  async drainOnce(): Promise<void> {
    if (this.drainInFlight) return
    this.drainInFlight = true
    try {
      const now = this.now()
      const due = [...this.pending.values()]
        .filter((e) => e.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, this.drainBatchSize)
      for (const entry of due) {
        await this.attempt(entry)
      }
    } finally {
      this.drainInFlight = false
    }
  }

  /** Rows updated in the last `sinceMs` window — cooldown seeding at boot. */
  listRecentEntries(sinceMs: number): readonly NcOutboxEntry[] {
    return [...this.pending.values()].filter((e) => e.createdAt >= sinceMs)
  }

  /**
   * Recent rows straight from the store (incl. sent), NEWEST first — the boot's notified-set
   * hydration (D692 C9) and cooldown reseed. A read that FAILED is `null`, never an empty
   * list (D393): "the store could not answer" must not read as "nothing was sent". A read
   * that hits {@link NC_OUTBOX_RECENT_QUERY_LIMIT} says so (review T10 LOW-4): the oldest
   * rows were not read.
   */
  async tryQueryRecentPersisted(sinceMs: number): Promise<readonly NcOutboxEntry[] | null> {
    try {
      const { rows } = await collectRecordPages(
        this.rows,
        { where: { createdAt: { gte: sinceMs } }, desc: true },
        NC_OUTBOX_RECENT_QUERY_LIMIT,
      )
      if (rows.length >= NC_OUTBOX_RECENT_QUERY_LIMIT) {
        this.logger.warn('outbox recent query hit its limit — older rows were not read', {
          meta: { limit: NC_OUTBOX_RECENT_QUERY_LIMIT, sinceMs },
        })
      }
      const out: NcOutboxEntry[] = []
      for (const row of rows) {
        const entry = rowToEntry(row.id, row.data)
        if (entry !== null) out.push(entry)
      }
      return out
    } catch (err) {
      this.logger.debug('outbox recent query failed', { meta: { error: String(err) } })
      return null
    }
  }

  /**
   * Query persisted outbox rows as DELIVERY HISTORY — newest-first (by fire
   * time `createdAt`), bounded by `limit`. History is a read-only VIEW over
   * the outbox: the very rows the drain loop drives, in every lifecycle
   * state (pending / sent / dead). There is no second write path, so a
   * history row can never diverge from delivery state.
   *
   * Filters (`ruleId` / `deviceId` / `status` / `since`..`until`) are pushed
   * to the store; the in-memory `pending` map is deliberately NOT consulted
   * (terminal sent / dead rows live only in the store). Best-effort: a store
   * error yields an empty page rather than throwing into the cap call.
   */
  async queryHistory(query: NcHistoryQuery): Promise<readonly NcOutboxEntry[]> {
    // Every combination of the three filters has its own index ending in
    // `createdAt` (`nc-durable-record-kinds.ts`), so the fire time is always
    // the range AND the order: the page is newest-first by construction.
    try {
      const { rows } = await collectRecordPages(
        this.rows,
        {
          where: {
            ...(query.ruleId !== undefined ? { ruleId: query.ruleId } : {}),
            ...(query.deviceId !== undefined ? { deviceId: query.deviceId } : {}),
            ...(query.status !== undefined ? { status: query.status } : {}),
            createdAt: {
              gte: query.since ?? RANGE_FLOOR,
              ...(query.until !== undefined ? { lte: query.until } : {}),
            },
          },
          desc: true,
        },
        query.limit,
      )
      const out: NcOutboxEntry[] = []
      for (const row of rows) {
        const entry = rowToEntry(row.id, row.data)
        if (entry !== null) out.push(entry)
      }
      return out
    } catch (err) {
      this.logger.debug('outbox history query failed', { meta: { error: String(err) } })
      return []
    }
  }

  /**
   * The rows `getRuleLastRuns` reduces: fire time inside `[sinceMs, ∞)`,
   * newest-first on the `created` index, read page by page (a records page
   * carries the whole row; there is no column projection), at most
   * `limit` rows. `sinceMs: null` = no lower bound (the operator keeps the
   * outbox forever); `limit` still bounds the read.
   *
   * Unlike {@link queryHistory} this THROWS on a store error: its caller
   * answers "which rules did not run", and an empty page from a failed read
   * would answer "none of them did" (D393).
   */
  async queryLastRunRows(sinceMs: number | null, limit: number): Promise<NcLastRunRead> {
    const { rows } = await collectRecordPages(
      this.rows,
      { where: { createdAt: { gte: sinceMs ?? RANGE_FLOOR } }, desc: true },
      limit,
    )
    const out: NcLastRunRow[] = []
    let malformed = 0
    // Over the RAW rows, malformed included: the read's reach is what the
    // store returned, not what survived the guard.
    let oldestReadAt: number | null = null
    for (const row of rows) {
      const at = Number(row.data['createdAt'])
      if (Number.isFinite(at) && (oldestReadAt === null || at < oldestReadAt)) oldestReadAt = at
      const parsed = lastRunRow(row.data)
      if (parsed === null) malformed += 1
      else out.push(parsed)
    }
    if (malformed > 0) {
      this.logger.warn('last-run read skipped malformed outbox rows', {
        meta: { malformed, read: rows.length },
      })
    }
    return { rows: out, truncated: rows.length >= limit, oldestReadAt }
  }

  // ── Watermark ─────────────────────────────────────────────────────

  async getWatermark(): Promise<number | null> {
    try {
      const row = await this.meta.get(NC_WATERMARK_KEY)
      const value = row?.data['value']
      if (!isStoredRow(value)) return null
      const ts = value['ts']
      return typeof ts === 'number' && Number.isFinite(ts) ? ts : null
    } catch {
      return null
    }
  }

  async setWatermark(ts: number): Promise<void> {
    try {
      await this.meta.put({ id: NC_WATERMARK_KEY, data: { value: { ts } } })
    } catch (err) {
      this.logger.debug('outbox watermark write failed', { meta: { error: String(err) } })
    }
  }

  /**
   * Drop still-PENDING rows a combined delivery has replaced.
   *
   * The alarm's own row carries the alarm's words AND the triggering rule's
   * pictures, so the rule's own row would be a second push about one incident.
   * Three properties, each of which is why this is not just a delete:
   *
   *  - **Only `pending` rows.** A row already `sent` is a notification the
   *    operator has in their hand; there is nothing to withdraw, and rewriting
   *    it would make history disagree with what was delivered. The caller logs
   *    that case — with an entry delay running, it is the NORMAL one.
   *  - **Only the named targets.** The alarm rule and the detection rule may
   *    address different people. Somebody the alarm never reached must still
   *    get the detection notification they were going to get.
   *  - **The dedup id stays known.** A boot reconcile replaying the same record
   *    must not resurrect the row this replaced.
   *
   * Returns how many rows it dropped. Never throws — a failed supersede costs
   * a duplicate notification, and it must never cost the alarm.
   */
  async supersede(input: NcOutboxSupersedeInput): Promise<number> {
    const wanted = new Set(input.targetIds)
    // The RECORD, not its id alone (D694): a rowid reused by another camera's
    // record must not lose that record's pending notification to this alarm.
    const victims = [...this.pending.values()].filter(
      (e) =>
        e.ruleId === input.ruleId &&
        wanted.has(e.targetId) &&
        hasRecordTimestamp(e.payload) &&
        isSameOutboxRecord(outboxRecordIdentity(e), input),
    )
    let dropped = 0
    for (const entry of victims) {
      try {
        await this.rows.delete(entry.id)
        this.pending.delete(entry.id)
        dropped += 1
      } catch (err) {
        this.logger.warn('outbox supersede failed — the row will deliver on its own', {
          tags: { deviceId: entry.deviceId },
          meta: { id: entry.id, ruleId: entry.ruleId, error: String(err) },
        })
      }
    }
    return dropped
  }

  /** Drop terminal rows older than `cutoffMs` (retention hygiene). */
  async pruneBefore(cutoffMs: number): Promise<number> {
    let pruned = 0
    try {
      const { rows } = await collectRecordPages(
        this.rows,
        { where: { createdAt: { gte: RANGE_FLOOR, lte: cutoffMs } } },
        5_000,
      )
      for (const row of rows) {
        const status = row.data['status']
        if (status !== 'sent' && status !== 'dead') continue
        await this.rows.delete(row.id)
        this.knownIds.delete(row.id)
        pruned += 1
      }
    } catch (err) {
      this.logger.debug('outbox prune failed', { meta: { error: String(err) } })
    }
    return pruned
  }

  // ── internals ───────────────────────────────────────────────────────

  private backoffMs(attempts: number): number {
    return Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.backoffCapMs)
  }

  private async attempt(entry: NcOutboxEntry): Promise<void> {
    let result: NcDeliverResult
    try {
      result = await this.deliver(entry)
    } catch (err) {
      result = { ok: false, error: String(err), permanent: false }
    }
    const now = this.now()
    if (result.ok) {
      const payloadPatch = {
        // The gate's verdict lands on the row it decided about — including
        // when it SUPPRESSED, which is still `ok` (benign, like a snooze). A
        // row that says `sent` with `confirmVerdict.decision: 'suppressed'` is
        // the honest record: the delivery is finished, and it finished by not
        // being sent.
        ...(result.confirm !== undefined ? { confirmVerdict: result.confirm } : {}),
        // The artefact ids THIS attempt's send actually indexed — see
        // `NcOutboxPayload.artifactIds`. Only written when non-empty: an
        // absent field reads as "no media indexed", never as a row that
        // overwrote a previous attempt's ids with nothing.
        ...(result.artifactIds !== undefined && result.artifactIds.length > 0
          ? { artifactIds: result.artifactIds }
          : {}),
      }
      const sent: NcOutboxEntry = {
        ...entry,
        status: 'sent',
        updatedAt: now,
        ...(Object.keys(payloadPatch).length > 0
          ? { payload: { ...entry.payload, ...payloadPatch } }
          : {}),
      }
      this.pending.delete(entry.id)
      await this.mutate(sent)
      return
    }
    const attempts = entry.attempts + 1
    const exhausted = attempts >= this.maxAttempts
    if (result.permanent || exhausted) {
      const dead: NcOutboxEntry = {
        ...entry,
        status: 'dead',
        attempts,
        updatedAt: now,
        lastError: result.error,
      }
      this.pending.delete(entry.id)
      await this.mutate(dead)
      this.logger.warn('outbox entry dead-lettered', {
        tags: { deviceId: entry.deviceId },
        meta: {
          id: entry.id,
          ruleId: entry.ruleId,
          targetId: entry.targetId,
          attempts,
          permanent: result.permanent,
          error: result.error,
        },
      })
      return
    }
    const retry: NcOutboxEntry = {
      ...entry,
      attempts,
      nextAttemptAt: now + this.backoffMs(attempts),
      updatedAt: now,
      lastError: result.error,
    }
    this.pending.set(entry.id, retry)
    await this.mutate(retry)
  }

  /**
   * Cold-horizon dedup: is this intent already a row in the store?
   *
   * Today's id first. Then, for a rowid record, the pre-D694 spelling — which
   * is accepted ONLY when the row found speaks for the SAME record (camera and
   * record timestamp too). A legacy row of a different record that reused the
   * rowid is exactly the collision D694 removes, and must not swallow this one.
   */
  private async alreadyStored(id: string, input: NcOutboxEnqueueInput): Promise<boolean> {
    if (await this.rowExists(id)) return true
    const legacy = legacyOutboxEntryId(input)
    if (legacy === null) return false
    const row = await this.readRow(legacy)
    if (row === null) return false
    if (!hasRecordTimestamp(row.payload)) {
      // A legacy row with no frozen record timestamp cannot be told apart from
      // another record on the reused id, so it dedups nothing (duplicate over
      // lost, as for a failed read).
      this.logger.warn('outbox: a pre-D694 row carries no record timestamp — not used for dedup', {
        tags: { deviceId: row.deviceId },
        meta: { id, legacyId: legacy, ruleId: input.ruleId },
      })
      return false
    }
    if (isSameOutboxRecord(outboxRecordIdentity(row), outboxRecordIdentity(input))) return true
    this.logger.info(
      'outbox: a pre-D694 row shares this rowid but is a different record — not a duplicate',
      {
        tags: { deviceId: input.deviceId },
        meta: { id, legacyId: legacy, legacyDeviceId: row.deviceId, ruleId: input.ruleId },
      },
    )
    return false
  }

  /**
   * The id a stored pre-D694 row would have today, or `null`.
   *
   * Guarded per row: a stored payload is validated only as an object
   * (`rowToEntry`), and a row with no `subject.timestamp` would otherwise throw
   * inside {@link load} and leave the WHOLE dedup horizon cold. Such a row is
   * still loaded under its stored id; it just gets no translated twin.
   */
  private translateLegacy(storedId: string, entry: NcOutboxEntry): string | null {
    if (legacyOutboxEntryId(entry) !== storedId) return null
    if (!hasRecordTimestamp(entry.payload)) {
      this.logger.warn(
        'outbox: a pre-D694 row carries no record timestamp — loaded without translation',
        {
          tags: { deviceId: entry.deviceId },
          meta: { id: storedId, ruleId: entry.ruleId },
        },
      )
      return null
    }
    return translatedLegacyEntryId(storedId, entry)
  }

  /** One stored row by id, or `null` (absent, unreadable, or a failed read). */
  private async readRow(id: string): Promise<NcOutboxEntry | null> {
    try {
      const row = await this.rows.get(id)
      return row === null ? null : rowToEntry(id, row.data)
    } catch (err) {
      this.logger.debug('outbox cold-horizon dedup read failed', {
        meta: { id, error: String(err) },
      })
      return null
    }
  }

  /**
   * Does a row already exist under this dedup id?
   *
   * Asked ONLY while {@link horizonLoaded} is false. {@link persist} writes
   * with `set` — an UPSERT keyed by the dedup id — so an enqueue that ran
   * before the horizon landed would rewrite a row that had already been
   * DELIVERED back to `pending`, and the drain would send it again. That is
   * the D-3 `maxPerTrack: 1` guarantee, and it cannot be allowed to depend on
   * whether a 743-row query had finished.
   *
   * A read that FAILS answers `false`, i.e. the intent is enqueued. Duplicate
   * over lost: a duplicate notification is an annoyance the operator can see,
   * and a dropped one is a notification nobody ever knows was owed.
   */
  private async rowExists(id: string): Promise<boolean> {
    try {
      return (await this.rows.get(id)) !== null
    } catch (err) {
      this.logger.debug('outbox cold-horizon dedup read failed', {
        meta: { id, error: String(err) },
      })
      return false
    }
  }

  private async persist(entry: NcOutboxEntry): Promise<void> {
    await this.rows.put(outboxPut(entry))
  }

  private async mutate(entry: NcOutboxEntry): Promise<void> {
    try {
      await this.rows.put(outboxPut(entry))
    } catch (err) {
      this.logger.debug('outbox row update failed', {
        meta: { id: entry.id, error: String(err) },
      })
    }
  }
}

/** One entry as a records write: the row body plus the camera on the envelope (D865 removal). */
function outboxPut(entry: NcOutboxEntry): {
  readonly id: string
  readonly deviceId: number
  readonly data: Record<string, unknown>
} {
  return { id: entry.id, deviceId: entry.deviceId, data: entryToRow(entry) }
}

/** The row body: the legacy column map, which the adoption mapper reproduces exactly. */
function entryToRow(entry: NcOutboxEntry): Record<string, unknown> {
  return {
    ruleId: entry.ruleId,
    targetId: entry.targetId,
    deviceId: entry.deviceId,
    recordKind: entry.recordKind,
    recordId: entry.recordId,
    ...(entry.trackId !== undefined ? { trackId: entry.trackId } : {}),
    status: entry.status,
    attempts: entry.attempts,
    nextAttemptAt: entry.nextAttemptAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
    payload: entry.payload,
  }
}

/**
 * Every kind a persisted row may carry, for the READ path.
 *
 * This must list the WHOLE union. A kind missing here makes `rowToEntry` answer
 * `null`, and a `null` row is invisible three ways at once: it is not
 * re-hydrated as pending at boot (so a row still queued when the process
 * restarted is dropped on the floor), it never appears in `queryHistory`, and
 * it never appears in the recent-rows scan. `'timelapse'` was missing from this
 * set from the day it shipped — the live deliveries hid it, because an enqueue
 * hands the entry straight to the drain from memory and only a RESTART goes
 * through this function.
 */
const OUTBOX_RECORD_KINDS: ReadonlySet<string> = new Set<NcOutboxRecordKind>([
  'object-event',
  'track-end',
  'device-event',
  'package-event',
  'audio-event',
  'audio-window',
  'system-event',
  'timelapse',
  'ai-summary',
  'calendar-events',
])

function isOutboxRecordKind(x: unknown): x is NcOutboxRecordKind {
  return typeof x === 'string' && OUTBOX_RECORD_KINDS.has(x)
}

/** A stored JSON value is `unknown` — a guard, never a cast. */
function isStoredRow(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** A stored row back to an entry — a guard, never a cast. Exported for the
 *  specs that read the store a centre wrote to. */
export function rowToEntry(id: string, data: Record<string, unknown>): NcOutboxEntry | null {
  const ruleId = data['ruleId']
  const targetId = data['targetId']
  const deviceId = Number(data['deviceId'])
  const recordKind = data['recordKind']
  const recordId = data['recordId']
  const status = data['status']
  const payload = data['payload']
  if (
    typeof ruleId !== 'string' ||
    typeof targetId !== 'string' ||
    !Number.isFinite(deviceId) ||
    !isOutboxRecordKind(recordKind) ||
    typeof recordId !== 'string' ||
    (status !== 'pending' && status !== 'sent' && status !== 'dead') ||
    payload === null ||
    typeof payload !== 'object'
  ) {
    return null
  }
  const trackId = data['trackId']
  const lastError = data['lastError']
  return {
    id,
    ruleId,
    targetId,
    deviceId,
    recordKind,
    recordId,
    ...(typeof trackId === 'string' ? { trackId } : {}),
    status,
    attempts: Number(data['attempts'] ?? 0),
    nextAttemptAt: Number(data['nextAttemptAt'] ?? 0),
    createdAt: Number(data['createdAt'] ?? 0),
    updatedAt: Number(data['updatedAt'] ?? 0),
    ...(typeof lastError === 'string' ? { lastError } : {}),
    // Documented type boundary: the payload JSON round-trips through the
    // settings-store as `unknown`; shape is validated structurally above
    // and consumed defensively by the dispatcher.
    payload: payload as NcOutboxPayload,
  }
}

/** A projected row back to a {@link NcLastRunRow} — a guard, never a cast. */
function lastRunRow(data: Record<string, unknown>): NcLastRunRow | null {
  const ruleId = data['ruleId']
  const createdAt = Number(data['createdAt'])
  const deviceId = Number(data['deviceId'])
  const status = data['status']
  if (
    typeof ruleId !== 'string' ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(deviceId) ||
    (status !== 'pending' && status !== 'sent' && status !== 'dead')
  ) {
    return null
  }
  return { ruleId, createdAt, status, deviceId }
}
