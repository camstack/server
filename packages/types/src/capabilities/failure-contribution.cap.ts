/**
 * `failure-contribution` — the capability an addon reports its OWN losses
 * through, per camera, with the denominator attached. It stores nothing.
 *
 * ## The twin of `load-contribution`, and why it is a twin and not a field
 *
 * `load-contribution` answers *what did this camera COST*. This answers *what
 * did this camera LOSE*. The reporting discipline is identical and deliberately
 * copied: the contributor reports what it already knows, hub-main adds only
 * `addonId`, nothing needs global knowledge, and there is no central list for
 * somebody to forget to edit.
 *
 * They are not merged, because their invariants are opposites:
 *
 *  - a `load-contribution` measurement is **absent, never zero** — a zero would
 *    claim a camera cost nothing, which is a measurement nobody made;
 *  - a `failure-contribution` zero is the **most valuable value on the
 *    surface** — `attempts: 400, succeeded: 400` is the proof a fix landed,
 *    and it is exactly what an absent entry cannot say.
 *
 * Putting a loss counter on a cost entry would also break the reconciliation
 * that gives `load-contribution` its point: contributions are subtracted from
 * `metrics.node-processes-snapshot` to find processes nobody claims. A failure
 * has no process.
 *
 * ## Why not a log line, since the counters already exist
 *
 * Several of these paths already counted themselves — `CaptureScheduler`'s
 * per-device window, `KeyFrameCaptureLog`, `bumpCropMetric`. Every one of them
 * ends in a log line, and a log line is the thing the operator asked to stop
 * needing: *"possiamo armare questi errori intanto? Così al prossimo giro
 * ricontrolliamo tutti questi punti"* [can we instrument these errors in the meantime? That way next round we recheck all these points]. Reading them meant grepping Loki and
 * hand-correlating timestamps, which is how a 22% thumbnail gap and a 3-hour
 * media blackout were both diagnosed. The counters stay; this is where they can
 * be READ.
 *
 * ## The rate is served with its denominator or not at all
 *
 * Every entry carries `attempts` and `succeeded`. A miss count alone is
 * unreadable: on 2026-08-28 the enrichment-crop miss count read as "35x worse
 * than yesterday" and was **flat across twelve hours** once divided by the
 * successes on the same path. A surface that publishes only the numerator
 * reproduces that mistake on every read.
 *
 * ## Shape
 *
 * Copied from `load-contribution.cap.ts` (`mode: 'collection'`,
 * `internal: true`, `mount: { kind: 'skip' }`): no tRPC route of its own and no
 * generated hooks, while `addons.listCapabilityProviders` still enumerates it
 * and the hub's `CapabilityRegistry` still holds an RPC proxy per provider — so
 * a forked runner's entries reach hub-main over transport that already exists.
 * No new UDS message, no second registry (D3). The operator reads the assembled
 * result through `system.getFailureContributions`.
 */

import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const FailureReasonCountSchema = z.object({
  /**
   * Why the attempt did not land, in the contributor's own vocabulary —
   * `worker-lease-gone`, `queue-overflow`, `timeout`, `empty-read`. The same
   * strings that already appear in this repo's logs and, where one exists, the
   * same string the per-track `previewMissReason` records (D276): a second
   * vocabulary for the same loss would make the row and the counter
   * un-joinable.
   */
  reason: z.string(),
  count: z.number().int().nonnegative(),
})

const FailureContributionSchema = z.object({
  /**
   * The failing path — `enrichment-crop`, `inference`, `plate-ocr`,
   * `person-over-vehicle`. Free text, for the reason `load-contribution` keeps
   * `unit` free: the families are owned by different addons and a shared enum
   * is a central list that rots invisibly.
   */
  family: z.string(),
  /**
   * The NUMERIC device id — the same value every log line carries as
   * `tags.deviceId`. Never nullable and never absent: a contributor that
   * cannot name the camera must not emit the entry, because a fleet total
   * cannot answer the only question anybody asks of this surface.
   */
  deviceId: z.number().int().positive(),
  /**
   * A second dimension inside the family: the model / step id for an inference
   * timeout, so "which camera AND which model" is one read. Absent when the
   * family has a single variant.
   */
  variant: z.string().optional(),
  /**
   * Epoch ms this counter started — the INCARNATION MARKER. A consumer
   * differencing two reads must drop the interval when it changes, because the
   * counter restarted from zero in a respawned runner. Same discipline as
   * `LoadContribution.startedAtMs`.
   */
  sinceMs: z.number(),
  /** Epoch ms it was read. `atMs - sinceMs` is the interval this covers. */
  atMs: z.number(),
  /**
   * THE DENOMINATOR — every attempt on this path for this camera in the
   * window. A failure count published without it is the mistake this schema
   * exists to make impossible.
   */
  attempts: z.number().int().nonnegative(),
  /** Attempts that landed. `attempts - succeeded` is the loss. */
  succeeded: z.number().int().nonnegative(),
  /** The loss, partitioned. Sums to `attempts - succeeded`. */
  reasons: z.array(FailureReasonCountSchema).readonly(),
})

export type FailureContribution = z.infer<typeof FailureContributionSchema>

export const failureContributionCapability = {
  name: 'failure-contribution',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * This addon's per-camera failure counters, read live from bounded in-RAM
     * state it already keeps. Inert: no persistence, no sampling, no timer.
     *
     * READING NEVER RESETS. The counters are CUMULATIVE since `sinceMs`, and a
     * consumer that wants a rate differences two reads. A draining read would
     * make two operators with the page open each destroy half of the other's
     * numbers, and `load-contribution` already settled the same question the
     * same way for `cpuSeconds`.
     */
    list: method(z.void(), z.array(FailureContributionSchema).readonly()),
  },
  /** In-process only — enumerated through `addons.listCapabilityProviders`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type IFailureContributionProvider = InferProvider<typeof failureContributionCapability>

export { FailureContributionSchema, FailureReasonCountSchema }
