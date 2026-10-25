import React from 'react'
/** @vitest-environment jsdom */
/**
 * OsdManagerPage — cameras DataTable + ItemFormDialog editor, and the
 * "Duplicate into…" flow.
 *
 * Partial-mock of `@camstack/ui-library`: only the generated tRPC hooks this
 * page and its children call are stubbed; every presentational primitive
 * (Button, Select, Badge, ErrorBox, Dialog, …) keeps its real
 * implementation so the test exercises actual DOM structure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const mockSetSlotBinding = vi.fn().mockResolvedValue({
  slot: { slotId: 'text-1', kind: 'text', readOnly: false, cameraEnabled: true, binding: null },
  render: { slotId: 'text-1', outcome: 'written', text: 'hello' },
})
const mockClearSlotBinding = vi.fn().mockResolvedValue({ success: true })
const mockPreviewSlot = vi.fn().mockResolvedValue({
  slotId: 'text-1',
  outcome: 'written',
  text: 'preview text',
})
const mockRenderDevice = vi.fn()
const mockCopyConfiguration = vi.fn().mockResolvedValue({ copied: 1, skipped: 0 })

const CAMERAS = [
  { id: 1, name: 'Front Door', isCamera: true, disabled: false, online: true },
  { id: 2, name: 'Back Yard', isCamera: true, disabled: false, online: true },
  { id: 3, name: 'Side Camera', isCamera: true, disabled: false, online: true },
  { id: 4, name: 'Not a camera', isCamera: false, disabled: false, online: true },
]

const BINDINGS = [
  { deviceId: 1, entries: [{ capName: 'osd' }, { capName: 'streaming' }] },
  { deviceId: 2, entries: [{ capName: 'osd' }, { capName: 'streaming' }] },
  { deviceId: 3, entries: [{ capName: 'streaming' }] },
]

// deviceId -> slot fixtures. Front Door is fully bound (`enabled`), Back
// Yard has no active binding (`disabled`), Side Camera publishes no `osd`
// cap at all (`unsupported`).
const SLOTS_BY_DEVICE: Record<number, unknown[]> = {
  1: [
    {
      slotId: 'text-1',
      kind: 'text',
      readOnly: false,
      cameraEnabled: true,
      cameraText: 'old text',
      binding: {
        enabled: true,
        source: { kind: 'static', text: 'hi' },
        template: '${value}',
        maxDecimals: 1,
      },
    },
    {
      slotId: 'text-2',
      kind: 'text',
      readOnly: false,
      cameraEnabled: true,
      binding: {
        enabled: true,
        source: { kind: 'none' },
        template: '${value}',
        maxDecimals: 1,
      },
    },
    {
      slotId: 'time-1',
      kind: 'timestamp',
      readOnly: true,
      cameraEnabled: true,
      binding: null,
    },
  ],
  2: [
    {
      slotId: 'text-1',
      kind: 'text',
      readOnly: false,
      cameraEnabled: true,
      binding: null,
    },
  ],
}

const refetchSpies = new Map<number, ReturnType<typeof vi.fn>>()
function refetchFor(deviceId: number) {
  let spy = refetchSpies.get(deviceId)
  if (!spy) {
    spy = vi.fn()
    refetchSpies.set(deviceId, spy)
  }
  return spy
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    PlaceholderChipField: ({
      label,
      value,
      onChange,
      testId,
    }: {
      label: string
      value: string
      onChange: (next: string) => void
      testId: string
    }) =>
      React.createElement(
        'div',
        { 'data-testid': testId },
        React.createElement('label', null, label),
        React.createElement('input', {
          'data-testid': `${testId}-input`,
          value,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
        }),
      ),
    DevicePicker: () => React.createElement('div', { 'data-testid': 'osd-device-picker-stub' }),
    UnitPicker: () => React.createElement('select', { 'aria-label': 'Unit' }),
    useDeviceManagerListAll: () => ({ data: CAMERAS, isLoading: false, error: null }),
    useDeviceManagerGetAllBindings: () => ({ data: BINDINGS, isLoading: false, error: null }),
    useOsdManagerGetDeviceOsd: (input: { deviceId: number }, opts: { enabled: boolean }) => {
      if (!opts.enabled) {
        return {
          data: undefined,
          isLoading: false,
          error: null,
          refetch: refetchFor(input.deviceId),
        }
      }
      return {
        data: { supported: true, slots: SLOTS_BY_DEVICE[input.deviceId] ?? [] },
        isLoading: false,
        error: null,
        refetch: refetchFor(input.deviceId),
      }
    },
    useOsdManagerGetSourceCatalog: (_input: unknown, opts: { enabled: boolean }) => ({
      data: opts.enabled
        ? {
            sources: [
              {
                deviceId: 1,
                deviceName: 'Front Door',
                capName: 'thermometer',
                valuePath: 'value',
                label: 'Thermometer · value',
                valueType: 'number',
              },
            ],
          }
        : undefined,
      isLoading: false,
      error: null,
    }),
    useOsdManagerSetSlotBinding: () => ({
      mutateAsync: mockSetSlotBinding,
      isPending: false,
      error: null,
    }),
    useOsdManagerClearSlotBinding: () => ({
      mutateAsync: mockClearSlotBinding,
      isPending: false,
      error: null,
    }),
    useOsdManagerSetSlotCameraEnabled: () => ({
      mutateAsync: vi.fn().mockResolvedValue({ success: true }),
      isPending: false,
      error: null,
    }),
    useOsdManagerPreviewSlot: () => ({
      mutateAsync: mockPreviewSlot,
      isPending: false,
      error: null,
    }),
    useOsdManagerRenderDevice: () => ({
      mutate: mockRenderDevice,
      isPending: false,
      error: null,
    }),
    useOsdManagerListTemplates: () => ({
      data: { templates: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useOsdManagerUpsertTemplate: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    }),
    useOsdManagerDeleteTemplate: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    }),
    useOsdManagerCopyDeviceConfiguration: () => ({
      mutateAsync: mockCopyConfiguration,
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
    useDeviceStateGetSnapshot: () => ({ data: undefined, isLoading: false, error: null }),
    useDeviceStateGetAllSnapshots: () => ({ data: undefined, isLoading: false, error: null }),
  }
})

import OsdManagerPage from '../page'

const pageProps = {
  trpc: {} as never,
  theme: { isDark: false },
  navigate: vi.fn(),
}

// jsdom does not implement <dialog>.showModal()/close(); stub them so dialogs
// open/close without throwing (mirrors ui-library's own dialog.test.tsx).
beforeEach(() => {
  // useUrlQueryParam reads window.location — clear leftovers from prior tests.
  window.history.replaceState(null, '', window.location.pathname)
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
  mockSetSlotBinding.mockClear()
  mockClearSlotBinding.mockClear()
  mockPreviewSlot.mockClear()
  mockRenderDevice.mockClear()
  mockCopyConfiguration.mockClear()
  refetchSpies.clear()
})

function camerasRoot() {
  return screen.getByTestId('osd-cameras')
}

/** Default Capability filter is OSD-capable only — clear it to see Unsupported rows. */
async function revealAllCameras() {
  await waitFor(() =>
    expect(within(camerasRoot()).queryByRole('button', { name: 'Clear filters' })).toBeTruthy(),
  )
  fireEvent.click(within(camerasRoot()).getByRole('button', { name: 'Clear filters' }))
}

