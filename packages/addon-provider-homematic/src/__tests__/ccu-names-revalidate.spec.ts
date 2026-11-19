import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HmDevice } from 'nodehomematic'
import { buildCcuDevicesHandlers } from '../ccu/ccu-devices-actions.js'
import { CCU_NAMES_STALE_MS } from '../ccu/ccu-names-revalidate.js'
import { fakeDeps } from './ccu-fake.js'

/** A valve paired on the CCU: the library read its names before the operator named it. */
function valve(name: string | null): HmDevice {
  return {
    address: '00119A499BFDC5',
    type: 'HmIP-eTRV-C',
    name,
    channels: [],
  }
}

function setup(failWith?: Error) {
  let held = valve(null)
  const refreshNames = vi.fn(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    if (failWith !== undefined) throw failWith
    held = valve('Bedroom valve')
  })
  const { deps, logger } = fakeDeps({ devices: () => [held], refreshNames })
  const handlers = buildCcuDevicesHandlers(deps)
  const names = async (): Promise<(string | null)[]> =>
    (await handlers.listCcuDevices({ integrationId: 'hm_1' })).devices.map((d) => d.name)
  return { names, refreshNames, logger }
}

describe('CCU names on the device list: serve and revalidate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('answers from the held names, then shows the CCU name on the next read', async () => {
    const { names, refreshNames } = setup()

    expect(await names()).toEqual([null])
    expect(refreshNames).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)

    expect(await names()).toEqual(['Bedroom valve'])
  })

  it('re-reads at most once per window, and again when it has passed', async () => {
    const { names, refreshNames } = setup()
    await names()
    await vi.advanceTimersByTimeAsync(50)
    await names()
    await names()
    expect(refreshNames).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CCU_NAMES_STALE_MS)
    await names()
    expect(refreshNames).toHaveBeenCalledTimes(2)
  })

  it('never joins a re-read already in flight', async () => {
    const { names, refreshNames } = setup()
    await Promise.all([names(), names(), names()])
    expect(refreshNames).toHaveBeenCalledTimes(1)
  })

  it('keeps answering, and says so, when the re-read fails', async () => {
    const { names, logger } = setup(new Error('CCU booting'))
    expect(await names()).toEqual([null])
    await vi.advanceTimersByTimeAsync(50)
    expect(
      logger.lines.some((e) => e.level === 'warn' && /could not be re-read/.test(e.message)),
    ).toBe(true)
  })
})
