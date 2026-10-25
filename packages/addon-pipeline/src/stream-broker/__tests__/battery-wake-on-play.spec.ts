import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  BatteryWakeOnPlaySingleFlight,
  BatteryStreamUnavailableError,
  type BatteryFacts,
  type WakeOnPlayDeps,
  wakeBatteryDeviceForPlay,
} from '../battery-wake-on-play.js'

/**
 * Wake-on-play (D173). The live path must wake a sleeping battery camera when
 * somebody presses play, and must never answer a battery camera with a flat
 * "No broker for stream".
 *
 * Each gate below is asserted with its NEUTRALISATION in mind: the fake never
 * supplies for free the thing production has to fetch. In particular
 * `hasBroker` is driven by a mutable cell that only the `ensureBroker` fake
 * flips, so a test that passes because the fake pre-seeded a broker is
 * impossible to write here.
 */

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

const NOW = 1_800_000_000_000

interface Harness {
  readonly deps: WakeOnPlayDeps
  /** Flip to make the next `ensureBroker` succeed. */
  brokerAppearsAfterWake: boolean
  readonly calls: {
    wake: number
    reconcile: number
    ensureBroker: number
  }
}

function makeHarness(overrides: {
  isBattery?: boolean | null
  facts?: BatteryFacts | null
  awoke?: boolean
  brokerExistsUpfront?: boolean
  brokerAppearsAfterWake?: boolean
  brokerAppearsOnEnsureCall?: number
  wait?: (timeoutMs: number) => Promise<void>
}): Harness {
  const calls = { wake: 0, reconcile: 0, ensureBroker: 0 }
  let brokerPresent = overrides.brokerExistsUpfront === true
  let now = NOW
  const h: Harness = {
    brokerAppearsAfterWake: overrides.brokerAppearsAfterWake === true,
    calls,
    deps: {
      logger: makeLogger(),
      isBatteryDevice: async () => (overrides.isBattery === undefined ? true : overrides.isBattery),
      readBatteryFacts: async () =>
        overrides.facts === undefined
          ? { sleeping: true, lastContactAt: NOW - 60_000 }
          : overrides.facts,
      wakeForStream: async () => {
        calls.wake += 1
        return { awoke: overrides.awoke ?? true, durationMs: 1_234 }
      },
      reconcileCatalog: async () => {
        calls.reconcile += 1
      },
      ensureBroker: async () => {
        calls.ensureBroker += 1
        if (
          h.brokerAppearsAfterWake ||
          (overrides.brokerAppearsOnEnsureCall !== undefined &&
            calls.ensureBroker >= overrides.brokerAppearsOnEnsureCall)
        ) {
          brokerPresent = true
        }
      },
      hasBroker: () => brokerPresent,
      nowMs: () => now,
      wait:
        overrides.wait ??
        (async (timeoutMs) => {
          now += timeoutMs
        }),
    },
  }
  return h
}

