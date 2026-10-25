import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksGetComposition: () => ({
      status: 'success',
      data: {
        state: 'loaded',
        view: {
          block: {
            id: 'blk-feeder',
            name: 'customize:x',
            code: '',
            enabled: true,
            placement: 'hub',
            createdAt: 1,
            updatedAt: 2,
            createdBy: 'a',
            status: 'running',
            lastChangedAt: 1,
            source: {
              kind: 'composition',
              composition: {
                target: {
                  kind: 'existing',
                  device: { addonId: 'provider-homeassistant', stableId: 'ha:device:petkit' },
                },
                features: [{ kind: 'fields', cap: 'battery', fields: {} }],
              },
            },
          },
          state: {
            kind: 'answered',
            state: { blockId: 'blk-feeder', deviceId: 4127, status: 'running', fields: [] },
          },
        },
      },
    }),
    useCoreBlocksCreateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})
const { CompositionEditorPage } = await import('../CompositionEditorPage')

describe('CompositionEditorPage', () => {
  it('a customization is edited on its device page, where its presets live', () => {
    render(
      <MemoryRouter initialEntries={['/build/compositions/blk-feeder']}>
        <Routes>
          <Route path="/build/compositions/:blockId" element={<CompositionEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(
      screen.getByRole('link', { name: 'Open it on the device page' }).getAttribute('href'),
    ).toBe('/devices/4127?tab=customize')
  })
})
