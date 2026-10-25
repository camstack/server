/**
 * `zone-rules-provider.ts` — implements `zoneRulesCapability` for the
 * orchestrator.
 *
 * Per-stage rule arrays (motion / detection) live next to zones in the
 * orchestrator's per-device store under `zoneRules.<stage>` keys.
 * Every mutation mirrors to a stage-specific device-state slice
 * (`motion-zone-rules`, `detection-zone-rules`) so consumer addons
 * subscribe independently and pick up the new gating without an extra
 * cap round-trip.
 *
 * The provider validates each rule against {@link ZoneRuleSchema}
 * before persisting — partial / corrupt writes are rejected outright
 * since rules drive runtime filtering and a bad payload would silently
 * widen the operator's intended scope.
 *
 * ── THE MIRROR IS HYDRATED AT BOOT, NOT ONLY ON MUTATION ──────────
 *
 * Same root cause as the `zones` slice (see `zones-provider.ts`): the
 * mirror used to be written only by `persist`, so a camera nobody had
 * mutated since its runtime-state row was last written had NO
 * `zone-rules` slice, and every mirror-only consumer — motion-wasm's
 * zone gate, the detection-pipeline zone gate, the admin rules editor
 * — read "no rules" until an operator happened to save one. Zones and
 * rules gate together, so hydrating one without the other still leaves
 * both runner-side gates inert. {@link ZoneRulesProvider.hydrateMirror}
 * is what the boot sweep (`zone-mirror-hydration.ts`) calls; it is an
 * RPC read, never an event replay (D8), and a stage that could not be
 * read leaves the mirror untouched (D49).
 */

import { z } from 'zod'
import {
  type IZoneRulesProvider,
  type ZoneRule,
  type ZoneRuleStage,
  ZoneRuleSchema,
  ZoneRuleStageEnum,
  type IScopedLogger,
  type DeviceProxy,
  type DurableState,
  createDurableState,
} from '@camstack/types'

import type { ZoneMirrorHydration } from './zones-provider.js'

/**
 * Every zone-rule stage, in the declared enum order. The unified device-state
 * mirror carries ONE key per stage so a single reactive handle
 * (`device.state.zoneRules.value`) covers every consumer. Derived from the cap
 * enum so a new stage (audio gating, alert filtering, …) is picked up here with
 * no edit — the mirror stays exhaustive over the widened discriminator.
 */
const ALL_STAGES: readonly ZoneRuleStage[] = ZoneRuleStageEnum.options

export interface ZoneRulesProviderContext {
  readonly logger: IScopedLogger
  readonly settings: {
    readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
    writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  }
  /**
   * Per-device facade — same shape as `AddonContext.fetchDevice`.
   * Used to push the `device-state.setCapSlice` write through the
   * codegen DeviceProxy.
   */
  readonly fetchDevice: (deviceId: number) => Promise<DeviceProxy>
  /**
   * Optional change hook fired after every successful persist. The
   * orchestrator may want to re-attach the runner config when motion
   * rules change so motion-wasm picks up the new gating without
   * waiting for the next attach. Detection rules are consumed by
   * analytics via the dev-state mirror and don't need a re-attach.
   */
  readonly onRulesChanged?: (
    deviceId: number,
    stage: ZoneRuleStage,
    rules: readonly ZoneRule[],
  ) => void
}

/** Settings store key for stage rules. Kept under a single nested
 *  object so a future stage just adds another property without
 *  reshuffling the schema. */
const RULES_STORE_KEY = 'zoneRules'

/** Cap name for the unified runtime-state slice. Matches the cap's
 *  declared `name` so the codegen DeviceProxy auto-wires
 *  `device.state.zoneRules`. The slice value is the full
 *  `{motion, detection}` object — both stages travel together so a
 *  single reactive handle covers every consumer. */
const ZONE_RULES_CAP_NAME = 'zone-rules'

const RulesArraySchema = z.array(ZoneRuleSchema)

