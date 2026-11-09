import { describe, expect, it, vi } from 'vitest'
import type { DeviceTemplateRender } from '../../expression/device-template.js'
import { type ActionVariable, resolveActionVariables } from '../action.js'
import { ActionTargetResolver } from '../action-target.js'
import { evaluateStepCondition } from '../step-condition.js'
import type { ActionStep } from '../recipe.js'
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
