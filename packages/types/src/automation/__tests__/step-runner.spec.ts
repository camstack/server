import { describe, expect, it, vi } from 'vitest'
import type { DeviceTemplateRender } from '../../expression/device-template.js'
import { type ActionVariable, resolveActionVariables } from '../action.js'
import { ActionTargetResolver } from '../action-target.js'
import { evaluateStepCondition } from '../step-condition.js'
import {
  type ActionStep,
  ActionStepSchema,
  CHOOSE_BRANCHES_MAX,
  CurrentAutomationRecipeSchema,
  stepConditionsOf,
  validateRecipeBounds,
} from '../recipe.js'
import {
  buildActionSteps,
  type CapCall,
  type RunnableStep,
  type RunStepsOptions,
  runSteps,
} from '../step-runner.js'
import { fakeRegistry, recordingLogger } from './target-fixtures.js'

function options(overrides: Partial<RunStepsOptions> = {}): RunStepsOptions {
  return {
    pathPrefix: 'steps',
    isAborted: () => false,
    abortReason: 'aborted',
    now: () => 1_000,
    onFailure: () => undefined,
    ...overrides,
  }
}

function deps() {
  const calls: CapCall[] = []
  const slept: number[] = []
  const missing: string[] = []
  const resolver = new ActionTargetResolver(fakeRegistry([]).directory, recordingLogger().logger)
  return {
    calls,
    slept,
    missing,
    deps: {
      invokeCap: async (call: CapCall) => {
        calls.push(call)
        if (call.cap === 'broken') throw new Error('device refused')
      },
      sleep: async (ms: number) => {
        slept.push(ms)
      },
      onMissingVar: (name: string) => {
        missing.push(name)
      },
      resolveTarget: (...args: Parameters<ActionTargetResolver['resolve']>) =>
        resolver.resolve(...args),
    },
  }
}

describe('runSteps', () => {
  it('a failed step leaves every later step not-run, with the reason', async () => {
    const failures: string[] = []
    const ran: string[] = []
    const steps: RunnableStep[] = [
      { meta: { kind: 'cap' }, run: async () => void ran.push('a') },
      {
        meta: { kind: 'cap', cap: 'siren', method: 'on' },
        run: async (scope) => {
          scope.setDeviceId(7)
          throw new Error('boom')
        },
      },
      { meta: { kind: 'cap' }, run: async () => void ran.push('c') },
    ]
    const result = await runSteps(
      steps,
      options({ onFailure: (f) => void failures.push(`${f.path}:${f.message}`) }),
    )
    expect(ran).toEqual(['a'])
    expect(result.failed).toBe(true)
    expect(result.steps).toMatchObject([
      { path: 'steps.0', outcome: 'ok' },
      { path: 'steps.1', outcome: 'error', message: 'boom', deviceId: 7 },
      { path: 'steps.2', outcome: 'not-run', message: 'an earlier step failed' },
    ])
    expect(failures).toEqual(['steps.1:boom'])
  })

  it('an abort between steps marks the rest not-run and is not a failure', async () => {
    let calls = 0
    const steps: RunnableStep[] = [
      { meta: { kind: 'wait' }, run: async () => void (calls += 1) },
      { meta: { kind: 'wait' }, run: async () => void (calls += 1) },
    ]
    const result = await runSteps(steps, options({ isAborted: () => calls >= 1 }))
    expect(result.aborted).toBe(true)
    expect(result.failed).toBe(false)
    expect(result.steps[1]).toMatchObject({ outcome: 'not-run', message: 'aborted' })
  })
})

