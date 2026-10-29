/**
 * The composer: every declarative composition on this hub, in one runner
 * (D659).
 *
 * `apply` is called by `core-blocks`' supervisor on its existing converge with
 * the WHOLE set of composition blocks. It is idempotent: a block whose
 * `updatedAt`, device and plan are unchanged keeps its runtime; the declared set
 * is reconciled only when it changed. Every verdict names its reason.
 *
 * Nothing is declared or withdrawn until two things hold (D49): the
 * `core_blocks` store has loaded (R2), and the composer has read the rows it
 * already owns, so a restart is not the first miss of every block
 * (`WithdrawalGate.seed`). A block whose row exists but whose composition no
 * longer plans (a cap renamed by a release) keeps its device as an offline
 * placeholder with no capabilities, and reports `failed` naming why.
 *
 * Slice 2 (D663) — a composition on an EXISTING device declares nothing: the
 * row is not the composer's, `DeclaredDevices` never sees it, and the owner
 * filter in `composer.addon.ts` stays load-bearing. Its fields are CLAIMED on
 * the hub under the block id (`OwnedFieldsTarget`), and released through the
 * `ClaimGate` — two applies must agree, seeded at boot from the claims index —
 * when the block merely vanished from one snapshot. An operator delete
 * (`retiredBlockIds`) or an edit that drops a cap releases those claims on
 * THIS apply, after the old runtime has quiesced and before any replacement
 * claims; a release that does not land is logged with `tags: { deviceId }` and
 * returned on the apply. Its own replaced
 * fields are read in the NATIVE view (rule 6). Its target row gone on two
 * agreeing index reads fails the block by name and ungrafts what it added —
 * whether the loss was seen on `device.unregistered` or on a later plan; its
 * claims die with the row. Nothing is claimed or released while the claims
 * index has not loaded (`CLAIMS_NOT_LOADED`). Planning is `composer-plan.ts`.
 *
 * A cap the customization ADDS is GRAFTED (`GraftHost`, Task 10): a
 * method-serving native on the target, decided at plan time only; when and why
 * is `composer-grafts.ts` (native always wins; an unserved cap is named in the
 * verdict; a previous process's leftover is retracted).
 *
 * A replaced field is handed back only on a CONFIRMED unavailability of its
 * source (D49, fix round 2): a failed, first or empty read HOLDS it on its last
 * value with its claim kept — the runtime's `held`, reported `starting` by name.
 * A runtime built by an apply starts in that apply's sync, never earlier from
 * an event (N-5).
 *
 * This file is the orchestration; the pieces live beside it:
 * `composer-apply-waits.ts` (the store / integration preconditions),
 * `composer-seeds.ts` (the two boot reads), `composer-runtime-factory.ts`
 * (where a runtime writes and how it reads) and `composer-live-set.ts` (the
 * pure reads of the live set: tracked sources, reset keys, wanted claims).
 */
import {
  type CapabilityLookup,
  type ClaimOutcome,
  type ComposerApplyInput,
  type ComposerApplyResult,
  type ComposerBlock,
  type ComposerBlockVerdict,
  type FanOutCall,
  type CompositionBlockState,
  type CompositionFieldState,
  composedDeviceStableId,
  compositionFeatureEnabled,
  type DeviceDeclaration,
  type DeviceHistoryQueryResult,
  type HistoryRetention,
  type ReadingQuantity,
  type HistoryHelperSpec,
  isHistoryHelper,
  errMsg,
  type FieldClaim,
  type IScopedLogger,
  type LogTags,
  type UnreleasedClaim,
} from '@camstack/types'
import type { DeviceStateChangedData } from '../shared/device-state-changed.js'
import { ClaimGate, type ClaimKey } from './claim-gate.js'
import { adoptMathQuantities } from './math-quantity.js'
import {
  ActuatorGroups,
  type ActuatorMemberLookup,
  isActuatorGroupDevice,
} from './actuator-groups.js'
import type { ComposedDeviceHandle } from './composed-device.js'
import {
  type ComposerDeclare,
  ComposedDeviceSet,
  type ComposerDevicePorts,
} from './composed-device-set.js'
import { type ForwardBlock, ForwardCommands, type ForwardCommandsDeps } from './forward-commands.js'
import { ApplyWaits, waitingResult } from './composer-apply-waits.js'
import { ComposerGrafts } from './composer-grafts.js'
import {
  confirmedReleaseKeys,
  operatorResetKeys,
  RELEASE_SETTLED_CODES,
  trackedSourceRequests,
  wantedClaims,
} from './composer-live-set.js'
import {
  logPlanTransition,
  lostTarget,
  type PlannedBlock,
  type PlannedExistingTarget,
  planExisting,
  planNew,
  planUnreadable,
  sameTarget,
  withExistingTargetWait,
} from './composer-plan.js'
import { newCompositionRuntime, writerFor } from './composer-runtime-factory.js'
import { claimIndexSeed, composedRowSeed } from './composer-seeds.js'
import { type LiveComposition, verdictOf } from './composer-verdict.js'
import { type PersistedComposedRow, WithdrawalGate } from './composition-declarations.js'
import type {
  CompositionEventEmitter,
  CompositionRuntime,
  DeadlineTimer,
} from './composition-runtime.js'
import type { ConfirmedSeed } from './confirmed-seed.js'
import {
  type ComposerClaimsApi,
  type ComposerGraftPorts,
  type DescribeTarget,
  type ExistingTargetSeedRead,
  heldFieldsOf,
  readExistingTargetSeeds,
  reportSeedlessRestoredCaps,
  ungraftGoneTarget,
  TargetDescriptions,
} from './existing-target.js'
import type { ClaimEvent } from './held-claims.js'
import { type HistoryBlockView, HistoryHelpers, type HistoryQuery } from './history-helpers.js'
import {
  resolvePulseSeeds,
  type PulseFieldSeed,
  type ReadPulseHistory,
} from './pulse-seed-resolve.js'
import type {
  SourceBindingsChangeReason,
  SourceTracker,
  TrackedSourceRequest,
} from './source-tracker.js'

