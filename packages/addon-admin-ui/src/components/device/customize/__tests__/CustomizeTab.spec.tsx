/**
 * The Customize tab (D676) claims one of five ANSWERED states about the
 * device's customization (D315), removes the ONE block only after a confirm,
 * and sends a composed device to its composition instead.
 *
 * Hooks are stubbed at the ui-library boundary; the i18n is real (English).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

const FEEDER = {
  id: 4127,
  name: 'PetKit Fresh Element 3',
  addonId: 'provider-homeassistant',
  stableId: 'ha:device:petkit-fresh-element-3',
  type: 'pet-feeder',
  role: null,
  display: undefined,
  integrationId: 'int_ha',
}
const CAMERA = {
  ...FEEDER,
  id: 103,
  name: 'Camera porch',
  addonId: 'provider-reolink',
  stableId: 'r-103',
  type: 'camera',
  isCamera: true,
}
const COMPOSED = {
  ...FEEDER,
  id: 4603,
  name: 'Porch (composto)',
  addonId: 'composer',
  stableId: 'composed-blk-porch',
  type: 'sensor',
}

interface Query {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: unknown
  readonly error?: { readonly message: string } | null
  readonly refetch: () => Promise<unknown>
}
const device = vi.hoisted((): { current: Record<string, unknown> | null } => ({ current: null }))
const customization = vi.hoisted((): { current: Query } => ({
  current: { status: 'pending', refetch: async () => undefined },
}))
/** The camera-sensors read: unanswered unless a test says otherwise. */
const cameraStatus = vi.hoisted(
  (): { current: { readonly status: Query['status']; readonly data?: unknown } } => ({
    current: { status: 'pending' },
  }),
)
/** The device's bindings: unanswered unless a test says otherwise. */
const bindings = vi.hoisted(
  (): {
    current: {
      readonly status: Query['status']
      readonly data?: unknown
      readonly error?: Query['error']
    }
  } => ({
    current: { status: 'pending' },
  }),
)
/** The composable caps for the device type: unanswered unless a test says otherwise. */
const composable = vi.hoisted(
  (): {
    current: {
      readonly status: Query['status']
      readonly data?: unknown
      readonly error?: Query['error']
    }
  } => ({
    current: { status: 'pending' },
  }),
)
/** The fleet read (`listAll`): unanswered unless a test says otherwise. */
const fleet = vi.hoisted(
  (): {
    current: {
      readonly status: Query['status']
      readonly data?: unknown
      readonly error?: Query['error']
    }
  } => ({ current: { status: 'pending' } }),
)
const composerPresence = vi.hoisted((): { current: string } => ({ current: 'present' }))
/** How the device read answered; `data` is `device.current` unless pending/error. */
const deviceRead = vi.hoisted(
  (): { current: { readonly status: Query['status']; readonly error?: Query['error'] } } => ({
    current: { status: 'success' },
  }),
)
const integrations = vi.hoisted(
  (): { current: readonly { id: string; addonId: string; name: string }[] | undefined } => ({
    current: undefined,
  }),
)
const deleteMutate = vi.fn(async (_input: { readonly blockId: string }) => ({ success: true }))
const confirmMock = vi.fn(async () => true)
const compositionRead = vi.hoisted((): { current: Query } => ({
  current: { status: 'pending', refetch: async () => undefined },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const mutation = (mutateAsync: (input: never) => Promise<unknown>) => () => ({
    mutateAsync,
    isPending: false,
  })
  return {
    ...actual,
    useDeviceManagerGetDevice: () => ({
      status: deviceRead.current.status,
      data: deviceRead.current.status === 'success' ? device.current : undefined,
      error: deviceRead.current.error ?? null,
      refetch: async () => undefined,
    }),
    useIntegrationsList: () => ({ data: integrations.current }),
    useCoreBlocksGetCustomization: () => customization.current,
    useCoreBlocksGetComposition: () => compositionRead.current,
    useCoreBlocksCreateComposition: mutation(vi.fn(async () => ({}))),
    useCoreBlocksUpdateComposition: mutation(vi.fn(async () => ({}))),
    useCoreBlocksDelete: mutation(deleteMutate),
    useCapabilityPresence: () => composerPresence.current,
    useConfirm: () => confirmMock,
    // The Identity section (Task 8) writes the existing authorities; not under test here.
    useDeviceManagerSetRole: () => ({ mutate: vi.fn(), isPending: false }),
    useDeviceManagerSetDisplay: () => ({ mutate: vi.fn(), isPending: false }),
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerListLocations: () => ({ data: [] }),
    useDeviceManagerGetRoleDisplayDefaults: () => ({ data: { defaults: {} } }),
    useDeviceManagerSetRoleDisplayDefaults: () => ({ mutate: vi.fn(), isPending: false }),
    // The Presets section (Task 13) reads these facts; unanswered here, so it only says "Checking…".
    useCoreBlocksListComposableCaps: () => composable.current,
    useDeviceManagerGetBindings: () => bindings.current,
    useDeviceManagerGetWireableFields: () => ({ status: 'pending', data: undefined }),
    useDeviceStateGetSnapshot: () => ({ status: 'pending', data: undefined }),
    // The Advanced editor (Task 19) validates the draft on the server; not under test here.
    useCoreBlocksValidateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerListAll: () => fleet.current,
    // The assignment cards' capability index (one query per source cap); unanswered here.
    trpc: { ...actual.trpc, useQueries: () => [] },
    // The cards' live values (the native battery row); unanswered here.
    useSystem: () => ({ trpcClient: null }),
    useDeviceStateGetCapSlice: () => ({ status: 'pending', data: undefined, error: null }),
    useDeviceCapSlice: () => undefined,
    // The linked-devices table calls its hooks on every device (gated by `enabled`); unanswered here.
    useDeviceExtensionListSlots: () => ({
      status: 'pending',
      data: undefined,
      error: null,
      refetch: async () => undefined,
    }),
    useDeviceExtensionListCandidates: () => ({ status: 'pending', data: undefined, error: null }),
    useDeviceExtensionSetSlot: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // The camera's Linked actions card; its own spec covers it.
    useActionsList: () => ({ data: undefined }),
    useActionsGetLinks: () => ({ data: undefined }),
    useActionsSetLinks: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useActionsRun: () => ({ mutate: vi.fn(), isPending: false }),
    // The Motion card (Task 15) writes the camera-sensors setting; not under test here.
    usePipelineOrchestratorSetCameraSensors: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePipelineOrchestratorApplyDeviceSettingsPatch: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useAddonSettingsGetDeviceSettings: () => ({ status: 'pending', data: undefined }),
    usePipelineOrchestratorGetCameraStatus: () => ({
      status: cameraStatus.current.status,
      data: cameraStatus.current.data,
      refetch: async () => undefined,
    }),
  }
})

const { CustomizeTab } = await import('../CustomizeTab')

/** jsdom implements neither `<dialog>.showModal()` nor `.close()`. */
function stubDialog(): void {
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

function renderTab(): void {
  stubDialog()
  const id = device.current?.['id']
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
  render(wrap(<CustomizeTab deviceId={typeof id === 'number' ? id : 0} />))
}

function loadedRead(
  target: { addonId: string; stableId: string },
  features: readonly object[],
): unknown {
  return {
    state: 'loaded',
    view: {
      block: {
        id: 'blk-feeder',
        name: 'customize:x',
        code: '',
        enabled: true,
        placement: 'hub',
        createdAt: 1,
        updatedAt: 7,
        createdBy: 'admin',
        status: 'running',
        lastChangedAt: 1,
        source: {
          kind: 'composition',
          composition: { target: { kind: 'existing', device: target }, features },
        },
      },
      state: { kind: 'answered', state: null },
    },
  }
}

const PRESENT: Query = {
  status: 'success',
  data: loadedRead({ addonId: FEEDER.addonId, stableId: FEEDER.stableId }, [
    {
      kind: 'fields',
      cap: 'battery',
      fields: { percentage: { kind: 'expression', expr: 'null', bindings: {} } },
    },
  ]),
  refetch: vi.fn(async () => undefined),
}

beforeEach(() => {
  device.current = FEEDER
  deviceRead.current = { status: 'success' }
  integrations.current = undefined
  customization.current = { status: 'pending', refetch: vi.fn(async () => undefined) }
  composerPresence.current = 'present'
  cameraStatus.current = { status: 'pending' }
  bindings.current = { status: 'pending' }
  composable.current = { status: 'pending' }
  fleet.current = { status: 'pending' }
  deleteMutate.mockClear()
  confirmMock.mockClear()
})

const REMAINING = {
  kind: 'from' as const,
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.filter' },
  cap: 'numeric-sensor',
  fieldPath: 'value',
}

function batteryFeature(): object {
  return { kind: 'fields', cap: 'battery', fields: { percentage: REMAINING } }
}

function consumablesFeature(): object {
  return {
    kind: 'fields',
    cap: 'consumables',
    fields: {},
    items: { essiccante: { label: 'Essiccante', fields: { level: REMAINING } } },
  }
}

describe('CustomizeTab — what it may claim (D315)', () => {
  it('pending never says "not customized"', () => {
    renderTab()
    expect(screen.getByText("Reading this device's customization…")).toBeTruthy()
    expect(screen.queryByText(/not customized/i)).toBeNull()
  })
  it('a failed read shows its reason, never "not customized"', () => {
    customization.current = {
      status: 'error',
      error: { message: 'FORBIDDEN' },
      refetch: vi.fn(async () => undefined),
    }
    renderTab()
    expect(screen.getByText(/FORBIDDEN/)).toBeTruthy()
    expect(screen.queryByText(/not customized/i)).toBeNull()
  })
  it('a table that has not loaded says so', () => {
    customization.current = {
      status: 'success',
      data: { state: 'not-loaded', reason: 'core_blocks has not loaded yet' },
      refetch: vi.fn(async () => undefined),
    }
    renderTab()
    expect(screen.getByText(/core_blocks has not loaded yet/)).toBeTruthy()
    expect(screen.queryByText(/not customized/i)).toBeNull()
  })
  it('an answered absence is not a status line, and offers no removal', () => {
    customization.current = {
      status: 'success',
      data: { state: 'loaded', view: null },
      refetch: vi.fn(async () => undefined),
    }
    renderTab()
    expect(screen.queryByText(/not customized/i)).toBeNull()
    expect(screen.queryByText(/Reading this device's customization/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove customization' })).toBeNull()
  })
  it('a present customization shows its block status', () => {
    customization.current = PRESENT
    renderTab()
    expect(screen.getByText('Customization active')).toBeTruthy()
  })
  it('an absent composer is said, not hidden; an unanswered one says nothing', () => {
    composerPresence.current = 'absent'
    renderTab()
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/composer is not running/)
    composerPresence.current = 'pending'
    renderTab()
    expect(screen.getAllByRole('alert').length).toBe(1)
  })
})