async function openCameraEditor(name: string) {
  fireEvent.click(within(camerasRoot()).getByRole('button', { name: `Edit ${name}` }))
  await waitFor(() => expect(screen.getByTestId('osd-camera-editor')).toBeTruthy())
}

describe('OsdManagerPage — table of cameras', () => {
  it('renders one row per camera, excluding non-cameras', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await revealAllCameras()
    const root = camerasRoot()
    expect(within(root).getByText('Front Door')).toBeTruthy()
    expect(within(root).getByText('Back Yard')).toBeTruthy()
    expect(within(root).getByText('Side Camera')).toBeTruthy()
    expect(within(root).queryByText('Not a camera')).toBeNull()
  })

  it('never shows a raw OSD slot id in a collapsed row', () => {
    render(<OsdManagerPage {...pageProps} />)
    expect(within(camerasRoot()).queryByText('text-1')).toBeNull()
    expect(within(camerasRoot()).queryByText('time-1')).toBeNull()
  })

  it('labels camera-level status as enabled, disabled, or unsupported', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await revealAllCameras()
    const root = camerasRoot()
    const frontRow = within(root).getByText('Front Door').closest('tr')
    const backRow = within(root).getByText('Back Yard').closest('tr')
    const sideRow = within(root).getByText('Side Camera').closest('tr')
    expect(within(frontRow!).getByText('Enabled')).toBeTruthy()
    expect(within(backRow!).getByText('Disabled')).toBeTruthy()
    expect(within(sideRow!).getByText('Unsupported')).toBeTruthy()
  })

  it('shows a resolved source chip, never a raw source id, for an active binding', () => {
    render(<OsdManagerPage {...pageProps} />)
    const frontRow = within(camerasRoot()).getByText('Front Door').closest('tr')
    expect(within(frontRow!).getByText(/Static text/)).toBeTruthy()
  })

  it('shows "no active sources" for an OSD-capable camera with nothing bound', () => {
    render(<OsdManagerPage {...pageProps} />)
    const backRow = within(camerasRoot()).getByText('Back Yard').closest('tr')
    expect(within(backRow!).getByText('No active sources')).toBeTruthy()
  })
})