/**
 * Whole-blob schema for the per-device `zoneRules` store key. Both stages
 * travel together under one key. Deliberately lenient — each stage is
 * `unknown` so a corrupt single stage can NOT drop the sibling on load
 * (durable-state `get()` falls back to `{}` only on a whole-blob parse
 * failure). Strict per-stage validation, with its own reset-on-corrupt
 * warn, still happens in `loadRules` exactly as before the migration.
 */
const ZoneRulesBlockSchema = z
  .object({
    motion: z.unknown().optional(),
    detection: z.unknown().optional(),
    // `package` stage — the store key indexed by `ZoneRuleStage`. The full
    // package-stage write path (persist + N-stage unified mirror) is live
    // (design §3.1, Phase 4); this keeps the typed index (`block[stage]`)
    // exhaustive over the widened enum.
    package: z.unknown().optional(),
  })
  .passthrough()
type ZoneRulesBlock = z.infer<typeof ZoneRulesBlockSchema>

interface PerStageStore {
  readonly motion?: unknown
  readonly detection?: unknown
  readonly package?: unknown
}

/**
 * A rules read that DISTINGUISHES "this camera has no rules" from "the store
 * could not answer". `listRules` (the cap surface) folds both into `[]`, which
 * is correct for a consumer that only filters — an unanswerable store there
 * means "gate nothing" and the next frame retries.
 *
 * It is NOT correct for a consumer whose empty answer DESTROYS work. The
 * `package-detection` step is appended and stripped from the resolved pipeline
 * purely on "does this camera have a package zone", so a swallowed read error
 * silently removed the step (CLAUDE.md: a one-shot decision never gates on a
 * fallible read — [D49](../../../docs/decisions/adr-0049.md)). Those callers
 * use {@link ZoneRulesProvider.listRulesChecked} and decide for themselves.
 */
export type ZoneRulesRead =
  | { readonly ok: true; readonly rules: readonly ZoneRule[] }
  | { readonly ok: false; readonly error: string }

export class ZoneRulesProvider implements IZoneRulesProvider {
  /** Per-device per-stage cache. Hydrated lazily on first read. */
  private readonly cache = new Map<number, Map<ZoneRuleStage, readonly ZoneRule[]>>()
  /**
   * Per-device durable handle over the `zoneRules` store key. The WHOLE
   * `{motion?, detection?}` block round-trips on every read/write so a
   * write on one stage can never drop the other. Built lazily + memoised.
   */
  private readonly stateByDevice = new Map<number, DurableState<ZoneRulesBlock>>()
  /** Per-device fingerprint of the slice this process last successfully wrote.
   *  Absent ⇒ never mirrored here, so the next hydration writes. */
  private readonly mirroredFingerprint = new Map<number, string>()
  /** Devices already reported as unmirrorable — one warn per episode. */
  private readonly reportedMirrorFailure = new Set<number>()

  constructor(private readonly ctx: ZoneRulesProviderContext) {}

  /** Lazily build (and memoise) the durable `zoneRules` handle for a device. */
  private rulesState(deviceId: number): DurableState<ZoneRulesBlock> {
    let handle = this.stateByDevice.get(deviceId)
    if (!handle) {
      handle = createDurableState<ZoneRulesBlock>({
        key: RULES_STORE_KEY,
        schema: ZoneRulesBlockSchema,
        fallback: {},
        read: () => this.ctx.settings.readDeviceStore(deviceId),
        write: (patch) => this.ctx.settings.writeDeviceStore(deviceId, patch),
        onParseError: (key, error) =>
          this.ctx.logger.warn('zone-rules store block failed to parse — resetting', {
            tags: { deviceId },
            meta: { key, error: error instanceof Error ? error.message : String(error) },
          }),
      })
      this.stateByDevice.set(deviceId, handle)
    }
    return handle
  }

  // ── Cap surface ───────────────────────────────────────────────────

  async listRules({
    deviceId,
    stage,
  }: {
    deviceId: number
    stage: ZoneRuleStage
  }): Promise<readonly ZoneRule[]> {
    return this.loadRules(deviceId, stage)
  }

  /**
   * The same read, with the failure still visible — see {@link ZoneRulesRead}.
   * NOT part of the cap surface: only an in-process consumer whose empty
   * answer destroys work needs it, and the cap's own `listRules` contract
   * (always an array) is what every filtering consumer wants.
   */
  async listRulesChecked({
    deviceId,
    stage,
  }: {
    deviceId: number
    stage: ZoneRuleStage
  }): Promise<ZoneRulesRead> {
    return this.readRules(deviceId, stage)
  }

