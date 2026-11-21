import type { CommandActor, DeviceCommandObservation, DeviceTransition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_MATCH_WINDOW_MS,
  PENDING_RING_MAX,
  SETTLE_MAX_HOLD_MS,
  SETTLE_QUIET_MS,
  TransitionCorrelator,
} from '../transition-correlator.js'

const USER: CommandActor = {
  kind: 'user',
  userId: 'u1',
  username: 'ada',
  credential: 'session',
}
const ALEXA: CommandActor = { kind: 'addon', addonId: 'export-alexa' }

function world(initial: Record<string, Record<string, unknown>> = {}) {
  let clock = 1_000_000
  const slices = new Map<string, Record<string, unknown>>(Object.entries(initial))
  const out: DeviceTransition[] = []
  const correlator = new TransitionCorrelator({
    now: () => clock,
    currentSlice: (deviceId, capName) => slices.get(`${deviceId}|${capName}`),
    emit: (t) => void out.push(t),
    prepareArgs: (_cap, _method, args) => ({ ...args }),
  })
  const command = (
    capName: string,
    method: string,
    args: Record<string, unknown>,
    actor: CommandActor = USER,
    outcome?: Promise<void>,
  ): void =>
    correlator.recordCommand({
      deviceId: 7,
      capName,
      method,
      args: { deviceId: 7, ...args },
      actor,
      at: clock,
      ...(outcome !== undefined ? { outcome } : {}),
    } satisfies DeviceCommandObservation)
  /** The provider writes its slice: the mirror calls the correlator with prior and new. */
  const write = (capName: string, slice: Record<string, unknown>): void => {
    const key = `7|${capName}`
    const prior = slices.get(key)
    slices.set(key, slice)
    correlator.onSliceChange(7, capName, prior, slice)
  }
  return {
    correlator,
    out,
    command,
    write,
    advance: (ms: number): void => {
      clock += ms
    },
    /** The cap goes quiet: the held burst is written by the next sweep. */
    settle: (): void => {
      clock += SETTLE_QUIET_MS
      correlator.sweep()
    },
  }
}

