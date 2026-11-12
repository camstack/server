/**
 * A stand-in for the `actions` cap in a centre spec (planning#473).
 *
 * A rule names an Action by id; the Action's steps belong to the Actions
 * surface. `capAction(deviceId, actionId)` registers a one-step Action running a
 * vocabulary action and answers its id, so a spec writes
 * `onTrigger: [capAction(PANEL, 'alarm.trigger')]`. The fake's `run` records
 * each command step as the cap method the vocabulary names (`findVocabAction`). It does not carry a
 * command origin: the specs that use it are about the auto-trigger path, which
 * reaches the panel without an Action run.
 */
import { findVocabAction, type ActionEntry, type ActionStep } from '@camstack/types'
import type { NcActionsPort } from '../rule-actions.js'

export interface FakeActuation {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
}

const registry = new Map<string, ActionEntry>()

export function capAction(deviceId: number, actionId: string): string {
  const id = `internal:cap-${deviceId}-${actionId}`
  if (!registry.has(id)) {
    const step: ActionStep = {
      kind: 'command',
      target: { kind: 'devices', ids: [deviceId] },
      actionId,
      args: {},
    }
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

export function makeFakeActions(onActuate: (actuation: FakeActuation) => unknown): NcActionsPort {
  return {
    list: async () => [...registry.values()],
    run: async ({ actionId }) => {
      for (const step of registry.get(actionId)?.steps ?? []) {
        if (step.kind === 'command' && step.target.kind === 'devices') {
          const found = findVocabAction(step.actionId)
          if (found === undefined) continue
          for (const deviceId of step.target.ids) {
            await onActuate({ deviceId, cap: found.cap, method: found.action.method })
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
