import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HmChannelLinkState, HmDevice } from 'nodehomematic'
import { buildCcuDevicesHandlers } from '../ccu/ccu-devices-actions.js'
import {
  publishKeyLinkStates,
  storedKeyLinkStates,
  type KeyLinkFacade,
} from '../devices/hm-key-link-states.js'
import {
  CCU_CALL_CONCURRENCY,
  CCU_TRANSIENT_RETRY_DELAYS_MS,
  CcuCallLimiterDisposedError,
  ccuCallLimiter,
  disposeCcuCallLimiter,
  HmCcuCallLimiter,
  isTransientCcuError,
} from '../hm-ccu-call-limiter.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'
import { RecordingLogger } from './recording-logger.js'

const INTEGRATION = 'hm_1'
const DEVICES = 10
const KEYS_PER_DEVICE = 4

function keyDevice(n: number): HmDevice {
  const address = `00315F29800${String(n).padStart(3, '0')}`
  return hmDevice({
    address,
    type: 'HmIP-WRC6',
    name: `Remote ${n}`,
    channels: Array.from({ length: KEYS_PER_DEVICE }, (_, i) => ({
      address: `${address}:${i + 1}`,
      index: i + 1,
      type: 'KEY_TRANSCEIVER',
      name: `Key ${i + 1}`,
    })),
  })
}

const devices = Array.from({ length: DEVICES }, (_, n) => keyDevice(n))

/** A library error as nodehomematic builds it: a plain Error whose `name` is the class name. */
function namedError(name: string): Error {
  const err = new Error(`${name}: CCU not ready`)
  err.name = name
  return err
}

/** Facade fake that records the peak number of CCU calls in flight at once. */
function countingFacade() {
  let inFlight = 0
  let peak = 0
  let calls = 0
  const track = async <T>(value: T): Promise<T> => {
    inFlight += 1
    calls += 1
    peak = Math.max(peak, inFlight)
    await new Promise<void>((resolve) => setImmediate(resolve))
    inFlight -= 1
    return value
  }
  const linkState: HmChannelLinkState = { central: true, links: [] }
  const facade = {
    devices: () => devices,
    getKeyEventProgram: () => track(null),
    getChannelLinkState: () => track(linkState),
  }
  return { facade, peak: () => peak, calls: () => calls }
}

afterEach(() => {
  homematicFacades.clear()
  vi.useRealTimers()
})

describe('CCU calls after a reconnect are bounded per integration', () => {
  it('a snapshot burst of every device reading its key links keeps at most K calls in flight', async () => {
    const { facade, peak, calls } = countingFacade()
    const keyLinkFacade: KeyLinkFacade = facade
    const logger = new RecordingLogger()
    const results = await Promise.all(
      devices.map((device, i) =>
        publishKeyLinkStates(INTEGRATION, {
          facade: keyLinkFacade,
          device,
          deviceAddress: device.address,
          deviceId: 100 + i,
          logger,
        }),
      ),
    )
    expect(results.every((r) => r?.failed === false)).toBe(true)
    expect(calls()).toBe(DEVICES * (1 + KEYS_PER_DEVICE))
    expect(peak()).toBeLessThanOrEqual(CCU_CALL_CONCURRENCY)
  })

  it('a refresh cut short by the session stopping publishes nothing and logs no failure', async () => {
    vi.useFakeTimers()
    const device = devices[0]
    if (device === undefined) throw new Error('fixture')
    const facade: KeyLinkFacade = {
      devices: () => [device],
      getKeyEventProgram: async () => null,
      getChannelLinkState: async () => {
        throw namedError('NoConnectionError')
      },
    }
    const logger = new RecordingLogger()
    const pending = publishKeyLinkStates(INTEGRATION, {
      facade,
      device,
      deviceAddress: device.address,
      deviceId: 100,
      logger,
    })
    await vi.advanceTimersByTimeAsync(100)
    disposeCcuCallLimiter(INTEGRATION)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBeNull()
    expect(storedKeyLinkStates(INTEGRATION, device.address)).toEqual([])
    expect(logger.lines.filter((l) => l.level === 'warn')).toEqual([])
    expect(logger.lines.find((l) => l.level === 'debug')?.tags).toMatchObject({ deviceId: 100 })
  })

  it('the CCU page device list shares the same bound', async () => {
    const { facade, peak } = countingFacade()
    const { deps } = fakeDeps(facade)
    const adopted = new Map(devices.map((d, i) => [d.address, 100 + i]))
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      adoptedAddresses: async () => adopted,
    })
    const out = await handlers.listCcuDevices({ integrationId: INTEGRATION })
    expect(out.devices).toHaveLength(DEVICES)
    expect(peak()).toBeLessThanOrEqual(CCU_CALL_CONCURRENCY)
  })

  it('a key read the booting CCU refuses is retried with backoff instead of published as failed', async () => {
    vi.useFakeTimers()
    let refusals = 1
    const device = devices[0]
    if (device === undefined) throw new Error('fixture')
    const facade: KeyLinkFacade = {
      devices: () => [device],
      getKeyEventProgram: async () => null,
      getChannelLinkState: async () => {
        if (refusals > 0) {
          refusals -= 1
          throw namedError('BackendUnavailableError')
        }
        return { central: true, links: [] }
      },
    }
    const pending = publishKeyLinkStates(INTEGRATION, {
      facade,
      device,
      deviceAddress: device.address,
      deviceId: 100,
      logger: new RecordingLogger(),
    })
    await vi.advanceTimersByTimeAsync(CCU_TRANSIENT_RETRY_DELAYS_MS[0] ?? 0)
    await expect(pending).resolves.toEqual({ failed: false })
  })
})

