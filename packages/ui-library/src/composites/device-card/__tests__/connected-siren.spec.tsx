// @vitest-environment jsdom
/**
 * A siren whose `switch` slice has not answered is pending, never blank and
 * never silent. An answered off is silent.
 */
import type { SwitchStatus } from '@camstack/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedSirenCard } from '../connected/ConnectedSirenCard'

const hub = vi.hoisted(() => ({
  slice: undefined as SwitchStatus | undefined,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    switch: { setState: async () => undefined },
    state: { switch: hub.slice },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return {
      common,
      actions: {},
      deviceType: 'siren',
      role: 'siren',
      features: [],
      implements: () => true,
      fail: () => undefined,
      succeed: () => undefined,
    }
  },
}))

beforeEach(() => {
  hub.slice = undefined
})
afterEach(cleanup)

describe('ConnectedSirenCard', () => {
  it('shows the pending state while the switch slice has not answered', () => {
    render(<ConnectedSirenCard deviceId={591} />)
    expect(screen.getByTestId('dc-card-pending')).toBeTruthy()
    expect(screen.queryByText('Silent')).toBeNull()
  })

  it('shows silent once the switch has answered off', () => {
    hub.slice = { on: false, lastChangedAt: 0 }
    render(<ConnectedSirenCard deviceId={591} />)
    expect(screen.getByText('Silent')).toBeTruthy()
    expect(screen.queryByTestId('dc-card-pending')).toBeNull()
  })
})
