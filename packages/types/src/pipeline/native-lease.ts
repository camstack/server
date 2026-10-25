/**
 * THE native-frame **lease** knobs — hold depth, RAM budget, demand window and
 * subject-tile budget for the decode worker's native-resolution retention.
 *
 * ## Why they live here and not in the addon that reads them
 *
 * The WRITER is `pipeline-orchestrator` (the cluster-wide settings authority);
 * the READER is a private child process of `addon-pipeline`'s pipeline-runner.
 * Addons never import each other, so a key owned by either side would have to
 * be hand-copied by the other — and a hand-copied key is how a setting silently
 * stops arriving while both sides still look correct. Same reasoning, same
 * placement as `detail-crop.ts` (D52's "one cluster-wide orchestrator setting").
 *
 * ## Why cluster-wide and not per-node
 *
 * The lease is a per-decode-worker RAM window. Its purpose — the late
 * cross-process native crop landing on a full-resolution frame rather than the
 * ≤640 detection fallback — is a property of the PIPELINE, not of a node's
 * hardware: a per-node window would mean the same camera produces different crop
 * quality depending on which node the balancer placed it on, and nobody could
 * tell that from the stored media. Node-level RAM pressure is already handled
 * by the per-session budget ceiling, which is itself one of these knobs.
 *
 * ## What each knob costs
 *
 * A HELD frame is a full NATIVE-resolution copy in system RAM. With the
 * pinned-RGB24 lease path (hardware sessions):
 * 4K ≈ 24.9 MB/frame, 1080p ≈ 6.2 MB/frame. On the YUV420P path (software-decoded
 * sessions): 4K ≈ 12.4 MB, 1080p ≈ 3.1 MB. Worst-case
 * resident RAM for ONE busy camera is now `frameBytes × holdFrames`, clamped by
 * the budget ceiling — bounded by a COUNT because a held frame is waiting for
 * one specific event (its own detection result), not for a clock.
 *
 * A TILE is one subject at native resolution, JPEG-encoded: ~60-120 KB on 4K,
 * and nothing at all on a frame that detected nothing. That is the asymmetry
 * this whole shape exists for — see
 * `docs/design/2026-08-13-native-lease-two-tier-redesign.md`.
 */
import { z } from 'zod'
import type { HydratedSettingsView } from './detail-crop.js'

/**
 * Store identity of the lease knobs in `pipeline-orchestrator`'s GLOBAL
 * (cluster-wide) settings. Keys are unique across that addon's whole schema, so
 * the reader can walk every section instead of trusting the section id.
 */
export const NATIVE_LEASE_SECTION_ID = 'native-lease'
export const NATIVE_LEASE_HOLD_KEY = 'nativeLeaseHoldFrames'
export const NATIVE_LEASE_BUDGET_KEY = 'nativeLeaseBudgetMb'
export const NATIVE_LEASE_ACTIVITY_KEY = 'nativeLeaseActivityMs'
export const NATIVE_LEASE_ADMISSION_KEY = 'nativeLeaseAdmission'
export const NATIVE_LEASE_TILE_BUDGET_KEY = 'nativeTileBudgetMb'
export const NATIVE_LEASE_SCENE_BUDGET_KEY = 'nativeSceneBudgetMb'

/**
 * WHICH delivered frames the decode worker retains a native copy of.
 *
 * - `all` — every frame the worker delivered to the runner. The shipped
 *   behaviour, and the only correct one if something can ask for a crop of a
 *   frame the runner never sent to inference.
 * - `inferred` — only the frames the runner ADMITTED to its detection queue.
 *   A native-crop request always names a `frameId` that rode an inference
 *   result, so that is the only set a request can name. How much it drops is
 *   the two-plane governor's admit ratio and nothing else: measured at ~50% on
 *   this cluster, not the ~80% the design sketch assumed, because the governor
 *   was not throttling as hard as the sketch supposed. Read
 *   `leaseAdmitted`/`leaseOffered` off the metrics line for the camera in front
 *   of you rather than quoting a number from here. The newest delivered frame is
 *   croppable regardless — it is still the worker's reserved slot, not a lease —
 *   which covers the one-frame race between a mark and the supersede that
 *   consumes it.
 */
export const NativeLeaseAdmissionSchema = z.enum(['all', 'inferred'])
export type NativeLeaseAdmission = z.infer<typeof NativeLeaseAdmissionSchema>

/**
 * Operator-tunable native-lease settings. Bounds are enforced HERE (not only in
 * the slider) because the value also travels to a forked child process, where a
 * junk number would silently become a 0-length or unbounded retention window.
 */
