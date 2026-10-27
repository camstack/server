import type { DeviceDisplayOverride } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { QuickDetailSaveProvider, useQuickDetailSave } from '../quick-detail-save'

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false }

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerSetRole: () => mutation,
    useDeviceManagerSetDisplay: () => mutation,
    useDeviceManagerSetName: () => mutation,
    useDeviceManagerSetLocation: () => mutation,
  }
})

function NameEditor(): ReactNode {
  const save = useQuickDetailSave()
  return (
    <button type="button" onClick={() => save?.setIdentityName('Renamed')}>
      rename
    </button>
  )
}

interface Seed {
  readonly name: string
  readonly location: string
  readonly role: string | null
  readonly display: DeviceDisplayOverride | undefined
}

const PRISTINE: Seed = { name: 'Pet feeder', location: '', role: null, display: undefined }

function renderWith(seed: Seed, showOpenFull = false): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmDialogProvider>
        <MemoryRouter>
          <QuickDetailSaveProvider deviceId={5063} seed={seed} showOpenFull={showOpenFull}>
            <NameEditor />
          </QuickDetailSaveProvider>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('the Save / Discard footer', () => {
  it('is absent while nothing has changed', () => {
    renderWith(PRISTINE)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })

  it('stays absent for an empty display override', () => {
    renderWith({ ...PRISTINE, display: {} })
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('appears with the first edit and leaves when the edit is discarded', () => {
    renderWith(PRISTINE)
    fireEvent.click(screen.getByRole('button', { name: 'rename' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps the modal Open full detail button even when pristine, with Save inert', () => {
    renderWith(PRISTINE, true)
    expect(screen.getByRole('button', { name: 'Open full detail' })).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveProperty('disabled', true)
  })
})
