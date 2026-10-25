/**
 * The prune banner renders ONLY an answered, matching, still-disabled prune —
 * never while pending, never on a failed read, never "nothing was pruned".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let answer: () => Promise<unknown> = () => Promise.resolve({ prunes: [] })
const mockCustom = vi.fn(() => answer())

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({ trpcClient: { addons: { custom: { mutate: mockCustom } } } }),
  }
})

import { NotificationPruneBanner } from '../NotificationPruneBanner'

const KEPT = {
  kind: 'timelapse',
  ruleId: 't1',
  subjectKind: 'device',
  subject: '102',
  field: 'deviceIds',
  outcome: 'kept-disabled',
  at: Date.UTC(2026, 8, 25),
  source: 'event',
}

function wrap(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

describe('NotificationPruneBanner', () => {
  beforeEach(() => {
    mockCustom.mockClear()
  })

  it('says why a disabled timelapse was switched off', async () => {
    answer = () => Promise.resolve({ prunes: [KEPT] })
    render(
      wrap(<NotificationPruneBanner kind="timelapse" ruleId="t1" enabled={false} updatedAt={0} />),
    )
    const banner = await screen.findByTestId('nc-prune-banner')
    expect(banner.textContent).toContain('its last device (#102) was deleted')
    expect(mockCustom).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      action: 'nc.listPrunes',
      input: {},
    })
  })

  it('does not even ask for an enabled rule', async () => {
    answer = () => Promise.resolve({ prunes: [KEPT] })
    render(wrap(<NotificationPruneBanner kind="timelapse" ruleId="t1" enabled updatedAt={0} />))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockCustom).not.toHaveBeenCalled()
    expect(screen.queryByTestId('nc-prune-banner')).toBeNull()
  })

  it('renders nothing on a refused read (non-admin) — no "nothing pruned" claim', async () => {
    answer = () => Promise.reject(new Error('forbidden: admin required'))
    const { container } = render(
      wrap(<NotificationPruneBanner kind="timelapse" ruleId="t1" enabled={false} updatedAt={0} />),
    )
    await waitFor(() => expect(mockCustom).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
