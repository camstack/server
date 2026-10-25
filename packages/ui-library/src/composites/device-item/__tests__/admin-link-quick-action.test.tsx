// @vitest-environment jsdom
//
// AdminLinkQuickAction — the row's "open this device's own config page" link.
//
// Every assertion here is about a state that must draw NOTHING. A button that
// opens a browser error is worse than no button, and a disabled one says
// "broken" about a device that is fine (D62). The positive case is one test;
// the rest are the four gates and the two things the anchor must carry.
import { act, render, screen } from '@testing-library/react'
import type { DeviceAdminLink } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminLinkQuickAction } from '../admin-link-quick-action'

type CapabilityResult = { dev: unknown; cap: unknown; online: boolean }

let capabilityResult: CapabilityResult
/** What the device proxy's `getAdminLink` resolves to, or rejects with. */
let answer: () => Promise<DeviceAdminLink | null>
const getAdminLink = vi.fn(() => answer())

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => capabilityResult,
}))

/** Render, then let the one-shot proxy read settle. */
async function renderSettled(deviceId: number): Promise<{ container: HTMLElement }> {
  const result = render(<AdminLinkQuickAction trpc={trpc} deviceId={deviceId} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return result
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

describe('AdminLinkQuickAction', () => {
  it('renders a link to the device page when the cap is bound and answered', async () => {
    await renderSettled(1436)
    const anchor = screen.getByLabelText('Open Web UI for this device')
    expect(anchor.getAttribute('href')).toBe('http://192.168.60.139/')
    expect(anchor.getAttribute('title')).toBe('Web UI — 192.168.60.139')
  })

  it('opens in a new tab WITHOUT handing the page a window.opener handle', async () => {
    await renderSettled(1436)
    const anchor = screen.getByLabelText('Open Web UI for this device')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toContain('noopener')
  })

  it('draws nothing, and ASKS nothing, when the cap is not bound for this device', async () => {
    capabilityResult = { dev: {}, cap: undefined, online: true }
    const { container } = await renderSettled(7)
    expect(container.firstChild).toBeNull()
    // Not merely ignored — not asked. A gate that still fires is a thousand
    // 412s on a fleet-sized device list.
    expect(getAdminLink).not.toHaveBeenCalled()
  })

  it('draws nothing, and asks nothing, while the device proxy is still resolving', async () => {
    capabilityResult = { dev: null, cap: undefined, online: true }
    const { container } = await renderSettled(7)
    expect(container.firstChild).toBeNull()
    expect(getAdminLink).not.toHaveBeenCalled()
  })

  it('draws nothing before the answer arrives — not-yet-known is not no-page', () => {
    // Deliberately NOT settled: this is the first paint.
    answer = () => new Promise(() => undefined)
    const { container } = render(<AdminLinkQuickAction trpc={trpc} deviceId={1436} />)
    expect(container.firstChild).toBeNull()
  })

  it('draws nothing when the call was refused, which is what a non-admin session gets', async () => {
    answer = () => Promise.reject(new Error('UNAUTHORIZED'))
    const { container } = await renderSettled(1436)
    expect(container.firstChild).toBeNull()
  })

  it('survives a proxy handle that throws SYNCHRONOUSLY, without taking the row down', async () => {
    // A cap handle that is present but not wired throws on call rather than
    // rejecting. An uncaught throw inside the effect unmounts the row and
    // everything else in it — five existing device-row specs went red exactly
    // this way before the call was wrapped.
    capabilityResult = {
      dev: {},
      cap: {
        getAdminLink: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'find')")
        },
      },
      online: true,
    }
    const { container } = await renderSettled(1436)
    expect(container.firstChild).toBeNull()
  })

  it('draws nothing when the provider says this device has no page', async () => {
    answer = () => Promise.resolve(null)
    const { container } = await renderSettled(592)
    expect(container.firstChild).toBeNull()
  })

  it('hides a DEVICE-hosted page when the device is offline', async () => {
    capabilityResult = { dev: {}, cap: { getAdminLink }, online: false }
    const { container } = await renderSettled(1436)
    expect(container.firstChild).toBeNull()
  })

  it('KEEPS an INTEGRATION page when the device is offline — the page is elsewhere', async () => {
    // The whole reason `target` is on the payload. A Home Assistant device
    // page is served by HA, and a dropped device is exactly when an operator
    // wants to open it.
    capabilityResult = { dev: {}, cap: { getAdminLink }, online: false }
    answer = () => Promise.resolve(INTEGRATION_LINK)
    await renderSettled(1027)
    expect(screen.getByLabelText('Open Home Assistant for this device')).toBeTruthy()
  })

  it('never renders a disabled control — the absent states render no node at all', async () => {
    answer = () => Promise.resolve(null)
    const { container } = await renderSettled(592)
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })
})