export type { ComposerDerivedSpec } from './composer-plan.js'
export type { ComposerDeclareResult, ComposerDevicePorts } from './composed-device-set.js'

/** What the composer reads of a `device.bindings-changed` payload; the typed `EventCatalog` payload is assignable to it. */
export interface DeviceBindingsChangedData {
  readonly deviceId: number
  readonly capName: string
  readonly reason: SourceBindingsChangeReason
  /** The addon that registered (or unregistered) the provider: a foreign native vs the composer's own graft. */
  readonly addonId: string
}

/** The owner-only `device.native-shadow-changed` payload (D224): the provider's slice under a claim. */
export interface NativeShadowChangedData {
  readonly deviceId: number
  readonly capName: string
  readonly native: Readonly<Record<string, unknown>>
}

export interface ComposerDeps {
  readonly logger: IScopedLogger
  readonly tracker: SourceTracker
  readonly lookupCap: CapabilityLookup
  /** The composed rows that already exist (`listOwnDevices`), read once before the first withdrawal decision. */
  readonly readPersisted: () => Promise<readonly PersistedComposedRow[]>
  readonly declare: ComposerDeclare
  readonly devices: ComposerDevicePorts
  /** The hub's per-field claims (D663): the write target's methods and the boot seed. */
  readonly claims: ComposerClaimsApi
  /** Typed state-derived events emitted by composed capability fields. */
  readonly events: CompositionEventEmitter
  /** Effective target state, read before an existing-target runtime owns any field. */
  readonly readExistingTargetCap: (
    deviceId: number,
    capName: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>
  /**
   * Raw history of a source field, for a pulse override's start seed (D938).
   * Absent (tests that predate the seed) leaves the boot slice as the initial.
   */
  readonly readPulseHistory?: ReadPulseHistory
  /**
   * A statistic or integral reads device history on a schedule (D944). Absent
   * in tests that predate it: those helpers stay offline, nothing is queried.
   */
  readonly readHistory?: (input: HistoryQuery) => Promise<DeviceHistoryQueryResult>
  readonly readHistoryRetention?: () => Promise<HistoryRetention>
  /** `SourceInfo.quantity` of a source device, copied onto a statistic or a meter (D944). */
  readonly readSourceQuantity?: (deviceId: number) => Promise<ReadingQuantity | null>
  /** IANA zone for calendar windows. The hub process zone when omitted. */
  readonly timeZone?: string
  /** ONE `getBindings` per target description read (rule 1). */
  readonly describeTarget: DescribeTarget
  /** `GraftHost` (Task 10): a method-serving native for each ADDED cap. Absent, nothing is grafted. */
  readonly grafts?: ComposerGraftPorts
  readonly now: () => number
  readonly newTimer: () => DeadlineTimer
  /**
   * Member capabilities and the command that reaches one member. Absent in
   * tests that predate actuator groups: those compositions still aggregate,
   * and a command names that fan-out was not attached.
   */
  readonly readActuatorMember?: (deviceId: number) => Promise<ActuatorMemberLookup>
  readonly invokeActuator?: (call: FanOutCall) => Promise<void>
  /**
   * `<cap>.<method>` on a source device through `ctx.api`, for the `forward`
   * commands of a built cap (D967). Absent in tests that predate them: such a
   * device refuses its commands by name.
   */
  readonly callCapMethod?: ForwardCommandsDeps['callCapMethod']
}

interface RuntimeRebuild {
  /** Source keys an operator action re-opened. Runtimes built by this apply are `unsynced`: started by its sync. */
  readonly reset: ReadonlySet<string>
  /** Runtimes this apply stopped. Quiesced before a confirmed release, so an in-flight claim cannot land after it. */
  readonly stopped: readonly CompositionRuntime[]
}

export class Composer {
  private live: ReadonlyMap<string, LiveComposition> = new Map()
  /** The composed devices of `new`-target blocks, and the rows that exist. */
  private readonly composed: ComposedDeviceSet
  /** The store / integration preconditions every apply waits on first (D49, R2). */
  private readonly waits: ApplyWaits
  private readonly gate: WithdrawalGate
  private readonly claimGate: ClaimGate
  private readonly targets: TargetDescriptions
  private readonly grafts: ComposerGrafts
  private readonly actuators: ActuatorGroups | null
  private readonly forwards: ForwardCommands | null
  private readonly history: HistoryHelpers | null
  private historySpecs: ReadonlyMap<string, HistoryHelperSpec> = new Map()
  /** The rows the composer owns, read ONCE before its first withdrawal decision. */
  private readonly rowSeed: ConfirmedSeed<PersistedComposedRow>
  /**
   * The claims the hub holds, read ONCE before the first release decision (rule
   * 3). Every owner in it is a composer block id — the Task 6 guard lets nothing
   * else claim. `not-loaded` is UNKNOWN (D315), never empty. Until seeded, every
   * existing-target block waits by name; new-target blocks are not held.
   */
  private readonly claimSeed: ConfirmedSeed<FieldClaim>
  /** Applies never interleave: each one reads and replaces the whole live set. */
  private applyChain: Promise<unknown> = Promise.resolve()
  /**
   * Runtimes built by an apply and not started yet: that apply's sync starts
   * them, with their sources tracked. An event in between never does (N-5) —
   * it would start one on sources "not tracked yet".
   */
  private unsynced: ReadonlySet<CompositionRuntime> = new Set()

