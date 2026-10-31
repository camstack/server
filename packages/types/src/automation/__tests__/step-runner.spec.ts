import { describe, expect, it, vi } from 'vitest'
import { type ActionVariable, resolveActionVariables } from '../action.js'
import { ActionTargetResolver } from '../action-target.js'
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
