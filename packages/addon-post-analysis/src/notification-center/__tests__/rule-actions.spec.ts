/**
 * Running a rule's Actions (planning#473): the centre starts an Action by id through
 * `actions.run` and owns nothing of the run itself.
 */
import type { ActionEntry, ActionRunResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  NcActionCatalog,
  type NcActionsPort,
  NcRuleActionRunner,
  variablesFor,
} from '../rule-actions.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'

function entry(over: Partial<ActionEntry> & Pick<ActionEntry, 'id'>): ActionEntry {
  return {
    name: over.id,
    addonId: 'core-blocks',
    source: 'internal',
    readOnly: false,
    status: { isRunning: false, lastRunAt: null, lastError: null },
    ...over,
  }
}

interface RunCall {
  readonly actionId: string
  readonly variables?: Readonly<Record<string, string | number | boolean>>
  readonly wait: boolean
  readonly deviceId?: number
  readonly origin?: { readonly ruleId: string }
}

function world(
  entries: readonly ActionEntry[],
  answer: (call: RunCall) => ActionRunResult | Error = () => ({ runId: 'r1', outcome: 'ran' }),
) {
  const calls: RunCall[] = []
  const port: NcActionsPort = {
    list: async () => entries,
    run: async (input) => {
      calls.push(input)
      const out = answer(input)
      if (out instanceof Error) throw out
      return out
    },
  }
  const logger = makeSilentLogger()
  const catalog = new NcActionCatalog(port, logger)
  return { calls, port, catalog, runner: new NcRuleActionRunner(port, catalog, logger) }
}

const GATE = entry({
  id: 'internal:gate',
  variables: [
    { name: 'deviceId', type: 'number' },
    { name: 'class', type: 'string' },
    { name: 'mood', type: 'select', options: ['calm', 'loud'] },
    { name: 'unrelated', type: 'string' },
  ],
})

describe('variablesFor', () => {
  it('hands an Action only the variables it declared, matched by name and type', () => {
    expect(
      variablesFor(GATE, { deviceId: 12, class: 'person', rule: 'Gate', ruleId: 'r1' }),
    ).toEqual({ deviceId: 12, class: 'person' })
  })

  it('hands nothing to an Action that declares nothing', () => {
    expect(variablesFor(entry({ id: 'internal:plain' }), { deviceId: 12, class: 'cat' })).toEqual(
      {},
    )
    expect(variablesFor(undefined, { deviceId: 12 })).toEqual({})
  })

  it('refuses a number offered to a string variable and a string offered to a number one', () => {
    const typed = entry({
      id: 'internal:typed',
      variables: [
        { name: 'deviceId', type: 'string' },
        { name: 'class', type: 'number' },
      ],
    })
    expect(variablesFor(typed, { deviceId: 12, class: 'person' })).toEqual({})
  })
})

describe('NcRuleActionRunner.runHook', () => {
  it('runs each named Action, waiting for it, on the subject device, with the declared variables', async () => {
    const w = world([GATE, entry({ id: 'internal:siren' })])
    await w.catalog.load()
    const out = await w.runner.runHook({
      ruleId: 'r1',
      ruleName: 'Gate rule',
      deviceId: 12,
      actionIds: ['internal:gate', 'internal:siren'],
      fire: { deviceId: 12, class: 'person' },
    })
    expect(out.map((o) => o.ran)).toEqual([true, true])
    expect(w.calls).toEqual([
      {
        actionId: 'internal:gate',
        variables: { deviceId: 12, class: 'person' },
        wait: true,
        deviceId: 12,
      },
      { actionId: 'internal:siren', variables: {}, wait: true, deviceId: 12 },
    ])
  })

  it('does not let a refused or failing Action cost the next one, and never throws', async () => {
    const w = world([GATE], (call) =>
      call.actionId === 'internal:a'
        ? { runId: 'r', outcome: 'skipped-cooldown', message: 'throttled' }
        : call.actionId === 'internal:b'
          ? new Error('the Actions cap is down')
          : { runId: 'r', outcome: 'ran' },
    )
    const out = await w.runner.runHook({
      ruleId: 'r1',
      ruleName: 'Rule',
      deviceId: 3,
      actionIds: ['internal:a', 'internal:b', 'internal:c'],
      fire: {},
    })
    expect(out).toEqual([
      { actionId: 'internal:a', ran: false, outcome: 'skipped-cooldown' },
      { actionId: 'internal:b', ran: false, error: 'the Actions cap is down' },
      { actionId: 'internal:c', ran: true, outcome: 'ran' },
    ])
  })
})

describe('NcRuleActionRunner.runGranted', () => {
  it('resolves when the Action ran to its end', async () => {
    const w = world([GATE])
    await expect(
      w.runner.runGranted({
        ruleId: 'r1',
        ruleName: 'Rule',
        deviceId: 5,
        actionId: 'internal:gate',
      }),
    ).resolves.toBeUndefined()
    expect(w.calls[0]).toMatchObject({ actionId: 'internal:gate', wait: true, deviceId: 5 })
    expect(w.calls[0]?.origin).toBeUndefined()
  })

  it('a rule fire is the run origin; a granted button press is not', async () => {
    const w = world([GATE])
    await w.catalog.load()
    const origin = {
      ruleId: 'r1',
      ruleName: 'Gate rule',
      deviceId: 12,
      recordId: 'rec',
      timestamp: 5,
    }
    await w.runner.runHook({
      ruleId: 'r1',
      ruleName: 'Gate rule',
      deviceId: 12,
      actionIds: ['internal:gate'],
      fire: { deviceId: 12 },
      origin,
    })
    expect(w.calls[0]?.origin).toEqual(origin)
  })

  it('throws when the Actions surface refused or failed the run, so the page can say so', async () => {
    const throttled = world([GATE], () => ({
      runId: 'r',
      outcome: 'skipped-cooldown',
      message: 'throttled',
    }))
    await expect(
      throttled.runner.runGranted({
        ruleId: 'r1',
        ruleName: 'Rule',
        deviceId: 5,
        actionId: 'internal:gate',
      }),
    ).rejects.toThrow('skipped-cooldown')
    const down = world([GATE], () => new Error('not reachable'))
    await expect(
      down.runner.runGranted({
        ruleId: 'r1',
        ruleName: 'Rule',
        deviceId: 5,
        actionId: 'internal:gate',
      }),
    ).rejects.toThrow('not reachable')
  })
})

describe('NcActionCatalog', () => {
  it('keeps the Actions it already knows when a refresh fails (D49)', async () => {
    let fail = false
    const port = {
      list: async (): Promise<readonly ActionEntry[]> => {
        if (fail) throw new Error('timeout')
        return [GATE]
      },
    }
    const catalog = new NcActionCatalog(port, makeSilentLogger())
    await catalog.load()
    fail = true
    await catalog.load()
    expect([...catalog.knownIds()]).toEqual(['internal:gate'])
    expect(catalog.stepsOf('internal:gate')).toBeUndefined()
  })

  it('exposes the steps of an Action for the alarm-exemption lookup', async () => {
    const step = {
      kind: 'command' as const,
      target: { kind: 'devices' as const, ids: [1] },
      actionId: 'alarm.arm.night',
    }
    const catalog = new NcActionCatalog(
      { list: async () => [entry({ id: 'internal:arm', steps: [step] })] },
      makeSilentLogger(),
    )
    await catalog.load()
    expect(catalog.stepsOf('internal:arm')).toEqual([step])
    expect(catalog.stepsOf('internal:missing')).toBeUndefined()
  })
})