  constructor(private readonly deps: ComposerDeps) {
    this.composed = new ComposedDeviceSet({
      logger: deps.logger,
      declare: deps.declare,
      devices: deps.devices,
    })
    this.gate = new WithdrawalGate(deps.logger.child('withdrawal'), (stableId) =>
      this.composed.idOf(stableId),
    )
    this.claimGate = new ClaimGate(deps.logger.child('claims'))
    this.grafts = new ComposerGrafts(deps.grafts, deps.logger.child('graft'), deps.describeTarget)
    this.targets = new TargetDescriptions(deps.logger.child('target'), (deviceId) => {
      this.grafts.describing(deviceId)
      return deps.describeTarget(deviceId)
    })
    this.forwards = this.attachForwards(deps)
    this.actuators = this.attachActuators(deps, this.forwards)
    this.history = this.attachHistory(deps)
    this.waits = new ApplyWaits(deps.logger)
    this.rowSeed = composedRowSeed({
      logger: deps.logger,
      readPersisted: deps.readPersisted,
      onSeeded: (rows) => {
        this.gate.seed(rows)
        this.composed.seedRows(rows)
      },
    })
    this.claimSeed = claimIndexSeed({
      logger: deps.logger,
      claims: deps.claims,
      onSeeded: (claims) => {
        this.claimGate.seed(claims)
        this.deps.tracker.seedClaims(claims)
      },
    })
  }

  apply(input: ComposerApplyInput): Promise<ComposerApplyResult> {
    return this.chained(() => this.applyNow(input))
  }

  getStates(blockIds: readonly string[]): readonly CompositionBlockState[] {
    return blockIds.flatMap((blockId) => {
      const entry = this.live.get(blockId)
      if (entry === undefined) return []
      const verdict = this.verdict(blockId)
      return [
        {
          blockId,
          deviceId: this.deviceIdOf(entry),
          status: verdict.status,
          ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
          fields: entry.runtime?.state().fields.map((f) => ({ ...f })) ?? [...entry.heldFields],
        },
      ]
    })
  }

  /** Runs on the tracker's one chain (R3): resolves once the change reached every runtime. */
  async onStateChanged(data: DeviceStateChangedData): Promise<void> {
    this.history?.noteSample(data.deviceId)
    this.dispatch(await this.deps.tracker.onStateChanged(data.deviceId, data.capName, data.slice))
  }

