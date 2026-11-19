// @vitest-environment jsdom
//
// useDeviceAdminLink — whether a device has its own config page.
//
// Every assertion here is about a state that must resolve NOTHING. A button that
// opens a browser error is worse than no button, and a disabled one says
// "broken" about a device that is fine (D62). The positive case is one test;
// the rest are the four gates and the two things the anchor must carry.
import { act, renderHook } from '@testing-library/react'
import type { DeviceAdminLink } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeviceAdminLink } from '../use-device-admin-link'

type CapabilityResult = { dev: unknown; cap: unknown; online: boolean }

let capabilityResult: CapabilityResult
/** What the device proxy's `getAdminLink` resolves to, or rejects with. */
let answer: () => Promise<DeviceAdminLink | null>
const getAdminLink = vi.fn(() => answer())

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => capabilityResult,
}))

/** Render, then let the one-shot proxy read settle. */
async function renderSettled(deviceId: number): Promise<{ link: () => DeviceAdminLink | null }> {
  const result = renderHook(() => useDeviceAdminLink(trpc, deviceId))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { link: () => result.result.current }
}

const DEVICE_LINK: DeviceAdminLink = {
  url: 'http://192.168.60.139/',
  label: 'Web UI',
  target: 'device',
  host: '192.168.60.139',
}

const INTEGRATION_LINK: DeviceAdminLink = {
  url: 'http://192.168.10.89:8123/config/devices/device/bf38dbc6',
  label: 'Home Assistant',
  target: 'integration',
  host: '192.168.10.89',
}

const trpc = {} as never

beforeEach(() => {
  getAdminLink.mockClear()
  capabilityResult = { dev: {}, cap: { getAdminLink }, online: true }
  answer = () => Promise.resolve(DEVICE_LINK)
})

describe('useDeviceAdminLink', () => {
  it('resolves the link when the cap is bound and answered', async () => {
    const { link } = await renderSettled(1436)
    expect(link()).toEqual(DEVICE_LINK)
  })

  it('resolves nothing, and ASKS nothing, when the cap is not bound for this device', async () => {
    capabilityResult = { dev: {}, cap: undefined, online: true }
    const { link } = await renderSettled(7)
    expect(link()).toBeNull()
    // Not merely ignored — not asked. A gate that still fires is a thousand
    // 412s on a fleet-sized device list.
    expect(getAdminLink).not.toHaveBeenCalled()
  })

  it('resolves nothing, and asks nothing, while the device proxy is still resolving', async () => {
    capabilityResult = { dev: null, cap: undefined, online: true }
    const { link } = await renderSettled(7)
    expect(link()).toBeNull()
    expect(getAdminLink).not.toHaveBeenCalled()
  })

  it('resolves nothing before the answer arrives — not-yet-known is not no-page', () => {
    answer = () => new Promise(() => undefined)
    const { result } = renderHook(() => useDeviceAdminLink(trpc, 1436))
    expect(result.current).toBeNull()
  })

  it('resolves nothing when the call was refused, which is what a non-admin session gets', async () => {
    answer = () => Promise.reject(new Error('UNAUTHORIZED'))
    const { link } = await renderSettled(1436)
    expect(link()).toBeNull()
  })

  it('survives a proxy handle that throws SYNCHRONOUSLY, without taking the row down', async () => {
    capabilityResult = {
      dev: {},
      cap: {
        getAdminLink: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'find')")
        },
      },
      online: true,
    }
    const { link } = await renderSettled(1436)
    expect(link()).toBeNull()
  })

  it('resolves nothing when the provider says this device has no page', async () => {
    answer = () => Promise.resolve(null)
    const { link } = await renderSettled(592)
    expect(link()).toBeNull()
  })

  it('hides a DEVICE-hosted page when the device is offline', async () => {
    capabilityResult = { dev: {}, cap: { getAdminLink }, online: false }
    const { link } = await renderSettled(1436)
    expect(link()).toBeNull()
  })

  it('KEEPS an INTEGRATION page when the device is offline — the page is elsewhere', async () => {
    capabilityResult = { dev: {}, cap: { getAdminLink }, online: false }
    answer = () => Promise.resolve(INTEGRATION_LINK)
    const { link } = await renderSettled(1027)
    expect(link()).toEqual(INTEGRATION_LINK)
  })
})
