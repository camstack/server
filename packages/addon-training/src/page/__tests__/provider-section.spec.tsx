// @vitest-environment jsdom
/**
 * Providers tab — single-entry ItemFormDialog; Save = create+update;
 * Delete = deleteEntry; form fields from type.configSchema via ConfigFormBuilder.
 */
import type { TrainingProviderDescriptor, TrainingProviderType } from '@camstack/types'
import { ConfirmDialogProvider, type AddonPageProps } from '@camstack/ui-library'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODAL_ENTRY_CONFIG_SCHEMA } from '../../providers/modal/modal-entry-schema.js'
import { ProviderSection } from '../ProviderSection.js'

const presence = vi.hoisted(() => ({
  value: 'present' as 'pending' | 'present' | 'absent' | 'unknown',
}))

vi.mock(import('@camstack/ui-library'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useCapabilityPresence: () => presence.value,
  }
})

/** jsdom does not implement HTMLDialogElement.showModal/close. */
function installDialogPolyfill(): void {
  if (typeof HTMLDialogElement === 'undefined') return
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
}

const TYPE: TrainingProviderType = {
  typeId: 'modal',
  label: 'Modal Labs',
  iconAsset: 'assets/training-modal/icon.svg',
  addonId: 'training-modal',
  configSchema: MODAL_ENTRY_CONFIG_SCHEMA,
}

const ENTRY: TrainingProviderDescriptor = {
  addonId: 'training-modal',
  entryId: 'entry-1',
  typeId: 'modal',
  name: 'Production',
  iconAsset: 'assets/training-modal/icon.svg',
  kind: 'modal',
  label: 'Modal Labs',
  gpuTypes: [{ id: 'L4', label: 'L4', usdPerHour: 0.8, vramGb: 24 }],
  regions: [{ id: '', label: 'Any', priceMultiplier: 1 }],
  maxDatasetBytes: 1_000_000,
  maxRuntimeSec: 14_400,
  dataResidencyNote: 'Frames leave the hub for the cloud.',
  configured: false,
  defaults: {
    gpuType: 'L4',
    region: '',
    costCapUsd: 5,
    maxRuntimeSec: 14_400,
    failedDatasetGraceHours: 24,
  },
  formValues: {
    tokenId: '',
    tokenSecret: '',
    environment: '',
    gpuType: 'L4',
    region: '',
    costCapUsd: 5,
    maxRuntimeHours: 4,
    failedDatasetGraceHours: 24,
  },
}

afterEach(() => {
  cleanup()
  presence.value = 'present'
})

beforeEach(() => {
  installDialogPolyfill()
  window.history.replaceState({}, '', '/addon/training?tab=providers')
})

function mockTrpc(opts: {
  readonly descriptors?: readonly TrainingProviderDescriptor[]
  readonly types?: readonly TrainingProviderType[] | 'pending'
  readonly create?: () => Promise<{ entryId: string }>
  readonly update?: (input: Record<string, unknown>) => Promise<{ ok: true }>
  readonly delete?: (input: { entryId: string; addonId: string }) => Promise<{ ok: true }>
}): AddonPageProps['trpc'] {
  let descriptors = [...(opts.descriptors ?? [])]
  const types = opts.types === 'pending' ? null : [...(opts.types ?? [TYPE])]
  const create =
    opts.create ??
    (async () => {
      descriptors = [{ ...ENTRY, entryId: 'entry-new', name: 'Staging' }]
      return { entryId: 'entry-new' }
    })
  const update =
    opts.update ??
    (async (input: Record<string, unknown>) => {
      const entryId = String(input.entryId)
      descriptors = descriptors.map((d) =>
        d.entryId === entryId
          ? {
              ...d,
              name: String(input.name ?? d.name),
              configured: true,
              formValues: {
                ...d.formValues,
                tokenId: typeof input.tokenId === 'string' ? input.tokenId : '',
              },
            }
          : d,
      )
      return { ok: true as const }
    })
  const del = async (input: { entryId: string; addonId: string }) => {
    if (opts.delete !== undefined) await opts.delete(input)
    descriptors = descriptors.filter((d) => d.entryId !== input.entryId)
    return { ok: true as const }
  }

  return {
    trainingProvider: {
      describe: {
        query: async () => descriptors,
      },
      describeTypes: {
        query: async () => {
          if (types === null) await new Promise(() => undefined)
          return types
        },
      },
      createEntry: {
        mutate: async (input: { typeId: string; name: string; addonId: string }) => {
          expect(input).toMatchObject({
            typeId: 'modal',
            name: 'Staging',
            addonId: 'training-modal',
          })
          return create()
        },
      },
      updateEntry: {
        mutate: async (input: Record<string, unknown>) => update(input),
      },
      validateCredentials: {
        mutate: async () => ({ ok: true, account: 'ws' }),
      },
      deleteEntry: {
        mutate: async (input: { entryId: string; addonId: string }) => del(input),
      },
    },
  } as unknown as AddonPageProps['trpc']
}

function renderSection(
  trpc: AddonPageProps['trpc'],
  opts: { readonly createRequested?: boolean } = {},
) {
  return render(
    <ConfirmDialogProvider>
      <ProviderSection
        trpc={trpc}
        navigate={vi.fn()}
        createRequested={opts.createRequested ?? false}
        onCreateConsumed={vi.fn()}
      />
    </ConfirmDialogProvider>,
  )
}

