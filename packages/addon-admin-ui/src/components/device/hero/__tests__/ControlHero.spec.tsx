// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

// ── Mocks ───────────────────────────────────────────────────────────
//
// ControlHero renders the type's HeroCard plus a single per-device
// OfflineBadge in the header when the device-status slice reports
// `online: false`. We mock the ui-library boundary so the test asserts
// purely the badge-gating behaviour: badge when offline, no badge when
// online (or before the slice lands).

interface StatusSlice {
  readonly online: boolean
  readonly lastChangedAt: number
}

const statusSlice = vi.hoisted(() => ({ current: undefined as StatusSlice | undefined }))

vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient: {} }),
  useDeviceProxy: () => ({ state: { deviceStatus: {} } }),
  useDeviceStateSlice: () => statusSlice.current,
  resolveDeviceControl: () => ({
    HeroCard: (): ReactNode => <div data-testid="hero-card" />,
  }),
  DummyHeroCard: (): ReactNode => <div data-testid="dummy-card" />,
  OfflineBadge: ({ lastChangedAt }: { lastChangedAt?: number | null }): ReactNode => (
    <div data-testid="offline-badge" data-last-changed={String(lastChangedAt)} />
  ),
}))

// The motion-activation ("Trigger on motion") control is a self-gating child;
// its own cap/slice wiring is exercised elsewhere. Here we only assert the
// regression fix — that ControlHero HOSTS it (Switch/Siren/Light lost it when
// the registry consolidated them onto ControlHero).
vi.mock('../MotionTriggerToggle', () => ({
  MotionTriggerToggle: (): ReactNode => <div data-testid="motion-trigger-toggle" />,
}))

import { ControlHero } from '../ControlHero'

const heroProps = {
  deviceId: 7,
  deviceName: 'Floodlight',
  deviceType: 'switch',
  provider: 'reolink',
  isOnline: true,
  features: [] as readonly string[],
}

describe('ControlHero offline badge', () => {
  beforeEach(() => {
    statusSlice.current = undefined
  })

  it('renders the hero card', () => {
    render(<ControlHero {...heroProps} />)
    expect(screen.getByTestId('hero-card')).toBeTruthy()
  })

  it('hosts the motion-activation toggle (restores siren/switch/light regression)', () => {
    render(<ControlHero {...heroProps} />)
    expect(screen.getByTestId('motion-trigger-toggle')).toBeTruthy()
  })

  it('does not render the offline badge while the status slice is absent', () => {
    statusSlice.current = undefined
    render(<ControlHero {...heroProps} />)
    expect(screen.queryByTestId('offline-badge')).toBeNull()
  })

  it('does not render the offline badge when the device is online', () => {
    statusSlice.current = { online: true, lastChangedAt: 1_000 }
    render(<ControlHero {...heroProps} />)
    expect(screen.queryByTestId('offline-badge')).toBeNull()
  })

  it('renders the offline badge with lastChangedAt when the device is offline', () => {
    statusSlice.current = { online: false, lastChangedAt: 123_456 }
    render(<ControlHero {...heroProps} />)
    const badge = screen.getByTestId('offline-badge')
    expect(badge.getAttribute('data-last-changed')).toBe('123456')
  })
})