export const NativeLeaseSettingsSchema = z.object({
  /**
   * How many delivered frames the worker HOLDS at once, waiting for each one's
   * detection result.
   *
   * This replaced a TTL on 2026-08-13, and the replacement is the whole point:
   * a time window was never related to the event the pixels were waiting for.
   * A held frame now lives from delivery until the runner has its `FrameResult`
   * — at which moment the runner cuts the subject tiles it actually wanted and
   * releases the frame. The bound exists only so a runner that stops answering
   * cannot pin RAM: above it the OLDEST held frame is dropped and counted.
   *
   * Sizing: the steady state is `inferenceLatency × deliveredFps`, measured at
   * 40-160 ms × ≤25 fps = 1-4 frames. The default leaves headroom for a hiccup
   * without ever approaching the old resident set (43 frames × 24.9 MB at 4K).
   * Raising it does not buy hit rate — it buys tolerance for a slow runner, and
   * `holdOverflow` on the metrics line is what says you need it.
   */
  holdFrames: z.number().int().min(1).max(64),
  /**
   * Hard per-decode-worker RAM ceiling for retained native frames, in MB.
   *
   * Since 2026-08-13 this is a SAFETY ceiling and nothing else: `holdFrames`
   * is what decides how much is held, and the ceiling is the number above which
   * something is wrong. Before that it was the effective cap — at 1024 MB with
   * a 2 800 ms TTL a 4K camera sat pinned at `leaseMb:1020, leaseFrames:43`
   * with the TTL expiring nothing, which is exactly the confusion the hold
   * removes. `leaseMb` / `leaseFrames` still say what is resident.
   * `0` DISABLES the lease entirely and falls the worker back to the tiny
   * leak-prone GPU surface ring (~85% crop miss; that is what the lease exists
   * to replace).
   */
  budgetMb: z.number().int().min(0).max(4096),
  /**
   * Demand window: eager per-frame native retention runs only within this many
   * ms of the last native-crop request (or of the dial starting).
   *
   * `0` means ALWAYS ON — it disables the gate, it does not disable retention.
   * That is the legacy behaviour that saturated an N100 (24 native-4K downloads
   * per second on a camera with zero crop demand), so leave it non-zero unless
   * you are reproducing that.
   */
  activityMs: z.number().int().min(0).max(120_000),
  /**
   * Which delivered frames are retained at all — see
   * {@link NativeLeaseAdmissionSchema}. This is the only knob of the four that
   * changes WHAT is kept rather than for how long, so it is also the only one
   * that can turn a crop that used to hit into a miss. The worker counts every
   * crop request naming a frame it did NOT see marked
   * (`leaseUnmarkedCrops` on the session-decode metrics line): a non-zero value
   * there is the signal that some caller names frames outside the inference set
   * and that this must go back to `all`.
   */
  admission: NativeLeaseAdmissionSchema,
  /**
   * RAM ceiling per decode worker, in MB, for the SUBJECT TILES — the
   * compressed native crops the worker cuts at the moment a frame's detection
   * result arrives, and keeps long after the frame itself is freed.
   *
   * This is the knob that replaced the old retention window, and it buys about
   * three orders of magnitude more of it: a tile is one subject at native
   * resolution, JPEG-encoded (~60-120 KB on a 4K person), against ~24.9 MB for
   * the frame it was cut from. A frame on which nothing was detected costs
   * nothing at all, which is the real change — the old lease paid per FRAME and
   * was interrogated per SUBJECT.
   *
   * `0` DISABLES tiles, leaving only the hold window and the ≤640 RAM
   * fallback — i.e. the pre-2026-08-13 miss profile. Set it there only to
   * reproduce that.
   */
  tileBudgetMb: z.number().int().min(0).max(1024),
  /**
   * RAM ceiling per decode worker, in MB, for the SCENE TILES — one
   * JPEG-encoded copy of the WHOLE native frame, cut in the same instant as the
   * subject tiles, on frames that detected something.
   *
   * It exists because a subject tile cannot answer a FULL-FRAME request:
   * containment is strict by design, so the native `keyFrame`, the detail
   * plane's `frameJpeg` rung and the display-crop fallback had no rung at all
   * below the hold. Measured on the live cluster: 23.3% of key-frame captures
   * missed, 95.7% of them with `worker-lease-gone` — the raster released one
   * frame-time after delivery, with the request only p50 367 ms behind it.
   *
   * Sizing, and why this is a budget and not a duration: a scene tile is
   * ~1.5-2.5 MB at 4K (against ~23.75 MB for the raster it was cut from and
   * ~60-120 KB for a subject tile), and it is cut ~0.4 times a second per busy
   * camera — only detection-bearing frames get one. 48 MB is therefore ~20-30
   * frames, i.e. the store's 30 s TTL binds at the steady state and the budget
   * binds only through a detection burst, where it still covers well past the
   * measured p90 ask age of 4.3 s. Holding the RASTERS for the same window
   * would be ~498 MB per camera and ~6 GB at peak concurrency — the OOM this
   * whole shape exists to avoid.
   *
   * A SEPARATE ceiling from `tileBudgetMb` on purpose: a scene tile is ~20× a
   * subject tile, so one shared budget would let a busy camera's key frames
   * evict the face/plate tiles the recognisers depend on. Two budgets make that
   * impossible rather than unlikely. `0` DISABLES scene tiles and restores the
   * pre-existing behaviour, where a late full-frame request had nothing but the
   * ≤640 RAM raster — which the `keyFrame` gate rejects, so in practice it had
   * nothing.
   */
  sceneBudgetMb: z.number().int().min(0).max(1024),
})

