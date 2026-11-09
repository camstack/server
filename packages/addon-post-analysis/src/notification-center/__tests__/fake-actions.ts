/**
 * A stand-in for the `actions` cap in a centre spec (planning#473).
 *
 * A rule names an Action by id; the Action's steps belong to the Actions
 * surface. `capAction(deviceId, cap, method)` registers a one-step Action and
 * answers its id, so a spec writes `onTrigger: [capAction(PANEL, 'alarm-panel', 'trigger')]`.
 * The fake's `run` records each cap step as an actuation, like the real
 * surface would invoke it; it forwards NO origin — the Actions cap carries none.
 */
import type { ActionEntry, ActionStep } from '@camstack/types'
import type { NcActionsPort } from '../rule-actions.js'

export interface FakeActuation {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
}

const registry = new Map<string, ActionEntry>()

export function capAction(deviceId: number, cap: string, method: string): string {
  const id = `internal:cap-${deviceId}-${cap}-${method}`
  if (!registry.has(id)) {
    const step: ActionStep = { kind: 'cap', target: { kind: 'devices', ids: [deviceId] }, cap, method, args: {} }
    registry.set(id, {
      id,
      name: id,
      addonId: 'core-blocks',
      source: 'internal',
      readOnly: false,
      status: { isRunning: false, lastRunAt: null, lastError: null },
      steps: [step],
    })
  }
  return id
}

export function makeFakeActions(onActuate: (actuation: FakeActuation) => void | Promise<void>): NcActionsPort {
  return {
    list: async () => [...registry.values()],
    run: async ({ actionId }) => {
      for (const step of registry.get(actionId)?.steps ?? []) {
        if (step.kind === 'cap' && step.target?.kind === 'devices') {
          for (const deviceId of step.target.ids) {
            await onActuate({ deviceId, cap: step.cap, method: step.method })
          }
        }
      }
      return { runId: `run-${actionId}`, outcome: 'ran' }
    },
  }
}

/** The catalog lookup the engine asks for, over the Actions this spec registered. */
export function fakeActionStepsOf(actionId: string): readonly ActionStep[] | undefined {
  return registry.get(actionId)?.steps
}
