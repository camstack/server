// @vitest-environment jsdom
/**
 * Custom tab offers Upload | URL only — plus catalog/plugin catalog live under Sources.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import { CustomTab } from '../tabs/RegisterTab.js'
import { OperationModalProvider } from '../components/OperationModalProvider.js'

function customTrpc(): AddonPageProps['trpc'] {
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
    pipelineExecutor: {
      getSchema: {
        query: async () => ({
          slots: [
            { addons: [{ id: 'object-detection', name: 'Object detection', slot: 'detector' }] },
          ],
        }),
      },
    },
  }
  return surface as unknown as AddonPageProps['trpc']
}

afterEach(cleanup)

describe('CustomTab — sources', () => {
  it('offers upload and URL — not plus catalog, plugin catalog, or CamStack', () => {
    render(
      <OperationModalProvider>
        <CustomTab trpc={customTrpc()} onRegistered={() => undefined} />
      </OperationModalProvider>,
    )
    for (const name of ['Upload file', 'Remote URL']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'plus catalog' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'plugin catalog' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'CamStack' })).toBeNull()
  })
})