export type NativeLeaseSettings = z.infer<typeof NativeLeaseSettingsSchema>

/**
 * The values in force when the operator has set nothing.
 *
 * `budgetMb` stays at 1024 on the day the hold landed, deliberately: it stopped
 * being the retention window and became the OOM ceiling, and lowering a ceiling
 * in the same change that redefines it would make a regression and a retune
 * indistinguishable. Cut it once `tileHits` / `holdOverflow` have been read on
 * live traffic.
 */
export const DEFAULT_NATIVE_LEASE_SETTINGS: NativeLeaseSettings = {
  holdFrames: 8,
  budgetMb: 1024,
  activityMs: 15_000,
  tileBudgetMb: 64,
  sceneBudgetMb: 48,
  // `inferred` is the default because the premise it rests on was MEASURED
  // before it became one, not argued from the call graph. Shipped as `all`
  // first, with the mark signal and `leaseUnmarkedCrops` live in both modes:
  // over ~50 000 native-crop requests across the cluster (hub + agent, six
  // cameras), with 24 000+ marks confirmed arriving, the count of requests
  // naming a frame the runner never sent to inference stayed at 0. Crop misses
  // then FELL (7.1% → 4.4% on every camera whose lease path was healthy),
  // because at a TTL where the RAM ceiling binds first the filter buys
  // retention window rather than RAM. See `docs/design/decode-path.md` →
  // "Lease admission" and D75.
  admission: 'inferred',
}

/**
 * Only the knobs the operator has ACTUALLY set. Distinguishing "set" from
 * "absent" is what makes the documented precedence (setting > env > default)
 * expressible: an absent knob leaves the env-var escape hatch working.
 */
export type NativeLeaseSettingsOverride = Partial<NativeLeaseSettings>

/** Slider bounds for the operator-facing knobs (orchestrator settings UI). */
export const NATIVE_LEASE_HOLD_FIELD = {
  min: 1,
  max: 64,
  step: 1,
  default: DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames,
} as const

export const NATIVE_LEASE_BUDGET_FIELD = {
  min: 0,
  max: 4096,
  step: 64,
  default: DEFAULT_NATIVE_LEASE_SETTINGS.budgetMb,
} as const

export const NATIVE_LEASE_ACTIVITY_FIELD = {
  min: 0,
  max: 120_000,
  step: 1000,
  default: DEFAULT_NATIVE_LEASE_SETTINGS.activityMs,
} as const

export const NATIVE_LEASE_TILE_BUDGET_FIELD = {
  min: 0,
  max: 1024,
  step: 16,
  default: DEFAULT_NATIVE_LEASE_SETTINGS.tileBudgetMb,
} as const

export const NATIVE_LEASE_SCENE_BUDGET_FIELD = {
  min: 0,
  max: 1024,
  step: 16,
  default: DEFAULT_NATIVE_LEASE_SETTINGS.sceneBudgetMb,
} as const

/** Select options for the admission knob (orchestrator settings UI). */
export const NATIVE_LEASE_ADMISSION_FIELD = {
  options: [
    { value: 'all', label: 'Every delivered frame' },
    { value: 'inferred', label: 'Only frames sent to inference' },
  ],
  default: DEFAULT_NATIVE_LEASE_SETTINGS.admission,
} as const

/**
 * Parse one knob, reporting `null` for absent, junk, out-of-bounds — AND for a
 * value equal to the shipped default.
 *
 * That last rule is not tidiness, it is the difference between the documented
 * precedence being true and being a lie. `addon-settings.getGlobalSettings`
 * returns a HYDRATED payload, and `hydrateField` fills an unstored field with
 * the schema's own `default` (verified live on the hub: a cluster that has never
 * opened the form still reports `nativeLeaseHoldFrames = 8`). A reader that took
 * that at face value would report all three knobs as "set" on every cluster on
 * the day this shipped, permanently retiring the `CAMSTACK_SESSION_NATIVE_LEASE_*`
 * emergency override that the precedence promises. There is no raw-store read on
 * this cap to distinguish the two, so the default value itself is treated as
 * "the operator has expressed no preference" — which is also what leaving a
 * slider untouched means.
 *
 * The cost is one honest edge: an operator who deliberately selects the default
 * value in order to overrule an env var does not get it. Clear the env var
 * instead; the worker's spawn line names the source, so this is visible rather
 * than mysterious.
 */
