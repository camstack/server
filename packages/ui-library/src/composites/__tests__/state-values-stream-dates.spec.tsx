// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { formatLocalDate } from '../format-state-value'

/**
 * The reported bug: the State panel showed `lastFetchedAt` as `1785060000000`.
 *
 * `format-state-value.test.ts` covers the RULE. This file covers the WIRING —
 * that the tree renderer actually calls it, keeps the raw value on the title
 * attribute, and does not convert numbers that merely look big. Testing the pure
 * module alone would pass even if the component never used it.
 *
 * Mock surface copied from `state-values-stream-raw.spec.tsx`.
 */

interface SnapshotQueryResult {
  readonly data: Record<string, Record<string, Record<string, unknown>>> | undefined
  readonly isLoading: boolean
}

let snapshotResult: SnapshotQueryResult

vi.mock('../../trpc-react', () => ({
  trpc: {
    deviceState: {
      getAllSnapshots: { useQuery: () => snapshotResult },
    },
    deviceManager: {
      getBindings: { useQuery: () => ({ data: { deviceId: 1, entries: [] } }) },
    },
    systemEvents: {
      subscribe: { useSubscription: (): void => undefined },
    },
  },
}))

vi.mock('../../contexts/system-context', () => ({
  useSystem: () => ({ trpcClient: {} }),
}))

vi.mock('../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() => null),
}))

import { StateValuesStream } from '../state-values-stream'

function renderWithClient(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const EPOCH_MS = 1_785_060_000_000

describe('StateValuesStream — timestamps render as local dates', () => {
  beforeEach(() => {
    snapshotResult = { data: undefined, isLoading: false }
  })

  it('shows lastFetchedAt as a local date, not a raw epoch number', () => {
    snapshotResult = {
      data: { '1': { battery: { percent: 80, lastFetchedAt: EPOCH_MS } } },
      isLoading: false,
    }
    renderWithClient(<StateValuesStream deviceId={1} />)

    expect(screen.getByText(formatLocalDate(EPOCH_MS))).toBeTruthy()
    expect(screen.queryByText(String(EPOCH_MS))).toBeNull()
  })

  it('keeps the raw epoch reachable as a tooltip', () => {
    // A debugging panel must not destroy the exact value.
    snapshotResult = {
      data: { '1': { battery: { lastFetchedAt: EPOCH_MS } } },
      isLoading: false,
    }
    renderWithClient(<StateValuesStream deviceId={1} />)

    const rendered = screen.getByText(formatLocalDate(EPOCH_MS))
    expect(rendered.getAttribute('title')).toBe(String(EPOCH_MS))
  })

  it('does NOT convert a large number under a non-time key', () => {
    // A bitrate is not a date. Rendering one as 1970 would be worse than raw.
    snapshotResult = {
      data: { '1': { streamParams: { bitrate: EPOCH_MS } } },
      isLoading: false,
    }
    renderWithClient(<StateValuesStream deviceId={1} />)

    expect(screen.getByText(String(EPOCH_MS))).toBeTruthy()
    expect(screen.queryByText(formatLocalDate(EPOCH_MS))).toBeNull()
  })

  it('adds no tooltip to an ordinary value', () => {
    snapshotResult = { data: { '1': { switch: { on: true } } }, isLoading: false }
    renderWithClient(<StateValuesStream deviceId={1} />)

    expect(screen.getByText('true').getAttribute('title')).toBeNull()
  })

  it('formats an ISO string, which is what a broker round-trip leaves behind', () => {
    const iso = '2026-07-26T10:00:00.000Z'
    snapshotResult = { data: { '1': { doorbell: { pressed: iso } } }, isLoading: false }
    renderWithClient(<StateValuesStream deviceId={1} />)

    expect(screen.getByText(formatLocalDate(Date.parse(iso)))).toBeTruthy()
  })
})
