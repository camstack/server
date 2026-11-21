import { describe, expect, it, vi } from 'vitest'
import { ActionTargetResolver } from '../action-target.js'
import { buildActionSteps } from '../action-steps.js'
import {
  ACTION_STEP_KINDS,
  ActionStepSchema,
  type ActionStep,
  AutomationActionSchema,
  CODE_NOT_IN_ACTION,
} from '../recipe.js'
import { TRIGGERED_BY_NEEDS_AUTOMATION } from '../when.js'
import type { HttpRequestInit } from '../reach-steps.js'
import { runSteps, type ActionStepDeps, type RunStepsOptions } from '../step-runner.js'
import { fakeRegistry, recordingLogger } from './target-fixtures.js'

const IF = { kind: 'all', children: [] } as const

/** One valid step of every kind an automation's Then has. */
const SAMPLES: Readonly<Record<string, unknown>> = {
  wait: { kind: 'wait', seconds: 1 },
  command: {
    kind: 'command',
    target: { kind: 'devices', ids: [1] },
    actionId: 'switch.on',
  },
  action: { kind: 'action', actionId: 'internal:other' },
  notify: { kind: 'notify', targetId: 't1', body: 'hello' },
  probe: { kind: 'probe', host: 'ccu.local', port: 80, timeoutSeconds: 2 },
  'http-request': {
    kind: 'http-request',
    method: 'GET',
    url: 'http://ccu.local/api',
    timeoutSeconds: 2,
  },
  'wait-until': { kind: 'wait-until', when: IF, timeoutS: 1, onTimeout: 'continue' },
  set: { kind: 'set', vars: { a: 1 } },
  stop: { kind: 'stop', reason: 'done', outcome: 'ok' },
  choose: {
    kind: 'choose',
    branches: [{ if: IF, steps: [{ kind: 'wait', seconds: 1 }] }],
  },
  parallel: {
    kind: 'parallel',
    steps: [
      { kind: 'wait', seconds: 1 },
      { kind: 'wait', seconds: 2 },
    ],
  },
  repeat: {
    kind: 'repeat',
    loop: { by: 'count', count: 2 },
    steps: [{ kind: 'wait', seconds: 1 }],
  },
  code: { kind: 'code', code: 'await 1' },
}

/** Every kind the automation schema knows, read from the schema itself. */
function automationKinds(): string[] {
  return AutomationActionSchema.options.map((option) => String(option.shape.kind.value))
}

function options(over: Partial<RunStepsOptions> = {}): RunStepsOptions {
  return {
    pathPrefix: 'steps',
    isAborted: () => false,
    abortReason: 'aborted',
    now: () => 1_000,
    onFailure: () => undefined,
    ...over,
  }
}

function baseDeps(over: Partial<ActionStepDeps> = {}): ActionStepDeps {
  const resolver = new ActionTargetResolver(fakeRegistry([]).directory, recordingLogger().logger)
  return {
    invokeCap: async () => undefined,
    sleep: async () => undefined,
    onMissingVar: () => undefined,
    resolveTarget: (...args: Parameters<ActionTargetResolver['resolve']>) =>
      resolver.resolve(...args),
    ...over,
  }
}

function parsed(raw: unknown): ActionStep {
  return ActionStepSchema.parse(raw)
}

