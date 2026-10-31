import { describe, expect, it, vi } from 'vitest'
import type { HmInterfaceInfo } from 'nodehomematic'
import { buildCcuPairingHandlers } from '../ccu/ccu-pairing-actions.js'
import type { CcuFacade } from '../ccu/ccu-facade.js'
import { fakeDeps } from './ccu-fake.js'

function iface(name: string): HmInterfaceInfo {
  return {
    name,
    port: 2001,
    info: null,
    connected: true,
    dutyCycle: null,
    firmware: null,
    type: null,
    gateways: [],
  }
}

function setup(facade: Partial<CcuFacade>) {
  const { deps, logger } = fakeDeps(facade)
  return { handlers: buildCcuPairingHandlers(deps), logger }
}

describe('ccuPairingStatus', () => {
  it('lists only the radio interfaces, with seconds left and secure support', async () => {
    const { handlers } = setup({
      listInterfaces: async () => [iface('BidCos-RF'), iface('HmIP-RF'), iface('VirtualDevices')],
      getInstallMode: async (name) => (name === 'HmIP-RF' ? 42 : 0),
    })
    const out = await handlers.ccuPairingStatus({ integrationId: 'hm_1' })
    expect(out).toEqual({
      interfaces: [
        { name: 'BidCos-RF', secondsLeft: 0, supportsSecure: true, error: null },
        { name: 'HmIP-RF', secondsLeft: 42, supportsSecure: false, error: null },
      ],
      error: null,
    })
  })

  it('keeps an unusable answer as null, never 0, and names a failing interface', async () => {
    const { handlers } = setup({
      listInterfaces: async () => [iface('BidCos-RF'), iface('HmIP-RF')],
      getInstallMode: async (name) => {
        if (name === 'HmIP-RF') throw new Error('timeout')
        return null
      },
    })
    const out = await handlers.ccuPairingStatus({ integrationId: 'hm_1' })
    expect(out.interfaces[0]?.secondsLeft).toBeNull()
    expect(out.interfaces[1]).toMatchObject({ secondsLeft: null, error: 'timeout' })
  })

  it('reports an unreadable interface list as an error, not as no interfaces', async () => {
    const { handlers, logger } = setup({
      listInterfaces: async () => {
        throw new Error('no credentials')
      },
    })
    const out = await handlers.ccuPairingStatus({ integrationId: 'hm_1' })
    expect(out).toEqual({ interfaces: [], error: 'no credentials' })
    expect(logger.lines.some((r) => r.level === 'warn')).toBe(true)
  })

  it('refuses an integration that is not connected', async () => {
    const { deps } = fakeDeps(null)
    await expect(
      buildCcuPairingHandlers(deps).ccuPairingStatus({ integrationId: 'hm_1' }),
    ).rejects.toThrow(/not connected/)
  })
})

describe('setCcuInstallMode', () => {
  it('refuses without the operator confirmation and touches nothing', async () => {
    const setInstallMode = vi.fn()
    const { handlers } = setup({ setInstallMode })
    await expect(
      handlers.setCcuInstallMode({
        integrationId: 'hm_1',
        interface: 'HmIP-RF',
        on: true,
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmation/)
    expect(setInstallMode).not.toHaveBeenCalled()
  })

  it('opens a pairing window with seconds and mode', async () => {
    const setInstallMode = vi.fn().mockResolvedValue(undefined)
    const { handlers } = setup({ setInstallMode })
    await handlers.setCcuInstallMode({
      integrationId: 'hm_1',
      interface: 'BidCos-RF',
      on: true,
      seconds: 120,
      mode: 'secure',
      confirmed: true,
    })
    expect(setInstallMode).toHaveBeenCalledWith({
      interface: 'BidCos-RF',
      on: true,
      seconds: 120,
      mode: 'secure',
    })
  })

  it('closes a window without sending seconds or mode', async () => {
    const setInstallMode = vi.fn().mockResolvedValue(undefined)
    const { handlers } = setup({ setInstallMode })
    await handlers.setCcuInstallMode({
      integrationId: 'hm_1',
      interface: 'HmIP-RF',
      on: false,
      seconds: 60,
      confirmed: true,
    })
    expect(setInstallMode).toHaveBeenCalledWith({ interface: 'HmIP-RF', on: false })
  })

  it('refuses an interface without a pairing window and secure pairing on HmIP', async () => {
    const setInstallMode = vi.fn()
    const { handlers } = setup({ setInstallMode })
    await expect(
      handlers.setCcuInstallMode({
        integrationId: 'hm_1',
        interface: 'VirtualDevices',
        on: true,
        confirmed: true,
      }),
    ).rejects.toThrow(/no pairing window/)
    await expect(
      handlers.setCcuInstallMode({
        integrationId: 'hm_1',
        interface: 'HmIP-RF',
        on: true,
        mode: 'secure',
        confirmed: true,
      }),
    ).rejects.toThrow(/BidCos-RF only/)
    expect(setInstallMode).not.toHaveBeenCalled()
  })
})

describe('deleteCcuDevice', () => {
  it('refuses without the operator confirmation', async () => {
    const deleteDevice = vi.fn()
    const { handlers } = setup({ deleteDevice })
    await expect(
      handlers.deleteCcuDevice({
        integrationId: 'hm_1',
        address: 'ABC',
        reset: true,
        force: false,
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmation/)
    expect(deleteDevice).not.toHaveBeenCalled()
  })

  it.each([
    [false, false, 0],
    [true, false, 1],
    [false, true, 2],
    [true, true, 3],
  ])('maps reset=%s force=%s to flags %i', async (reset, force, flags) => {
    const deleteDevice = vi.fn().mockResolvedValue(undefined)
    const { handlers } = setup({ deleteDevice })
    await handlers.deleteCcuDevice({
      integrationId: 'hm_1',
      address: 'ABC',
      reset,
      force,
      confirmed: true,
    })
    expect(deleteDevice).toHaveBeenCalledWith('ABC', flags)
  })

  it('lets the CCU refusal through to the caller', async () => {
    const { handlers } = setup({
      deleteDevice: async () => {
        throw new Error('unreachable')
      },
    })
    await expect(
      handlers.deleteCcuDevice({
        integrationId: 'hm_1',
        address: 'ABC',
        reset: false,
        force: false,
        confirmed: true,
      }),
    ).rejects.toThrow('unreachable')
  })
})
