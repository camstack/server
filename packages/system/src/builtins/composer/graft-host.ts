/**
 * Grafts (D663): a method-serving native provider for a cap a customization
 * ADDS to a device the composer does not own — a battery on an HA pet feeder
 * that registers none. Without it the added cap has claimed values on the hub
 * but nothing answers its methods, so `getBindings` never lists it and a caller
 * of `battery.wakeForStream` finds no provider.
 *
 * - The provider is built ONLY from the cap's `composedMethods` (Task 1): an
 *   `answer` resolves to its value, a `refuse` rejects naming its reason. A cap
 *   with a served method that has no composed answer is refused here as it is
 *   at plan time (`has-commands`, slice 1). `getStatus` reads the MERGED slice
 *   (`readMerged`): the hub overlays it anyway (Task 7), but a direct call to
 *   this runner must never answer `{}`.
 * - The context is `createContext(stableId, id)` on a FOREIGN device id: the
 *   second use of the forked-runner native path D659 lists as unverified live
 *   (D659 live item 1). Task 16 step 4.1 is its live proof. Its EMPTY runtime
 *   state is correct and deliberate (D677): no device is built from it and no
 *   slice is written through it — the graft only registers method-serving
 *   natives, and `getStatus` reads the hub's merged slice.
 * - `ungraft` removes only what THIS host registered, through the context's
 *   optional `unregisterNativeCap`. An older kernel without it leaves the graft
 *   routable until the composer respawns — warned once per device, never
 *   silent.
 */
