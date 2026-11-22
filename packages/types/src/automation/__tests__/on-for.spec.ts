import { describe, expect, it } from 'vitest'
import { type OnForHold, OnForHolds, onForActionOf } from '../on-for.js'
import {
  ActionStepSchema,
  AutomationActionSchema,
  NarrowActionStepSchema,
  ON_FOR_NEEDS_AUTOMATION,
} from '../recipe.js'

const LAMP = 7
const MIN = 60_000

interface Rig {
  readonly holds: OnForHolds<number>
  readonly sent: string[]
  readonly persisted: OnForHold[][]
  readonly dropped: string[]
  state: boolean | null
  failOff: boolean
  failOn: boolean
  failPersist: boolean
  /** Every persist and send, in the order they happened. */
  readonly trail: string[]
  readonly errors: string[]
  advance(ms: number): Promise<void>
}

/** A lamp with a clock: timers fire in order as the clock advances. */
function rig(start = 1_000_000, lampOn: boolean | null = false): Rig {
  let now = start
  let seq = 0
  const timers = new Map<number, { readonly at: number; readonly fn: () => void }>()
  const out: Rig = {
    sent: [],
    persisted: [],
    dropped: [],
    state: lampOn,
    failOff: false,
    failOn: false,
    failPersist: false,
    trail: [],
    errors: [],
    holds: new OnForHolds({
      timers: {
        now: () => now,
        set: (fn, ms) => {
          seq += 1
          timers.set(seq, { at: now + ms, fn })
          return seq
        },
        clear: (handle) => {
          timers.delete(handle)
        },
      },
      readOn: async () => out.state,
      send: async (deviceId, actionId) => {
        if (actionId === 'switch.off' && out.failOff) throw new Error('unreachable')
        if (actionId === 'switch.on' && out.failOn) throw new Error('unreachable')
        out.trail.push(`send:${actionId}`)
        out.sent.push(`${deviceId}:${actionId}`)
        out.state = actionId === 'switch.on'
      },
      persist: async (list) => {
        if (out.failPersist) throw new Error('ledger down')
        out.trail.push(`persist:${list.length}`)
        out.persisted.push([...list])
      },
      onError: (deviceId, what) => {
        out.errors.push(`${deviceId}:${what}`)
      },
      onDropped: (hold, reason) => {
        out.dropped.push(`${hold.deviceId}:${reason}`)
      },
    }),
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        await out.holds.idle()
      }
      now = end
    },
  }
  return out
}

describe('onForActionOf', () => {
  it('knows switch.on and its way back, and nothing else', () => {
    expect(onForActionOf('switch.on')).toEqual({
      cap: 'switch',
      fieldPath: 'on',
      offActionId: 'switch.off',
    })
    expect(onForActionOf('switch.off')).toBeNull()
    expect(onForActionOf('switch.toggle')).toBeNull()
  })
})

describe('OnForHolds', () => {
  it('off: turns on, a new event restarts the timer, and it turns off when the last one runs out', async () => {
    const r = rig()
    expect(await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).toBe('turned-on')
    expect(r.sent).toEqual(['7:switch.on'])
    await r.advance(4 * MIN)
    expect(await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).toBe('extended')
    await r.advance(4 * MIN)
    // the first deadline has passed; the second has not
    expect(r.sent).toEqual(['7:switch.on'])
    await r.advance(MIN)
    expect(r.sent).toEqual(['7:switch.on', '7:switch.off'])
    expect(r.holds.list()).toEqual([])
    expect(r.persisted.at(-1)).toEqual([])
  })

  it('two events at the same moment turn it on once and leave one timer', async () => {
    const r = rig()
    const both = await Promise.all([
      r.holds.trigger(LAMP, 'switch.on', 5 * MIN),
      r.holds.trigger(LAMP, 'switch.on', 5 * MIN),
    ])
    expect(both).toEqual(['turned-on', 'extended'])
    await r.advance(5 * MIN)
    expect(r.sent).toEqual(['7:switch.on', '7:switch.off'])
  })

  it('already on: touches nothing and takes no hold', async () => {
    const r = rig(1_000_000, true)
    expect(await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).toBe('already-on')
    await r.advance(10 * MIN)
    expect(r.sent).toEqual([])
    expect(r.persisted).toEqual([])
  })

  it('a state that cannot be read changes nothing', async () => {
    const r = rig(1_000_000, null)
    expect(await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).toBe('unknown')
    expect(r.sent).toEqual([])
    expect(r.holds.list()).toEqual([])
  })

  it('switched off by hand: the cycle ends and nothing is sent at the old deadline', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    r.holds.observe(LAMP, 'switch', true)
    r.state = false
    r.holds.observe(LAMP, 'switch', false)
    expect(r.holds.list()).toEqual([])
    await r.advance(10 * MIN)
    expect(r.sent).toEqual(['7:switch.on'])
  })

  it('an off report that is older than our own on does not end the cycle', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    r.holds.observe(LAMP, 'switch', false)
    expect(r.holds.list()).toHaveLength(1)
  })

  it('a new event on a held lamp that is off again turns it back on', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    r.state = false
    expect(await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).toBe('turned-on')
    expect(r.sent).toEqual(['7:switch.on', '7:switch.on'])
  })

  it('persists the hold with its deadline, and a restart turns off at that time', async () => {
    const first = rig(1_000_000)
    await first.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    const stored = first.persisted.at(-1) ?? []
    expect(stored).toEqual([{ deviceId: LAMP, cap: 'switch', deadline: 1_000_000 + 5 * MIN }])

    // the block restarts two minutes in: no memory, only what was stored
    const second = rig(1_000_000 + 2 * MIN, true)
    second.holds.restore(stored)
    await second.advance(3 * MIN - 1)
    expect(second.sent).toEqual([])
    await second.advance(1)
    expect(second.sent).toEqual(['7:switch.off'])
  })

  it('a restart after the deadline turns off at once', async () => {
    const r = rig(2_000_000, true)
    r.holds.restore([{ deviceId: LAMP, cap: 'switch', deadline: 1_500_000 }])
    await r.advance(0)
    expect(r.sent).toEqual(['7:switch.off'])
    expect(r.persisted.at(-1)).toEqual([])
  })

  it('a restored hold whose lamp is already off sends nothing and is dropped', async () => {
    const r = rig(2_000_000, false)
    r.holds.restore([{ deviceId: LAMP, cap: 'switch', deadline: 1_500_000 }])
    await r.advance(0)
    expect(r.sent).toEqual([])
    expect(r.holds.list()).toEqual([])
  })

  it('an off that fails is tried again, then given up and said', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', MIN)
    r.failOff = true
    await r.advance(MIN)
    expect(r.holds.list()).toHaveLength(1)
    r.failOff = false
    await r.advance(MIN)
    expect(r.sent).toEqual(['7:switch.on', '7:switch.off'])
    expect(r.holds.list()).toEqual([])

    const stuck = rig()
    await stuck.holds.trigger(LAMP, 'switch.on', MIN)
    stuck.failOff = true
    await stuck.advance(60 * MIN)
    expect(stuck.holds.list()).toEqual([])
    expect(stuck.dropped).toEqual(['7:the device could not be turned off'])
  })

  it('dispose stops the timers and keeps what was stored', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', MIN)
    const writes = r.persisted.length
    r.holds.dispose()
    await r.advance(10 * MIN)
    expect(r.sent).toEqual(['7:switch.on'])
    expect(r.persisted).toHaveLength(writes)
  })
})

