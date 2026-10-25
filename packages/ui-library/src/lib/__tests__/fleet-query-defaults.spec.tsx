// @vitest-environment jsdom
/**
 * `applyFleetQueryDefaults` — the OUTCOME, measured through a real
 * `QueryClient`: N observers of `deviceManager.listAll` produce ONE fetch.
 *
 * These tests deliberately do NOT assert that a prop was passed. They mount
 * real observers with NO local options — i.e. they impersonate the ~40 call
 * sites that forget `staleTime` — and count `queryFn` invocations.
 *
 * Two mount shapes, because they fail for two different reasons and only one
 * of them is what people picture:
 *
 *  1. **Staggered mounts, all kept alive** — the lazily code-split route
 *     chunk, the modal opened a second later, the tab switched into. Fixed by
 *     `staleTime`. Note the case NOT tested as a regression: observers mounting
 *     in the SAME tick were already deduped by query-core's in-flight retryer,
 *     with or without this fix. Pinning that would have been a green test that
 *     proved nothing, so the third test pins it as the non-goal it is.
 *  2. **Mount → unmount → mount** — navigating away from Recordings and back.
 *     Fixed by `gcTime`: the app-wide default is `gcTime: 0`, which evicts the
 *     entry the instant the last observer leaves, and an evicted entry cannot
 *     be stale-served no matter what `staleTime` says.
 *
 * Each is paired with its own negative control on a client that did NOT get
 * the defaults, so the assertions cannot pass for the ambient reason.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { applyFleetQueryDefaults } from '../fleet-query-defaults'

/**
 * The exact key tRPC v11 builds for `useDeviceManagerListAll({ projection:
 * 'slim' })` — `[[path…], { input, type }]`. The defaults registration only
 * covers this because it is matched as a PREFIX, so using the real shape here
 * is load-bearing: a hand-simplified key would pass while production missed.
 */
const FLEET_KEY: QueryKey = [
  ['deviceManager', 'listAll'],
  { input: { projection: 'slim' }, type: 'query' },
]

/** The admin UI's app-wide defaults, verbatim from `App.tsx:123`. */
function makeAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false },
    },
  })
}

interface FleetReaderProps {
  readonly queryFn: () => Promise<readonly number[]>
}

/**
 * A forgetful call site: the shared key, and no options at all. Every
 * behaviour under test has to come from the client.
 */
function FleetReader({ queryFn }: FleetReaderProps) {
  const { data } = useQuery({ queryKey: FLEET_KEY, queryFn })
  return <div data-testid="reader">{data === undefined ? 'loading' : String(data.length)}</div>
}

const OBSERVER_COUNT = 5

describe('applyFleetQueryDefaults', () => {
  it('serves 5 STAGGERED observers of the fleet key from one fetch', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()
    applyFleetQueryDefaults(client)

    // Mount them one at a time, letting each settle — a lazily-loaded page,
    // then a modal, then a tab. Nothing overlaps in flight.
    for (let i = 0; i < OBSERVER_COUNT; i++) {
      const view = render(
        <QueryClientProvider client={client}>
          <FleetReader queryFn={queryFn} />
        </QueryClientProvider>,
      )
      await waitFor(() =>
        expect(within(view.container).getByTestId('reader').textContent).toBe('3'),
      )
    }

    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('WITHOUT the defaults, the same 5 staggered observers each refetch', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()

    for (let i = 0; i < OBSERVER_COUNT; i++) {
      const view = render(
        <QueryClientProvider client={client}>
          <FleetReader queryFn={queryFn} />
        </QueryClientProvider>,
      )
      await waitFor(() =>
        expect(within(view.container).getByTestId('reader').textContent).toBe('3'),
      )
    }

    expect(queryFn).toHaveBeenCalledTimes(OBSERVER_COUNT)
  })

  it('does not claim credit for same-tick mounts: query-core already dedupes those', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()

    const view = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
        <FleetReader queryFn={queryFn} />
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(within(view.container).getAllByTestId('reader')[0]?.textContent).toBe('3'),
    )

    // One in-flight fetch is shared. This is the case the app-wide comment
    // already described, and it is NOT what `applyFleetQueryDefaults` buys.
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('survives navigation: unmounting every observer does not evict the fleet', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()
    applyFleetQueryDefaults(client)

    const first = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(within(first.container).getByTestId('reader').textContent).toBe('3'))
    act(() => {
      first.unmount()
    })

    const second = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(within(second.container).getByTestId('reader').textContent).toBe('3'),
    )

    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('WITHOUT the defaults, gcTime: 0 evicts on unmount and the return refetches', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()

    const first = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(within(first.container).getByTestId('reader').textContent).toBe('3'))
    act(() => {
      first.unmount()
    })

    const second = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(within(second.container).getByTestId('reader').textContent).toBe('3'),
    )

    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('still lets a call site override the window it genuinely needs', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()
    applyFleetQueryDefaults(client)

    function AlwaysFreshReader() {
      const { data } = useQuery({ queryKey: FLEET_KEY, queryFn, staleTime: 0, gcTime: 0 })
      return <div data-testid="reader">{data === undefined ? 'loading' : String(data.length)}</div>
    }

    for (let i = 0; i < 2; i++) {
      const view = render(
        <QueryClientProvider client={client}>
          <AlwaysFreshReader />
        </QueryClientProvider>,
      )
      await waitFor(() =>
        expect(within(view.container).getByTestId('reader').textContent).toBe('3'),
      )
    }

    // Call-site options sit LAST in `defaultQueryOptions`' merge, so the
    // registration never traps a surface that must be live.
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('invalidates through the double-nested tRPC prefix, not the single one', async () => {
    const queryFn = vi.fn(() => Promise.resolve([1, 2, 3]))
    const client = makeAppQueryClient()
    applyFleetQueryDefaults(client)

    const view = render(
      <QueryClientProvider client={client}>
        <FleetReader queryFn={queryFn} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(within(view.container).getByTestId('reader').textContent).toBe('3'))
    expect(queryFn).toHaveBeenCalledTimes(1)

    // `['deviceManager']` compares a string against the key's first element,
    // which is an ARRAY — it matches nothing. This is what `useDevice.ts` did.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['deviceManager'] })
    })
    expect(queryFn).toHaveBeenCalledTimes(1)

    // `[['deviceManager']]` is a real prefix of `[['deviceManager','listAll'], …]`.
    await act(async () => {
      await client.invalidateQueries({ queryKey: [['deviceManager']] })
    })
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
  })
})
