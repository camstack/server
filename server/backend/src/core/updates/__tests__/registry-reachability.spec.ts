import type { Alert, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  REGISTRY_UNREACHABLE_MIN_FAILURE_MS,
  RegistryReachabilityTracker,
  registryUnreachableAlertId,
  type RegistryAlertsPort,
} from '../registry-reachability.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

interface AlertUpdate {
  readonly alertId: string
  readonly patch: Partial<Alert>
}

interface Harness {
  readonly tracker: RegistryReachabilityTracker
  readonly emitted: Alert[]
  readonly updates: AlertUpdate[]
  advance(ms: number): void
}

function harness(): Harness {
  const emitted: Alert[] = []
  const updates: AlertUpdate[] = []
  let now = 1_000_000
  const alerts: RegistryAlertsPort = {
    emit: async (alert) => {
      emitted.push(alert)
    },
    update: async (input) => {
      updates.push(input)
    },
  }
  const tracker = new RegistryReachabilityTracker({
    logger,
    getAlerts: () => alerts,
    now: () => now,
  })
  return {
    tracker,
    emitted,
    updates,
    advance: (ms) => {
      now += ms
    },
  }
}

const SWEEP_GAP_MS = 6 * 60 * 60 * 1000

describe('RegistryReachabilityTracker', () => {
  it('does not open an alert on one failed probe', async () => {
    const h = harness()
    await h.tracker.failed('npm', 'ENOTFOUND')
    expect(h.emitted).toHaveLength(0)
  })

  it('does not open on two failures closer together than the minimum duration', async () => {
    const h = harness()
    await h.tracker.failed('npm', 'ENOTFOUND')
    h.advance(REGISTRY_UNREACHABLE_MIN_FAILURE_MS - 1)
    await h.tracker.failed('npm', 'ENOTFOUND')
    expect(h.emitted).toHaveLength(0)
  })

  it('opens one critical alert naming the registry after two failures spanning the minimum', async () => {
    const h = harness()
    await h.tracker.failed('npm', 'ENOTFOUND')
    h.advance(SWEEP_GAP_MS)
    await h.tracker.failed('npm', 'ENOTFOUND')
    await h.tracker.failed('npm', 'ENOTFOUND')
    expect(h.emitted).toHaveLength(1)
    const alert = h.emitted[0]
    expect(alert?.id).toBe(registryUnreachableAlertId('npm'))
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('Addon and server updates are paused')
    expect(alert?.source).toEqual({ type: 'registry', id: 'npm' })
  })

  it('names what stops working for Hugging Face', async () => {
    const h = harness()
    await h.tracker.failed('huggingface', 'timeout')
    h.advance(REGISTRY_UNREACHABLE_MIN_FAILURE_MS)
    await h.tracker.failed('huggingface', 'timeout')
    expect(h.emitted[0]?.message).toContain('Model downloads are failing')
  })

  it('resolves the episode on the first success, and a success with nothing open does nothing', async () => {
    const h = harness()
    await h.tracker.reached('npm')
    // The first success after boot reconciles a leftover episode once.
    expect(h.updates).toHaveLength(1)
    h.updates.length = 0
    await h.tracker.reached('npm')
    expect(h.updates).toHaveLength(0)
    await h.tracker.failed('npm', 'x')
    h.advance(SWEEP_GAP_MS)
    await h.tracker.failed('npm', 'x')
    await h.tracker.reached('npm')
    expect(h.updates).toEqual([
      { alertId: registryUnreachableAlertId('npm'), patch: { status: 'completed', read: true } },
    ])
    await h.tracker.reached('npm')
    expect(h.updates).toHaveLength(1)
  })

  it('a success between two failures restarts the count', async () => {
    const h = harness()
    await h.tracker.failed('npm', 'x')
    await h.tracker.reached('npm')
    h.advance(SWEEP_GAP_MS)
    await h.tracker.failed('npm', 'x')
    expect(h.emitted).toHaveLength(0)
  })

  it('keeps the registries apart', async () => {
    const h = harness()
    await h.tracker.failed('npm', 'x')
    h.advance(SWEEP_GAP_MS)
    await h.tracker.failed('huggingface', 'x')
    expect(h.emitted).toHaveLength(0)
  })
})
