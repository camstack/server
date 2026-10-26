/**
 * A focus while the hub socket is down must not refetch. Coming back online
 * does — that is the tab-return the Customize cards were losing data on.
 */
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { applyQueryTransportOnline } from '../query-socket-online'

interface ProbeProps {
  readonly queryFn: () => Promise<string>
}

function Probe({ queryFn }: ProbeProps): ReactNode {
  useQuery({
    queryKey: ['customize-read'],
    queryFn,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  return null
}

describe('applyQueryTransportOnline', () => {
  afterEach(() => {
    applyQueryTransportOnline('connected')
    focusManager.setFocused(true)
  })

  it('a focus while the socket is down does not refetch; reconnect does', async () => {
    const queryFn = vi.fn(() => Promise.resolve('kept'))
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 0 } },
    })
    render(
      <QueryClientProvider client={client}>
        <Probe queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    applyQueryTransportOnline('disconnected')
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queryFn).toHaveBeenCalledTimes(1)

    applyQueryTransportOnline('connected')
    await waitFor(() => expect(queryFn.mock.calls.length).toBeGreaterThan(1))
  })
})
