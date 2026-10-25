// @vitest-environment jsdom
/**
 * Catalog inventory empty copy points at Import (Library/Distribute gone).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import { CatalogInventory } from '../tabs/CatalogInventory.js'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useClusterNodes: () => ({
      nodes: [{ id: 'hub', name: 'Hub', shortName: 'hub', isOnline: true }],
    }),
  }
})

function emptyTrpc(): AddonPageProps['trpc'] {
  const surface = {
    addons: {
      custom: {
        mutate: async (input: { action: string }) => {
          if (input.action === 'listCustomModels') return []
          if (input.action === 'listAvailability') return {}
          throw new Error(`unexpected action ${input.action}`)
        },
      },
    },
  }
  return surface as unknown as AddonPageProps['trpc']
}

afterEach(cleanup)

describe('CatalogInventory — empty copy', () => {
  it('points the operator to Import when nothing is on the node', async () => {
    render(<CatalogInventory trpc={emptyTrpc()} refreshKey={0} provider="custom" nodeId="hub" />)
    const empty = await screen.findByText(/No custom models on hub/i)
    expect(empty.textContent).toMatch(/Import/)
    expect(empty.textContent).not.toMatch(/Convert/)
    expect(empty.textContent).not.toMatch(/Library/)
    expect(screen.queryByText(/absent/i)).toBeNull()
  })
})