  async setRules({
    deviceId,
    stage,
    rules,
  }: {
    deviceId: number
    stage: ZoneRuleStage
    rules: readonly ZoneRule[]
  }): Promise<void> {
    // Validate the whole list up front — rejecting on first failure
    // keeps the persisted shape consistent.
    const parsed = RulesArraySchema.safeParse(rules)
    if (!parsed.success) {
      throw new Error(
        `zone-rules.setRules: invalid rule payload — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      )
    }
    await this.persist(deviceId, stage, parsed.data)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Reconcile ONE device's `zone-rules` mirror against the durable block.
   * Called by the boot sweep for every camera. Never throws.
   *
   * A stage whose read FAILED aborts the whole hydration: the mirror is a
   * single slice carrying every stage, so writing a partially-read block would
   * publish "this stage has no rules" off a store blip — and an empty
   * `motion`/`detection` array is what makes a gate stop gating.
   */
  async hydrateMirror(deviceId: number): Promise<ZoneMirrorHydration> {
    const perDevice = this.stageCache(deviceId)
    for (const stage of ALL_STAGES) {
      const read = await this.readRules(deviceId, stage)
      if (!read.ok) return 'unreadable'
      perDevice.set(stage, read.rules)
    }
    const slice = await this.buildSliceValue(deviceId, perDevice)
    const fingerprint = JSON.stringify(slice)
    if (this.mirroredFingerprint.get(deviceId) === fingerprint) return 'unchanged'
    try {
      const dev = await this.ctx.fetchDevice(deviceId)
      await dev.deviceState.setCapSlice({ capName: ZONE_RULES_CAP_NAME, slice })
    } catch (err: unknown) {
      if (!this.reportedMirrorFailure.has(deviceId)) {
        this.reportedMirrorFailure.add(deviceId)
        this.ctx.logger.warn(
          'zone-rules mirror write failed — mirror-only zone gates see NO rules for this camera until it lands',
          {
            tags: { deviceId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          },
        )
      }
      return 'write-failed'
    }
    const first = !this.mirroredFingerprint.has(deviceId)
    this.mirroredFingerprint.set(deviceId, fingerprint)
    this.reportedMirrorFailure.delete(deviceId)
    if (first) {
      this.ctx.logger.info('zone-rules mirror hydrated from the durable block', {
        tags: { deviceId },
      })
    }
    return 'written'
  }

  /** Drop a device's cache entries. Called when the device is removed. */
  forgetDevice(deviceId: number): void {
    this.cache.delete(deviceId)
    this.stateByDevice.delete(deviceId)
    // Per-device state keyed by the same id — a future device reusing it must
    // be hydrated from ITS block, not skipped as already mirrored.
    this.mirroredFingerprint.delete(deviceId)
    this.reportedMirrorFailure.delete(deviceId)
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Cap-surface read: a failure folds to the empty list, as it always has. */
  private async loadRules(deviceId: number, stage: ZoneRuleStage): Promise<readonly ZoneRule[]> {
    const read = await this.readRules(deviceId, stage)
    return read.ok ? read.rules : []
  }

  /**
   * The one real read. A SUCCESSFUL result is cached; a FAILED one is not —
   * the cache is keyed by presence, and an empty array is a perfectly valid
   * cached value, so caching the fold of a transient failure pinned this
   * device+stage to "no rules" for the process's whole lifetime. That turned a
   * momentary store blip into a permanent one.
   */
  private async readRules(deviceId: number, stage: ZoneRuleStage): Promise<ZoneRulesRead> {
    const perDevice = this.stageCache(deviceId)
    const cached = perDevice.get(stage)
    if (cached) return { ok: true, rules: cached }
    let rules: readonly ZoneRule[] = []
    try {
      // Whole `{motion?, detection?}` block via the durable handle; the
      // per-stage value stays `unknown` and is strictly validated below
      // (reset-on-corrupt isolated to the offending stage).
      const block: PerStageStore = await this.rulesState(deviceId).get()
      const raw = block[stage]
      if (raw !== undefined) {
        const parsed = RulesArraySchema.safeParse(raw)
        if (parsed.success) {
          rules = parsed.data
        } else {
          // A parse failure is NOT a read failure: the store answered, and its
          // answer is unusable. Resetting to empty is the deliberate
          // reset-on-corrupt behaviour, so this is a successful read of [].
          this.ctx.logger.warn('zone-rules store entry failed to parse — resetting', {
            tags: { deviceId },
            meta: { stage, issues: parsed.error.issues },
          })
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      this.ctx.logger.warn(
        'zone-rules store read failed — reporting the failure, not an empty list',
        {
          tags: { deviceId },
          meta: { stage, error },
        },
      )
      return { ok: false, error }
    }
    perDevice.set(stage, rules)
    return { ok: true, rules }
  }

  private async persist(
    deviceId: number,
    stage: ZoneRuleStage,
    rules: readonly ZoneRule[],
  ): Promise<void> {
    const perDevice = this.stageCache(deviceId)
    perDevice.set(stage, rules)

    // Read-modify-write the per-device block through the durable handle so
    // the other stages' rules survive this update (whole-blob round-trip).
    await this.rulesState(deviceId).update((prev) => ({ ...prev, [stage]: rules }))

    // Mirror the FULL per-stage slice (`{motion, detection, package}`) —
    // consumer code reads via `device.state.zoneRules.value.<stage>` and the
    // codegen DeviceProxy keeps every branch in lock-step. Each sibling stage's
    // current value comes from the cache (populated above for `stage`; loaded
    // lazily for the rest), so writing one stage never silently drops another —
    // the `package` stage is now a first-class functional slice, not a passive
    // forward-compat key (design §3.1 / §8, Phase 4).
    const sliceValue = await this.buildSliceValue(deviceId, perDevice)

    try {
      const dev = await this.ctx.fetchDevice(deviceId)
      await dev.deviceState.setCapSlice({
        capName: ZONE_RULES_CAP_NAME,
        slice: sliceValue,
      })
      // Keep the hydration bookkeeping in step with the mutation path, so a
      // boot sweep that lands after an operator save costs no second write.
      this.mirroredFingerprint.set(deviceId, JSON.stringify(sliceValue))
      this.reportedMirrorFailure.delete(deviceId)
    } catch (err: unknown) {
      this.ctx.logger.debug('zone-rules slice mirror failed', {
        tags: { deviceId },
        meta: {
          stage,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }

    this.ctx.onRulesChanged?.(deviceId, stage, rules)
  }

  /**
   * Assemble the unified `{motion, detection, package}` mirror value from every
   * stage's current rules. The stage just written is already in `perDevice`;
   * siblings resolve from the cache when present, else a lazy store read (which
   * also warms the cache). Iterates {@link ALL_STAGES} so it stays exhaustive
   * over the cap's stage discriminator without a per-stage branch.
   */
  /** The per-stage cache map for a device, created on first use. */
  private stageCache(deviceId: number): Map<ZoneRuleStage, readonly ZoneRule[]> {
    let perDevice = this.cache.get(deviceId)
    if (!perDevice) {
      perDevice = new Map<ZoneRuleStage, readonly ZoneRule[]>()
      this.cache.set(deviceId, perDevice)
    }
    return perDevice
  }

  private async buildSliceValue(
    deviceId: number,
    perDevice: Map<ZoneRuleStage, readonly ZoneRule[]>,
  ): Promise<Record<ZoneRuleStage, readonly ZoneRule[]>> {
    // Start from a fully-keyed literal so TypeScript enforces exhaustiveness:
    // widening `ZoneRuleStageEnum` fails this compile until the new stage is
    // added here — no silent missing-key drift in the mirror.
    const slice: Record<ZoneRuleStage, readonly ZoneRule[]> = {
      motion: [],
      detection: [],
      package: [],
    }
    for (const s of ALL_STAGES) {
      slice[s] = perDevice.get(s) ?? (await this.loadRules(deviceId, s))
    }
    return slice
  }
}
