import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  type ClaimOutcome,
  type ClaimsListing,
  type CompositionFieldPlan,
  type CompositionSourceRef,
  compositionSourceKey,
  DeviceType,
  type FieldClaimMode,
  type IScopedLogger,
  type LogExtras,
  planComposition,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import type {
  ComposedWriteTarget,
  DeadlineTimer,
  TargetAsyncFailure,
  WriteOutcome,
} from '../composition-runtime.js'
import type { ComposerClaimsApi } from '../existing-target.js'
import type { ClaimFieldsInput } from '../owned-fields-target.js'
import type { SlicePatch } from '../slice-assembler.js'
import type {
  BoundCapsRead,
  SliceRead,
  SliceView,
  SourceListRead,
  SourceTrackerPorts,
} from '../source-tracker.js'

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
}

export interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly lines: LogLine[]
}

export function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = []
  const logger: IScopedLogger = {
    debug: (message, extras) => lines.push({ level: 'debug', message, extras }),
    info: (message, extras) => lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

/** One per-field claim the fake hub holds, as the real mirror would (D663). */
export interface FakeClaim {
  readonly owner: string
  readonly mode: FieldClaimMode
  readonly fields: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * An in-memory hub: device rows by owner, NATIVE cap slices, bindings, per-field
 * claims and a call log. `readSlice` in the `effective` view answers the merge
 * of the native and the claim, exactly as the mirror does; the `native` view
 * answers what the provider wrote.
 */
export class FakeHub {
  private readonly rows = new Map<string, Map<string, number>>()
  private readonly slices = new Map<string, Readonly<Record<string, unknown>>>()
  private readonly bound = new Map<number, Set<string>>()
  private readonly addonOf = new Map<number, string>()
  /** A cap served by an addon other than the row's own (a composer graft): `${id}#${cap}` → addonId. */
  private readonly boundBy = new Map<string, string>()
  private readonly types = new Map<number, DeviceType>()
  private readonly failing = new Set<string>()
  private readonly failingBindings = new Set<number>()
  private readonly claims = new Map<string, FakeClaim>()
  readonly calls: string[] = []
  /** Answers for the NEXT list reads of an addon, consumed in order. */
  readonly scriptedLists = new Map<string, SourceListRead[]>()
  /** Answers for the NEXT `listClaims` reads, consumed in order; then the live claims. */
  readonly scriptedClaims: ClaimsListing[] = []
  /** How many of the next `releaseClaim` calls THROW (the hub unreachable). */
  failReleases = 0
  /** When set, runs after a claim is stored and BEFORE `claimFields` answers — the real mirror emits its merge there (N-1). */
  beforeClaimReturns: ((input: ClaimFieldsInput) => Promise<void>) | null = null
  /** When set, every hub read awaits it first: the window in which an event can race a hydration (R3). */
  slowRead: Promise<void> | null = null

  add(
    ref: CompositionSourceRef,
    id: number,
    caps: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    type: DeviceType = DeviceType.Sensor,
  ): void {
    const owned = this.rows.get(ref.addonId) ?? new Map<string, number>()
    owned.set(ref.stableId, id)
    this.rows.set(ref.addonId, owned)
    this.bound.set(id, new Set(Object.keys(caps)))
    this.addonOf.set(id, ref.addonId)
    this.types.set(id, type)
    for (const [cap, slice] of Object.entries(caps)) this.slices.set(`${id}#${cap}`, slice)
  }

  remove(ref: CompositionSourceRef): void {
    this.rows.get(ref.addonId)?.delete(ref.stableId)
  }

  /** A NATIVE write, as the provider makes it. */
  setSlice(id: number, cap: string, slice: Readonly<Record<string, unknown>>): void {
    this.slices.set(`${id}#${cap}`, slice)
  }

  /** Every read of this slice answers `unreadable` from now on. */
  failSlice(id: number, cap: string): void {
    this.failing.add(`${id}#${cap}`)
  }

  /** Reads of this slice answer again. */
  healSlice(id: number, cap: string): void {
    this.failing.delete(`${id}#${cap}`)
  }

  /** The cap stays bound; the device has simply never reported it. */
  clearSlice(id: number, cap: string): void {
    this.slices.delete(`${id}#${cap}`)
  }

  /** The provider unregistered the cap: `getBindings` no longer lists it (the slice stays, as the mirror keeps it). */
  unbind(id: number, cap: string): void {
    this.bound.get(id)?.delete(cap)
    this.boundBy.delete(`${id}#${cap}`)
  }

  bind(id: number, cap: string): void {
    this.bound.set(id, new Set([...(this.bound.get(id) ?? []), cap]))
  }

  /** `cap` is bound on `id` by `addonId` — e.g. the composer's own graft, as `getBindings` lists it. */
  bindAs(id: number, cap: string, addonId: string): void {
    this.bind(id, cap)
    this.boundBy.set(`${id}#${cap}`, addonId)
  }

  /** Every `getBindings` of this device answers `unreadable` until `healBindings`. */
  failBindings(id: number): void {
    this.failingBindings.add(id)
  }

  healBindings(id: number): void {
    this.failingBindings.delete(id)
  }

  /** A claim persisted before this process started (the boot seed reads it). */
  seedClaim(id: number, cap: string, claim: FakeClaim): void {
    this.claims.set(`${id}#${cap}`, claim)
  }

  claim(id: number, cap: string): FakeClaim | undefined {
    return this.claims.get(`${id}#${cap}`)
  }

  /** What every consumer reads: the native under the claim's values. */
  effective(id: number, cap: string): Readonly<Record<string, unknown>> | undefined {
    const native = this.slices.get(`${id}#${cap}`)
    const claim = this.claims.get(`${id}#${cap}`)
    if (claim === undefined) return native
    return claim.mode === 'add' ? claim.values : { ...native, ...claim.values }
  }

  claimsApi(): ComposerClaimsApi {
    return {
      claimFields: async (input): Promise<ClaimOutcome> => {
        this.calls.push(`claim:${input.deviceId}#${input.capName}`)
        await this.settle()
        if (!this.addonOf.has(input.deviceId))
          return { ok: false, code: 'unknown-device', message: `no device ${input.deviceId}` }
        const slot = `${input.deviceId}#${input.capName}`
        const existing = this.claims.get(slot)
        if (existing !== undefined && existing.owner !== input.owner)
          return { ok: false, code: 'owned-by-other', message: `owned by ${existing.owner}` }
        this.claims.set(slot, {
          owner: input.owner,
          mode: input.mode,
          fields: [...input.fields],
          values: { ...existing?.values, ...input.values },
        })
        if (this.beforeClaimReturns !== null) await this.beforeClaimReturns(input)
        return { ok: true, changed: true }
      },
      patchOwnedFields: async (input): Promise<ClaimOutcome> => {
        this.calls.push(`patch:${input.deviceId}#${input.capName}`)
        await this.settle()
        const slot = `${input.deviceId}#${input.capName}`
        const existing = this.claims.get(slot)
        if (existing === undefined)
          return { ok: false, code: 'not-claimed', message: `nothing claimed on ${slot}` }
        if (existing.owner !== input.owner)
          return { ok: false, code: 'owned-by-other', message: `owned by ${existing.owner}` }
        this.claims.set(slot, { ...existing, values: { ...existing.values, ...input.values } })
        return { ok: true, changed: true }
      },
      releaseClaim: async (input): Promise<ClaimOutcome> => {
        this.calls.push(`release:${input.deviceId}#${input.capName}`)
        await this.settle()
        if (this.failReleases > 0) {
          this.failReleases -= 1
          throw new Error('hub unreachable')
        }
        const slot = `${input.deviceId}#${input.capName}`
        const existing = this.claims.get(slot)
        if (existing === undefined)
          return { ok: false, code: 'not-claimed', message: `nothing claimed on ${slot}` }
        if (existing.owner !== input.owner)
          return { ok: false, code: 'owned-by-other', message: `owned by ${existing.owner}` }
        this.claims.delete(slot)
        return { ok: true, changed: true }
      },
      listClaims: async (): Promise<ClaimsListing> => {
        this.calls.push('listClaims')
        await this.settle()
        const scripted = this.scriptedClaims.shift()
        if (scripted !== undefined) return scripted
        return {
          state: 'loaded',
          claims: [...this.claims].map(([slot, claim]) => {
            const [deviceId, capName] = slot.split('#')
            return {
              deviceId: Number(deviceId),
              capName: capName ?? '',
              owner: claim.owner,
              mode: claim.mode,
              fields: [...claim.fields],
            }
          }),
        }
      },
    }
  }

  ports(logger: IScopedLogger): SourceTrackerPorts {
    return {
      logger,
      listDevicesOf: async (addonId): Promise<SourceListRead> => {
        this.calls.push(`list:${addonId}`)
        await this.settle()
        const scripted = this.scriptedLists.get(addonId)?.shift()
        if (scripted !== undefined) return scripted
        const owned = this.rows.get(addonId) ?? new Map<string, number>()
        return {
          kind: 'rows',
          rows: [...owned].map(([stableId, id]) => ({
            id,
            stableId,
            type: this.types.get(id) ?? DeviceType.Sensor,
          })),
        }
      },
      readSlice: async (deviceId, capName, view: SliceView): Promise<SliceRead> => {
        this.calls.push(`${view === 'native' ? 'native' : 'slice'}:${deviceId}#${capName}`)
        await this.settle()
        if (this.failing.has(`${deviceId}#${capName}`))
          return { kind: 'unreadable', error: 'timeout' }
        const slice =
          view === 'native'
            ? this.slices.get(`${deviceId}#${capName}`)
            : this.effective(deviceId, capName)
        return slice === undefined ? { kind: 'none' } : { kind: 'slice', slice }
      },
      readBoundCaps: async (deviceId): Promise<BoundCapsRead> => {
        this.calls.push(`bindings:${deviceId}`)
        await this.settle()
        if (this.failingBindings.has(deviceId))
          return { kind: 'unreadable', error: 'bindings timeout' }
        const addonId = this.addonOf.get(deviceId) ?? 'unknown'
        return {
          kind: 'caps',
          caps: new Map(
            [...(this.bound.get(deviceId) ?? [])].map((cap) => [
              cap,
              this.boundBy.get(`${deviceId}#${cap}`) ?? addonId,
            ]),
          ),
        }
      },
    }
  }

  private async settle(): Promise<void> {
    if (this.slowRead !== null) await this.slowRead
  }
}

export function key(ref: CompositionSourceRef): string {
  return compositionSourceKey(ref)
}

export const LOOKUP_CAP = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)

export function roomPlan(): readonly CompositionFieldPlan[] {
  const composition = roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
  })
  const plan = planComposition(composition, LOOKUP_CAP)
  if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
  return plan.fields
}

