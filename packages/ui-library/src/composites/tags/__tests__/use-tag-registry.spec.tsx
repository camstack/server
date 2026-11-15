// @vitest-environment jsdom
/**
 * A rename or remove rewrites the records that carry tags, so it refreshes
 * exactly the queries of those owners (and the tag list) — not every query of
 * the app.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const mutation = { mutateAsync: vi.fn(async () => ({})) }

vi.mock('../../../generated/system-hooks', () => ({
  useTagsList: () => ({ data: [], status: 'success' }),
  useTagsSetStyle: () => mutation,
  useTagsRename: () => mutation,
  useTagsRemove: () => mutation,
}))
vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))

// The package setup replaces this hook with a fixed registry; test the real one.
const { useTagRegistry } =
  await vi.importActual<typeof import('../use-tag-registry')>('../use-tag-registry')

const KEYS = {
  tags: [['tags', 'list'], { type: 'query' }],
  blocks: ['coreBlocks', 'list'],
  schedulers: [['schedulers', 'list'], { type: 'query' }],
  templates: [['template', 'list'], { type: 'query' }],
  actions: [['actions', 'list'], { type: 'query' }],
  devices: [['deviceManager', 'listAll'], { input: { projection: 'slim' }, type: 'query' }],
  unrelated: [['recordings', 'list'], { type: 'query' }],
} as const

function setup() {
  const client = new QueryClient()
  for (const key of Object.values(KEYS)) client.setQueryData(key, 1)
  // Record which cached queries each invalidation's filters reach.
  const reached = new Set<string>()
  const original = client.invalidateQueries.bind(client)
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters, options) => {
    for (const query of client.getQueryCache().findAll(filters)) reached.add(query.queryHash)
    return original(filters, options)
  })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useTagRegistry(), { wrapper })
  const stale = (key: readonly unknown[]): boolean => {
    const hash = client.getQueryCache().find({ queryKey: key, exact: true })?.queryHash
    return hash !== undefined && reached.has(hash)
  }
  return { result, stale }
}

describe('useTagRegistry — refresh after a rewrite', () => {
  it.each(['rename', 'remove'] as const)('%s invalidates the tag owners only', async (op) => {
    const { result, stale } = setup()
    await act(async () => {
      if (op === 'rename') await result.current.rename('Garden', 'Yard')
      else await result.current.remove('Garden')
    })
    for (const [name, key] of Object.entries(KEYS)) {
      expect({ name, stale: stale(key) }).toEqual({ name, stale: name !== 'unrelated' })
    }
  })
})
