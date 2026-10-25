/**
 * A voice PTZ command travels ~1 s, built ONLY from the cap's `ptz.move`.
 *
 * `move` is a self-terminating burst whose length the driver owns and reports
 * as `getOptions().moveImpulseMs` (ptz.cap.ts): 200 reolink, 350 amcrest,
 * 500 hikvision, 1000 onvif. Alexa used to drive `continuousMove` + its own
 * 1000 ms timer + `stop` instead — and ONVIF throws "not implemented" on
 * `continuousMove`, so every Alexa pan/tilt on an ONVIF camera failed.
 *
 * Drivers also differ in WHEN `move` returns: hikvision awaits its own pulse,
 * reolink / amcrest / onvif return as soon as the burst has started. The
 * travel waits out the rest of each pulse before issuing the next, so both
 * kinds of driver produce back-to-back pulses rather than overlapping ones.
 */
import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { handlePtzDirection } from '../handlers/ptz-direction.js'
import { handleSetMode } from '../handlers/ptz-preset.js'
import { ptzTravelPulses, runPtzTravel, TARGET_TRAVEL_MS } from '../handlers/ptz-travel.js'

describe('ptzTravelPulses', () => {
  it('targets ~1 s of travel', () => {
    expect(TARGET_TRAVEL_MS).toBe(1_000)
  })

  it.each([
    [200, 5], // reolink
    [350, 3], // amcrest: 2.86 → 3
    [500, 2], // hikvision
    [1_000, 1], // onvif
    [3_000, 1], // a pulse longer than the target still moves once
  ])('impulse %i ms → %i pulses', (impulse, pulses) => {
    expect(ptzTravelPulses(impulse)).toBe(pulses)
  })

  it('an unknown impulse is a single move', () => {
    expect(ptzTravelPulses(null)).toBe(1)
  })
})

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Time spent inside a `move` call (a driver that awaits its own pulse). */
  advance: (ms: number) => void
  readonly sleeps: number[]
}

/** A virtual clock: `sleep` advances time instead of waiting. */
function virtualClock(): Clock {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms) => {
      t += ms
    },
    sleeps,
  }
}

type MoveInput = { deviceId: number; pan?: number; tilt?: number }

function ptzStub(opts: {
  impulse: number | null | 'throws'
  /** How long `move` itself takes before resolving (hikvision = its pulse). */
  moveTakesMs?: number
  failOnCall?: number
  clock: Clock
}) {
  const moves: Array<{ input: MoveInput; at: number }> = []
  const continuousMove = vi.fn()
  const stop = vi.fn()
  const ptz = {
    getOptions: {
      query: async () => {
        if (opts.impulse === 'throws') throw new Error('offline')
        return { moveImpulseMs: opts.impulse }
      },
    },
    move: {
      mutate: async (input: MoveInput) => {
        moves.push({ input, at: opts.clock.now() })
        if (opts.failOnCall === moves.length) throw new Error('not reachable')
        if (opts.moveTakesMs) opts.clock.advance(opts.moveTakesMs)
      },
    },
    continuousMove: { mutate: continuousMove },
    stop: { mutate: stop },
  }
  return { ptz, moves, continuousMove, stop }
}

describe('runPtzTravel', () => {
  it('a driver that returns at once: pulses spaced by the impulse', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 200, clock })
    const r = await runPtzTravel(s.ptz, 7, { pan: -1 }, clock)
    expect(r).toEqual({ pulses: 5, issued: 5 })
    expect(s.moves.map((m) => m.at)).toEqual([0, 200, 400, 600, 800])
    expect(s.moves.every((m) => m.input.deviceId === 7 && m.input.pan === -1)).toBe(true)
  })

  it('a driver that waits out its own pulse: no extra wait', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 500, moveTakesMs: 500, clock })
    const r = await runPtzTravel(s.ptz, 7, { tilt: 1 }, clock)
    expect(r).toEqual({ pulses: 2, issued: 2 })
    expect(s.moves.map((m) => m.at)).toEqual([0, 500])
    expect(clock.sleeps).toEqual([])
  })

  it('amcrest 350 ms → 3 pulses', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 350, clock })
    expect(await runPtzTravel(s.ptz, 7, { pan: 1 }, clock)).toEqual({ pulses: 3, issued: 3 })
    expect(s.moves.map((m) => m.at)).toEqual([0, 350, 700])
  })

  it('unknown impulse (null or unreadable) → one move, no wait', async () => {
    for (const impulse of [null, 'throws'] as const) {
      const clock = virtualClock()
      const s = ptzStub({ impulse, clock })
      expect(await runPtzTravel(s.ptz, 7, { pan: 1 }, clock)).toEqual({ pulses: 1, issued: 1 })
      expect(clock.sleeps).toEqual([])
    }
  })

  it('the first move failing rejects — nothing moved', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 200, failOnCall: 1, clock })
    await expect(runPtzTravel(s.ptz, 7, { pan: 1 }, clock)).rejects.toThrow('not reachable')
    expect(s.moves).toHaveLength(1)
  })

  it('a later move failing stops the travel and reports how far it got', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 200, failOnCall: 3, clock })
    const r = await runPtzTravel(s.ptz, 7, { pan: 1 }, clock)
    expect(r.pulses).toBe(5)
    expect(r.issued).toBe(2)
    expect(r.error?.message).toBe('not reachable')
    expect(s.moves).toHaveLength(3)
  })

  it('never drives continuousMove or stop', async () => {
    const clock = virtualClock()
    const s = ptzStub({ impulse: 200, clock })
    await runPtzTravel(s.ptz, 7, { pan: 1 }, clock)
    expect(s.continuousMove).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()
  })
})