describe('runSteps — flow control (#500)', () => {
  const ok = (ran: string[], name: string): RunnableStep => ({
    meta: { kind: 'cap' },
    run: async () => void ran.push(name),
  })
  const boom: RunnableStep = {
    meta: { kind: 'cap' },
    continueOnError: true,
    run: async () => {
      throw new Error('boom')
    },
  }

  it('continueOnError: the failure is traced failed-continued, the run goes on and is not failed', async () => {
    const ran: string[] = []
    const failures: string[] = []
    const continued: string[] = []
    const result = await runSteps(
      [ok(ran, 'a'), boom, ok(ran, 'c')],
      options({
        onFailure: (f) => void failures.push(f.path),
        onContinuedFailure: (f) => void continued.push(`${f.path}:${f.message}`),
      }),
    )
    expect(ran).toEqual(['a', 'c'])
    expect(result.failed).toBe(false)
    expect(result.steps).toMatchObject([
      { outcome: 'ok' },
      { path: 'steps.1', outcome: 'failed-continued', message: 'boom' },
      { outcome: 'ok' },
    ])
    expect(failures).toEqual([])
    expect(continued).toEqual(['steps.1:boom'])
  })

  it('stop (ok): the later steps are not-run with the reason, and the run is not failed', async () => {
    const ran: string[] = []
    const stop: RunnableStep = {
      meta: { kind: 'stop' },
      run: async (scope) => scope.stop('nobody is home', 'ok'),
    }
    const result = await runSteps([ok(ran, 'a'), stop, ok(ran, 'c')], options())
    expect(ran).toEqual(['a'])
    expect(result.failed).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stopped).toEqual({ reason: 'nobody is home', outcome: 'ok', path: 'steps.1' })
    expect(result.steps).toMatchObject([
      { outcome: 'ok' },
      { path: 'steps.1', outcome: 'ok', message: 'stopped: nobody is home' },
      { path: 'steps.2', outcome: 'not-run', message: 'stopped at steps.1: nobody is home' },
    ])
  })

  it('stop (failed): the run is failed and the failure is reported once', async () => {
    const failures: string[] = []
    const stop: RunnableStep = {
      meta: { kind: 'stop' },
      run: async (scope) => scope.stop('the pump did not start', 'failed'),
    }
    const result = await runSteps(
      [stop, ok([], 'b')],
      options({ onFailure: (f) => void failures.push(`${f.path}:${f.message}`) }),
    )
    expect(result.failed).toBe(true)
    expect(result.steps).toMatchObject([
      { outcome: 'error', message: 'stopped: the pump did not start' },
      { outcome: 'not-run', message: 'stopped at steps.0: the pump did not start' },
    ])
    expect(failures).toEqual(['steps.0:stopped: the pump did not start'])
  })

  it('a stop whose condition is false does not stop; a stop in an else list stops the whole run', async () => {
    const ran: string[] = []
    const guarded: RunnableStep = {
      meta: { kind: 'stop' },
      guard: async () => ({ result: 'false', reason: 'the door is closed' }),
      run: async (scope) => scope.stop('door open', 'ok'),
    }
    const first = await runSteps([guarded, ok(ran, 'b')], options())
    expect(ran).toEqual(['b'])
    expect(first.stopped).toBeUndefined()
    expect(first.steps[0]).toMatchObject({ outcome: 'skipped' })

    const inElse: RunnableStep = {
      meta: { kind: 'cap' },
      guard: async () => ({ result: 'false', reason: 'no' }),
      otherwise: [
        { meta: { kind: 'stop' }, run: async (scope) => scope.stop('else said stop', 'ok') },
      ],
      run: async () => void ran.push('never'),
    }
    const second = await runSteps([inElse, ok(ran, 'after')], options())
    expect(ran).toEqual(['b'])
    expect(second.stopped).toMatchObject({ reason: 'else said stop', path: 'steps.0.else.0' })
    expect(second.steps[1]).toMatchObject({ outcome: 'not-run' })
  })
})

describe('runSteps — a step that timed out and went on (#500)', () => {
  it('is traced timed-out with its reason, and the sequence continues without failing', async () => {
    const ran: string[] = []
    const result = await runSteps(
      [
        {
          meta: { kind: 'wait-until' },
          run: async (scope) => scope.markTimedOut('timed out after 600 s: the door is open'),
        },
        { meta: { kind: 'cap' }, run: async () => void ran.push('after') },
      ],
      options(),
    )
    expect(ran).toEqual(['after'])
    expect(result.failed).toBe(false)
    expect(result.steps[0]).toMatchObject({
      kind: 'wait-until',
      outcome: 'timed-out',
      message: 'timed out after 600 s: the door is open',
    })
    expect(result.steps[1]).toMatchObject({ outcome: 'ok' })
  })
})