describe('the step kinds of an Action', () => {
  it('are every kind an automation has, except code: a new kind is offered or refused on purpose', () => {
    const expected = automationKinds()
      .filter((kind) => kind !== 'code')
      .sort()
    expect([...ACTION_STEP_KINDS].sort()).toEqual(expected)
  })

  it('every one has a sample that the schema takes, and an Action refuses code by name', () => {
    for (const kind of ACTION_STEP_KINDS) {
      expect(ActionStepSchema.safeParse(SAMPLES[kind]).success, kind).toBe(true)
    }
    const code = ActionStepSchema.safeParse(SAMPLES['code'])
    expect(code.success).toBe(false)
    expect(JSON.stringify(code.error?.issues)).toContain(CODE_NOT_IN_ACTION)
  })

  it('every one is built by the runner: a kind without a builder fails here', () => {
    for (const kind of ACTION_STEP_KINDS) {
      const [built] = buildActionSteps([parsed(SAMPLES[kind])], {}, baseDeps())
      expect(built?.meta.kind, kind).toBe(kind)
    }
  })

  it('refuse a triggered-by condition, wherever it sits', () => {
    const byTrigger = { kind: 'triggered-by', leafIds: ['e1'] }
    const result = ActionStepSchema.safeParse({
      kind: 'choose',
      branches: [{ if: byTrigger, steps: [{ kind: 'wait', seconds: 1 }] }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      TRIGGERED_BY_NEEDS_AUTOMATION,
    )
  })
})

describe('a stored Action with an http-request step', () => {
  const stored = [
    { kind: 'set', vars: { host: 'ccu.local' } },
    {
      kind: 'http-request',
      method: 'POST',
      url: 'http://{{vars.host}}/api',
      headers: { 'X-Key': 'secret' },
      body: '{"on":true}',
      timeoutSeconds: 5,
      expect: { on: 'status', operator: 'eq', value: 200 },
      saveAs: 'r',
    },
    { kind: 'stop', reason: 'status {{vars.r.status}}', outcome: 'ok' },
  ]

  it('validates and runs through the runner: the request goes out, the answer is traced', async () => {
    const steps = z3(stored)
    const fetch = vi.fn(async (_url: string, _init: HttpRequestInit) => ({
      status: 200,
      text: async () => '{"ok":true}',
    }))
    const runnable = buildActionSteps(steps, {}, baseDeps({ fetch }))
    const result = await runSteps(runnable, options())
    expect(result.failed).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('http://ccu.local/api')
    expect(init).toMatchObject({ method: 'POST', body: '{"on":true}' })
    expect(result.stopped?.reason).toBe('status 200')
    expect(result.steps[1]?.outcome).toBe('ok')
    // a header value is never traced
    expect(JSON.stringify(result.steps)).not.toContain('secret')
  })

  it('fails the step, traced, when the answer is not what it expects', async () => {
    const steps = z3(stored)
    const fetch = vi.fn(async () => ({ status: 500, text: async () => '' }))
    const result = await runSteps(buildActionSteps(steps, {}, baseDeps({ fetch })), options())
    expect(result.failed).toBe(true)
    expect(result.steps[1]?.outcome).toBe('error')
    expect(result.steps[2]?.outcome).toBe('not-run')
  })

  it('fails when the consumer has no network, instead of running as something else', async () => {
    const result = await runSteps(buildActionSteps(z3(stored), {}, baseDeps()), options())
    expect(result.failed).toBe(true)
    expect(result.steps[1]?.message).toContain('cannot run a http-request step')
  })
})

function z3(raw: readonly unknown[]): ActionStep[] {
  return raw.map(parsed)
}

describe('the flow steps of an Action', () => {
  it('a choose runs the branch whose condition reads true', async () => {
    const steps = z3([
      {
        kind: 'choose',
        branches: [{ if: IF, steps: [{ kind: 'set', vars: { picked: 'first' } }] }],
        else: [{ kind: 'set', vars: { picked: 'else' } }],
      },
      { kind: 'stop', reason: '{{vars.picked}}', outcome: 'ok' },
    ])
    const result = await runSteps(
      buildActionSteps(
        steps,
        {},
        baseDeps({ evaluateCondition: async () => ({ result: 'true', reason: 'x' }) }),
      ),
      options(),
    )
    expect(result.stopped?.reason).toBe('first')
  })

  it('a repeat by count runs its steps that many times', async () => {
    const slept: number[] = []
    const steps = z3([
      { kind: 'repeat', loop: { by: 'count', count: 3 }, steps: [{ kind: 'wait', seconds: 2 }] },
    ])
    await runSteps(
      buildActionSteps(steps, {}, baseDeps({ sleep: async (ms) => void slept.push(ms) })),
      options(),
    )
    expect(slept).toEqual([2000, 2000, 2000])
  })

  it('a wait-until that never reads true times out and goes on, as an automation does', async () => {
    const steps = z3([{ kind: 'wait-until', when: IF, timeoutS: 10, onTimeout: 'continue' }])
    let t = 0
    const result = await runSteps(
      buildActionSteps(
        steps,
        {},
        baseDeps({
          now: () => t,
          sleep: async (ms) => {
            t += ms
          },
          evaluateCondition: async () => ({ result: 'false', reason: 'not yet' }),
        }),
      ),
      options(),
    )
    expect(result.failed).toBe(false)
    expect(result.steps[0]?.outcome).toBe('timed-out')
  })

  it('an action step takes the outcome of the run it awaits', async () => {
    const steps = z3([{ kind: 'action', actionId: 'internal:b', variables: { n: '{{vars.n}}' } }])
    const run = vi.fn(async () => ({ outcome: 'failed', message: 'boom' }))
    const result = await runSteps(
      buildActionSteps(steps, { n: 4 }, baseDeps({ runAction: run })),
      options(),
    )
    expect(run).toHaveBeenCalledWith({ actionId: 'internal:b', variables: { n: '4' } })
    expect(result.failed).toBe(true)
    expect(result.steps[0]?.message).toContain('action internal:b failed: boom')
  })
})
