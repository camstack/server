/**
 * An exported ACTION is a stateless momentary switch (D967): on → run the
 * action → auto-off after about a second. It is an accessory beside the
 * devices, never a device.
 */
import { Characteristic, Service } from '@homebridge/hap-nodejs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACTION_SWITCH_AUTO_OFF_MS, actionSwitchUuid, buildActionSwitch } from '../action-switch.js'

describe('buildActionSwitch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function build(run: () => Promise<void>) {
    return buildActionSwitch({ actionId: 'internal:abc', displayName: 'Open gate', run })
  }

  function onOf(mapper: ReturnType<typeof build>) {
    const service = mapper.accessory.getService(Service.Switch)
    if (service === undefined) throw new Error('no switch service')
    return service.getCharacteristic(Characteristic.On)
  }

  it('publishes one named switch accessory with a uuid derived from the action id', () => {
    const mapper = build(async () => undefined)
    expect(mapper.accessories).toHaveLength(1)
    expect(mapper.accessory.displayName).toBe('Open gate')
    expect(mapper.accessory.UUID).toBe(actionSwitchUuid('internal:abc'))
    expect(actionSwitchUuid('internal:abc')).not.toBe(actionSwitchUuid('internal:other'))
    expect(onOf(mapper).value).toBe(false)
  })

  it('turning it on runs the action once, then switches itself off after about a second', async () => {
    const run = vi.fn(async () => undefined)
    const mapper = build(run)
    const on = onOf(mapper)

    on.setValue(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(on.value).toBe(true)

    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS - 1)
    expect(on.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(on.value).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('turning it off by hand never runs the action', async () => {
    const run = vi.fn(async () => undefined)
    const mapper = build(run)
    const on = onOf(mapper)
    on.setValue(true)
    await vi.advanceTimersByTimeAsync(0)
    on.setValue(false)
    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(on.value).toBe(false)
  })

  it('a failing run does not leave the switch stuck on', async () => {
    const mapper = build(async () => {
      throw new Error('boom')
    })
    const on = onOf(mapper)
    on.setValue(true)
    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS)
    expect(on.value).toBe(false)
  })

  it('dispose cancels a pending auto-off', async () => {
    const mapper = build(async () => undefined)
    const on = onOf(mapper)
    on.setValue(true)
    await vi.advanceTimersByTimeAsync(0)
    await mapper.dispose()
    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS * 2)
    // The pulse's own timer is gone: nothing switched it off.
    expect(on.value).toBe(true)
  })
})