describe('runSteps — choose (#500)', () => {
  const ok = (ran: string[], name: string): RunnableStep => ({
    meta: { kind: 'cap' },
    run: async () => void ran.push(name),
  })
  const verdict = (result: 'true' | 'false' | 'unknown', seen?: string[], name?: string) => () => {
    if (seen !== undefined && name !== undefined) seen.push(name)
    return Promise.resolve({ result, reason: `it is ${result}` })
  }
  const choose = (
    branches: NonNullable<RunnableStep['choose']>['branches'],
    otherwise?: readonly RunnableStep[],
  ): RunnableStep => ({
    meta: { kind: 'choose' },
    run: async () => undefined,
    choose: { branches, ...(otherwise === undefined ? {} : { otherwise }) },
  })

  it('runs the first branch that is true and reads no branch after it', async () => {
    const ran: string[] = []
    const seen: string[] = []
    const result = await runSteps(
      [
        choose(
          [
            { guard: verdict('false', seen, 'b0'), steps: [ok(ran, 'zero')] },
            { guard: verdict('true', seen, 'b1'), steps: [ok(ran, 'one'), ok(ran, 'one-b')] },
            { guard: verdict('true', seen, 'b2'), steps: [ok(ran, 'two')] },
          ],
          [ok(ran, 'else')],
        ),
        ok(ran, 'after'),
      ],
      options(),
    )
    expect(ran).toEqual(['one', 'one-b', 'after'])
    expect(seen).toEqual(['b0', 'b1'])
    expect(result.steps[0]).toMatchObject({
      kind: 'choose',
      outcome: 'ok',
      branch: 'branches.1',
      branchChecks: [
        { condition: 'false', conditionReason: 'it is false' },
        { condition: 'true', conditionReason: 'it is true' },
      ],
      steps: [
        { path: 'steps.0.branches.1.steps.0', outcome: 'ok' },
        { path: 'steps.0.branches.1.steps.1', outcome: 'ok' },
      ],
    })
  })

  it('runs the else list when every branch is false, and is skipped with the reason when there is none', async () => {
    const ran: string[] = []
    const none = [{ guard: verdict('false'), steps: [ok(ran, 'zero')] }]
    const result = await runSteps([choose(none, [ok(ran, 'else')]), choose(none)], options())
    expect(ran).toEqual(['else'])
    expect(result.steps[0]).toMatchObject({
      outcome: 'ok',
      branch: 'else',
      steps: [{ path: 'steps.0.else.0', outcome: 'ok' }],
    })
    expect(result.steps[1]).toMatchObject({
      outcome: 'skipped',
      message: 'not run: no branch is true',
    })
    expect(result.steps[1]).not.toHaveProperty('branch')
  })

  it('a branch that cannot be read runs nothing: not the branches after it, not the else', async () => {
    const ran: string[] = []
    const unknowns: string[] = []
    const result = await runSteps(
      [
        choose(
          [
            { guard: verdict('unknown'), steps: [ok(ran, 'zero')] },
            { guard: verdict('true'), steps: [ok(ran, 'one')] },
          ],
          [ok(ran, 'else')],
        ),
        ok(ran, 'after'),
      ],
      options({ onGuardUnknown: (u) => void unknowns.push(`${u.path}:${u.reason}`) }),
    )
    expect(ran).toEqual(['after'])
    expect(result.failed).toBe(false)
    expect(result.steps[0]).toMatchObject({
      outcome: 'skipped',
      message: 'not run: branch 1 could not be read (it is unknown)',
    })
    expect(unknowns).toEqual(['steps.0.branches.0.if:it is unknown'])
  })

  it("a failure or a stop inside a branch is the run's", async () => {
    const ran: string[] = []
    const failures: string[] = []
    const boom: RunnableStep = {
      meta: { kind: 'cap' },
      run: async () => {
        throw new Error('boom')
      },
    }
    const failed = await runSteps(
      [choose([{ guard: verdict('true'), steps: [boom, ok(ran, 'x')] }]), ok(ran, 'after')],
      options({ onFailure: (f) => void failures.push(f.path) }),
    )
    expect(failed.failed).toBe(true)
    expect(failures).toEqual(['steps.0.branches.0.steps.0'])
    expect(failed.steps[0]).toMatchObject({
      outcome: 'error',
      message: 'a step of the branch failed',
    })
    expect(failed.steps[1]).toMatchObject({ outcome: 'not-run' })

    const stop: RunnableStep = {
      meta: { kind: 'stop' },
      run: async (scope) => scope.stop('enough', 'ok'),
    }
    const stopped = await runSteps(
      [choose([{ guard: verdict('true'), steps: [stop] }]), ok(ran, 'after')],
      options(),
    )
    expect(ran).toEqual([])
    expect(stopped.failed).toBe(false)
    expect(stopped.stopped).toMatchObject({ path: 'steps.0.branches.0.steps.0', reason: 'enough' })
    expect(stopped.steps[1]).toMatchObject({
      outcome: 'not-run',
      message: 'stopped at steps.0.branches.0.steps.0: enough',
    })
  })
})

