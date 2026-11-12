// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { RunningStateStatus } from '@camstack/types'
import { ApplianceInlineControl } from '../appliance-control'

let running: RunningStateStatus | undefined

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceState: (_t: unknown, _id: number, select: (s: Record<string, unknown>) => unknown) => {
    const probe = { runningState: 'running' }
    return select(probe) === 'running' ? running : undefined
  },
}))

const props = { trpc: {} as never, deviceId: 1, features: undefined }

function runningSlice(overrides: Partial<RunningStateStatus>): RunningStateStatus {
  return {
    running: true,
    since: Date.now() - 35 * 60_000,
    source: 'native',
    phase: 'Rinse',
    lastFetchedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  running = undefined
})

describe('ApplianceInlineControl', () => {
  it('badges a running cycle and leaves an unknown one unbadged', () => {
    running = runningSlice({})
    const { container, rerender } = render(<ApplianceInlineControl {...props} />)
    expect(container.querySelector('[data-running="running"]')).not.toBeNull()
    running = runningSlice({ running: null })
    rerender(<ApplianceInlineControl {...props} />)
    expect(container.querySelector('[data-running="unknown"]')).not.toBeNull()
    expect(container.querySelector('[data-running="running"]')).toBeNull()
  })
})
