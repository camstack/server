/**
 * M5 (D690 review, D315): a camera whose zone read FAILED does not make its
 * stored zone look deleted — the chip says the zone is unavailable, never "not
 * found", and the zones the other cameras answered stay pickable.
 */
import type { NcConditions } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        zones: {
          listZones: {
            query: ({ deviceId }: { readonly deviceId: number }) =>
              deviceId === 1
                ? Promise.resolve([{ id: 'z-ok', name: 'Uscio' }])
                : Promise.reject(new Error('camera 2 unreachable')),
          },
        },
      },
    }),
  }
})

import { ZoneScopeField } from '../notification-scope-fields'

function mount(conditions: NcConditions): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ZoneScopeField
        conditions={conditions}
        onConditionsChange={() => {}}
        exceptOffered
        cameraIds={[1, 2]}
        cameras={[
          { id: 1, name: 'Front door' },
          { id: 2, name: 'Garden' },
        ]}
      />
    </QueryClientProvider>,
  )
}

describe('ZoneScopeField — a failed zone read', () => {
  it('labels a stored zone of the failed camera unavailable, never not found', async () => {
    mount({ zones: { ids: ['z-lost'] } })
    // Once every read has settled — the failed one included.
    await screen.findByRole('button', { name: 'Edit…' })
    expect(screen.getByText(/z-lost — zone unavailable/)).toBeTruthy()
    expect(screen.queryByText(/not found/)).toBeNull()
  })

  it('keeps the answered cameras pickable', async () => {
    mount({ zones: { ids: ['z-lost'] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }))
    expect(await screen.findByLabelText(/Front door:Uscio/)).toBeTruthy()
  })
})