describe('CustomizeTab — the device read (D315)', () => {
  it('a pending read is loading', () => {
    deviceRead.current = { status: 'pending' }
    renderTab()
    expect(screen.getByText('Loading the device…')).toBeTruthy()
  })
  it('a failed read shows its reason, never "loading" forever', () => {
    deviceRead.current = { status: 'error', error: { message: 'UNAUTHORIZED' } }
    renderTab()
    expect(screen.getByText('The device could not be read')).toBeTruthy()
    expect(screen.getByText(/UNAUTHORIZED/)).toBeTruthy()
    expect(screen.queryByText('Loading the device…')).toBeNull()
  })
  it('an answered null says there is no such device', () => {
    device.current = null
    renderTab()
    expect(screen.getByText('No device 0 exists.')).toBeTruthy()
    expect(screen.queryByText('Loading the device…')).toBeNull()
  })
})

describe('CustomizeTab — layout (spec §5)', () => {
  const NONE: Query = {
    status: 'success',
    data: { state: 'loaded', view: null },
    refetch: vi.fn(async () => undefined),
  }
  const top = (el: HTMLElement): number => {
    const all = [...document.body.querySelectorAll('*')]
    return all.indexOf(el)
  }
  it('an uncustomized device has no status line and no "every field comes from" sentence', () => {
    customization.current = NONE
    renderTab()
    expect(screen.queryByText(/every field comes from/i)).toBeNull()
    expect(screen.queryByText(/not customized/i)).toBeNull()
    expect(screen.queryByText(/Loading integration/)).toBeNull()
  })
  it('there is no presets section and no explanatory remove hint', () => {
    customization.current = PRESENT
    renderTab()
    expect(screen.queryByRole('heading', { name: /presets/i })).toBeNull()
    expect(screen.queryByText(/Quick presets/i)).toBeNull()
    expect(screen.queryByText(/restores the device exactly/i)).toBeNull()
  })
  it('the order is identity, status, then cards — no footer Advanced link', () => {
    customization.current = PRESENT
    renderTab()
    const identity = screen.getAllByText('Room')[0] as HTMLElement
    const status = screen.getByText('Customization active')
    const battery = screen.getByRole('heading', { name: 'Battery' })
    const order = [identity, status, battery].map(top)
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(screen.queryByRole('heading', { name: 'What changes on the device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove customization' })).toBeNull()
    expect(screen.queryByTestId('customize-advanced')).toBeNull()
  })
  it('a stored battery stays off the tab when it is not offered; a stored consumable array stays so it can be removed', () => {
    composable.current = { status: 'success', data: { caps: [] } }
    bindings.current = { status: 'success', data: { entries: [] } }
    customization.current = {
      ...PRESENT,
      data: loadedRead({ addonId: FEEDER.addonId, stableId: FEEDER.stableId }, [
        batteryFeature(),
        consumablesFeature(),
      ]),
    }
    renderTab()
    expect(screen.queryByRole('heading', { name: 'Battery' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Consumables' })).toBeTruthy()
    expect(screen.queryByText('battery.percentage')).toBeNull()
  })
  it('pending or failed facts speak no preset sentence — the presets are gone (task 7 L5, task 15 L2)', () => {
    customization.current = PRESENT
    renderTab()
    expect(document.body.textContent ?? '').not.toMatch(/presets|could not be checked: /i)
    bindings.current = { status: 'error', error: { message: 'bindings down' } }
    composable.current = { status: 'error', error: { message: 'caps down' } }
    renderTab()
    expect(document.body.textContent ?? '').not.toMatch(/presets/i)
  })
  const hand = { kind: 'expression' as const, expr: '0', bindings: {} }
  const ANOTHER_FORMULA = [
    {
      heading: 'Doorbell',
      cap: 'doorbell',
      feature: (): object => ({
        kind: 'fields',
        cap: 'doorbell',
        enabled: true,
        fields: { pressCountSinceStart: hand },
      }),
    },
    {
      heading: 'Battery',
      cap: 'battery',
      feature: (): object => ({ kind: 'fields', cap: 'battery', fields: { percentage: hand } }),
    },
    {
      heading: 'Consumables',
      cap: 'consumables',
      feature: (): object => ({
        kind: 'fields',
        cap: 'consumables',
        fields: {},
        items: { filtro: { label: 'Filtro', fields: { status: hand } } },
      }),
    },
  ] as const
  it.each(
    ANOTHER_FORMULA,
  )("the $heading card's another-formula row opens the formula dialog and leaves the card", ({
    heading,
    cap,
    feature,
  }) => {
    const host = cap === 'doorbell' ? CAMERA : FEEDER
    device.current = host
    composable.current = { status: 'success', data: { caps: [{ cap }] } }
    bindings.current = { status: 'success', data: { entries: [] } }
    customization.current = {
      ...PRESENT,
      data: loadedRead({ addonId: host.addonId, stableId: host.stableId }, [feature()]),
    }
    renderTab()
    const card = screen.getByRole('heading', { name: heading }).closest('section')
    if (card === null) throw new Error('no card section')
    fireEvent.click(within(card).getByRole('button', { name: /^Formula$/ }))
    expect(screen.getByTestId('formula-dialog')).toBeTruthy()
    expect(screen.queryByText('1 · Target')).toBeNull()
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
  })
})

describe('CustomizeTab — removal', () => {
  it('removing the last card entry deletes the ONE block after confirm', async () => {
    composable.current = { status: 'success', data: { caps: [{ cap: 'battery' }] } }
    bindings.current = { status: 'success', data: { entries: [] } }
    customization.current = {
      ...PRESENT,
      data: loadedRead({ addonId: FEEDER.addonId, stableId: FEEDER.stableId }, [batteryFeature()]),
    }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ blockId: 'blk-feeder' }))
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })
  it('a declined confirm deletes nothing', async () => {
    composable.current = { status: 'success', data: { caps: [{ cap: 'battery' }] } }
    bindings.current = { status: 'success', data: { entries: [] } }
    customization.current = {
      ...PRESENT,
      data: loadedRead({ addonId: FEEDER.addonId, stableId: FEEDER.stableId }, [batteryFeature()]),
    }
    confirmMock.mockResolvedValueOnce(false)
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(deleteMutate).not.toHaveBeenCalled()
  })
  it('there is no Remove customization button on the tab', () => {
    customization.current = PRESENT
    renderTab()
    expect(screen.queryByRole('button', { name: 'Remove customization' })).toBeNull()
  })
})

