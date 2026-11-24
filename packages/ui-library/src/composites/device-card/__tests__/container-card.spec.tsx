// @vitest-environment jsdom
/**
 * The connected container card (#694): what it has not measured is "—", never
 * 0 (D393) — the battery reads still pending, a failed read, a child past the
 * read bound — and a failed children read is shown, not "Counting…" forever.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedContainerCard } from '../connected/ConnectedContainerCard'

interface Child {
  readonly id: number
  readonly online: boolean
}

const hub = vi.hoisted(() => ({
  childrenStatus: 'success' as 'pending' | 'success' | 'error',
  children: [] as readonly { id: number; online: boolean }[],
  slice: (_id: number): Promise<Record<string, unknown> | null> => Promise.resolve(null),
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({
    deviceState: {
      getCapSlice: { query: ({ deviceId }: { deviceId: number }) => hub.slice(deviceId) },
    },
  }),
}))
vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerGetChildren: () => ({
    status: hub.childrenStatus,
    data: hub.childrenStatus === 'success' ? hub.children : undefined,
  }),
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return { common: { ...common, power: null, consumables: null, supply: null }, actions: {} }
  },
}))

const kids = (n: number): Child[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, online: true }))

const renderCard = (): void => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConnectedContainerCard deviceId={9} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  hub.childrenStatus = 'success'
  hub.children = kids(2)
  hub.slice = () => Promise.resolve({ level: 10 })
})
afterEach(cleanup)

const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

describe('the connected container card', () => {
  it('low battery is "—" until the battery reads answer, then the count', async () => {
    renderCard()
    expect(text('dc-container-low')).toContain('—')
    await waitFor(() => expect(text('dc-container-low')).toContain('2'))
  })

  it('low battery stays "—" when a battery read fails, while online is counted', async () => {
    hub.slice = (id) =>
      id === 1 ? Promise.reject(new Error('down')) : Promise.resolve({ level: 5 })
    renderCard()
    await waitFor(() => expect(text('dc-container-online')).toContain('2'))
    await settle()
    expect(text('dc-container-low')).toContain('—')
  })

  it('children past the read bound leave the low-battery count unknown', async () => {
    hub.children = kids(51)
    renderCard()
    await settle()
    expect(text('dc-container-low')).toContain('—')
  })

  it('a failed children read is shown, not "Counting…" forever', () => {
    hub.childrenStatus = 'error'
    renderCard()
    expect(screen.queryByText('Counting…')).toBeNull()
    expect(screen.getByText('Could not read the devices')).toBeTruthy()
  })
})
