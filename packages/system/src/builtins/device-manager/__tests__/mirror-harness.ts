/**
 * Shared `DeviceStateMirror` fixture (ruling M, D663): one harness for the
 * durability spec and the ownership spec instead of a verbatim copy in each.
 *
 * `policy` defaults to a small injected table so the gate can be exercised
 * without the real cap set; pass `runtimeStatePolicyFor` to test a real cap.
 */
import { vi } from 'vitest'
import type { AddonContext, RuntimeStatePolicy } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { type ClaimsIndexView, DeviceStateMirror } from '../device-state-mirror.js'
import type { DeviceManagerSettings } from '../device-meta-store.js'
import type { RuntimeStatePolicyLookup } from '../runtime-state-persist-gate.js'

export const POLICY: Record<string, RuntimeStatePolicy> = {
  battery: { durability: 'restored', volatileFields: ['lastUpdated'] },
  'device-status': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  zones: { durability: 'restored', volatileFields: [] },
  'audio-metrics': { durability: 'session', volatileFields: [] },
}
export const policyFor = (cap: string): RuntimeStatePolicy =>
  POLICY[cap] ?? { durability: 'session', volatileFields: [] }

/** `DeviceStateChanged.data` minus `deviceId` — the PUBLIC payload, never with `native`. */
export interface EmittedChange {
  readonly capName: string
  readonly slice: Record<string, unknown>
}

/** `DeviceNativeShadowChanged.data` minus `deviceId` — the owner-only channel (D224). */
export interface EmittedShadow {
  readonly capName: string
  readonly native: Record<string, unknown>
}

export interface LogLine {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

export interface Harness {
  readonly mirror: DeviceStateMirror
  readonly writes: { deviceId: number; blob: Record<string, unknown> }[]
  /** Cap names, in order — what the durability spec asserts on. */
  readonly emitted: string[]
  /** Full `DeviceStateChanged.data` minus `deviceId`, in order — what the ownership spec asserts on. */
  readonly events: EmittedChange[]
  /** Every `DeviceNativeShadowChanged.data` minus `deviceId`, in order. */
  readonly shadows: EmittedShadow[]
  /** Every category seen on the bus, in order — proves nothing else was emitted. */
  readonly categories: string[]
  readonly logs: LogLine[]
  readonly settings: DeviceManagerSettings
  /** Scripted answers for `readDeviceRuntimeState`, by device id; a `rows` miss answers `{}`. */
  readonly rows: Map<number, Record<string, unknown>>
  /** Device ids whose `readDeviceRuntimeState` throws `sqlite busy`. */
  readonly failReads: Set<number>
}

interface BusEvent {
  readonly category: string
  readonly data: Record<string, unknown>
}

export function harness(policy: RuntimeStatePolicyLookup = policyFor): Harness {
  const writes: { deviceId: number; blob: Record<string, unknown> }[] = []
  const emitted: string[] = []
  const events: EmittedChange[] = []
  const shadows: EmittedShadow[] = []
  const categories: string[] = []
  const logs: LogLine[] = []
  const rows = new Map<number, Record<string, unknown>>()
  const failReads = new Set<number>()
  const log =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      logs.push({ level, message, extras })
    }
  const ctx = {
    logger: { warn: log('warn'), debug: log('debug'), info: log('info'), error: log('error') },
    eventBus: {
      emit: (evt: BusEvent) => {
        categories.push(evt.category)
        const { deviceId: _deviceId, ...rest } = evt.data
        if (evt.category === EventCategory.DeviceNativeShadowChanged) {
          shadows.push(rest as unknown as EmittedShadow)
          return
        }
        emitted.push(String(evt.data.capName))
        events.push(rest as unknown as EmittedChange)
      },
    },
  } as unknown as AddonContext
  const settings = {
    writeDeviceRuntimeState: async (deviceId: number, blob: Record<string, unknown>) => {
      writes.push({ deviceId, blob })
    },
    readDeviceRuntimeState: async (deviceId: number): Promise<Record<string, unknown>> => {
      if (failReads.has(deviceId)) throw new Error('sqlite busy')
      return rows.get(deviceId) ?? {}
    },
  } as unknown as DeviceManagerSettings
  return {
    mirror: new DeviceStateMirror(ctx, policy),
    writes,
    emitted,
    events,
    shadows,
    categories,
    logs,
    settings,
    rows,
    failReads,
  }
}

/** Run the debounce timer and let the write's promise chain settle. */
export async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_100)
}

export const NOT_LOADED_INDEX: ClaimsIndexView = { state: 'not-loaded' }

export function loadedIndex(claimed: readonly number[]): ClaimsIndexView {
  const set = new Set(claimed)
  return { state: 'loaded', hasClaims: (id) => set.has(id) }
}