describe('OsdManagerPage — camera editor modal', () => {
  it('opens a dialog with slot tabs and the active editor', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy())
    expect(screen.queryByTestId('osd-slot-tab-time-1')).toBeNull()
    expect(screen.queryByText('Edit slot “text-1”')).toBeNull()
    expect(screen.getByTestId('osd-slot-current-value')).toBeTruthy()
  })

  it('only one camera editor is open at a time', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Back Yard' }))
    await waitFor(() => {
      const dialog = screen.getByTestId('osd-camera-editor')
      expect(within(dialog).getByText('Back Yard')).toBeTruthy()
    })
    expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy()
  })

  it('closing the dialog hides the editor again', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy())

    fireEvent.click(
      within(screen.getByTestId('osd-camera-editor')).getByRole('button', { name: 'Close' }),
    )
    await waitFor(() => expect(screen.queryByTestId('osd-slot-tab-text-1')).toBeNull())
  })

  it('an unsupported camera opens to a plain explanatory message, with no editor', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await revealAllCameras()
    await openCameraEditor('Side Camera')
    const dialog = await waitFor(() => screen.getByTestId('osd-camera-editor'))
    await waitFor(() =>
      expect(
        within(dialog).getByText('This camera does not expose writable text-overlay slots.'),
      ).toBeTruthy(),
    )
    expect(within(dialog).queryByTestId('osd-slot-tab-text-1')).toBeNull()
    expect(within(dialog).queryByTestId('osd-camera-save')).toBeNull()
  })
})

