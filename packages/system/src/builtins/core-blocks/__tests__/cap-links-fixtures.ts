import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  topLevelFieldsOf,
  type Composition,
  type CompositionFieldSource,
  type CompositionSourceRef,
  type CoreBlock,
  type IScopedLogger,
  coreBlockComposition,
  compositionSourceKey,
} from '@camstack/types'
import { vi } from 'vitest'
import { CapLinksService, type CapLinksPorts } from '../cap-links.js'

export const HOST_REF: CompositionSourceRef = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:dryer',
}
export const HOST_ID = 5356
export const METER_REF: CompositionSourceRef = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:meter',
}
export const METER_ID = 5359

export function fromMeter(fieldPath: string): CompositionFieldSource {
  return { kind: 'from', source: METER_REF, cap: 'power-meter', fieldPath }
}

export function block(id: string, composition: Composition, updatedAt = 1): CoreBlock {
  return {
    id,
    name: `Custom ${id}`,
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt,
    createdBy: 'u',
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition },
  }
}

export function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)

/** Every host field of power-meter read from the meter, the clock as `now`: what the link serves. */
export function fullMeterFields(): Record<string, CompositionFieldSource> {
  const out: Record<string, CompositionFieldSource> = {}
  for (const path of topLevelFieldsOf('power-meter', lookupCap) ?? []) {
    out[path] =
      path === 'lastFetchedAt' ? { kind: 'expression', expr: 'now', bindings: {} } : fromMeter(path)
  }
  return out
}

export interface CapLinksWorld {
  readonly service: CapLinksService
  readonly log: IScopedLogger
  blocks: CoreBlock[] | null
  /** Device identities that exist, by key. */
  readonly devices: Map<string, number>
  writes: number
  /** When set, every rewrite is refused with this message (what the composition API does for a bad link). */
  refuseWith: string | null
}

/** A service over an in-memory store: a rewrite replaces the block and bumps `updatedAt`. */
export function capLinksWorld(initial: CoreBlock[] | null): CapLinksWorld {
  const log = logger()
  const devices = new Map<string, number>([
    [compositionSourceKey(HOST_REF), HOST_ID],
    [compositionSourceKey(METER_REF), METER_ID],
  ])
  const world: CapLinksWorld = {
    blocks: initial,
    devices,
    writes: 0,
    refuseWith: null,
    log,
    service: new CapLinksService(ports()),
  }
  function ports(): CapLinksPorts {
    return {
      blocks: () => world.blocks,
      refOfDevice: async (deviceId) => (deviceId === HOST_ID ? HOST_REF : null),
      deviceIdOf: async (ref) => devices.get(compositionSourceKey(ref)) ?? null,
      hostFieldsOf: (cap) => topLevelFieldsOf(cap, lookupCap),
      rewrite: async (stored, composition) => {
        if (world.refuseWith !== null) throw new Error(world.refuseWith)
        world.writes += 1
        const updated: CoreBlock = {
          ...stored,
          updatedAt: stored.updatedAt + 1,
          source: { kind: 'composition', composition },
        }
        world.blocks = (world.blocks ?? []).map((b) => (b.id === stored.id ? updated : b))
        return updated
      },
      logger: log,
    }
  }
  return world
}

export function compositionOf(world: CapLinksWorld, id: string): Composition | null {
  const found = world.blocks?.find((b) => b.id === id)
  return found === undefined ? null : coreBlockComposition(found)
}