describe('CustomizeTab — a composed device', () => {
  it('is edited on this tab with the card editor', () => {
    device.current = COMPOSED
    compositionRead.current = {
      status: 'success',
      data: {
        state: 'loaded',
        view: {
          block: {
            id: 'blk-porch',
            name: 'Porch',
            code: '',
            enabled: true,
            placement: 'hub',
            createdAt: 1,
            updatedAt: 1,
            createdBy: 'admin',
            status: 'running',
            lastChangedAt: 1,
            source: {
              kind: 'composition',
              composition: {
                target: { kind: 'new', type: 'sensor', role: 'temperature-sensor' },
                features: [
                  {
                    kind: 'fields',
                    cap: 'temperature-sensor',
                    fields: {
                      celsius: { kind: 'expression', expr: 'null', bindings: {} },
                    },
                  },
                ],
              },
            },
          },
          state: { kind: 'answered', state: { deviceId: 4603 } },
        },
      },
      refetch: vi.fn(async () => undefined),
    }
    renderTab()
    expect(screen.queryByRole('link', { name: 'Edit its composition' })).toBeNull()
    expect(screen.getByTestId('fields-card-temperature-sensor')).toBeTruthy()
  })
})

const SENSOR = {
  ...FEEDER,
  id: 510,
  name: 'Filter life',
  addonId: 'provider-homeassistant',
  stableId: 'appliance-510',
  type: 'sensor',
}