  async onNativeChanged(data: NativeShadowChangedData): Promise<void> {
    this.dispatch(await this.deps.tracker.onNativeChanged(data.deviceId, data.capName, data.native))
  }

  async onDeviceUnregistered(deviceId: number): Promise<void> {
    const changed = await this.deps.tracker.onDeviceUnregistered(deviceId)
    // The live set is replaced here: on the apply chain, so an apply in flight never overwrites it.
    await this.chained(() => this.failGoneTargets(deviceId))
    this.dispatch(changed)
  }

  async onBindingsChanged(data: DeviceBindingsChangedData): Promise<void> {
    this.targets.invalidate(data.deviceId)
    this.grafts.onBindingsChanged(data)
    this.dispatch(
      await this.deps.tracker.onBindingsChanged(data.deviceId, data.capName, data.reason),
    )
    await this.chained(() => this.actuators?.onMemberBindings(data.deviceId))
  }

  shutdown(): void {
    for (const entry of this.live.values()) entry.runtime?.stop()
    this.actuators?.shutdown()
    this.history?.stop()
  }

  private attachForwards(deps: ComposerDeps): ForwardCommands | null {
    const callCapMethod = deps.callCapMethod
    if (callCapMethod === undefined) return null
    return new ForwardCommands({
      logger: deps.logger.child('forward'),
      resolve: (ref) => deps.tracker.resolve(ref, true),
      callCapMethod,
      deviceIdOf: (blockId) => this.composed.idOf(composedDeviceStableId(blockId)),
    })
  }

  /**
   * The dispatch path of a composed device's commands. A forward-only
   * deployment (no actuator ports) still gets it: the fan-out it never uses
   * refuses by name.
   */
  private attachActuators(
    deps: ComposerDeps,
    forwards: ForwardCommands | null,
  ): ActuatorGroups | null {
    const read = deps.readActuatorMember ?? unattachedMemberRead
    const invoke = deps.invokeActuator ?? unattachedInvoke
    if (
      forwards === null &&
      (deps.readActuatorMember === undefined || deps.invokeActuator === undefined)
    )
      return null
    return new ActuatorGroups({
      logger: deps.logger.child('actuators'),
      now: deps.now,
      resolve: (ref) => {
        const found = deps.tracker.resolution(ref)
        return found.kind === 'found'
          ? { kind: 'found', deviceId: found.deviceId }
          : { kind: 'other' }
      },
      readMember: read,
      deviceOf: (blockId) => {
        const device = this.composed.get(composedDeviceStableId(blockId))
        return device !== null && isActuatorGroupDevice(device) ? device : null
      },
      invoke,
      ...(forwards === null ? {} : { forwards }),
    })
  }

  private attachHistory(deps: ComposerDeps): HistoryHelpers | null {
    const read = deps.readHistory
    const retention = deps.readHistoryRetention
    if (read === undefined || retention === undefined) return null
    return new HistoryHelpers({
      now: deps.now,
      timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      logger: deps.logger.child('history'),
      query: read,
      retention,
      sourceDeviceId: (ref) => {
        const found = deps.tracker.resolution(ref)
        return found.kind === 'found' ? found.deviceId : null
      },
      sourceQuantity: deps.readSourceQuantity,
      adoptQuantity: (blockId, quantity) => this.adoptQuantityOf(blockId, quantity),
      blocks: () => this.historyBlocks(),
      publish: (blockId, writes) => {
        this.live.get(blockId)?.runtime?.publishSeries(writes)
      },
      timer: deps.newTimer(),
    })
  }

  private async adoptQuantityOf(blockId: string, quantity: ReadingQuantity): Promise<void> {
    const device = this.composed.get(composedDeviceStableId(blockId))
    if (device?.adoptQuantity === undefined) {
      throw new Error(`composed device for ${blockId} cannot store a quantity`)
    }
    await device.adoptQuantity(quantity)
  }

  private historyBlocks(): readonly HistoryBlockView[] {
    const blocks: HistoryBlockView[] = []
    for (const [blockId, helper] of this.historySpecs) {
      const entry = this.live.get(blockId)
      if (entry === undefined) continue
      const deviceId = this.deviceIdOf(entry)
      if (deviceId === null) continue
      blocks.push({ blockId, deviceId, helper })
    }
    return blocks
  }