describe('ProviderSection', () => {
  it('shows pending chrome, not “install”, while presence is unanswered', () => {
    presence.value = 'pending'
    renderSection(mockTrpc({}))
    expect(screen.queryByText(/No training provider installed/i)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open the Add dialog until types have answered', async () => {
    render(
      <ConfirmDialogProvider>
        <ProviderSection
          trpc={mockTrpc({ types: 'pending', descriptors: [] })}
          navigate={vi.fn()}
          createRequested={true}
          onCreateConsumed={vi.fn()}
        />
      </ConfirmDialogProvider>,
    )
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('Create token secret eye toggles the typed value (plain PasswordField)', async () => {
    render(
      <ConfirmDialogProvider>
        <ProviderSection
          trpc={mockTrpc({ descriptors: [] })}
          navigate={vi.fn()}
          createRequested={true}
          onCreateConsumed={vi.fn()}
        />
      </ConfirmDialogProvider>,
    )
    // Type in the very first moment the form exists in the DOM — before the
    // passive effects of that commit have run. The form must not be re-seeded
    // blank afterwards.
    const secret = await new Promise<HTMLInputElement>((resolve) => {
      const observer = new MutationObserver(() => {
        const field = document.querySelector<HTMLInputElement>('input[placeholder="as-…"]')
        if (field === null) return
        observer.disconnect()
        fireEvent.change(field, { target: { value: 'as-plain' } })
        resolve(field)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    await act(async () => {})
    expect(secret.value).toBe('as-plain')
    expect((secret as HTMLInputElement).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect((secret as HTMLInputElement).type).toBe('text')
    expect((secret as HTMLInputElement).value).toBe('as-plain')
  })

  it('Edit seeds SecretFieldControl from formValues.tokenSecret keychain view', async () => {
    const withSecret: TrainingProviderDescriptor = {
      ...ENTRY,
      configured: true,
      formValues: {
        ...ENTRY.formValues,
        tokenId: 'ak-set',
        tokenSecret: {
          $secret: 'secret://training-modal/global/entries[entry-1].tokenSecret',
          v: 1,
          set: true,
        },
      },
    }
    renderSection(mockTrpc({ descriptors: [withSecret] }))
    expect(await screen.findByText('Production')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByTestId('provider-entry-editor')
    expect(dialog.querySelector('[data-secret-field="tokenSecret"]')).toBeTruthy()
    expect(within(dialog).getByPlaceholderText('••••••••')).toBeTruthy()
  })

  it('Create shows type fields and Save calls create then update', async () => {
    const updates: Record<string, unknown>[] = []
    const trpc = mockTrpc({
      descriptors: [],
      update: async (input) => {
        updates.push(input)
        return { ok: true as const }
      },
    })
    render(
      <ConfirmDialogProvider>
        <ProviderSection
          trpc={trpc}
          navigate={vi.fn()}
          createRequested={true}
          onCreateConsumed={vi.fn()}
        />
      </ConfirmDialogProvider>,
    )

    const dialog = await screen.findByTestId('provider-entry-editor')
    expect(within(dialog).getByPlaceholderText('ak-…')).toBeTruthy()
    expect(within(dialog).getByPlaceholderText('as-…')).toBeTruthy()
    expect(within(dialog).queryByText(/Entries/i)).toBeNull()
    expect(within(dialog).queryByTestId('settings-form')).toBeNull()

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Staging' } })
    fireEvent.change(within(dialog).getByPlaceholderText('ak-…'), { target: { value: 'ak-test' } })
    fireEvent.change(within(dialog).getByPlaceholderText('as-…'), {
      target: { value: 'as-test' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    // Save chains create -> update; a loaded CI runner took 1.1 s, past
    // waitFor's 1 s default. Bounded, not unbounded.
    await waitFor(
      () => {
        expect(updates).toHaveLength(1)
      },
      { timeout: 5_000 },
    )
    expect(updates[0]).toMatchObject({
      entryId: 'entry-new',
      addonId: 'training-modal',
      name: 'Staging',
      tokenId: 'ak-test',
      tokenSecret: 'as-test',
      gpuType: 'L4',
    })
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull()
      },
      { timeout: 5_000 },
    )
    expect(await screen.findByText('Staging')).toBeTruthy()
  })

  it('lists entries in a DataTable with Edit and Delete', async () => {
    renderSection(mockTrpc({ descriptors: [ENTRY] }))
    expect(await screen.findByText('Production')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete Production' })).toBeTruthy()
  })

  it('Delete calls deleteEntry and removes the row', async () => {
    const deleted: string[] = []
    renderSection(
      mockTrpc({
        descriptors: [ENTRY],
        delete: async (input) => {
          deleted.push(input.entryId)
          return { ok: true as const }
        },
      }),
    )
    expect(await screen.findByText('Production')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Production' }))
    await screen.findByText('Delete provider entry?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleted).toEqual(['entry-1'])
    })
    await waitFor(() => {
      expect(screen.queryByText('Production')).toBeNull()
    })
  })
})
