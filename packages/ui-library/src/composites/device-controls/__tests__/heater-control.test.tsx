// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { HeaterInlineControl } from '../heater-control'

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => ({
    cap: { setState: vi.fn() },
    slice: { on: true, lastChangedAt: 0 },
    available: true,
    online: true,
  }),
}))
vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({
    display: slice,
    applyOptimisticAction: (_patch: unknown, run: () => unknown) => void run(),
  }),
}))

const trpc = {} as never

afterEach(cleanup)

describe('HeaterInlineControl', () => {
  it('is the power switch, and leaves the timed run to the row control', () => {
    render(<HeaterInlineControl trpc={trpc} deviceId={5} features={undefined} />)
    expect(screen.getByRole('switch', { name: 'Heater' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Run|Stop/ })).toBeNull()
  })
})