describe('transition correlator (D1022)', () => {
  it('a set that the device then reports is confirmed, with from, to and the delay', () => {
    const w = world({ '7|switch': { on: false } })
    w.command('switch', 'setState', { on: true })
    w.advance(420)
    w.write('switch', { on: true })
    expect(w.out).toHaveLength(1)
    expect(w.out[0]).toMatchObject({
      deviceId: 7,
      capName: 'switch',
      field: 'on',
      from: false,
      to: true,
      outcome: 'confirmed',
      actor: USER,
      command: { method: 'setState', matchedAfterMs: 420 },
    })
  })

  it('a change nobody asked for belongs to the device', () => {
    const w = world({ '7|switch': { on: false } })
    w.write('switch', { on: true })
    w.settle()
    expect(w.out).toEqual([
      expect.objectContaining({
        outcome: 'device',
        actor: { kind: 'device' },
        from: false,
        to: true,
      }),
    ])
    expect(w.out[0]?.command).toBeUndefined()
  })

  it('the first slice a cap ever reports is learning the device, not a change', () => {
    const w = world()
    w.write('switch', { on: true })
    w.settle()
    expect(w.out).toEqual([])
    w.write('switch', { on: false })
    w.settle()
    expect(w.out).toEqual([expect.objectContaining({ outcome: 'device', from: true, to: false })])
  })

  it('a field absent from the prior slice and claimed by no command is the device being learned', () => {
    const w = world({ '7|switch': {} })
    w.write('switch', { on: true })
    w.settle()
    expect(w.out).toEqual([])
    w.write('switch', { on: false })
    w.settle()
    expect(w.out).toEqual([expect.objectContaining({ outcome: 'device', from: true, to: false })])
  })

  it('a field present in the prior slice that changes stays a device row', () => {
    const w = world({ '7|climate-control': { mode: 'cool' } })
    w.write('climate-control', { mode: 'off' })
    w.settle()
    expect(w.out).toEqual([
      expect.objectContaining({
        outcome: 'device',
        field: 'mode',
        from: 'cool',
        to: 'off',
      }),
    ])
  })

  it('a command still claims a field that appears for the first time', () => {
    const w = world({ '7|switch': {} })
    w.command('switch', 'setState', { on: true })
    w.write('switch', { on: true })
    expect(w.out).toEqual([expect.objectContaining({ outcome: 'confirmed', to: true })])
  })

  it('a command whose target already holds is recorded as already, and waits for nothing', () => {
    const w = world({ '7|switch': { on: true } })
    w.command('switch', 'setState', { on: true })
    expect(w.out).toEqual([
      expect.objectContaining({
        outcome: 'already',
        from: true,
        to: true,
        actor: USER,
      }),
    ])
    expect(w.correlator.pendingCount()).toBe(0)
    w.write('switch', { on: false })
    w.settle()
    expect(w.out[1]).toMatchObject({ outcome: 'device' })
  })

  it('an effect-less command (stop) takes the next change of the cap', () => {
    const w = world({ '7|cover': { state: 'opening', position: 40 } })
    w.command('cover', 'stop', {}, ALEXA)
    w.write('cover', { state: 'open', position: 40 })
    w.settle()
    expect(w.out).toHaveLength(1)
    expect(w.out[0]).toMatchObject({
      field: 'state',
      from: 'opening',
      to: 'open',
      outcome: 'confirmed',
      actor: ALEXA,
      command: { method: 'stop' },
    })
  })

  it('the newest command whose effect fits wins; the other expires unconfirmed', () => {
    const w = world({ '7|switch': { on: false } })
    w.command('switch', 'setState', { on: true }, ALEXA)
    w.advance(100)
    w.command('switch', 'setState', { on: true }, USER)
    w.advance(50)
    w.write('switch', { on: true })
    expect(w.out).toHaveLength(1)
    expect(w.out[0]?.actor).toEqual(USER)
    w.advance(COMMAND_MATCH_WINDOW_MS)
    w.correlator.sweep()
    expect(w.out).toHaveLength(2)
    expect(w.out[1]).toMatchObject({
      outcome: 'unconfirmed',
      actor: ALEXA,
      field: 'on',
    })
  })

  it('a command that causes nothing inside its window is unconfirmed, from = to', () => {
    const w = world({ '7|switch': { on: false } })
    w.command('switch', 'setState', { on: true })
    w.advance(COMMAND_MATCH_WINDOW_MS - 1)
    w.correlator.sweep()
    expect(w.out).toEqual([])
    w.advance(1)
    w.correlator.sweep()
    expect(w.out).toEqual([
      expect.objectContaining({
        outcome: 'unconfirmed',
        from: false,
        to: false,
        field: 'on',
        command: expect.objectContaining({ matchedAfterMs: null }),
      }),
    ])
  })

  it('a change after the window is the device, not the expired command', () => {
    const w = world({ '7|switch': { on: false } })
    w.command('switch', 'setState', { on: true })
    w.advance(COMMAND_MATCH_WINDOW_MS + 1)
    w.write('switch', { on: true })
    w.settle()
    expect(w.out[0]).toMatchObject({ outcome: 'device' })
  })

  it('an unknown previous value is from: null', () => {
    const w = world()
    w.command('switch', 'setState', { on: true })
    w.write('switch', { on: true })
    expect(w.out[0]).toMatchObject({
      outcome: 'confirmed',
      from: null,
      to: true,
    })
  })

  it('one write that changes several fields yields one row each, sharing the command', () => {
    const w = world({ '7|cover': { state: 'closed', position: 0 } })
    w.command('cover', 'open', {})
    w.write('cover', { state: 'open', position: 100 })
    expect(w.out.map((t) => t.field).sort()).toEqual(['position', 'state'])
    const ids = new Set(w.out.map((t) => t.command?.commandId))
    expect(ids.size).toBe(1)
    expect(w.out.every((t) => t.outcome === 'confirmed')).toBe(true)
  })

  it.each([
    ['state first', { state: 'open', position: 100 }],
    ['position first', { position: 100, state: 'open' }],
  ])('the final write of a setPosition credits every changed field to the sender (%s)', (_o, next) => {
    const w = world({ '7|cover': { state: 'opening', position: 6 } })
    w.command('cover', 'setPosition', { position: 100 }, ALEXA)
    w.write('cover', next)
    expect(w.out.map((t) => t.field).sort()).toEqual(['position', 'state'])
    expect(w.out.every((t) => t.outcome === 'confirmed')).toBe(true)
    expect(w.out.every((t) => t.actor.kind === 'addon')).toBe(true)
  })

  it('a state change on a cap with no pending command stays the device', () => {
    const w = world({ '7|cover': { state: 'closed', position: 0 } })
    w.write('cover', { state: 'opening', position: 0 })
    w.settle()
    expect(w.out).toHaveLength(1)
    expect(w.out[0]).toMatchObject({
      field: 'state',
      outcome: 'device',
      actor: { kind: 'device' },
    })
  })

  it('a command whose call threw is failed, with the scrubbed message, and is not matched later', async () => {
    const w = world({ '7|switch': { on: false } })
    const failure = Promise.reject(
      new Error('device unreachable rtsp://admin:abc123secret@10.0.0.5/live'),
    )
    w.command('switch', 'setState', { on: true }, USER, failure)
    await failure.catch(() => undefined)
    await Promise.resolve()
    expect(w.out).toHaveLength(1)
    expect(w.out[0]).toMatchObject({
      outcome: 'failed',
      field: 'on',
      from: false,
      to: false,
    })
    expect(w.out[0]?.command?.error).toContain('device unreachable')
    expect(w.out[0]?.command?.error).not.toContain('abc123secret')
    w.write('switch', { on: true })
    w.settle()
    expect(w.out[1]).toMatchObject({ outcome: 'device' })
  })

  it('a cap with no audited field costs nothing and records nothing', () => {
    const w = world()
    w.write('power-meter', { watts: 12 })
    expect(w.out).toEqual([])
  })

  it('an identical write is not a transition', () => {
    const w = world({ '7|switch': { on: true } })
    w.write('switch', { on: true, other: 1 })
    expect(w.out).toEqual([])
  })

  it('keeps at most a bounded ring per device and cap, expiring the oldest', () => {
    const w = world({ '7|switch': { on: false } })
    for (let i = 0; i < PENDING_RING_MAX + 2; i += 1) w.command('switch', 'setState', { on: true })
    expect(w.correlator.pendingCount()).toBe(PENDING_RING_MAX)
    expect(w.out.filter((t) => t.outcome === 'unconfirmed')).toHaveLength(2)
  })

  it('stores the arguments the injected preparer returns', () => {
    const out: DeviceTransition[] = []
    let clock = 5
    const correlator = new TransitionCorrelator({
      now: () => clock,
      currentSlice: () => ({ on: false }),
      emit: (t) => void out.push(t),
      prepareArgs: () => ({ redacted: true }),
    })
    correlator.recordCommand({
      deviceId: 7,
      capName: 'switch',
      method: 'setState',
      args: { deviceId: 7, on: true },
      actor: USER,
      at: clock,
    })
    clock += 1
    correlator.onSliceChange(7, 'switch', { on: false }, { on: true })
    expect(out[0]?.command?.args).toEqual({ redacted: true })
  })

  describe('settling a burst (one row per field per settled change)', () => {
    it('the 5500 cover: one setPosition, five reports, two rows credited to the sender', () => {
      const w = world({ '7|cover': { state: 'closed', position: 0 } })
      w.command('cover', 'setPosition', { position: 100 }, ALEXA)
      w.advance(200)
      w.write('cover', { state: 'open', position: 0 })
      w.advance(300)
      w.write('cover', { state: 'open', position: 6 })
      w.advance(300)
      w.write('cover', { state: 'opening', position: 6 })
      expect(w.out).toEqual([])
      w.advance(23_000)
      w.write('cover', { state: 'open', position: 100 })
      expect(w.out.map((t) => [t.field, t.from, t.to]).sort()).toEqual([
        ['position', 0, 100],
        ['state', 'closed', 'open'],
      ])
      expect(w.out.every((t) => t.outcome === 'confirmed' && t.actor === ALEXA)).toBe(true)
    })

    it('the same without a command: two rows, the device, written after the quiet window', () => {
      const w = world({ '7|cover': { state: 'closed', position: 0 } })
      w.write('cover', { state: 'open', position: 0 })
      w.advance(500)
      w.write('cover', { state: 'open', position: 6 })
      w.advance(500)
      w.write('cover', { state: 'opening', position: 6 })
      w.advance(2_000)
      w.write('cover', { state: 'open', position: 100 })
      w.advance(SETTLE_QUIET_MS - 1)
      w.correlator.sweep()
      expect(w.out).toEqual([])
      w.advance(1)
      w.correlator.sweep()
      expect(w.out.map((t) => [t.field, t.from, t.to]).sort()).toEqual([
        ['position', 0, 100],
        ['state', 'closed', 'open'],
      ])
      expect(w.out.every((t) => t.outcome === 'device' && t.actor.kind === 'device')).toBe(true)
    })

    it('a field that went there and back writes no row; its sibling still does', () => {
      const w = world({ '7|cover': { state: 'closed', position: 0 } })
      w.write('cover', { state: 'opening', position: 0 })
      w.advance(100)
      w.write('cover', { state: 'closed', position: 30 })
      w.settle()
      expect(w.out.map((t) => [t.field, t.from, t.to])).toEqual([['position', 0, 30]])
    })

    it('a flapping switch that ends where it began writes nothing', () => {
      const w = world({ '7|switch': { on: false } })
      for (const on of [true, false, true, false]) {
        w.advance(100)
        w.write('switch', { on })
      }
      w.settle()
      expect(w.out).toEqual([])
    })

    it('a burst that never goes quiet is written after the maximum hold', () => {
      const w = world({ '7|cover': { state: 'open', position: 0 } })
      const step = SETTLE_QUIET_MS - 1_000
      let position = 0
      for (let t = 0; t <= SETTLE_MAX_HOLD_MS; t += step) {
        position += 1
        w.advance(step)
        w.write('cover', { state: 'open', position })
        w.correlator.sweep()
      }
      expect(w.out).toHaveLength(1)
      expect(w.out[0]).toMatchObject({ field: 'position', from: 0, outcome: 'device' })
    })

    it('a flush on dispose writes the held burst', () => {
      const w = world({ '7|switch': { on: false } })
      w.write('switch', { on: true })
      expect(w.out).toEqual([])
      w.correlator.flush()
      expect(w.out).toEqual([expect.objectContaining({ outcome: 'device', from: false, to: true })])
      w.correlator.flush()
      expect(w.out).toHaveLength(1)
    })

    it('a removed device keeps no held burst', () => {
      const w = world({ '7|switch': { on: false } })
      w.write('switch', { on: true })
      w.correlator.forgetDevice(7)
      w.correlator.flush()
      expect(w.out).toEqual([])
    })
  })
})
