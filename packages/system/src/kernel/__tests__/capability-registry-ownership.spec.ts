/**
 * Regression: an unregister from a DEAD runner generation must not erase the
 * registration a LIVE successor generation already made.
 *
 * 2026-08-20 00:45, mass-update of 30 addons. The recorder runner was replaced;
 * the new runner handshook first (its cap set was unchanged, so the manifest
 * diff left the existing registrations in place), and the OLD runner's teardown
 * landed afterwards. Its cleanup unregistered `recording`, `storage-evictable`
 * and `recording-export` by `(cap, addonId)` — the same key the live runner was
 * serving under. `recording.getAvailability` answered "provider not available"
 * for ~7 hours while the new process was happily writing segments.
 *
 * The rule these tests pin: a registration may declare an OWNER, and an
 * unregister must PRESENT that owner. A mismatched (or missing) owner is a
 * logged no-op, never a deletion.
 */
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../capability-registry.js'

function createMockLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

interface CapturingBus {
  readonly bus: IEventBus
  readonly emitted: SystemEvent[]
}

function createCapturingBus(): CapturingBus {
  const emitted: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      emitted.push(event)
    },
    subscribe: () => () => {},
    getRecent: () => [],
  }
  return { bus, emitted }
}

const RECORDING_CAPS = ['recording', 'storage-evictable', 'recording-export'] as const

describe('CapabilityRegistry — registration ownership', () => {
  let registry: CapabilityRegistry
  let capturing: CapturingBus

  beforeEach(() => {
    capturing = createCapturingBus()
    registry = new CapabilityRegistry(createMockLogger(), capturing.bus)
    for (const name of RECORDING_CAPS) {
      registry.declareCapability({
        name,
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })
    }
    registry.ready()
  })

  it('keeps the successor registration when the dead generation unregisters (the 7-hour recording outage)', () => {
    const oldRunner = { generation: 1 }
    const newRunner = { generation: 2 }

    // Generation 1 registers, dies, and generation 2 takes the same key over.
    registry.registerProvider('recording', 'addon-recorder', oldRunner, 'hub/recorder#1')
    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#1')
    registry.registerProvider('recording', 'addon-recorder', newRunner, 'hub/recorder#2')

    // …and NOW the old generation's teardown finally lands.
    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#1')

    expect(registry.getSingleton('recording')).toBe(newRunner)
    expect(registry.hasProvider('recording', 'addon-recorder')).toBe(true)
  })

  it('does not emit provider-unregistered for a stale-owner unregister', () => {
    registry.registerProvider('recording', 'addon-recorder', { g: 2 }, 'hub/recorder#2')
    capturing.emitted.length = 0

    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#1')

    const unregisterEvents = capturing.emitted.filter(
      (e) => e.category === 'capability:provider-unregistered',
    )
    expect(unregisterEvents).toHaveLength(0)
  })

  it('refuses an unregister that presents no owner at all against an owned registration', () => {
    registry.registerProvider('storage-evictable', 'addon-recorder', { g: 2 }, 'hub/recorder#2')

    registry.unregisterProvider('storage-evictable', 'addon-recorder')

    expect(registry.hasProvider('storage-evictable', 'addon-recorder')).toBe(true)
  })

  it('unregisters when the presented owner matches', () => {
    registry.registerProvider('recording-export', 'addon-recorder', { g: 2 }, 'hub/recorder#2')

    registry.unregisterProvider('recording-export', 'addon-recorder', 'hub/recorder#2')

    expect(registry.hasProvider('recording-export', 'addon-recorder')).toBe(false)
    expect(registry.getSingleton('recording-export')).toBeNull()
  })

  it('leaves ownerless registrations exactly as they were (in-process addons)', () => {
    registry.registerProvider('recording', '$kernel', { builtin: true })

    registry.unregisterProvider('recording', '$kernel')

    expect(registry.hasProvider('recording', '$kernel')).toBe(false)
  })

  it('reports the current owner of a registration', () => {
    registry.registerProvider('recording', 'addon-recorder', { g: 2 }, 'hub/recorder#2')

    expect(registry.getProviderOwner('recording', 'addon-recorder')).toBe('hub/recorder#2')
    expect(registry.getProviderOwner('recording', 'nobody')).toBeNull()
  })

  it('reassigns ownership to the live generation when an unchanged cap set is taken over', () => {
    // The manifest diff leaves an unchanged cap registered as-is; the successor
    // must still become its OWNER, or nothing will ever be able to clean it up.
    registry.registerProvider('recording', 'addon-recorder', { g: 1 }, 'hub/recorder#1')

    expect(registry.reassignProviderOwner('recording', 'addon-recorder', 'hub/recorder#2')).toBe(
      true,
    )
    expect(registry.getProviderOwner('recording', 'addon-recorder')).toBe('hub/recorder#2')

    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#1')
    expect(registry.hasProvider('recording', 'addon-recorder')).toBe(true)

    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#2')
    expect(registry.hasProvider('recording', 'addon-recorder')).toBe(false)
  })

  it('reports a reassignment against an unregistered pair instead of inventing one', () => {
    expect(registry.reassignProviderOwner('recording', 'addon-recorder', 'hub/recorder#2')).toBe(
      false,
    )
    expect(registry.hasProvider('recording', 'addon-recorder')).toBe(false)
  })

  it('does not promote another singleton provider on a stale-owner unregister', () => {
    const live = { g: 2 }
    const other = { other: true }
    registry.registerProvider('recording', 'addon-recorder', live, 'hub/recorder#2')
    registry.registerProvider('recording', 'addon-recorder-alt', other, 'hub/recorder-alt#1')

    registry.unregisterProvider('recording', 'addon-recorder', 'hub/recorder#1')

    expect(registry.getSingleton('recording')).toBe(live)
  })
})