  /** Run `work` after every apply already queued, whether that settled or failed. */
  private chained<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.applyChain.then(work, work)
    this.applyChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async applyNow(input: ComposerApplyInput): Promise<ComposerApplyResult> {
    const ids = [...input.blocks.map((b) => b.id), ...input.unreadableBlocks.map((u) => u.id)]
    const gate = this.waits.check(input, this.live.size)
    if (gate.kind === 'wait') return waitingResult(ids, gate.reason)
    const unseeded = await this.rowSeed.ensure()
    if (unseeded !== null) return waitingResult(ids, unseeded)
    const claimsWait = await this.claimSeed.ensure()
    const restart = new Set(input.restartBlockIds)
    const planned: PlannedBlock[] = []
    for (const block of input.blocks) planned.push(await this.plan(block, restart, claimsWait))
    for (const block of input.unreadableBlocks)
      planned.push(planUnreadable(block, this.composed.rows))
    for (const p of planned) {
      logPlanTransition(
        this.deps.logger,
        this.live.get(p.block.id)?.planned,
        p,
        this.tagsOf(p.block.id),
      )
    }
    const declarations = this.gate.filter(
      planned.flatMap((p) => (p.declaration === null ? [] : [p.declaration])),
    )
    const rebuildErrors = await this.composed.rebuildShapes(planned, (blockId) => {
      const previous = this.live.get(blockId)
      return previous === undefined
        ? undefined
        : { device: previous.device, shape: previous.planned.shape }
    })
    await this.composed.reconcile(gate.integrationId, declarations, planned)
    const releasing = confirmedReleaseKeys(
      input.retiredBlockIds ?? [],
      planned,
      this.live,
      this.claimGate,
    )
    const rebuilt = await this.rebuildRuntimes(planned, declarations, restart, rebuildErrors)
    await Promise.all(rebuilt.stopped.map((runtime) => runtime.quiesce()))
    const unreleasedClaims = await this.releaseConfirmed(releasing)
    await this.syncSources(rebuilt)
    this.forwards?.sync(forwardBlocksOf(input.blocks))
    await this.actuators?.sync(
      input.blocks.flatMap((block) => {
        const helper = block.composition.helper
        if (helper !== undefined && helper.kind !== 'group') return []
        return [{ id: block.id, helper }]
      }),
    )
    await adoptMathQuantities(
      input.blocks.map((block) => ({ id: block.id, helper: block.composition.helper })),
      {
        logger: this.deps.logger.child('math'),
        sourceDeviceId: (ref) => {
          const found = this.deps.tracker.resolution(ref)
          return found.kind === 'found' ? found.deviceId : null
        },
        deviceIdOf: (blockId) => {
          const entry = this.live.get(blockId)
          return entry === undefined ? null : this.deviceIdOf(entry)
        },
        ...(this.deps.readSourceQuantity === undefined
          ? {}
          : { sourceQuantity: this.deps.readSourceQuantity }),
        adopt: (blockId, quantity) => this.adoptQuantityOf(blockId, quantity),
      },
    )
    this.historySpecs = historySpecsOf(input.blocks)
    this.history?.start()
    await this.reconcileClaims()
    return {
      blocks: planned.map((p) => this.verdict(p.block.id)),
      acted: true,
      unreleasedClaims,
    }
  }

  private plan(
    block: ComposerBlock,
    restart: ReadonlySet<string>,
    claimsWait: string | null,
  ): Promise<PlannedBlock> {
    const target = block.composition.target
    if (target.kind === 'new')
      return Promise.resolve(planNew(block, target, this.deps.lookupCap, this.composed.rows))
    const previous = this.live.get(block.id)?.planned
    return planExisting({
      block,
      target,
      previous,
      operatorAction:
        previous === undefined ||
        restart.has(block.id) ||
        previous.block.updatedAt !== block.updatedAt,
      claimsWait,
      tracker: this.deps.tracker,
      targets: this.targets,
      lookupCap: this.deps.lookupCap,
    })
  }