describe('choose schema (#500)', () => {
  const recipe = (actions: unknown[]) =>
    CurrentAutomationRecipeSchema.safeParse({ when: { kind: 'manual' }, actions })
  const issue = (actions: unknown[]): string => {
    const parsed = recipe(actions)
    return parsed.success ? '' : (parsed.error.issues[0]?.message ?? '')
  }
  const IF = { kind: 'manual' }
  const WAIT = { kind: 'wait', seconds: 1 }
  const branch = { if: IF, steps: [WAIT] }

  it('takes up to six branches of flow steps and an else list', () => {
    expect(
      recipe([
        {
          kind: 'choose',
          branches: [
            {
              if: IF,
              steps: [
                WAIT,
                { kind: 'set', vars: { a: 1 } },
                { kind: 'stop', reason: 'x', outcome: 'ok' },
                { kind: 'action', actionId: 'internal:x', continueOnError: true },
              ],
            },
            ...Array.from({ length: CHOOSE_BRANCHES_MAX - 1 }, () => branch),
          ],
          else: [WAIT],
        },
      ]).success,
    ).toBe(true)
  })

  it('refuses the bounds with a sentence an operator can read', () => {
    expect(issue([{ kind: 'choose', branches: [] }])).toBe('a choose needs at least one branch')
    expect(
      issue([
        { kind: 'choose', branches: Array.from({ length: CHOOSE_BRANCHES_MAX + 1 }, () => branch) },
      ]),
    ).toBe('a choose takes at most 6 branches')
    expect(issue([{ kind: 'choose', branches: [{ if: IF, steps: [] }] }])).toBe(
      'a branch needs at least one step',
    )
    expect(
      recipe([
        { kind: 'choose', branches: [{ if: IF, steps: [{ kind: 'choose', branches: [branch] }] }] },
      ]).success,
    ).toBe(false)
    expect(
      recipe([{ kind: 'choose', branches: [{ if: IF, steps: [{ kind: 'code', code: 'x' }] }] }])
        .success,
    ).toBe(false)
    expect(
      recipe([{ kind: 'choose', branches: [{ if: IF, steps: [{ ...WAIT, if: IF }] }] }]).success,
    ).toBe(false)
  })

  it('a standalone list has no choose', () => {
    expect(ActionStepSchema.safeParse({ kind: 'choose', branches: [branch] }).success).toBe(false)
  })

  it('a branch condition is checked like a step condition: a dangling "started by" is refused', () => {
    const parsed = recipe([
      {
        kind: 'choose',
        branches: [{ if: { kind: 'triggered-by', leafIds: ['gone'] }, steps: [WAIT] }],
      },
    ])
    if (!parsed.success) throw new Error('expected the schema to take it')
    expect(validateRecipeBounds(parsed.data)).toMatch(/step 1/)
    expect(stepConditionsOf(parsed.data.actions[0]!)).toMatchObject([{ path: 'branches.0.if' }])
  })
})

describe('flow-control schema (#500)', () => {
  const recipe = (actions: unknown[]) =>
    CurrentAutomationRecipeSchema.safeParse({ when: { kind: 'manual' }, actions })

  it('an automation list takes stop, set, continueOnError and a one-hour wait', () => {
    expect(
      recipe([
        { kind: 'set', vars: { room: 'kitchen', level: 3, on: true } },
        { kind: 'stop', reason: 'nobody home', outcome: 'ok', if: { kind: 'manual' } },
        { kind: 'wait', seconds: 3600 },
        { kind: 'action', actionId: 'internal:x', continueOnError: true },
      ]).success,
    ).toBe(true)
  })

  it('refuses the bounds with a reason an operator can read', () => {
    const issue = (actions: unknown[]): string => {
      const parsed = recipe(actions)
      return parsed.success ? '' : (parsed.error.issues[0]?.message ?? '')
    }
    expect(issue([{ kind: 'wait', seconds: 3601 }])).toBe('a wait is at most one hour (3600 s)')
    expect(issue([{ kind: 'stop', reason: '', outcome: 'ok' }])).toBe(
      'a stop needs a reason: it is what the run trace shows',
    )
    expect(recipe([{ kind: 'stop', reason: 'x', outcome: 'maybe' }]).success).toBe(false)
    expect(issue([{ kind: 'set', vars: {} }])).toBe('set needs at least one variable')
    expect(issue([{ kind: 'set', vars: { leaf: 'when.0' } }])).toContain('belong to the run')
    expect(issue([{ kind: 'set', vars: { 'not a name': 1 } }])).toContain('variable name')
  })

  it('a standalone list keeps wait and cap only', () => {
    expect(ActionStepSchema.safeParse({ kind: 'stop', reason: 'x', outcome: 'ok' }).success).toBe(
      false,
    )
    expect(ActionStepSchema.safeParse({ kind: 'set', vars: { a: 1 } }).success).toBe(false)
    expect(ActionStepSchema.safeParse({ kind: 'wait', seconds: 3600 }).success).toBe(true)
  })
})