describe('HmCcuCallLimiter', () => {
  it('matches the library transient errors by name, old and new versions alike', () => {
    for (const name of [
      'BackendUnavailableError',
      'LoginBackoffError',
      'NoConnectionError',
      'CircuitBreakerOpenError',
    ]) {
      expect(isTransientCcuError(namedError(name))).toBe(true)
    }
    expect(isTransientCcuError(namedError('AuthFailureError'))).toBe(false)
    expect(isTransientCcuError({ name: 'NoConnectionError' })).toBe(false)
  })

  it('does not retry an error that is not transient', async () => {
    const limiter = new HmCcuCallLimiter({ retryDelaysMs: [1] })
    const call = vi.fn().mockRejectedValue(namedError('AuthFailureError'))
    await expect(limiter.run(call)).rejects.toThrow('AuthFailureError')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('gives up after the last backoff delay', async () => {
    const limiter = new HmCcuCallLimiter({ retryDelaysMs: [1, 1] })
    const call = vi.fn().mockRejectedValue(namedError('NoConnectionError'))
    await expect(limiter.run(call)).rejects.toThrow('NoConnectionError')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('rejects queued calls when the session stops', async () => {
    const limiter = new HmCcuCallLimiter({ concurrency: 1 })
    let release: () => void = () => undefined
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)))
    const queued = limiter.run(async () => 'never')
    limiter.dispose()
    await expect(queued).rejects.toBeInstanceOf(CcuCallLimiterDisposedError)
    release()
    await expect(first).resolves.toBeUndefined()
  })

  it('one limiter per integration, dropped when the resolver clears', () => {
    const a = ccuCallLimiter('a')
    expect(ccuCallLimiter('a')).toBe(a)
    expect(ccuCallLimiter('b')).not.toBe(a)
    homematicFacades.clear()
    expect(ccuCallLimiter('a')).not.toBe(a)
  })

  it('a call waiting out a backoff is not re-run once the session stops', async () => {
    vi.useFakeTimers()
    const limiter = new HmCcuCallLimiter({ retryDelaysMs: [10_000] })
    const call = vi.fn().mockRejectedValue(namedError('BackendUnavailableError'))
    const pending = limiter.run(call)
    const outcome = pending.then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(call).toHaveBeenCalledTimes(1)
    limiter.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(call).toHaveBeenCalledTimes(1)
    expect(await outcome).toBeInstanceOf(CcuCallLimiterDisposedError)
    expect(vi.getTimerCount()).toBe(0)
  })
})