function readKnob(knob: NativeLeaseNumberKnob, raw: unknown): number | null {
  const parsed = NativeLeaseSettingsSchema.shape[knob].safeParse(raw)
  if (!parsed.success) return null
  return parsed.data === DEFAULT_NATIVE_LEASE_SETTINGS[knob] ? null : parsed.data
}

/** {@link readKnob} for the one non-numeric knob. Same default-means-unset rule. */
function readAdmissionKnob(raw: unknown): NativeLeaseAdmission | null {
  const parsed = NativeLeaseAdmissionSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data === DEFAULT_NATIVE_LEASE_SETTINGS.admission ? null : parsed.data
}

/** Every knob, as a key union. */
export type NativeLeaseKnob = keyof NativeLeaseSettings

/** The knobs whose value is a bounded integer (everything but `admission`). */
export type NativeLeaseNumberKnob =
  | 'holdFrames'
  | 'budgetMb'
  | 'activityMs'
  | 'tileBudgetMb'
  | 'sceneBudgetMb'

/**
 * Narrow a FLAT settings record to the knobs the operator set.
 *
 * Per-FIELD parse, deliberately: a junk TTL must not also discard a valid
 * budget. An absent, out-of-bounds or default-valued knob is OMITTED (not
 * clamped, not defaulted) so the caller can still fall through to the env
 * override — clamping here would turn a typo into a value nobody chose. See
 * {@link readKnob} for why the default counts as unset.
 */
export function readNativeLeaseOverride(
  config: Readonly<Record<string, unknown>>,
): NativeLeaseSettingsOverride {
  const holdFrames = readKnob('holdFrames', config[NATIVE_LEASE_HOLD_KEY])
  const budgetMb = readKnob('budgetMb', config[NATIVE_LEASE_BUDGET_KEY])
  const activityMs = readKnob('activityMs', config[NATIVE_LEASE_ACTIVITY_KEY])
  const admission = readAdmissionKnob(config[NATIVE_LEASE_ADMISSION_KEY])
  const tileBudgetMb = readKnob('tileBudgetMb', config[NATIVE_LEASE_TILE_BUDGET_KEY])
  const sceneBudgetMb = readKnob('sceneBudgetMb', config[NATIVE_LEASE_SCENE_BUDGET_KEY])
  return {
    ...(holdFrames === null ? {} : { holdFrames }),
    ...(budgetMb === null ? {} : { budgetMb }),
    ...(activityMs === null ? {} : { activityMs }),
    ...(admission === null ? {} : { admission }),
    ...(tileBudgetMb === null ? {} : { tileBudgetMb }),
    ...(sceneBudgetMb === null ? {} : { sceneBudgetMb }),
  }
}

/** One hydrated field of an `addon-settings.getGlobalSettings` payload. */
interface HydratedLeaseField {
  readonly key: unknown
  readonly value?: unknown
}

function isHydratedField(entry: unknown): entry is HydratedLeaseField {
  return typeof entry === 'object' && entry !== null && 'key' in entry
}

const LEASE_KEYS: readonly string[] = [
  NATIVE_LEASE_HOLD_KEY,
  NATIVE_LEASE_BUDGET_KEY,
  NATIVE_LEASE_ACTIVITY_KEY,
  NATIVE_LEASE_ADMISSION_KEY,
  NATIVE_LEASE_TILE_BUDGET_KEY,
  NATIVE_LEASE_SCENE_BUDGET_KEY,
]

/**
 * Extract the operator's lease overrides from an
 * `addon-settings.getGlobalSettings` payload.
 *
 * Walks EVERY section rather than looking inside {@link NATIVE_LEASE_SECTION_ID}
 * alone: the keys are unique across the addon's schema, and a section rename
 * must not silently revert the whole cluster to the defaults. A `null` payload
 * (addon mid-boot) means "operator set nothing" — the env/default fallback then
 * applies, which is the correct read of "I could not ask".
 */
export function pickNativeLeaseOverride(
  view: HydratedSettingsView | null,
): NativeLeaseSettingsOverride {
  if (view === null) return {}
  const flat: Record<string, unknown> = {}
  for (const section of view.sections) {
    for (const entry of section.fields) {
      if (!isHydratedField(entry) || typeof entry.key !== 'string') continue
      if (LEASE_KEYS.includes(entry.key)) flat[entry.key] = entry.value
    }
  }
  return readNativeLeaseOverride(flat)
}