describe('buildActionSteps — variables', () => {
  const steps: ActionStep[] = [
    {
      kind: 'cap',
      deviceId: { $var: 'siren' },
      cap: 'siren',
      method: 'on',
      args: { volume: { $var: 'volume' }, label: 'alarm {{vars.zone}}' },
    },
  ]

  it('substitutes a whole-value { $var } keeping its type, and {{vars.x}} inside a string', async () => {
    const d = deps()
    const runnable = buildActionSteps(steps, { siren: 616, volume: 80, zone: 'porch' }, d.deps)
    const result = await runSteps(runnable, options())
    expect(result.failed).toBe(false)
    expect(d.calls).toEqual([
      { deviceId: 616, cap: 'siren', method: 'on', args: { volume: 80, label: 'alarm porch' } },
    ])
  })

  it('a variable that is not set fails THAT step instead of running with a hole', async () => {
    const d = deps()
    const runnable = buildActionSteps(steps, { siren: 616 }, d.deps)
    const result = await runSteps(runnable, options())
    expect(d.calls).toEqual([])
    expect(result.steps[0]).toMatchObject({
      outcome: 'error',
      message: 'variable "volume" is not set',
    })
  })

  it('runs a wait in milliseconds and fans a multi-device step out', async () => {
    const d = deps()
    const runnable = buildActionSteps(
      [
        { kind: 'wait', seconds: 2 },
        { kind: 'cap', deviceId: [1, 2], cap: 'lock-control', method: 'lock' },
      ],
      {},
      d.deps,
    )
    await runSteps(runnable, options())
    expect(d.slept).toEqual([2000])
    expect(d.calls.map((c) => c.deviceId)).toEqual([1, 2])
  })
})

