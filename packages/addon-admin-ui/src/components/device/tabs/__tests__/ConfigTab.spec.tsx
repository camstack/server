/**
 * L4 (final review, D676): the Extensions card left Config for everyone, but
 * its new home (Customize) is admin-only — `deviceExtension.listSlots` is
 * `protected`, so a non-admin used to see linked devices and doorbell sources
 * and would otherwise see them nowhere. ConfigTab shows it read-only for
 * whoever cannot open Customize; an admin keeps it in Customize only.
 *
 * `DeviceAggregateSection` is stubbed (it pulls the full settings-form hook
 * graph, irrelevant here); `ExtensionsPanel` is stubbed so this test pins the
 * WIRING (when it is rendered, and with `readOnly`) rather than its own
 * internals, which `AssociationSlotCard`'s own specs already cover.
 */
import { DeviceType } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../DeviceAggregateSection', () => ({
  DeviceAggregateSection: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="aggregate-surface">settings for {deviceId}</div>
  ),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    ExtensionsPanel: ({ deviceId, readOnly }: { deviceId: number; readOnly?: boolean }) => (
      <div data-testid="extensions-surface">
        extensions for {deviceId} · readOnly={String(readOnly === true)}
      </div>
    ),
  }
})

const { ConfigTab } = await import('../ConfigTab')

describe('ConfigTab — the read-only Extensions card for a non-admin (L4)', () => {
  it('a non-admin on a camera sees it, read-only', () => {
    render(<ConfigTab deviceId={101} deviceType={DeviceType.Camera} isAdmin={false} />)
    const surface = screen.getByTestId('extensions-surface')
    expect(surface.textContent).toContain('extensions for 101')
    expect(surface.textContent).toContain('readOnly=true')
  })

  it('an admin does not see it here — they have it in Customize, never twice', () => {
    render(<ConfigTab deviceId={101} deviceType={DeviceType.Camera} isAdmin={true} />)
    expect(screen.queryByTestId('extensions-surface')).toBeNull()
  })

  it('a non-admin on a device type with no Extensions slot sees nothing extra', () => {
    render(<ConfigTab deviceId={4127} deviceType={DeviceType.Sensor} isAdmin={false} />)
    expect(screen.queryByTestId('extensions-surface')).toBeNull()
  })

  it('an unanswered device type is not claimed as a host (D315) — nothing shown yet', () => {
    render(<ConfigTab deviceId={101} isAdmin={false} />)
    expect(screen.queryByTestId('extensions-surface')).toBeNull()
  })

  it('the settings aggregate always renders, either way', () => {
    render(<ConfigTab deviceId={101} deviceType={DeviceType.Camera} isAdmin={false} />)
    expect(screen.getByTestId('aggregate-surface').textContent).toContain('settings for 101')
  })
})
