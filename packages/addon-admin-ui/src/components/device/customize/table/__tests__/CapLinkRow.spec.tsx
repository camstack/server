/**
 * The cells of a whole-capability link row (D1076, D1098 2b): the active Switch
 * and the confirmed Remove edit the draft through `handle.save`, the pick is the
 * `SourceSelector` device dialog; nothing is written here.
 */
import type { Composition, CustomizeCapLink } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

const confirm = vi.hoisted(() => vi.fn(async (_options: unknown) => true))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => confirm,
    useCoreBlocksGetCapLinks: () => ({ status: 'pending', data: undefined, error: null }),
    useDeviceManagerListAll: () => ({
      status: 'success',
      data: [
        {
          id: 77,
          name: 'Plug',
          addonId: 'ha',
          stableId: 'plug',
          type: 'switch',
          location: null,
          isCamera: false,
        },
      ],
    }),
    useIntegrationsList: () => ({ data: undefined }),
    trpc: {
      ...actual.trpc,
      useQueries: () => [{ status: 'success', data: [77], error: null }],
    },
  }
})

// The picker reads the fleet and is covered by its own spec; here a pick is a click.
vi.mock('../../source-selector/SourceSelectorDevicesDialog', () => ({
  SourceSelectorDevicesDialog: (props: {
    readonly open: boolean
    readonly selection: string
    readonly candidates: {
      readonly kind: string
      readonly value?: readonly { readonly name: string }[]
    }
    readonly onConfirm: (picked: readonly unknown[]) => void
  }) =>
    props.open ? (
      <button
        type="button"
        data-selection={props.selection}
        onClick={() =>
          props.onConfirm(props.candidates.kind === 'known' ? (props.candidates.value ?? []) : [])
        }
      >
        pick-first
      </button>
    ) : null,
}))

const { CapLinkActionsCell, CapLinkDialog, CapLinkSourceCell } = await import('../CapLinkRow')

const HOST = { addonId: 'ha', stableId: 'dryer' }
const LINK: CustomizeCapLink = {
  id: 'meter-device',
  sourceCap: 'power-meter',
  mode: 'project',
  apply: 'add',
  deviceTypes: [DeviceType.Switch],
}
const OFFERED = { cap: 'power-meter', link: LINK }
const STORED: Composition = {
  target: { kind: 'existing', device: HOST },
  features: [
    {
      kind: 'capLink',
      cap: 'power-meter',
      linkId: 'meter-device',
      source: { addonId: 'ha', stableId: 'plug' },
    },
  ],
}

function handleOf(composition: Composition | null) {
  return {
    target: HOST,
    state:
      composition === null
        ? ({ kind: 'none' } as const)
        : ({ kind: 'present', composition, view: {} } as never),
    saving: false,
    save: vi.fn(async (_next: Composition | null) => ({ kind: 'saved' as const })),
  }
}

function wrap(node: React.ReactNode): React.ReactNode {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

beforeEach(() => confirm.mockClear())

describe('a capability link row', () => {
  it('shows the linked device by name, and "Not linked" when nothing is stored', () => {
    const linked = handleOf(STORED)
    const view = render(
      wrap(<CapLinkSourceCell device={{ id: 5 }} handle={linked} offered={OFFERED} />),
    )
    expect(screen.getByText('Plug')).toBeTruthy()
    view.unmount()
    render(wrap(<CapLinkSourceCell device={{ id: 5 }} handle={handleOf(null)} offered={OFFERED} />))
    expect(screen.getByText('Not linked')).toBeTruthy()
  })

  it('the Switch turns the link off in the draft and keeps its source', () => {
    const handle = handleOf(STORED)
    render(
      wrap(
        <CapLinkActionsCell
          device={{ id: 5 }}
          handle={handle}
          offered={OFFERED}
          title="Source device"
          onEdit={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    )
    fireEvent.click(screen.getByTestId('cap-link-power-meter-meter-device-active'))
    expect(handle.save).toHaveBeenCalledTimes(1)
    const next = handle.save.mock.calls[0]?.[0]
    expect(next?.features).toEqual([{ ...STORED.features[0], enabled: false }])
  })

  it('Remove asks first and drops the link only once confirmed; declined removes nothing', async () => {
    const handle = handleOf(STORED)
    const props = {
      device: { id: 5 },
      handle,
      offered: OFFERED,
      title: 'Source device',
      onEdit: vi.fn(),
      onError: vi.fn(),
    }
    render(wrap(<CapLinkActionsCell {...props} />))
    confirm.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByTestId('cap-link-power-meter-meter-device-remove'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(handle.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('cap-link-power-meter-meter-device-remove'))
    await waitFor(() => expect(handle.save).toHaveBeenCalledWith(null))
  })

  it('a pick in the SourceSelector dialog sets the link as a draft', async () => {
    const handle = handleOf(null)
    render(
      wrap(
        <CapLinkDialog
          device={{ id: 5 }}
          handle={handle}
          offered={OFFERED}
          open
          onClose={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    )
    const pick = await screen.findByRole('button', { name: 'pick-first' })
    // One device: the cap's source, never a list.
    expect(pick.getAttribute('data-selection')).toBe('single')
    fireEvent.click(pick)
    await waitFor(() => expect(handle.save).toHaveBeenCalledTimes(1))
    expect(handle.save.mock.calls[0]?.[0]?.features).toEqual([
      {
        kind: 'capLink',
        cap: 'power-meter',
        linkId: 'meter-device',
        source: { addonId: 'ha', stableId: 'plug' },
      },
    ])
  })
})
