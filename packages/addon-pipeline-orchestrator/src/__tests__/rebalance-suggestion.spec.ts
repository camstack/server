/**
 * After a node joins, leaves or changes what it may run, the orchestrator
 * decides ONCE (debounced) whether the placement can be improved by a manual
 * rebalance that the auto sweep would never make, and says so in an alert whose
 * action runs `rebalanceNow`. Everything is read from in-memory state (D49): a
 * failed plan changes nothing.
 */
import type { Alert } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_REBALANCE_MIN_IMPROVEMENT } from '../orchestrator-types.js'
import {
  NODE_NOT_USED_ALERT_PREFIX,
  REBALANCE_SUGGESTED_ALERT_ID,
  RebalanceSuggestion,
  type RebalanceSuggestionDeps,
} from '../rebalance-suggestion.js'

const DEBOUNCE_MS = 90_000

interface Harness {
  readonly deps: RebalanceSuggestionDeps
  readonly emitted: Alert[]
  readonly completed: string[]
  readonly plans: number[]
  setPlans(byMargin: (margin: number) => readonly number[]): void
  enabled: string[]
  runners: string[]
  readonly names: Record<string, string>
}

function harness(): Harness {
  const emitted: Alert[] = []
  const completed: string[] = []
  const plans: number[] = []
  const state = {
    enabled: ['hub', 'agent-a'],
    runners: ['hub', 'agent-a'],
    names: {} as Record<string, string>,
    planFor: (_margin: number): readonly number[] => [],
  }
  const deps: RebalanceSuggestionDeps = {
    addonId: 'pipeline-orchestrator',
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    debounceMs: DEBOUNCE_MS,
    now: () => Date.now(),
    plan: async (margin) => {
      plans.push(margin)
      return { moves: state.planFor(margin).map((deviceId) => ({ deviceId })) }
    },
    enabledNodes: () => state.enabled,
    runnerNodes: () => state.runners,
    nodeName: async (nodeId) => state.names[nodeId] ?? null,
    alerts: {
      emit: async (alert) => {
        emitted.push(alert)
      },
      complete: async (alertId) => {
        completed.push(alertId)
      },
    },
  }
  return {
    deps,
    emitted,
    completed,
    plans,
    setPlans(f) {
      state.planFor = f
    },
    get enabled() {
      return state.enabled
    },
    set enabled(v: string[]) {
      state.enabled = v
    },
    names: state.names,
    get runners() {
      return state.runners
    },
    set runners(v: string[]) {
      state.runners = v
    },
  }
}