describe('resolveActionVariables', () => {
  const declared: ActionVariable[] = [
    { name: 'mode', type: 'select', options: ['home', 'away'], default: 'home', label: 'Mode' },
    { name: 'level', type: 'number', required: true },
  ]

  it('fills defaults and checks types and options', () => {
    expect(resolveActionVariables(declared, { level: 3 })).toEqual({
      ok: true,
      values: { mode: 'home', level: 3 },
    })
    expect(resolveActionVariables(declared, { level: 3, mode: 'night' })).toMatchObject({
      ok: false,
    })
    expect(resolveActionVariables(declared, { level: 'x' as never })).toMatchObject({ ok: false })
  })

  it('refuses a missing required variable and an undeclared one', () => {
    expect(resolveActionVariables(declared, {})).toEqual({
      ok: false,
      error: 'variable "level" is required',
    })
    expect(resolveActionVariables(declared, { level: 1, typo: 1 })).toEqual({
      ok: false,
      error: 'unknown variable "typo"',
    })
  })

  it('is not called when nothing is declared and nothing given', () => {
    const spy = vi.fn()
    expect(resolveActionVariables(undefined, undefined)).toEqual({ ok: true, values: {} })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('buildActionSteps — device templates (D1021 run-time contract)', () => {
  const templated: ActionStep[] = [
    {
      kind: 'cap',
      deviceId: 616,
      cap: 'display',
      method: 'show',
      args: {
        text: 'Stufa {{ stufa.temperature | round(1) }} in {{vars.zone}}',
        level: 3,
        plain: 'no markup',
      },
    },
  ]

  function rendering(answer: (source: string) => DeviceTemplateRender): {
    sources: string[]
    render: (sources: readonly string[]) => Promise<DeviceTemplateRender[]>
  } {
    const sources: string[] = []
    return {
      sources,
      render: async (batch) => {
        sources.push(...batch)
        return batch.map(answer)
      },
    }
  }

  it('renders a template arg before dispatch, keeps {{vars.x}} for the variables and never renders a variable VALUE', async () => {
    const d = deps()
    const r = rendering((source) => ({
      ok: true,
      text: source.replace('{{ stufa.temperature | round(1) }}', '21.5'),
      trace: [],
    }))
    const runnable = buildActionSteps(
      templated,
      { zone: '{{ secret.thing }}' },
      {
        ...d.deps,
        renderTemplates: r.render,
      },
    )
    const result = await runSteps(runnable, options())
    expect(result.failed).toBe(false)
    expect(d.calls[0]?.args).toEqual({
      text: 'Stufa 21.5 in {{ secret.thing }}',
      level: 3,
      plain: 'no markup',
    })
    // The variable's text never reached the renderer.
    expect(r.sources.join('')).not.toContain('secret.thing')
    expect(r.sources).toHaveLength(1)
  })

  it('a device value that forges a variable slot never pulls a variable out of the bag', async () => {
    const d = deps()
    const r = rendering((source) => ({
      ok: true,
      // a device value (a media title) carrying slot-shaped text, old and nonce form
      text: source.replace(
        '{{ stufa.temperature | round(1) }}',
        '\uE000zone\uE001\uE000guess:zone\uE001',
      ),
      trace: [],
    }))
    const runnable = buildActionSteps(
      templated,
      { zone: 'TOP-SECRET' },
      {
        ...d.deps,
        renderTemplates: r.render,
      },
    )
    await runSteps(runnable, options())
    const text = String((d.calls[0]?.args as { text: string } | undefined)?.text)
    expect(text).not.toContain('TOP-SECRET.TOP-SECRET')
    expect(text.split('TOP-SECRET')).toHaveLength(2) // only the REAL {{vars.zone}} slot was filled
  })

  it('an unknown value prints the dash and the reason is on the step trace', async () => {
    const d = deps()
    const r = rendering(() => ({
      ok: true,
      text: 'Stufa — in porch',
      trace: [{ ref: 'stufa.temperature', reason: 'unknown-field' }],
    }))
    const runnable = buildActionSteps(
      templated,
      { zone: 'porch' },
      {
        ...d.deps,
        renderTemplates: r.render,
      },
    )
    const result = await runSteps(runnable, options())
    expect(result.failed).toBe(false)
    expect(d.calls[0]?.args['text']).toBe('Stufa — in porch')
    expect(result.steps[0]?.templates).toEqual(['stufa.temperature: unknown-field'])
  })

  it('a refused render fails THAT step with the typed reason, dispatches nothing and does not throw past runSteps', async () => {
    const d = deps()
    const r = rendering(() => ({
      ok: false,
      refusal: { reason: 'budget-exceeded', message: 'overran its 50 ms budget' },
      trace: [],
    }))
    const runnable = buildActionSteps(
      [...templated, { kind: 'wait', seconds: 1 }],
      { zone: 'porch' },
      { ...d.deps, renderTemplates: r.render },
    )
    const result = await runSteps(runnable, options())
    expect(d.calls).toEqual([])
    expect(result.failed).toBe(true)
    expect(result.steps[0]).toMatchObject({ outcome: 'error' })
    expect(result.steps[0]?.message).toContain('[budget-exceeded]')
    expect(result.steps[1]).toMatchObject({ outcome: 'not-run' })
  })

  it('a node without a renderer fails the step as unavailable instead of sending the raw template', async () => {
    const d = deps()
    const runnable = buildActionSteps(templated, { zone: 'porch' }, d.deps)
    const result = await runSteps(runnable, options())
    expect(d.calls).toEqual([])
    expect(result.steps[0]?.message).toContain('[unavailable]')
  })

  it('a step without template markup never calls the renderer', async () => {
    const d = deps()
    const r = rendering(() => ({ ok: true, text: 'x', trace: [] }))
    const runnable = buildActionSteps(
      [{ kind: 'cap', deviceId: 616, cap: 'siren', method: 'on', args: { volume: 80 } }],
      {},
      { ...d.deps, renderTemplates: r.render },
    )
    await runSteps(runnable, options())
    expect(r.sources).toEqual([])
    expect(d.calls).toHaveLength(1)
  })
})

describe('a conditional step (#472): if / else on the ONE when tree', () => {
  const IS_ON = {
    kind: 'device-is',
    deviceId: 7,
    cap: 'switch',
    fieldPath: 'on',
    operator: 'eq',
    value: true,
  } as const
  const closeStep: ActionStep = {
    kind: 'cap',
    deviceId: 616,
    cap: 'cover',
    method: 'close',
    if: IS_ON,
    else: [{ kind: 'cap', deviceId: 617, cap: 'cover', method: 'open' }],
  }

  function run(slice: unknown, extra: Partial<RunStepsOptions> = {}) {
    const d = deps()
    const failures: string[] = []
    const steps = buildActionSteps(
      [closeStep],
      {},
      {
        ...d.deps,
        evaluateCondition: async (when) =>
          evaluateStepCondition(when, {
            fetchSlice: async () => slice,
            fetchStableIds: async () => new Map(),
          }),
      },
    )
    return runSteps(steps, options({ onFailure: (f) => failures.push(f.message), ...extra })).then(
      (result) => ({ result, calls: d.calls, failures }),
    )
  }

  it('true: the step runs, the else does not, and the trace says what was read', async () => {
    const { result, calls } = await run({ on: true })
    expect(calls.map((c) => c.method)).toEqual(['close'])
    expect(result.steps[0]).toMatchObject({ outcome: 'ok', condition: 'true' })
    expect(result.steps[0]?.else).toBeUndefined()
  })

  it('false: the else steps run instead and are traced under the step', async () => {
    const { result, calls } = await run({ on: false })
    expect(calls.map((c) => c.method)).toEqual(['open'])
    expect(result.steps[0]).toMatchObject({ outcome: 'ok', condition: 'false' })
    expect(result.steps[0]?.else?.[0]).toMatchObject({
      outcome: 'ok',
      method: 'open',
      path: 'steps.0.else.0',
    })
  })

  it('false with no else: the step is skipped, not silently ok', async () => {
    const d = deps()
    const { else: _drop, ...bare } = closeStep as Extract<ActionStep, { kind: 'cap' }>
    const steps = buildActionSteps(
      [bare],
      {},
      {
        ...d.deps,
        evaluateCondition: async (when) =>
          evaluateStepCondition(when, {
            fetchSlice: async () => ({ on: false }),
            fetchStableIds: async () => new Map(),
          }),
      },
    )
    const result = await runSteps(steps, options())
    expect(d.calls).toEqual([])
    expect(result.steps[0]).toMatchObject({ outcome: 'skipped', condition: 'false' })
  })

  it('unknown: NEITHER side runs and the trace says why', async () => {
    const { result, calls } = await run(undefined)
    expect(calls).toEqual([])
    expect(result.steps[0]).toMatchObject({ outcome: 'skipped', condition: 'unknown' })
    expect(result.steps[0]?.message).toMatch(/not known/i)
    expect(result.steps[0]?.else).toBeUndefined()
  })

  it('a failing else step fails the run and the later steps are not run', async () => {
    const d = deps()
    const failing: ActionStep = {
      ...(closeStep as Extract<ActionStep, { kind: 'cap' }>),
      else: [{ kind: 'cap', deviceId: 1, cap: 'broken', method: 'x' }],
    }
    const steps = buildActionSteps(
      [failing, { kind: 'wait', seconds: 1 }],
      {},
      {
        ...d.deps,
        evaluateCondition: async (when) =>
          evaluateStepCondition(when, {
            fetchSlice: async () => ({ on: false }),
            fetchStableIds: async () => new Map(),
          }),
      },
    )
    const result = await runSteps(steps, options())
    expect(result.failed).toBe(true)
    expect(result.steps[0]).toMatchObject({ outcome: 'error', condition: 'false' })
    expect(result.steps[1]).toMatchObject({ outcome: 'not-run' })
  })

  it('a consumer with no evaluator fails the step rather than guessing', async () => {
    const d = deps()
    const steps = buildActionSteps([closeStep], {}, d.deps)
    const result = await runSteps(steps, options())
    expect(d.calls).toEqual([])
    expect(result.steps[0]).toMatchObject({ outcome: 'skipped', condition: 'unknown' })
    expect(result.steps[0]?.message).toMatch(/no condition evaluator/i)
  })
})
