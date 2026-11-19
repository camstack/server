/**
 * Every Then step kind the recipe schema knows, against everything the editor
 * does with a step: create it, draw it, validate it, compile it, and map a run
 * trace row back onto it. The kinds are READ from the schema, so a new kind
 * with no sample here, no way to add it, no renderer or no trace mapping fails
 * this spec instead of crashing a page.
 */
import {
  type AutomationAction,
  AutomationActionSchema,
  type AutomationRecipe,
  type AutomationRunTrace,
  CurrentAutomationRecipeSchema,
  generateAutomationBlock,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return { ...actual, FieldPicker: () => null, useFieldDescriptor: () => undefined }
})
vi.mock('../../flow/CommandStep', () => ({
  CommandStep: () => <span data-testid="fake-command" />,
}))
vi.mock('../RunActionFields', () => ({ RunActionFields: () => null }))
vi.mock('../WhenTree', () => ({ WhenTree: () => null }))

import { stepToneAt, traceDetails, traceView } from '../../flow/trace-view'
import { ACTION_KINDS, ActionList } from '../ActionList'
import { type ActionKind, newAction } from '../recipe-parts'
import { prepareRecipeUnits } from '../recipe-units'

const STATE = {
  kind: 'device-is' as const,
  deviceId: 1,
  cap: 'switch',
  fieldPath: 'on',
  operator: 'eq' as const,
  value: true,
}
const WAIT: AutomationAction = { kind: 'wait', seconds: 5 }

/** One VALID step of every kind. A `Record` over the kinds: a new kind is a type error here. */
const VALID: Readonly<Record<ActionKind, AutomationAction>> = {
  wait: WAIT,
  command: { kind: 'command', target: { kind: 'devices', ids: [1] }, actionId: 'switch.on' },
  action: { kind: 'action', actionId: 'internal:abc' },
  code: { kind: 'code', code: 'ctx.log.info("x")' },
  stop: { kind: 'stop', reason: 'done', outcome: 'ok' },
  set: { kind: 'set', vars: { room: 'kitchen' } },
  choose: { kind: 'choose', branches: [{ if: STATE, steps: [WAIT] }] },
  'wait-until': { kind: 'wait-until', when: STATE, timeoutS: 60, onTimeout: 'continue' },
  parallel: { kind: 'parallel', steps: [WAIT, WAIT] },
  repeat: { kind: 'repeat', loop: { by: 'count', count: 2 }, steps: [WAIT] },
}

function schemaKinds(): readonly string[] {
  const kinds = AutomationActionSchema._zod.propValues?.['kind']
  return kinds === undefined ? [] : [...kinds].map(String)
}

const KINDS = schemaKinds()

function recipeOf(action: AutomationAction): AutomationRecipe {
  return { when: { kind: 'all', children: [STATE] }, actions: [action] }
}

function traceOf(kind: string, outcome: 'ok' | 'error'): AutomationRunTrace {
  return {
    runId: 'r',
    startedAt: 1,
    endedAt: 2,
    trigger: { kind: 'detection', outcome: 'pass', reason: '', vars: {} },
    conditions: [],
    steps: [
      { path: 'actions.0', kind, outcome, ...(outcome === 'error' ? { message: 'boom' } : {}) },
    ],
    outcome: outcome === 'ok' ? 'ran' : 'failed',
    repeat: 1,
    lastAt: 2,
  }
}

function draw(action: AutomationAction, withResult: boolean): void {
  const detail = withResult ? traceDetails(traceOf(action.kind, 'ok')).steps[0] : undefined
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActionList
        actions={[action]}
        devices={[]}
        flowControl
        stepResults={[detail]}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('every Then step kind', () => {
  it('reads ten kinds from the schema, and this spec holds a sample for each', () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(10)
    expect([...KINDS].sort()).toEqual(Object.keys(VALID).sort())
  })

  it.each(KINDS)('%s: can be added from the step picker', (kind) => {
    expect(ACTION_KINDS.map((k) => k.value)).toContain(kind)
  })

  it.each(KINDS)('%s: a freshly added step draws without throwing', (kind) => {
    draw(newAction(kind as ActionKind), false)
    expect(screen.getByTestId('step-kind-0')).toBeTruthy()
  })

  it.each(KINDS)('%s: a valid step draws, with the run result inside its card', (kind) => {
    draw(VALID[kind as ActionKind], true)
    expect(screen.getByTestId('step-result').getAttribute('data-tone')).toBe('pass')
  })

  it.each(KINDS)('%s: a valid step passes the recipe schema', (kind) => {
    const parsed = CurrentAutomationRecipeSchema.safeParse(recipeOf(VALID[kind as ActionKind]))
    expect(parsed.error?.issues ?? []).toEqual([])
  })

  it.each(KINDS)('%s: compiles to a block, units prepared, without throwing', (kind) => {
    const prepared = prepareRecipeUnits(recipeOf(VALID[kind as ActionKind]))
    if (!prepared.ok) throw new Error(prepared.error)
    expect(generateAutomationBlock({ name: 'T', recipe: prepared.recipe }).length).toBeGreaterThan(
      0,
    )
  })

  it.each(KINDS)('%s: a trace row maps back onto the step, ok and failed', (kind) => {
    const ok = traceView(traceOf(kind, 'ok'))
    expect(stepToneAt(ok, 0)).toBe('pass')
    const failed = traceDetails(traceOf(kind, 'error')).steps[0]
    expect(failed?.kind).toBe(kind)
    expect(failed?.failure).toBe('boom')
  })

  it.each(KINDS)('%s: a step still being filled in never throws on the way to a block', (kind) => {
    const blank = recipeOf(newAction(kind as ActionKind))
    expect(() => {
      const prepared = prepareRecipeUnits(blank)
      if (prepared.ok) generateAutomationBlock({ name: 'T', recipe: prepared.recipe })
    }).not.toThrow()
  })
})

describe('a Then command step with no action chosen yet', () => {
  const blank: AutomationAction = {
    kind: 'command',
    target: { kind: 'devices', ids: [] },
    actionId: '',
  }

  it('is reported by the schema on the step, not thrown', () => {
    const parsed = CurrentAutomationRecipeSchema.safeParse(recipeOf(blank))
    const issue = parsed.error?.issues.find((i) => i.path.join('.') === 'actions.0.actionId')
    expect(issue).toBeTruthy()
  })

  it('goes through the unit boundary untouched', () => {
    const prepared = prepareRecipeUnits(recipeOf(blank))
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.actions[0]).toEqual(blank)
  })
})