describe('RebalanceSuggestion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('raises the suggestion when a manual rebalance would move cameras the sweep would not', async () => {
    const h = harness()
    h.setPlans((margin) => (margin === 0 ? [1, 2] : []))
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(h.plans).toEqual([0, AUTO_REBALANCE_MIN_IMPROVEMENT])
    const alert = h.emitted.find((a) => a.id === REBALANCE_SUGGESTED_ALERT_ID)
    expect(alert).toBeDefined()
    expect(alert?.severity).toBe('warning')
    expect(alert?.status).toBe('active')
    expect(alert?.message).toContain('agent-a')
    expect(alert?.message).toContain('2')
    expect(alert?.action?.label).toBe('Rebalance now')
    expect(alert?.action?.invoke).toEqual({
      addonId: 'pipeline-orchestrator',
      action: 'rebalanceNow',
    })
    s.dispose()
  })

  it('stays quiet when the auto sweep would make every move itself', async () => {
    const h = harness()
    h.setPlans(() => [1, 2])
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'left', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.emitted.filter((a) => a.id === REBALANCE_SUGGESTED_ALERT_ID)).toEqual([])
    s.dispose()
  })

  it('closes an open suggestion once the plan is empty', async () => {
    const h = harness()
    h.setPlans((margin) => (margin === 0 ? [1] : []))
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.completed).not.toContain(REBALANCE_SUGGESTED_ALERT_ID)

    h.setPlans(() => [])
    s.noteNodeEvent({ kind: 'capabilities', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.completed).toContain(REBALANCE_SUGGESTED_ALERT_ID)
    s.dispose()
  })

  it('debounces: each further event re-arms the single evaluation', async () => {
    const h = harness()
    h.setPlans((margin) => (margin === 0 ? [1] : []))
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1_000)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-b' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1_000)
    expect(h.plans).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.plans).toEqual([0, AUTO_REBALANCE_MIN_IMPROVEMENT])
    expect(h.emitted.find((a) => a.id === REBALANCE_SUGGESTED_ALERT_ID)?.message).toContain(
      'agent-b',
    )
    s.dispose()
  })

  it('a failed plan changes nothing (D49): no alert raised, none closed', async () => {
    const h = harness()
    const failing: RebalanceSuggestionDeps = {
      ...h.deps,
      plan: async () => {
        throw new Error('load read failed')
      },
    }
    const s = new RebalanceSuggestion(failing)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.emitted).toEqual([])
    expect(h.completed).toEqual([])
    expect(failing.logger.warn).toHaveBeenCalled()
    s.dispose()
  })

  it('raises an info alert for an online runner node that is not detect-enabled, and closes it when enabled', async () => {
    const h = harness()
    h.runners = ['hub', 'agent-a', 'agent-b']
    h.enabled = ['hub', 'agent-a']
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-b' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const alert = h.emitted.find((a) => a.id === `${NODE_NOT_USED_ALERT_PREFIX}agent-b`)
    expect(alert?.severity).toBe('info')
    expect(alert?.action?.href).toContain('node=agent-b')
    expect(h.emitted.find((a) => a.id === `${NODE_NOT_USED_ALERT_PREFIX}agent-a`)).toBeUndefined()

    h.enabled = ['hub', 'agent-a', 'agent-b']
    s.noteNodeEvent({ kind: 'capabilities', nodeId: 'agent-b' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.completed).toContain(`${NODE_NOT_USED_ALERT_PREFIX}agent-b`)
    s.dispose()
  })

  it('names a node by its display name and id in both alerts, and by id alone when no name is known', async () => {
    const h = harness()
    h.names['agent-a'] = 'garage-arm64'
    h.names['agent-b'] = 'agent-b'
    h.setPlans((margin) => (margin === 0 ? [1] : []))
    h.runners = ['hub', 'agent-a', 'agent-b', 'agent-c']
    h.enabled = ['hub']
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const message = (id: string): string | undefined => h.emitted.find((a) => a.id === id)?.message
    expect(message(REBALANCE_SUGGESTED_ALERT_ID)).toContain('Node garage-arm64 (agent-a) joined')
    expect(message(`${NODE_NOT_USED_ALERT_PREFIX}agent-a`)).toContain(
      'Node garage-arm64 (agent-a) is online',
    )
    expect(message(`${NODE_NOT_USED_ALERT_PREFIX}agent-b`)).toContain('Node agent-b is online')
    expect(message(`${NODE_NOT_USED_ALERT_PREFIX}agent-c`)).toContain('Node agent-c is online')
    s.dispose()
  })

  it('closes the not-used alert of a node that left', async () => {
    const h = harness()
    h.runners = ['hub', 'agent-b']
    h.enabled = ['hub']
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'agent-b' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runners = ['hub']
    s.noteNodeEvent({ kind: 'left', nodeId: 'agent-b' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.completed).toContain(`${NODE_NOT_USED_ALERT_PREFIX}agent-b`)
    s.dispose()
  })

  it('ignores forked-process ids (they contain a slash)', async () => {
    const h = harness()
    h.setPlans((margin) => (margin === 0 ? [1] : []))
    const s = new RebalanceSuggestion(h.deps)
    s.noteNodeEvent({ kind: 'joined', nodeId: 'hub/decoder' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(h.plans).toEqual([])
    s.dispose()
  })
})