  private async rebuildRuntimes(
    planned: readonly PlannedBlock[],
    declarations: readonly DeviceDeclaration[],
    restart: ReadonlySet<string>,
    rebuildErrors: ReadonlyMap<string, string>,
  ): Promise<RuntimeRebuild> {
    const reset = new Set<string>()
    const fresh = new Set<CompositionRuntime>()
    const stopped: CompositionRuntime[] = []
    const next = new Map<string, LiveComposition>()
    const halt = (runtime: CompositionRuntime | null): void => {
      if (runtime === null) return
      runtime.stop()
      stopped.push(runtime)
    }
    for (const p of planned) {
      const previous = this.live.get(p.block.id)
      const lost = lostTarget(p, previous?.planned)
      if (lost !== null) this.ungraftGone(p.block.id, lost.target, lost.deviceId)
      const rebuildError = rebuildErrors.get(p.block.id) ?? null
      if (previous !== undefined && rebuildError !== null) {
        // The old device is still live: keep its plan too, so the next apply retries.
        next.set(p.block.id, { ...previous, rebuildError })
        continue
      }
      const device =
        p.target.kind === 'existing' ? null : this.composed.get(composedDeviceStableId(p.block.id))
      const appliedName =
        device === null
          ? null
          : p.block.name === null
            ? (previous?.appliedName ?? device.name)
            : await this.applyName(device, p.block.name, previous?.appliedName ?? null)
      const unchanged =
        previous?.runtime != null &&
        previous.device === device &&
        sameTarget(previous.planned.target, p.target) &&
        previous.planned.block.updatedAt === p.block.updatedAt &&
        previous.planned.block.enabled === p.block.enabled &&
        !restart.has(p.block.id)
      if (unchanged) {
        next.set(p.block.id, {
          planned: p,
          device,
          runtime: previous.runtime,
          appliedName,
          rebuildError: null,
          heldFields: [],
        })
        continue
      }
      let targetSeed: ExistingTargetSeedRead | undefined
      let pulseSeeds: ReadonlyMap<string, PulseFieldSeed> | undefined
      if (
        p.target.kind === 'existing' &&
        p.target.deviceId !== null &&
        p.target.waiting === null &&
        p.target.gone === null &&
        p.block.enabled &&
        p.fields.length > 0
      ) {
        try {
          targetSeed = await readExistingTargetSeeds(
            p.target.deviceId,
            p.fields.map((field) => field.cap),
            this.deps.readExistingTargetCap,
          )
          reportSeedlessRestoredCaps({
            logger: this.deps.logger,
            blockId: p.block.id,
            deviceId: p.target.deviceId,
            features: p.target.features,
            seed: targetSeed,
            lookupCap: this.deps.lookupCap,
          })
          const readHistory = this.deps.readPulseHistory
          if (readHistory !== undefined) {
            pulseSeeds = await resolvePulseSeeds({
              blockId: p.block.id,
              deviceId: p.target.deviceId,
              fields: p.fields,
              targetSeed,
              lookupCap: this.deps.lookupCap,
              claims: this.deps.claims,
              sources: this.deps.tracker,
              readCap: this.deps.readExistingTargetCap,
              readPulseHistory: readHistory,
              now: this.deps.now,
              logger: this.deps.logger,
            })
          }
        } catch (err: unknown) {
          const reason =
            `the target device state could not be read before ownership (${errMsg(err)}) — ` +
            'nothing is grafted or claimed until it is; retried on the next apply'
          this.deps.logger.warn(
            previous?.runtime === null || previous === undefined
              ? 'customization target state could not be read — ownership is held'
              : 'customization edit target state could not be read — the previous runtime stays installed',
            {
              tags: { deviceId: p.target.deviceId },
              meta: { blockId: p.block.id, error: errMsg(err) },
            },
          )
          if (previous !== undefined) next.set(p.block.id, previous)
          else
            next.set(p.block.id, {
              planned: withExistingTargetWait(p, reason),
              device: null,
              runtime: null,
              appliedName: null,
              rebuildError: null,
              heldFields: [],
            })
          continue
        }
      }
      // Rule 4: a customization that stops planning keeps its claims, so the hub
      // keeps its last values — read them before the runtime goes.
      const heldFields = this.heldFieldsFor(p, previous)
      // Only the operator re-opens the sources this block reads: a restart, an
      // edit, or the block's first appearance. A block whose device has not
      // built lands here on EVERY apply — resetting then would re-read a
      // source it shares with a healthy block each converge (a poll) and drop
      // that source's sticky `missing` (auto-repair). D3. The target itself was
      // re-resolved by `planExisting` already: never twice.
      const operatorAction =
        previous === undefined ||
        restart.has(p.block.id) ||
        previous.planned.block.updatedAt !== p.block.updatedAt
      if (operatorAction) for (const key of operatorResetKeys(p)) reset.add(key)
      // A placeholder plans no field, so it never runs a runtime.
      const writer = writerFor(this.deps, p, device, (deviceId, cap, owner, event) => {
        void this.onClaimEvent(deviceId, cap, owner, event)
      })
      const runtime =
        writer === null || p.fields.length === 0
          ? null
          : newCompositionRuntime(this.deps, p, writer, targetSeed, pulseSeeds)
      if (writer !== null && p.target.kind === 'existing' && p.target.deviceId !== null)
        this.grafts.plan({
          deviceId: p.target.deviceId,
          ref: p.target.ref,
          features: p.target.features,
          nativeCaps: p.target.nativeCaps,
          enabled: p.block.enabled,
          settled: p.problems.length === 0,
        })
      halt(previous?.runtime ?? null)
      if (runtime !== null) fresh.add(runtime)
      next.set(p.block.id, {
        planned: p,
        device,
        runtime,
        appliedName,
        rebuildError: null,
        heldFields,
      })
    }
    // A block missing once is carried by the gate: keep its runtime too.
    const held = new Set(declarations.map((d) => d.stableId))
    for (const [blockId, entry] of this.live) {
      if (next.has(blockId)) continue
      if (held.has(composedDeviceStableId(blockId))) next.set(blockId, entry)
      else halt(entry.runtime)
    }
    this.live = next
    const liveRuntimes = new Set([...next.values()].map((e) => e.runtime))
    this.unsynced = new Set([...[...this.unsynced].filter((r) => liveRuntimes.has(r)), ...fresh])
    return { reset, stopped }
  }