// ── Handlers ─────────────────────────────────────────────────────────

function handlerHarness(opts: { impulse: number | null; fail?: boolean }) {
  const moves: MoveInput[] = []
  const continuousMove = vi.fn()
  const stop = vi.fn()
  const warn = vi.fn()
  const logger = {
    info: () => undefined,
    warn,
    debug: () => undefined,
    error: () => undefined,
    withTags: () => logger,
  } as unknown as IScopedLogger
  // Documented test-stub boundary: the handlers read four `ptz` methods of an
  // API surface far too large to build by hand.
  const api = {
    ptz: {
      getOptions: { query: async () => ({ moveImpulseMs: opts.impulse }) },
      move: {
        mutate: async (input: MoveInput) => {
          moves.push(input)
          if (opts.fail) throw new Error('not implemented')
        },
      },
      continuousMove: { mutate: continuousMove },
      stop: { mutate: stop },
    },
  } as unknown as AddonApi
  const ctx = { api } as unknown as AddonContext
  return { deps: { ctx, logger }, moves, continuousMove, stop, warn }
}

const HEADER = { payloadVersion: '3', messageId: 'm', correlationToken: 'c' }
const IDENTITY = { userId: 'u', username: 'u', scopes: [] }

function toggle(
  h: ReturnType<typeof handlerHarness>,
  name: 'TurnOn' | 'TurnOff',
  instance: string,
) {
  return handlePtzDirection(
    { ...HEADER, namespace: 'Alexa.ToggleController', name, instance },
    { endpointId: '42' },
    h.deps,
    IDENTITY,
  )
}

function setMode(h: ReturnType<typeof handlerHarness>, instance: string, mode: string) {
  return handleSetMode(
    { ...HEADER, namespace: 'Alexa.ModeController', name: 'SetMode', instance },
    { endpointId: '42' },
    { mode },
    h.deps,
    IDENTITY,
  )
}

interface ResponseShape {
  event: { header: { name: string }; payload: { type?: string } }
  context?: { properties: Array<{ namespace: string; instance: string; value: unknown }> }
}

describe('ToggleController ptz.* — pulses of ptz.move', () => {
  it('TurnOn pans through the driver pulses and reports OFF', async () => {
    const h = handlerHarness({ impulse: 1_000 })
    const r = (await toggle(h, 'TurnOn', 'ptz.panLeft')) as ResponseShape
    expect(r.event.header.name).toBe('Response')
    expect(r.context?.properties[0]).toMatchObject({
      namespace: 'Alexa.ToggleController',
      instance: 'ptz.panLeft',
      value: 'OFF',
    })
    expect(h.moves).toEqual([{ deviceId: 42, pan: -1 }])
    expect(h.continuousMove).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('TurnOff drives nothing', async () => {
    const h = handlerHarness({ impulse: 200 })
    const r = (await toggle(h, 'TurnOff', 'ptz.tiltUp')) as ResponseShape
    expect(r.event.header.name).toBe('Response')
    expect(h.moves).toEqual([])
  })

  it('a failed move warns and answers INTERNAL_ERROR (onvif without continuousMove still moves)', async () => {
    const h = handlerHarness({ impulse: null, fail: true })
    const r = (await toggle(h, 'TurnOn', 'ptz.tiltDown')) as ResponseShape
    expect(r.event.header.name).toBe('ErrorResponse')
    expect(r.event.payload.type).toBe('INTERNAL_ERROR')
    expect(h.warn).toHaveBeenCalled()
    expect(h.continuousMove).not.toHaveBeenCalled()
  })
})

describe('ModeController ptz.pan / ptz.tilt — pulses of ptz.move', () => {
  it('a direction issues the pulses and snaps the dropdown back to center', async () => {
    const h = handlerHarness({ impulse: 1_000 })
    const r = (await setMode(h, 'ptz.tilt', 'ptz.tilt.down')) as ResponseShape
    expect(r.context?.properties[0]).toMatchObject({
      namespace: 'Alexa.ModeController',
      instance: 'ptz.tilt',
      value: 'ptz.tilt.center',
    })
    expect(h.moves).toEqual([{ deviceId: 42, tilt: -1 }])
    expect(h.continuousMove).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('center drives nothing — move already stops itself', async () => {
    const h = handlerHarness({ impulse: 200 })
    const r = (await setMode(h, 'ptz.pan', 'ptz.pan.center')) as ResponseShape
    expect(r.context?.properties[0]?.value).toBe('ptz.pan.center')
    expect(h.moves).toEqual([])
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('a failed move warns and answers INTERNAL_ERROR', async () => {
    const h = handlerHarness({ impulse: 500, fail: true })
    const r = (await setMode(h, 'ptz.pan', 'ptz.pan.right')) as ResponseShape
    expect(r.event.header.name).toBe('ErrorResponse')
    expect(r.event.payload.type).toBe('INTERNAL_ERROR')
    expect(h.warn).toHaveBeenCalled()
  })
})
