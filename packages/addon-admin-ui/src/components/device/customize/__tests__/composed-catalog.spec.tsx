/**
 * The general check for composed devices (D1004): for EVERY Customize target in
 * the catalog, a composed device of a compatible type exposes it — free or
 * helper. Driven by the catalog, so a new target is covered without a new
 * assertion, and a helper kind that hides the lists (an early return in
 * ComposedCustomizeBody) fails here.
 *
 * Two kinds of target are structurally not offered to a composed device and are
 * listed by name: a camera-sensors span (a composed device has no camera
 * bridge) and a `replace` (it rewrites a field of the device's OWN native cap).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCatalogTarget,
  type DeviceInfo,
} from '@camstack/types'
import '../../../../i18n'

interface Read {
  readonly status: 'pending' | 'success'
  readonly data?: unknown
}
const composable = vi.hoisted((): { current: Read } => ({ current: { status: 'pending' } }))
const compositionRead = vi.hoisted((): { current: Read & { refetch: () => Promise<unknown> } } => ({
  current: { status: 'pending', refetch: async () => undefined },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false })
  const pending = { status: 'pending', data: undefined, error: null }
  return {
    ...actual,
    useCoreBlocksGetComposition: () => compositionRead.current,
    useCoreBlocksUpdateComposition: mutation,
    useCoreBlocksListComposableCaps: () => composable.current,
    useDeviceManagerGetBindings: () => ({ status: 'success', data: { entries: [] } }),
    useDeviceManagerGetWireableFields: () => pending,
    useDeviceManagerListAll: () => ({ status: 'success', data: [] }),
    useDeviceManagerSetRole: () => ({ mutate: vi.fn(), isPending: false }),
    useDeviceManagerSetDisplay: () => ({ mutate: vi.fn(), isPending: false }),
    useDeviceManagerSetName: mutation,
    useDeviceManagerSetLocation: mutation,
    useDeviceManagerListLocations: () => ({ data: [] }),
    useDeviceManagerGetRoleDisplayDefaults: () => ({ data: { defaults: {} } }),
    useDeviceManagerSetRoleDisplayDefaults: () => ({ mutate: vi.fn(), isPending: false }),
    useDeviceStateGetSnapshot: () => pending,
    useDeviceStateGetCapSlice: () => pending,
    useDeviceCapSlice: () => undefined,
    useCapabilityPresence: () => 'present',
    useCoreBlocksValidateComposition: mutation,
    useIntegrationsList: () => ({ data: undefined }),
    useSystem: () => ({ trpcClient: null }),
    trpc: { ...actual.trpc, useQueries: () => [] },
    useConfirm: () => vi.fn(async () => true),
    useDeviceExtensionListSlots: () => ({ ...pending, refetch: async () => undefined }),
    useDeviceExtensionListCandidates: () => pending,
    useDeviceExtensionSetSlot: mutation,
    useActionsList: () => ({ data: undefined }),
    useActionsGetLinks: () => ({ data: undefined }),
    useActionsSetLinks: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useActionsRun: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorSetCameraSensors: mutation,
    usePipelineOrchestratorApplyDeviceSettingsPatch: mutation,
    useAddonSettingsGetDeviceSettings: () => pending,
    usePipelineOrchestratorGetCameraStatus: () => ({ ...pending, refetch: async () => undefined }),
  }
})
// The two config cards talk to tRPC; this spec asks only whether they are offered.
vi.mock('../../../remote/RemoteExtensionCard', () => ({
  RemoteExtensionCard: () => <div data-testid="config-card-remote" />,
}))
vi.mock('../../../fan-presets/FanPresetsExtensionCard', () => ({
  FanPresetsExtensionCard: () => <div data-testid="config-card-fan-presets" />,
}))

const { ComposedCustomizeBody } = await import('../ComposedCustomizeBody')

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

interface Row {
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}
const rows: readonly Row[] = Object.entries(CAP_CUSTOMIZE_CATALOG).flatMap(([cap, entry]) =>
  entry.targets.map((target) => ({ cap, target })),
)
const notOffered = (r: Row): boolean =>
  r.target.applyAuthority?.kind === 'camera-sensors' || r.target.apply === 'replace'
const offered = rows.filter((r) => !notOffered(r))

/** An extension is listed in the table; every other target is attached from the picker. */
function isExposed(r: Row): boolean {
  const key = `${r.cap}.${r.target.id}`
  if (r.target.cardinality === 'config') {
    return screen.queryByTestId(`customize-manage-${key}`) !== null
  }
  const trigger = screen.queryByTestId('customize-table-add')
  if (trigger === null) return false
  fireEvent.click(trigger)
  return screen.queryByTestId(`customize-table-add-${key}`) !== null
}

function deviceOf(r: Row): DeviceInfo {
  const type = r.target.deviceTypes?.[0] ?? 'sensor'
  // Only the fields the tab reads; the rest of DeviceInfo is not its business.
  const device: unknown = {
    id: 9001,
    name: 'Built device',
    addonId: 'composer',
    stableId: 'composed-blk-x',
    type,
    role: null,
    display: undefined,
    integrationId: 'int_x',
  }
  return device as DeviceInfo
}

function readOf(type: string, helper: boolean): Read & { refetch: () => Promise<unknown> } {
  const source = { addonId: 'provider-x', stableId: 'x:1' }
  const composition = {
    target: { kind: 'new', type },
    features: [],
    ...(helper
      ? {
          helper: {
            kind: 'statistic',
            stat: 'max',
            window: { kind: 'rolling', span: '24h' },
            source: { source, cap: 'temperature-sensor', fieldPath: 'celsius' },
          },
        }
      : {}),
  }
  return {
    status: 'success',
    refetch: async () => undefined,
    data: {
      state: 'loaded',
      view: {
        block: {
          id: 'blk-x',
          name: 'Built device',
          code: '',
          enabled: true,
          placement: 'hub',
          createdAt: 1,
          updatedAt: 1,
          createdBy: 'admin',
          status: 'running',
          lastChangedAt: 1,
          source: { kind: 'composition', composition },
        },
        state: { kind: 'answered', state: { deviceId: 9001 } },
      },
    },
  }
}

function mount(r: Row, helper: boolean): void {
  stubDialog()
  const device = deviceOf(r)
  composable.current = { status: 'success', data: { caps: [{ cap: r.cap }] } }
  compositionRead.current = readOf(device.type, helper)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ComposedCustomizeBody device={device} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  composable.current = { status: 'pending' }
})

describe('every Customize target reaches a composed device (D1004)', () => {
  it('the catalog is non-empty and only the two named kinds are not offered', () => {
    expect(offered.length).toBeGreaterThan(8)
    expect(rows.filter(notOffered).map((r) => `${r.cap}.${r.target.id}`)).toEqual([
      'lock-control.door-contact',
      'motion.detected',
    ])
  })
  for (const helper of [false, true]) {
    describe(helper ? 'a helper device' : 'a free composed device', () => {
      for (const r of offered) {
        it(`${r.cap}.${r.target.id} (${r.target.cardinality}) is exposed`, () => {
          mount(r, helper)
          expect(isExposed(r)).toBe(true)
        })
      }
    })
  }
})