  private ungraftGone(blockId: string, target: PlannedExistingTarget, deviceId: number): void {
    this.grafts.gone(deviceId)
    ungraftGoneTarget({
      grafts: this.deps.grafts,
      logger: this.deps.logger,
      blockId,
      deviceId,
      ref: target.ref,
      features: target.features,
    })
  }

  /** C-1/N-1: the tracker follows the block's OWN claim as the hub answers it; every answer re-reads the native once. */
  private async onClaimEvent(
    deviceId: number,
    cap: string,
    owner: string,
    event: ClaimEvent,
  ): Promise<void> {
    try {
      this.dispatch(await this.deps.tracker.claimEvent(deviceId, cap, owner, event))
    } catch (err: unknown) {
      this.deps.logger.warn('composer: following a claim transition failed', {
        tags: { deviceId },
        meta: { cap, owner, event, error: errMsg(err) },
      })
    }
  }

  private heldFieldsFor(
    p: PlannedBlock,
    previous: LiveComposition | undefined,
  ): readonly CompositionFieldState[] {
    if (p.target.kind !== 'existing' || p.problems.length === 0 || previous === undefined) return []
    if (previous.runtime === null) return previous.heldFields
    return heldFieldsOf(
      previous.runtime.state().fields,
      `the composition no longer plans — the field keeps its last value on the device: ${p.problems.join('; ')}`,
    )
  }

  private async applyName(
    device: ComposedDeviceHandle,
    name: string,
    applied: string | null,
  ): Promise<string> {
    if ((applied ?? device.name) === name) return name
    try {
      await this.deps.devices.setName(device.id, name)
      this.deps.logger.info('composed device renamed after its block', {
        tags: { deviceId: device.id },
        meta: { name },
      })
      return name
    } catch (err: unknown) {
      this.deps.logger.warn('composed device rename failed — retried on the next apply', {
        tags: { deviceId: device.id },
        meta: { name, error: errMsg(err) },
      })
      return applied ?? device.name
    }
  }

  private async syncSources(rebuilt: RuntimeRebuild): Promise<void> {
    const requests = trackedSourceRequests(this.live.values())
    const changed = await this.syncTracker(requests, rebuilt.reset)
    for (const entry of this.live.values()) {
      const runtime = entry.runtime
      if (runtime === null) continue
      const fresh = this.unsynced.has(runtime)
      this.unsynced = new Set([...this.unsynced].filter((r) => r !== runtime))
      if (!entry.planned.block.enabled) runtime.disable('the block is disabled')
      else if (fresh) runtime.start()
      else runtime.onSourcesChanged(changed)
    }
  }

