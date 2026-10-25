/**
 * Running a rule's action sequences / bindings.
 */
import type { NcSharedSequence } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { asForcedSequence, NcRuleActionRunner, type ResolvedRunSequence } from '../rule-actions.js'

const T0 = 1_800_000_000_000

interface Harness {
  readonly runner: NcRuleActionRunner
  readonly calls: { cap: string; method: string; deviceId: number; args: unknown }[]
  readonly waits: number[]
  setNow(ms: number): void
  failOn(predicate: (cap: string, method: string) => boolean): void
}

function makeHarness(opts: { deviceScoped?: (cap: string) => boolean } = {}): Harness {
  const calls: Harness['calls'] = []
  const waits: number[] = []
  let now = T0
  let shouldFail: (cap: string, method: string) => boolean = () => false
  const runner = new NcRuleActionRunner({
    logger: makeSilentLogger(),
    actuate: async ({ deviceId, cap, method, args }) => {
      if (shouldFail(cap, method)) throw new Error(`${cap}.${method} refused`)
      calls.push({ cap, method, deviceId, args })
    },
    isDeviceScoped: opts.deviceScoped ?? (() => true),
    sleep: async (ms) => {
      waits.push(ms)
    },
    now: () => now,
  })
  return {
    runner,
    calls,
    waits,
    setNow: (ms) => {
      now = ms
    },
    failOn: (p) => {
      shouldFail = p
    },
  }
}

function shared(overrides: Partial<NcSharedSequence> = {}): NcSharedSequence {
  return {
    id: 'seq-arm',
    name: 'arm the house',
    actions: [
      { kind: 'cap', deviceId: 9, cap: 'alarm-panel', method: 'arm', args: { mode: 'away' } },
    ],
    ...overrides,
  }
}

function resolved(sequence: NcSharedSequence, throttle = true): ResolvedRunSequence {
  return {
    id: sequence.id,
    name: sequence.name,
    enabled: true,
    ...(sequence.minDelaySec !== undefined ? { minDelaySec: sequence.minDelaySec } : {}),
    actions: sequence.actions,
    throttle,
  }
}

const base = { ruleId: 'r1', ruleName: 'gate', deviceId: 101 }

describe('running a sequence', () => {
  it('actuates the device — the alarm is not a special case', async () => {
    const h = makeHarness()
    await h.runner.run({ ...base, sequences: [resolved(shared())] })
    expect(h.calls).toEqual([
      { cap: 'alarm-panel', method: 'arm', deviceId: 9, args: { mode: 'away' } },
    ])
  })

  it('runs the steps IN ORDER, with wait as a real step', async () => {
    const h = makeHarness()
    await h.runner.run({
      ...base,
      sequences: [
        resolved(
          shared({
            actions: [
              { kind: 'cap', deviceId: 3, cap: 'lock-control', method: 'unlock' },
              { kind: 'wait', seconds: 5 },
              { kind: 'cap', deviceId: 3, cap: 'cover', method: 'open' },
            ],
          }),
        ),
      ],
    })
    expect(h.calls.map((c) => `${c.cap}.${c.method}`)).toEqual([
      'lock-control.unlock',
      'cover.open',
    ])
    expect(h.waits).toEqual([5000])
  })

  it('STOPS at the first failure instead of carrying on', async () => {
    const h = makeHarness()
    h.failOn((cap) => cap === 'alarm-panel')
    const [outcome] = await h.runner.run({
      ...base,
      sequences: [
        resolved(
          shared({
            actions: [
              { kind: 'cap', deviceId: 9, cap: 'alarm-panel', method: 'disarm' },
              { kind: 'cap', deviceId: 3, cap: 'cover', method: 'open' },
            ],
          }),
        ),
      ],
    })
    expect(outcome?.failedAt).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  it('never throws — a failed actuation must not cost the notification', async () => {
    const h = makeHarness()
    h.failOn(() => true)
    await expect(h.runner.run({ ...base, sequences: [resolved(shared())] })).resolves.toBeDefined()
  })
})

describe('what a rule may reach', () => {
  it('REFUSES a capability that is not device-scoped', async () => {
    const h = makeHarness({ deviceScoped: (cap) => cap !== 'device-manager' })
    const [outcome] = await h.runner.run({
      ...base,
      sequences: [
        resolved(
          shared({
            actions: [{ kind: 'cap', deviceId: 9, cap: 'device-manager', method: 'removeDevice' }],
          }),
        ),
      ],
    })
    expect(outcome?.failedAt).toBe(0)
    expect(h.calls).toHaveLength(0)
  })
})

describe('throttle by sequenceId', () => {
  it('throttles by sequence id, not ruleId:name — two rules share one budget', async () => {
    const h = makeHarness()
    const seq = resolved(shared({ minDelaySec: 60 }))
    await h.runner.run({ ...base, sequences: [seq] })
    const [second] = await h.runner.run({
      ruleId: 'r2',
      ruleName: 'other',
      deviceId: 616,
      sequences: [seq],
    })
    expect(second?.skippedReason).toBe('throttled')
    expect(h.calls).toHaveLength(1)

    h.setNow(T0 + 61_000)
    await h.runner.run({ ...base, sequences: [seq] })
    expect(h.calls).toHaveLength(2)
  })

  it('throttles per SEQUENCE id, not per rule', async () => {
    const h = makeHarness()
    await h.runner.run({
      ...base,
      sequences: [
        resolved(shared({ id: 'a', name: 'a', minDelaySec: 60 })),
        resolved(shared({ id: 'b', name: 'b', minDelaySec: 60 })),
      ],
    })
    expect(h.calls).toHaveLength(2)
  })

  it('does not throttle a Do binding', async () => {
    const h = makeHarness()
    const lookup = (): NcSharedSequence | null => null
    await h.runner.runBindings({
      ...base,
      bindings: [
        {
          kind: 'do',
          action: {
            kind: 'cap',
            deviceId: 1,
            cap: 'switch',
            method: 'setState',
            args: { on: true },
          },
        },
      ],
      lookup,
    })
    await h.runner.runBindings({
      ...base,
      bindings: [
        {
          kind: 'do',
          action: {
            kind: 'cap',
            deviceId: 1,
            cap: 'switch',
            method: 'setState',
            args: { on: true },
          },
        },
      ],
      lookup,
    })
    expect(h.calls).toHaveLength(2)
  })
})

describe('runBindings', () => {
  it('resolves a sequence ref via lookup', async () => {
    const h = makeHarness()
    const seq = shared()
    await h.runner.runBindings({
      ...base,
      bindings: [{ kind: 'sequence', sequenceId: seq.id }],
      lookup: (id) => (id === seq.id ? seq : null),
    })
    expect(h.calls).toHaveLength(1)
  })

  it('asForcedSequence always enables for a button tap', () => {
    const forced = asForcedSequence(shared())
    expect(forced.enabled).toBe(true)
    expect(forced.throttle).toBe(true)
  })
})