describe('OnForHolds: the hold is durable before the device is touched', () => {
  it('persists the hold BEFORE it sends the on', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    expect(r.trail).toEqual(['persist:1', 'send:switch.on'])
  })

  it('an on that fails leaves no hold, in memory or in the ledger, and says so', async () => {
    const r = rig()
    r.failOn = true
    await expect(r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).resolves.toBe('failed')
    expect(r.holds.list()).toEqual([])
    expect(r.persisted.at(-1)).toEqual([])
    expect(r.errors).toHaveLength(1)
    await r.advance(10 * MIN)
    expect(r.sent).toEqual([])
  })

  it('a ledger that cannot be written is said, and the lamp is still held in memory', async () => {
    const r = rig()
    r.failPersist = true
    await expect(r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).resolves.toBe('turned-on')
    expect(r.errors.length).toBeGreaterThan(0)
    await r.advance(6 * MIN)
    expect(r.sent).toEqual(['7:switch.on', '7:switch.off'])
  })

  it('a turn-back-on that fails keeps the old deadline and timer', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    const before = r.holds.list()[0]?.deadline
    r.holds.observe(LAMP, 'switch', true)
    r.state = false
    r.failOn = true
    await r.advance(MIN)
    await expect(r.holds.trigger(LAMP, 'switch.on', 5 * MIN)).resolves.toBe('failed')
    expect(r.holds.list()[0]?.deadline).toBe(before)
    expect(r.errors).toHaveLength(1)
    r.failOn = false
    await r.advance(5 * MIN)
    // the old timer still fires: the hold is ours, the lamp is off, nothing more is sent but the hold ends
    expect(r.holds.list()).toEqual([])
  })

  it('switched off and on again by hand: the hold is released and the lamp is left on', async () => {
    const r = rig()
    await r.holds.trigger(LAMP, 'switch.on', 5 * MIN)
    r.holds.observe(LAMP, 'switch', true)
    r.holds.observe(LAMP, 'switch', false)
    r.holds.observe(LAMP, 'switch', true)
    expect(r.holds.list()).toEqual([])
    r.state = true
    await r.advance(10 * MIN)
    expect(r.sent).toEqual(['7:switch.on'])
  })
})

describe('where "on for a time" may be written', () => {
  const step = (actionId: string) => ({
    kind: 'command',
    target: { kind: 'devices', ids: [LAMP] },
    actionId,
    onFor: { seconds: 60 },
  })

  it('an automation step takes it on a turn-on action only', () => {
    expect(AutomationActionSchema.safeParse(step('switch.on')).success).toBe(true)
    const refused = AutomationActionSchema.safeParse(step('switch.off'))
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused.error?.issues)).toContain('only a turn-on action can')
  })

  it('an Action or a narrow list refuses it: nothing there outlives the run to turn it off', () => {
    for (const schema of [ActionStepSchema, NarrowActionStepSchema]) {
      const refused = schema.safeParse(step('switch.on'))
      expect(refused.success).toBe(false)
      expect(refused.error?.issues.map((issue) => issue.message)).toContain(ON_FOR_NEEDS_AUTOMATION)
    }
    const nested = ActionStepSchema.safeParse({
      kind: 'parallel',
      steps: [step('switch.on'), step('switch.on')],
    })
    expect(nested.success).toBe(false)
  })
})
