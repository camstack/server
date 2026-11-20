import { describe, expect, it } from 'vitest'
import { ActionTargetResolver } from '../action-target.js'
import { AutomationRecipeSchema, type AutomationRecipe } from '../recipe.js'
import {
  buildActionSteps,
  DISABLED_STEP_MESSAGE,
  type RunnableStep,
  type RunStepsOptions,
  runSteps,
} from '../step-runner.js'
import { fakeRegistry, recordingLogger } from './target-fixtures.js'

function options(): RunStepsOptions {
  return {
    pathPrefix: 'actions',
    isAborted: () => false,
    abortReason: 'aborted',
    now: () => 1_000,
    onFailure: () => undefined,
  }
}

function step(ran: string[], name: string, extra: Partial<RunnableStep> = {}): RunnableStep {
  return { meta: { kind: 'cap' }, run: async () => void ran.push(name), ...extra }
}

describe('a disabled step', () => {
  it('is skipped with the reason `disabled`, and its siblings still run', async () => {
    const ran: string[] = []
    const result = await runSteps(
      [step(ran, 'a'), step(ran, 'b', { disabled: true }), step(ran, 'c')],
      options(),
    )
    expect(ran).toEqual(['a', 'c'])
    expect(result.failed).toBe(false)
    expect(result.steps.map((s) => [s.outcome, s.message])).toEqual([
      ['ok', undefined],
      ['skipped', DISABLED_STEP_MESSAGE],
      ['ok', undefined],
    ])
    expect(DISABLED_STEP_MESSAGE).toBe('disabled')
  })

  it('a disabled choose skips its whole subtree and reads no branch', async () => {
    const ran: string[] = []
    let read = 0
    const choose: RunnableStep = {
      meta: { kind: 'choose' },
      run: async () => undefined,
      disabled: true,
      choose: {
        branches: [
          {
            guard: async () => {
              read += 1
              return { result: 'true', reason: 'yes' }
            },
            steps: [step(ran, 'inside')],
          },
        ],
      },
    }
    const result = await runSteps([choose, step(ran, 'after')], options())
    expect(ran).toEqual(['after'])
    expect(read).toBe(0)
    expect(result.steps[0]).toMatchObject({ outcome: 'skipped', message: 'disabled' })
  })

  it('a disabled parallel starts none of its members; a disabled member is skipped alone', async () => {
    const ran: string[] = []
    const parallel = (disabled: boolean): RunnableStep => ({
      meta: { kind: 'parallel' },
      run: async () => undefined,
      ...(disabled ? { disabled: true as const } : {}),
      parallel: [step(ran, 'm1'), step(ran, 'm2', { disabled: true })],
    })
    const off = await runSteps([parallel(true)], options())
    expect(ran).toEqual([])
    expect(off.steps[0]).toMatchObject({ outcome: 'skipped', message: 'disabled' })
    await runSteps([parallel(false)], options())
    expect(ran).toEqual(['m1'])
  })

  it('a standalone list: buildActionSteps carries the flag, so the command is never sent', async () => {
    const calls: string[] = []
    const resolver = new ActionTargetResolver(fakeRegistry([]).directory, recordingLogger().logger)
    const built = buildActionSteps(
      [
        { kind: 'wait', seconds: 1, enabled: false },
        {
          kind: 'command',
          target: { kind: 'devices', ids: [3] },
          actionId: 'switch.on',
          enabled: false,
        },
      ],
      {},
      {
        invokeCap: async (call) => void calls.push(call.method),
        sleep: async () => void calls.push('sleep'),
        onMissingVar: () => undefined,
        resolveTarget: (...args) => resolver.resolve(...args),
      },
    )
    const result = await runSteps(built, options())
    expect(calls).toEqual([])
    expect(result.steps.map((s) => s.message)).toEqual(['disabled', 'disabled'])
  })
})

describe('enabled on the recipe schema', () => {
  const recipe: AutomationRecipe = {
    when: { kind: 'manual' },
    actions: [
      { kind: 'wait', seconds: 1, enabled: false },
      { kind: 'notify', targetId: 't1', body: 'hi', enabled: false },
      { kind: 'set', vars: { a: 'b' }, enabled: false },
      { kind: 'code', code: 'return', enabled: false },
      {
        kind: 'choose',
        enabled: false,
        branches: [
          {
            if: { kind: 'all', children: [] },
            steps: [{ kind: 'wait', seconds: 1, enabled: false }],
          },
        ],
      },
      {
        kind: 'repeat',
        enabled: false,
        loop: { by: 'count', count: 2 },
        steps: [{ kind: 'notify', targetId: 't1', body: 'x', enabled: false }],
      },
    ],
  }

  it('keeps `enabled: false` on every step kind, nested ones included', () => {
    const parsed = AutomationRecipeSchema.parse(JSON.parse(JSON.stringify(recipe)))
    expect(parsed).toEqual(recipe)
  })

  it('an absent flag stays absent (enabled by default)', () => {
    const parsed = AutomationRecipeSchema.parse({
      when: { kind: 'manual' },
      actions: [{ kind: 'wait', seconds: 1 }],
    })
    expect(parsed.actions[0]).toEqual({ kind: 'wait', seconds: 1 })
  })

  it('a notify step needs a target and a message', () => {
    const bad = AutomationRecipeSchema.safeParse({
      when: { kind: 'manual' },
      actions: [{ kind: 'notify', targetId: '', body: '' }],
    })
    expect(bad.success).toBe(false)
  })
})
