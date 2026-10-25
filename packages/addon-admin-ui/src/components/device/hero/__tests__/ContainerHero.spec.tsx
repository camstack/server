import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

// ── Mocks ───────────────────────────────────────────────────────────
//
// ContainerHero pulls device + children via React-Query hooks and renders
// the shared `ContainerPrimaryHero`. The primary-child PICKER moved out of the
// hero into the Device Info / Identity block (`PrimaryChildRow`), so this hero
// no longer owns the `setPrimaryChildEntityId` mutation or its inline error.
// We mock the boundaries so the test asserts purely the loading-guard:
//   - while EITHER query is loading → neutral skeleton (no "No child entities")
//   - once settled → the primary hero is rendered (children passed through).

interface QueryResult<T> {
  readonly data: T | undefined
  readonly isLoading: boolean
}

const deviceResult = vi.hoisted(() => ({
  current: { data: undefined, isLoading: true } as QueryResult<unknown>,
}))
const childrenResult = vi.hoisted(() => ({
  current: { data: undefined, isLoading: true } as QueryResult<readonly unknown[]>,
}))

vi.mock('../../../../hooks/useDevice', () => ({
  useDevice: () => deviceResult.current,
  useDeviceChildren: () => childrenResult.current,
}))

vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient: {} }),
  ContainerPrimaryHero: ({ children }: { children: readonly { id: number }[] }): ReactNode => (
    <div data-testid="primary-hero" data-child-count={children.length} />
  ),
}))

import { ContainerHero } from '../ContainerHero'

const heroProps = {
  deviceId: 42,
  deviceName: 'Front Door',
  deviceType: 'container',
  provider: 'ha',
  isOnline: true,
  features: [] as readonly string[],
}

describe('ContainerHero', () => {
  beforeEach(() => {
    deviceResult.current = { data: undefined, isLoading: true }
    childrenResult.current = { data: undefined, isLoading: true }
  })

  it('renders a neutral skeleton (no empty fallback) while loading', () => {
    deviceResult.current = { data: undefined, isLoading: true }
    childrenResult.current = { data: undefined, isLoading: true }
    const { container } = render(<ContainerHero {...heroProps} />)
    expect(screen.queryByTestId('primary-hero')).toBeNull()
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('still skeletons while only the children query is loading', () => {
    deviceResult.current = { data: { linkDeviceId: null }, isLoading: false }
    childrenResult.current = { data: undefined, isLoading: true }
    const { container } = render(<ContainerHero {...heroProps} />)
    expect(screen.queryByTestId('primary-hero')).toBeNull()
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('renders the primary hero once both queries settle', () => {
    deviceResult.current = { data: { linkDeviceId: null }, isLoading: false }
    childrenResult.current = {
      data: [{ id: 7, stableId: 's7', type: 'lock', name: 'Lock', features: [] }],
      isLoading: false,
    }
    const { container } = render(<ContainerHero {...heroProps} />)
    const hero = screen.getByTestId('primary-hero')
    expect(hero.getAttribute('data-child-count')).toBe('1')
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })
})