export class FakeTimer implements DeadlineTimer {
  armedAt: number | null = null
  private fire: (() => void) | null = null
  arm(at: number, fire: () => void): void {
    this.armedAt = at
    this.fire = fire
  }
  disarm(): void {
    this.armedAt = null
    this.fire = null
  }
  trigger(): void {
    const fire = this.fire
    this.disarm()
    fire?.()
  }
}

export interface TargetWrite {
  readonly op: 'seed' | 'patch'
  readonly cap: string
  readonly values: SlicePatch
}

export interface TargetWithhold {
  readonly cap: string
  readonly fields: readonly string[]
}

export class FakeTarget implements ComposedWriteTarget {
  readonly writes: TargetWrite[] = []
  readonly withholds: TargetWithhold[] = []
  readonly availability: boolean[] = []
  refuse: string | null = null
  /** When set, every write THROWS this — a target breaking its no-throw contract. */
  throwing: string | null = null
  private asyncListener: ((cap: string, failure: TargetAsyncFailure) => void) | null = null
  constructor(
    readonly id: number,
    readonly name = 'Living room',
  ) {}
  seed(cap: string, slice: SlicePatch): WriteOutcome {
    if (this.throwing !== null) throw new Error(this.throwing)
    if (this.refuse !== null) return { ok: false, error: this.refuse }
    this.writes.push({ op: 'seed', cap, values: slice })
    return { ok: true }
  }
  patch(cap: string, patch: SlicePatch): WriteOutcome {
    if (this.throwing !== null) throw new Error(this.throwing)
    if (this.refuse !== null) return { ok: false, error: this.refuse }
    this.writes.push({ op: 'patch', cap, values: patch })
    return { ok: true }
  }
  withhold(cap: string, fields: readonly string[]): WriteOutcome {
    if (this.throwing !== null) throw new Error(this.throwing)
    this.withholds.push({ cap, fields })
    return { ok: true }
  }
  onAsyncFailure(listener: (cap: string, failure: TargetAsyncFailure) => void): void {
    this.asyncListener = listener
  }
  /** What a claim-backed target reports when an enqueued RPC did not land. */
  failAsync(cap: string, failure: TargetAsyncFailure): void {
    if (this.asyncListener === null) throw new Error('no async listener subscribed')
    this.asyncListener(cap, failure)
  }
  /** How many next `setAvailable` calls throw. */
  availabilityThrows = 0
  setAvailable(available: boolean): void {
    if (this.availabilityThrows > 0) {
      this.availabilityThrows -= 1
      throw new Error('availability rejected')
    }
    this.availability.push(available)
  }
}
