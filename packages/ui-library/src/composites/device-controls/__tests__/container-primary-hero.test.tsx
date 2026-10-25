// @vitest-environment jsdom
/**
 * Tests for <ContainerPrimaryHero> — the container detail hero rendered AS its
 * primary child. The primary-child PICKER no longer lives on the hero (it moved
 * to the Device Info / Identity block — see admin-ui `PrimaryChildRow`); this
 * hero now only resolves + renders the primary child's HeroCard.
 *
 * The control registry is mocked so each device type's HeroCard renders an
 * identifiable marker carrying the bound deviceId — letting us assert WHICH
 * child's hero (and bound id) is on screen without pulling the real panel
 * controls (which need a live trpc client).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../control-registry', () => ({
  resolveDeviceControl: (type: string) => ({
    HeroCard: ({ deviceId }: { deviceId: number }) => (
      <div data-testid="hero">{`hero:${type}:${String(deviceId)}`}</div>
    ),
  }),
}))

import { ContainerPrimaryHero, type ContainerHeroChild } from '../container-primary-hero'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

// Minimal real trpc stub satisfying the interface — only `deviceManager.getBindings`
// is required and the mocked HeroCard never invokes it, so a no-op suffices.
const trpc: UseDeviceProxyTrpc = {
  deviceManager: {
    getBindings: { query: () => Promise.reject(new Error('not used in this test')) },
  },
}

const battery: ContainerHeroChild = {
  id: 7,
  stableId: 'st-batt',
  type: 'sensor',
  name: 'Battery',
  sourceInfo: { id: 'sensor.batt' },
}
const lock: ContainerHeroChild = {
  id: 9,
  stableId: 'st-lock',
  type: 'lock',
  name: 'Serratura',
  sourceInfo: { id: 'lock.front' },
}
const children: readonly ContainerHeroChild[] = [battery, lock]

describe('ContainerPrimaryHero', () => {
  it('renders the priority-default child hero (lock) bound to the child id', () => {
    render(<ContainerPrimaryHero trpc={trpc} children={children} linkDeviceId={null} />)
    expect(screen.getByTestId('hero').textContent).toBe('hero:lock:9')
  })

  it('renders the legacy override hero (battery) when linkDeviceId points at it', () => {
    render(<ContainerPrimaryHero trpc={trpc} children={children} linkDeviceId={7} />)
    expect(screen.getByTestId('hero').textContent).toBe('hero:sensor:7')
  })

  it('falls back to the priority default when linkDeviceId is stale', () => {
    render(<ContainerPrimaryHero trpc={trpc} children={children} linkDeviceId={9999} />)
    expect(screen.getByTestId('hero').textContent).toBe('hero:lock:9')
  })

  it('renders the durable override hero (battery) when primaryChildEntityId points at it', () => {
    render(
      <ContainerPrimaryHero
        trpc={trpc}
        children={children}
        linkDeviceId={null}
        primaryChildEntityId="sensor.batt"
      />,
    )
    expect(screen.getByTestId('hero').textContent).toBe('hero:sensor:7')
  })

  it('does not render a picker on the hero (the selector moved to the config block)', () => {
    render(<ContainerPrimaryHero trpc={trpc} children={children} linkDeviceId={null} />)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('degrades gracefully for a container with no children (no crash, no hero)', () => {
    render(<ContainerPrimaryHero trpc={trpc} children={[]} linkDeviceId={null} />)
    expect(screen.queryByTestId('hero')).toBeNull()
    expect(screen.getByText(/no child entities/i)).toBeTruthy()
  })
})