  /** A failed sync leaves the tracker as it was: the runtimes read what it holds. */
  private async syncTracker(
    requests: readonly TrackedSourceRequest[],
    reset: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>> {
    try {
      return await this.deps.tracker.sync(requests, reset)
    } catch (err: unknown) {
      this.deps.logger.warn(
        'composer: syncing the tracked sources failed — retried on the next apply',
        {
          meta: { error: errMsg(err), sources: requests.length },
        },
      )
      return new Set()
    }
  }

  /** Rule 3: release what no live customization wants, once two applies agree (`wantedClaims`). */
  private async reconcileClaims(): Promise<void> {
    if (!this.claimSeed.done) return
    for (const key of this.claimGate.filter(wantedClaims(this.live, this.claimGate)))
      await this.release(key)
  }

  /** Confirmed releases, awaited. A failure is the string the hub gave; the gate retries it later. */
  private async releaseConfirmed(keys: readonly ClaimKey[]): Promise<UnreleasedClaim[]> {
    const unreleased: UnreleasedClaim[] = []
    for (const key of keys) {
      const error = await this.release(key)
      if (error === null) continue
      unreleased.push({
        deviceId: key.deviceId,
        capName: key.capName,
        owner: key.owner,
        error,
      })
    }
    return unreleased
  }

  /** Null when the hub confirmed the release (or held nothing of ours). */
  private async release(key: ClaimKey): Promise<string | null> {
    let outcome: ClaimOutcome
    try {
      outcome = await this.deps.claims.releaseClaim(key)
    } catch (err: unknown) {
      const error = errMsg(err)
      this.claimGate.releaseFailed(key, error)
      return error
    }
    if (!outcome.ok && !RELEASE_SETTLED_CODES.has(outcome.code)) {
      const error = `${outcome.code}: ${outcome.message}`
      this.claimGate.releaseFailed(key, error)
      return error
    }
    this.claimGate.released(key, outcome.ok ? 'released' : outcome.code)
    await this.grafts.released(key.deviceId, key.capName)
    await this.onClaimEvent(key.deviceId, key.capName, key.owner, 'free')
    return null
  }

  /**
   * Rule 5: a customization whose target row is gone — the tracker's two
   * agreeing reads — fails naming it, stops writing, and ungrafts every cap it
   * added on that id (Task 10's seam). Its claims are left as they are: the row
   * and its `$owned` died with the device. No auto-repair: an operator edit or
   * restart re-resolves the target.
   */
  private failGoneTargets(deviceId: number): void {
    const next = new Map(this.live)
    for (const [blockId, entry] of this.live) {
      const target = entry.planned.target
      if (target.kind !== 'existing' || target.deviceId !== deviceId || target.gone !== null)
        continue
      const resolution = this.deps.tracker.resolution(target.ref)
      if (resolution.kind !== 'missing') continue
      entry.runtime?.stop()
      this.unsynced = new Set([...this.unsynced].filter((r) => r !== entry.runtime))
      this.ungraftGone(blockId, target, deviceId)
      next.set(blockId, {
        ...entry,
        runtime: null,
        planned: {
          ...entry.planned,
          target: { ...target, gone: `${resolution.reason} — two index reads agreed` },
        },
      })
    }
    this.live = next
  }

  private dispatch(changed: ReadonlySet<string>): void {
    if (changed.size === 0) return
    for (const entry of this.live.values()) {
      const runtime = entry.runtime
      if (runtime === null || !entry.planned.block.enabled) continue
      // A runtime its apply has not synced yet is that sync's to start (N-5).
      if (!this.unsynced.has(runtime)) runtime.onSourcesChanged(changed)
    }
  }

  private deviceIdOf(entry: LiveComposition): number | null {
    if (entry.device !== null) return entry.device.id
    return entry.planned.target.kind === 'existing' ? entry.planned.target.deviceId : null
  }

  private tagsOf(blockId: string): LogTags {
    const entry = this.live.get(blockId)
    const deviceId =
      this.composed.idOf(composedDeviceStableId(blockId)) ??
      (entry === undefined ? null : this.deviceIdOf(entry))
    return deviceId === null ? {} : { deviceId }
  }

  private verdict(blockId: string): ComposerBlockVerdict {
    const entry = this.live.get(blockId)
    const runtime = entry?.runtime ?? null
    const target = entry?.planned.target
    const grafts =
      target?.kind === 'existing' && target.deviceId !== null
        ? this.grafts.verdict(target.deviceId, target.features)
        : null
    return verdictOf(blockId, entry, runtime !== null && this.unsynced.has(runtime), grafts)
  }
}

function historySpecsOf(blocks: readonly ComposerBlock[]): ReadonlyMap<string, HistoryHelperSpec> {
  const specs = new Map<string, HistoryHelperSpec>()
  for (const block of blocks) {
    const helper = block.composition.helper
    if (helper === undefined || !isHistoryHelper(helper)) continue
    specs.set(block.id, helper)
  }
  return specs
}

/** The fan-out ports a deployment without actuator helpers does not attach: a call names that. */
const unattachedMemberRead: NonNullable<ComposerDeps['readActuatorMember']> = async () => ({
  kind: 'unreadable',
  error: 'actuator groups are not attached',
})
const unattachedInvoke: NonNullable<ComposerDeps['invokeActuator']> = async () => {
  throw new Error('actuator fan-out is not attached')
}

/** The forwards of the enabled blocks that build a NEW device: the only target a built cap's commands serve (D967). */
function forwardBlocksOf(blocks: readonly ComposerBlock[]): readonly ForwardBlock[] {
  return blocks.flatMap((block): readonly ForwardBlock[] => {
    if (!block.enabled || block.composition.target.kind !== 'new') return []
    const features = block.composition.features.flatMap((feature) =>
      feature.kind === 'fields' && compositionFeatureEnabled(feature) ? [feature] : [],
    )
    return [{ id: block.id, features }]
  })
}