describe('wakeBatteryDeviceForPlay', () => {
  it('does nothing when a broker already exists', async () => {
    const h = makeHarness({ brokerExistsUpfront: true })
    await wakeBatteryDeviceForPlay(106, h.deps)
    expect(h.calls.wake).toBe(0)
    expect(h.calls.ensureBroker).toBe(0)
  })

  it('leaves a NON-battery device on its pre-existing error path — no wake call', async () => {
    const h = makeHarness({ isBattery: false })
    await expect(wakeBatteryDeviceForPlay(101, h.deps)).resolves.toBeUndefined()
    expect(h.calls.wake).toBe(0)
    expect(h.calls.ensureBroker).toBe(0)
  })

  it('treats an UNANSWERABLE battery question as "not battery" — unknown excludes nothing', async () => {
    const h = makeHarness({ isBattery: null })
    await expect(wakeBatteryDeviceForPlay(101, h.deps)).resolves.toBeUndefined()
    expect(h.calls.wake).toBe(0)
  })

  it('wakes, reconciles and succeeds when the broker appears', async () => {
    const h = makeHarness({ brokerAppearsAfterWake: true })
    await expect(wakeBatteryDeviceForPlay(106, h.deps)).resolves.toBeUndefined()
    expect(h.calls.wake).toBe(1)
    expect(h.calls.reconcile).toBe(1)
    expect(h.calls.ensureBroker).toBe(1)
  })

  it('polls reconciliation until a late broker publication succeeds', async () => {
    // Attempt 8 lands 10.5s after acknowledgement — beyond the old 6s
    // one-shot event wait, but inside the field-sized settle window.
    const h = makeHarness({ brokerAppearsOnEnsureCall: 8 })
    await expect(wakeBatteryDeviceForPlay(106, h.deps)).resolves.toBeUndefined()
    expect(h.calls.wake).toBe(1)
    expect(h.calls.reconcile).toBe(8)
    expect(h.calls.ensureBroker).toBe(8)
  })

  it('names "waking" when the firmware acknowledged but no stream appeared', async () => {
    const h = makeHarness({ awoke: true, brokerAppearsAfterWake: false })
    await expect(wakeBatteryDeviceForPlay(106, h.deps)).rejects.toMatchObject({
      name: 'BatteryStreamUnavailableError',
      presence: 'waking',
      deviceId: 106,
    })
  })

  it('names "sleeping" when the firmware never answered the wake', async () => {
    const h = makeHarness({ awoke: false, brokerAppearsAfterWake: false })
    const err = await wakeBatteryDeviceForPlay(106, h.deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BatteryStreamUnavailableError)
    expect((err as BatteryStreamUnavailableError).presence).toBe('sleeping')
    // The error text must not be the old flat sentence.
    expect(String(err)).not.toContain('No broker for stream')
    expect(String(err)).toContain('sleeping')
  })

  it('REFUSES to spend a wake on a camera silent past the threshold, and says "unreachable"', async () => {
    const h = makeHarness({
      facts: { sleeping: true, lastContactAt: NOW - 30 * 60 * 60_000 },
    })
    const err = await wakeBatteryDeviceForPlay(106, h.deps).catch((e: unknown) => e)
    expect((err as BatteryStreamUnavailableError).presence).toBe('unreachable')
    // The point of the refusal: no dial at all.
    expect(h.calls.wake).toBe(0)
    expect(h.calls.ensureBroker).toBe(0)
  })

  it('a device that has NEVER reported contact is sleeping, never unreachable', async () => {
    // Freshly adopted / slice lost. "We know nothing" must not paint a fault.
    const h = makeHarness({ facts: { sleeping: true }, awoke: true, brokerAppearsAfterWake: true })
    await expect(wakeBatteryDeviceForPlay(106, h.deps)).resolves.toBeUndefined()
    expect(h.calls.wake).toBe(1)
  })

  it('never issues a SECOND wake inside one bounded transaction', async () => {
    const h = makeHarness({ awoke: true, brokerAppearsAfterWake: false })
    await wakeBatteryDeviceForPlay(106, h.deps).catch(() => undefined)
    expect(h.calls.wake).toBe(1)
    expect(h.calls.ensureBroker).toBeGreaterThan(1)
  })

  it('single-flights concurrent and retry demand while the camera is settling', async () => {
    let releaseWait!: () => void
    let enteredWait!: () => void
    const waitEntered = new Promise<void>((resolve) => {
      enteredWait = resolve
    })
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const h = makeHarness({
      brokerAppearsOnEnsureCall: 2,
      wait: async () => {
        enteredWait()
        await waitGate
      },
    })
    const singleFlight = new BatteryWakeOnPlaySingleFlight()

    const first = singleFlight.run(640, h.deps)
    const concurrent = singleFlight.run(640, h.deps)
    await waitEntered
    const retry = singleFlight.run(640, h.deps)

    expect(h.calls.wake).toBe(1)
    releaseWait()
    await expect(Promise.all([first, concurrent, retry])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(h.calls.wake).toBe(1)
  })

  it('a joined profile never falls through to the flat no-broker error', async () => {
    let releaseWait!: () => void
    let enteredWait!: () => void
    const waitEntered = new Promise<void>((resolve) => {
      enteredWait = resolve
    })
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const owner = makeHarness({
      brokerAppearsOnEnsureCall: 2,
      wait: async () => {
        enteredWait()
        await waitGate
      },
    })
    const joinedProfile = makeHarness({ brokerAppearsAfterWake: false })
    const singleFlight = new BatteryWakeOnPlaySingleFlight()

    const first = singleFlight.run(640, owner.deps)
    await waitEntered
    const joined = singleFlight.run(640, joinedProfile.deps)
    releaseWait()

    await expect(first).resolves.toBeUndefined()
    await expect(joined).rejects.toMatchObject({
      name: 'BatteryStreamUnavailableError',
      presence: 'waking',
    })
    expect(owner.calls.wake).toBe(1)
    expect(joinedProfile.calls.wake).toBe(0)
    expect(joinedProfile.calls.ensureBroker).toBe(1)
  })
})
