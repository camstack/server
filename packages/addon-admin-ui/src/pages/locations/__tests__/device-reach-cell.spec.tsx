import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceReachCell } from '../device-glyphs'
import type { SiteDevice } from '../site-locations'

const BASE: SiteDevice = {
  id: 1,
  name: 'Kitchen sensor',
  location: 'Kitchen',
  type: 'sensor',
  isCamera: false,
  parentDeviceId: null,
  online: true,
  role: null,
}

afterEach(cleanup)

describe('DeviceReachCell — a location row says Offline, never Online', () => {
  it('a reachable device shows a quiet dot and no word', () => {
    const { container } = render(<DeviceReachCell device={BASE} />)
    expect(screen.queryByText(/online/i)).toBeNull()
    expect(container.querySelector('[title]')).toBeNull()
    expect(container.querySelector('[aria-label]')).toBeNull()
    expect(container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('online')
  })

  it('an offline device names itself in text and for a screen reader', () => {
    const { container } = render(<DeviceReachCell device={{ ...BASE, online: false }} />)
    expect(screen.getByText(/offline/i)).toBeTruthy()
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toMatch(/offline/i)
  })
})
