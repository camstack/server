import type { CommandActor, DeviceCommandObservation, DeviceTransition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_MATCH_WINDOW_MS,
  PENDING_RING_MAX,
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
    expect(w.out).toEqual([
      expect.objectContaining({ outcome: 'device', actor: { kind: 'device' }, from: false, to: true }),
    ])
    expect(w.out[0]?.command).toBeUndefined()
  })

  it('the first slice a cap ever reports is learning the device, not a change', () => {
    const w = world()
    w.write('switch', { on: true })
    expect(w.out).toEqual([])
    w.write('switch', { on: false })
    expect(w.out).toEqual([expect.objectContaining({ outcome: 'device', from: true, to: false })])
  })

  it('a command whose target already holds is recorded as already, and waits for nothing', () => {
    const w = world({ '7|switch': { on: true } })
    w.command('switch', 'setState', { on: true })
    expect(w.out).toEqual([
      expect.objectContaining({ outcome: 'already', from: true, to: true, actor: USER }),
    ])
    expect(w.correlator.pendingCount()).toBe(0)
    w.write('switch', { on: false })
    expect(w.out[1]).toMatchObject({ outcome: 'device' })
  })

  it('an effect-less command (stop) takes the next change of the cap', () => {
    const w = world({ '7|cover': { state: 'opening', position: 40 } })
    w.command('cover', 'stop', {}, ALEXA)
    w.write('cover', { state: 'open', position: 40 })
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
    expect(w.out[1]).toMatchObject({ outcome: 'unconfirmed', actor: ALEXA, field: 'on' })
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
    expect(w.out[0]).toMatchObject({ outcome: 'device' })
  })

  it('an unknown previous value is from: null', () => {
    const w = world()
    w.command('switch', 'setState', { on: true })
    w.write('switch', { on: true })
    expect(w.out[0]).toMatchObject({ outcome: 'confirmed', from: null, to: true })
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

  it('a command whose call threw is failed, with the scrubbed message, and is not matched later', async () => {
    const w = world({ '7|switch': { on: false } })
    const failure = Promise.reject(new Error('device unreachable rtsp://admin:abc123secret@10.0.0.5/live'))
    w.command('switch', 'setState', { on: true }, USER, failure)
    await failure.catch(() => undefined)
    await Promise.resolve()
    expect(w.out).toHaveLength(1)
    expect(w.out[0]).toMatchObject({ outcome: 'failed', field: 'on', from: false, to: false })
    expect(w.out[0]?.command?.error).toContain('device unreachable')
    expect(w.out[0]?.command?.error).not.toContain('abc123secret')
    w.write('switch', { on: true })
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
})