describe('CustomizeTab — battery on a sensor (D944)', () => {
  const loadedNone: Query = {
    status: 'success',
    data: { state: 'loaded', view: null },
    refetch: vi.fn(async () => undefined),
  }
  const numericOnly = {
    status: 'success' as const,
    data: {
      entries: [{ capName: 'numeric-sensor', nativeAddonId: 'provider-homeassistant' }],
    },
  }
  function renderSensor(): void {
    device.current = SENSOR
    composable.current = { status: 'success', data: { caps: [{ cap: 'battery' }] } }
    customization.current = loadedNone
    renderTab()
  }
  it('offers the Battery add card when native caps are known and lack battery', () => {
    bindings.current = numericOnly
    renderSensor()
    expect(screen.getByRole('heading', { name: 'Battery' })).toBeTruthy()
    expect(screen.getByTestId('scalar-add-battery')).toBeTruthy()
  })
  it('hides the Battery card when the sensor already serves battery natively', () => {
    bindings.current = {
      status: 'success',
      data: {
        entries: [
          { capName: 'numeric-sensor', nativeAddonId: 'provider-homeassistant' },
          { capName: 'battery', nativeAddonId: 'provider-homeassistant' },
        ],
      },
    }
    renderSensor()
    expect(screen.queryByRole('heading', { name: 'Battery' })).toBeNull()
    expect(screen.queryByTestId('scalar-add-battery')).toBeNull()
  })
})

describe('CustomizeTab — the Motion card (spec U8, D676)', () => {
  const motion = (): HTMLElement | null => screen.queryByRole('heading', { name: 'Motion' })
  it('a camera whose sensor read answered is offered the Motion card', () => {
    device.current = CAMERA
    cameraStatus.current = {
      status: 'success',
      data: { cameraSensors: { state: 'not-configured' } },
    }
    renderTab()
    expect(motion()).not.toBeNull()
  })
  it('a device that is not a camera has none', () => {
    cameraStatus.current = {
      status: 'success',
      data: { cameraSensors: { state: 'not-configured' } },
    }
    renderTab()
    expect(motion()).toBeNull()
  })
  it('a camera whose orchestrator answered without the sensors key has none, not a disabled one', () => {
    device.current = CAMERA
    cameraStatus.current = { status: 'success', data: {} }
    renderTab()
    expect(motion()).toBeNull()
  })
})