describe('OsdManagerPage — slot editing inside the modal', () => {
  it('mounts the editor and saves every writable layer from the dialog footer', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-current-value')).toBeTruthy())
    expect(screen.getByTestId('osd-slot-tab-text-1').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: 'Binding' }))
    const textInput = (await screen.findByLabelText('Text')) as HTMLInputElement
    fireEvent.change(textInput, { target: { value: 'Hello operator' } })
    fireEvent.click(screen.getByTestId('osd-camera-save'))

    await waitFor(() => expect(mockSetSlotBinding).toHaveBeenCalled())
    const call = mockSetSlotBinding.mock.calls.find((c) => c[0].slotId === 'text-1')?.[0]
    expect(call).toBeTruthy()
    expect(call!.deviceId).toBe(1)
    expect(call!.binding.source).toEqual({ kind: 'static', text: 'Hello operator' })
    await waitFor(() => expect(screen.queryByTestId('osd-slot-tab-text-1')).toBeNull())
  })

  it('hides read-only layers from the single-camera tab strip', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy())
    expect(screen.queryByTestId('osd-slot-tab-time-1')).toBeNull()
    expect(screen.queryByTestId('osd-slot-readonly')).toBeNull()
    expect(screen.getByTestId('osd-camera-save')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Layer' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Binding' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy()
    expect(screen.queryByText('Save & apply')).toBeNull()
  })

  it('labels each writable slot tab with a short bound/unbound status', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-tab-text-1')).toBeTruthy())
    expect(screen.getByTestId('osd-slot-tab-text-1').textContent).toContain('bound')
  })

  it('puts the Layer/Binding panel in the URL and keeps it across slot changes', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await openCameraEditor('Front Door')
    await waitFor(() => expect(screen.getByTestId('osd-slot-content-tabs')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Clear binding/i })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Binding' }))
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('panel')).toBe('binding'),
    )
    expect(screen.getByLabelText('Source')).toBeTruthy()

    fireEvent.click(screen.getByTestId('osd-slot-tab-text-2'))
    await waitFor(() =>
      expect(screen.getByTestId('osd-slot-tab-text-2').getAttribute('aria-selected')).toBe('true'),
    )
    expect(new URLSearchParams(window.location.search).get('panel')).toBe('binding')
    expect(screen.getByLabelText('Source')).toBeTruthy()
    const source = screen.getByLabelText('Source') as HTMLSelectElement
    expect(source.value).toBe('none')
    expect(screen.getByTestId('osd-source-none-hint')).toBeTruthy()
  })
})

describe('OsdManagerPage — Duplicate into… (table row)', () => {
  function openDuplicateFromRow(name: string) {
    const row = within(camerasRoot()).getByText(name).closest('tr')
    fireEvent.click(within(row!).getByText('Duplicate into…'))
  }

  it('offers every other OSD-capable camera as a destination, excluding the source itself', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await waitFor(() => expect(within(camerasRoot()).getByText('Front Door')).toBeTruthy())
    openDuplicateFromRow('Front Door')
    const select = screen.getByLabelText('Destination camera') as HTMLSelectElement
    const optionLabels = [...select.options].map((o) => o.textContent)
    expect(optionLabels).toContain('Back Yard')
    expect(optionLabels).not.toContain('Front Door')
    expect(optionLabels).not.toContain('Side Camera') // not OSD-capable
  })

  it('copies the source camera into the chosen destination and refreshes it', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await waitFor(() => expect(within(camerasRoot()).getByText('Front Door')).toBeTruthy())
    openDuplicateFromRow('Front Door')
    fireEvent.change(screen.getByLabelText('Destination camera'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() =>
      expect(mockCopyConfiguration).toHaveBeenCalledWith({
        sourceDeviceId: 1,
        targetDeviceId: 2,
      }),
    )
    expect(await screen.findByText('1 slot copied into Back Yard')).toBeTruthy()
    expect(refetchFor(2)).toHaveBeenCalled()
  })

  it('prevents confirming before a destination is chosen', async () => {
    render(<OsdManagerPage {...pageProps} />)
    await waitFor(() => expect(within(camerasRoot()).getByText('Front Door')).toBeTruthy())
    openDuplicateFromRow('Front Door')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Duplicate' }).disabled).toBe(true)
    expect(mockCopyConfiguration).not.toHaveBeenCalled()
  })

  it('surfaces a copy error through the existing error pattern', async () => {
    mockCopyConfiguration.mockRejectedValueOnce(new Error('camera offline'))
    render(<OsdManagerPage {...pageProps} />)
    await waitFor(() => expect(within(camerasRoot()).getByText('Front Door')).toBeTruthy())
    openDuplicateFromRow('Front Door')
    fireEvent.change(screen.getByLabelText('Destination camera'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('camera offline')
  })
})