import {
  type CapabilityDefinition,
  type CapabilityLookup,
  type DeviceContext,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'
import type { ComposerGraftPorts } from './existing-target.js'

export interface GraftPorts {
  readonly createContext: (stableId: string, id: number) => DeviceContext
  readonly logger: IScopedLogger
}

export type GraftOutcome =
  | { readonly kind: 'grafted' }
  | { readonly kind: 'already' }
  | { readonly kind: 'refused'; readonly reason: string }

/** The merged (effective) slice of `cap` on `deviceId`, as every consumer reads it; null when there is none. */
export type ReadMergedSlice = (
  deviceId: number,
  cap: string,
) => Promise<Readonly<Record<string, unknown>> | null>

/** How a composed provider answers one method (`CapabilityDefinition.composedMethods`, Task 1). */
type ComposedMethodAnswer = NonNullable<CapabilityDefinition['composedMethods']>[string]

/** One grafted method: the composed answer, or the merged-slice status read. */
type GraftMethod = (input: unknown) => Promise<unknown>

/** What asking the kernel to unregister did. */
type UnregisterOutcome = 'unregistered' | 'unsupported' | 'threw'

/** The provider a graft registers: method name → its composed implementation. */
export type GraftProvider = Readonly<Record<string, GraftMethod>>

/** The served methods of `def` that have no composed answer — non-empty means the cap cannot be grafted. */
function unanswered(def: CapabilityDefinition): readonly string[] {
  return Object.entries(def.methods)
    .filter(([name, m]) => m.systemOnly !== true && def.composedMethods?.[name] === undefined)
    .map(([name]) => name)
}

function isSliceRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A slice field that is present. Unknown throws — it is not false or 0 (D393). */
function sliceField(slice: Readonly<Record<string, unknown>> | null, field: string): unknown {
  const value = slice?.[field]
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  throw new Error(`composed ${field} is unknown — not a stand-in value`)
}

function composedMethod(
  answer: ComposedMethodAnswer,
  readSlice: () => Promise<Readonly<Record<string, unknown>> | null>,
): GraftMethod {
  if (answer.kind === 'answer') return async () => answer.value
  if (answer.kind === 'slice') {
    const field = answer.field
    return async () => sliceField(await readSlice(), field)
  }
  return async () => {
    throw new Error(answer.reason)
  }
}

export class GraftHost implements ComposerGraftPorts {
  /** One context per foreign device: `registerNativeCap` is per context, and so is its unregister. */
  private contexts: ReadonlyMap<number, DeviceContext> = new Map()
  private caps: ReadonlyMap<number, ReadonlySet<string>> = new Map()
  /** Devices already warned that this kernel cannot unregister a graft. */
  private warnedNoUnregister: ReadonlySet<number> = new Set()

  constructor(
    private readonly ports: GraftPorts,
    private readonly lookupCap: CapabilityLookup,
    private readonly readMerged: ReadMergedSlice,
  ) {}

  graft(deviceId: number, stableId: string, capName: string): GraftOutcome {
    if (this.grafted(deviceId).has(capName)) return { kind: 'already' }
    const def = this.lookupCap(capName)
    if (def === null) return this.refuse(deviceId, capName, `unknown capability \`${capName}\``)
    const missing = unanswered(def)
    if (missing.length > 0) {
      return this.refuse(
        deviceId,
        capName,
        `\`${capName}\` has ${missing.map((m) => `\`${m}\``).join(', ')} with no composed answer — a graft cannot serve it until commands arrive (slice 3)`,
      )
    }
    const ctx = this.contextFor(deviceId, stableId)
    try {
      ctx.registerNativeCap(def, this.providerFor(deviceId, def))
    } catch (err: unknown) {
      return this.refuse(deviceId, capName, `registerNativeCap threw — ${errMsg(err)}`)
    }
    this.caps = new Map([...this.caps, [deviceId, new Set([...this.grafted(deviceId), capName])]])
    this.ports.logger.info('graft: an added cap is served on a device the composer does not own', {
      tags: { deviceId },
      meta: { cap: capName, stableId },
    })
    return { kind: 'grafted' }
  }

  ungraft(deviceId: number, capName: string, reason: string): void {
    if (!this.grafted(deviceId).has(capName)) return
    const ctx = this.contexts.get(deviceId)
    if (ctx === undefined) return
    const outcome = this.unregister(ctx, deviceId, capName, reason)
    if (outcome === 'threw') return
    const remaining = new Set([...this.grafted(deviceId)].filter((c) => c !== capName))
    this.caps = new Map([...this.caps, [deviceId, remaining]])
    if (outcome === 'unregistered')
      this.ports.logger.info('graft removed', {
        tags: { deviceId },
        meta: { cap: capName, reason },
      })
  }

  /**
   * I-3: a binding a PREVIOUS composer process left on `deviceId` — this one
   * never registered it. The kernel retracts it under the composer's addon id;
   * the hub drops only an entry the composer registered (rule 4). The caller has
   * read that the binding is the composer's.
   */
  retractStale(deviceId: number, capName: string, reason: string): void {
    if (this.grafted(deviceId).has(capName)) {
      this.ungraft(deviceId, capName, reason)
      return
    }
    // The stable id only labels the context's logger: a retract names the device by id.
    const ctx = this.contextFor(deviceId, `graft-retract:${deviceId}`)
    if (this.unregister(ctx, deviceId, capName, reason) === 'unregistered')
      this.ports.logger.info('graft left by a previous composer process retracted', {
        tags: { deviceId },
        meta: { cap: capName, reason },
      })
  }

  grafted(deviceId: number): ReadonlySet<string> {
    return this.caps.get(deviceId) ?? new Set()
  }

  /** A throw keeps the graft known, so a later plan retries (M-2); an older kernel forgets it (warned once). */
  private unregister(
    ctx: DeviceContext,
    deviceId: number,
    capName: string,
    reason: string,
  ): UnregisterOutcome {
    if (ctx.unregisterNativeCap === undefined) {
      if (!this.warnedNoUnregister.has(deviceId)) {
        this.warnedNoUnregister = new Set([...this.warnedNoUnregister, deviceId])
        this.ports.logger.warn(
          'graft: this kernel cannot unregister a native — the graft stays routable until the composer respawns',
          { tags: { deviceId }, meta: { cap: capName, reason } },
        )
      }
      // Nothing more this process can do: forgotten, so it is not retried forever.
      return 'unsupported'
    }
    try {
      ctx.unregisterNativeCap(capName)
      return 'unregistered'
    } catch (err: unknown) {
      this.ports.logger.error(
        'graft: unregistering the added cap threw — it stays routable and is retried by the next plan',
        { tags: { deviceId }, meta: { cap: capName, reason, error: errMsg(err) } },
      )
      return 'threw'
    }
  }

  private contextFor(deviceId: number, stableId: string): DeviceContext {
    const existing = this.contexts.get(deviceId)
    if (existing !== undefined) return existing
    const ctx = this.ports.createContext(stableId, deviceId)
    this.contexts = new Map([...this.contexts, [deviceId, ctx]])
    return ctx
  }

  private providerFor(deviceId: number, def: CapabilityDefinition): GraftProvider {
    const readSlice = async (): Promise<Readonly<Record<string, unknown>> | null> => {
      const slice = await this.readMerged(deviceId, def.name)
      return isSliceRecord(slice) ? slice : null
    }
    const answers = Object.entries(def.composedMethods ?? {}).map(
      ([name, answer]) => [name, composedMethod(answer, readSlice)] as const,
    )
    const withStatus =
      def.status === undefined && def.runtimeState === undefined
        ? []
        : [['getStatus', async () => this.readMerged(deviceId, def.name)] as const]
    return Object.fromEntries([...answers, ...withStatus])
  }

  private refuse(deviceId: number, capName: string, reason: string): GraftOutcome {
    this.ports.logger.error('graft refused — the added cap has no method-serving native', {
      tags: { deviceId },
      meta: { cap: capName, reason },
    })
    return { kind: 'refused', reason }
  }
}
