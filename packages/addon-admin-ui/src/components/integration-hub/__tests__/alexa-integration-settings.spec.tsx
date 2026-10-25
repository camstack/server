/**
 * The Alexa export's REAL settings schema, through the REAL integration-page
 * tree (`AddonIntegrationBody` → `NodeAddonsSettingsPanel` → `FormBuilder`),
 * beside the Addons page's mount of the same panel.
 *
 * Operator report (Connectivity → Device export → Alexa): no Re-sync button,
 * and an EMPTY section right before Activity. Both were one bug: a panel with
 * no tab scope stripped every section title (`undefined !== null`), so the
 * collapsed Troubleshooting accordion lost the header that opens it and drew
 * as an empty frame with its three action buttons sealed inside.
 *
 * Only the tRPC transport and the activity streams are stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateSchema, type ConfigUISchemaWithValues } from '@camstack/types'
// A spec may mount a sibling's real code: the point is THIS addon's schema.
import { buildAlexaSettingsSections } from '../../../../../addon-export-alexa/src/settings-schema'

const ALEXA_DEFAULTS = {
  skillMode: 'public',
  region: 'EU',
  expectedAudience: '',
  publicHubUrl: '',
  detectionSensors: true,
  objectDetection: true,
  snapshots: true,
  enforceIngressToken: false,
} as const

function alexaForm(stored: Record<string, unknown>): ConfigUISchemaWithValues {
  return hydrateSchema(
    {
      sections: buildAlexaSettingsSections({
        linkedAccounts: [],
        tokens: [],
        now: 0,
        defaults: ALEXA_DEFAULTS,
      }),
    },
    stored,
  )
}

let served: ConfigUISchemaWithValues = alexaForm({})
const getGlobalSettings = vi.fn(async () => served)
const customMutate = vi.fn(async (_input: unknown) => ({
  endpointCount: 3,
  deviceCount: 2,
  accountCount: 1,
  removedEndpointCount: 0,
  retainedEndpointCount: 0,
  failedCount: 0,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noopMutation = () => ({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: { getGlobalSettings: { query: getGlobalSettings } },
        addons: { custom: { mutate: customMutate } },
      },
    }),
    useAddonsList: () => ({
      data: [{ manifest: { id: 'export-alexa', name: 'Alexa' } }],
    }),
    useAddonSettingsUpdateGlobalSettings: noopMutation,
    useAddonSettingsUpdateDeviceSettings: noopMutation,
    useDecoderReprobeHwaccel: noopMutation,
    useAudioAnalyzerReprobeAudioEngine: noopMutation,
    useAddonsRestartAddon: noopMutation,
    useAddonsSetCapabilityProviderEnabled: noopMutation,
    LogStream: () => <div>logs</div>,
    EventStream: () => <div>events</div>,
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { NodeAddonsSettingsPanel } from '../../settings/NodeAddonsSettingsPanel'
import { AddonIntegrationBody } from '../AddonIntegrationBody'

function renderTree(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConfirmDialogProvider>{node}</ConfirmDialogProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const SURFACES: ReadonlyArray<{
  readonly name: string
  readonly node: () => ReactNode
}> = [
  {
    name: 'Connectivity → Device export → Alexa',
    node: () => (
      <AddonIntegrationBody
        addonId="export-alexa"
        displayName="Alexa"
        capName="device-export"
        isActive
      />
    ),
  },
  {
    // The Addons page's mount (AddonCard): unchanged behaviour.
    name: 'Addons page',
    node: () => (
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={['export-alexa']}
        level="global"
        fieldScope="cluster"
      />
    ),
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  served = alexaForm({})
})

describe.each(SURFACES)('the Alexa settings on $name', ({ node }) => {
  it('draws every section with its heading', async () => {
    renderTree(node())
    for (const title of ['Connection', 'Features', 'Account link', 'Troubleshooting']) {
      expect(await screen.findByText(title)).toBeTruthy()
    }
  })

  it('opens Troubleshooting and the Re-sync button invokes resyncDiscovery', async () => {
    renderTree(node())
    expect(screen.queryByRole('button', { name: 'Re-sync now' })).toBeNull()
    fireEvent.click(await screen.findByText('Troubleshooting'))
    fireEvent.click(await screen.findByRole('button', { name: 'Re-sync now' }))
    await waitFor(() =>
      expect(customMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          addonId: 'export-alexa',
          action: 'resyncDiscovery',
        }),
      ),
    )
  })

  it('draws no empty section frame: public mode has no Custom-skill security at all', async () => {
    const { container } = renderTree(node())
    await screen.findByText('Features')
    expect(screen.queryByText('Custom-skill security')).toBeNull()
    expect(
      container.querySelector('[data-settings-section="export-alexa-custom-security"]'),
    ).toBeNull()
    for (const section of container.querySelectorAll('[data-settings-section]')) {
      expect(section.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('shows Custom-skill security live when the operator switches to the custom skill', async () => {
    renderTree(node())
    const mode = (await screen.findByText('Alexa skill')).parentElement?.querySelector('select')
    if (!mode) throw new Error('no skill-mode select')
    expect(screen.queryByText('Alexa skill id')).toBeNull()
    fireEvent.change(mode, { target: { value: 'custom' } })
    expect(await screen.findByText('Custom-skill security')).toBeTruthy()
    expect(screen.getByText('Alexa skill id')).toBeTruthy()
  })

  it('a hub already in custom mode shows the section on load', async () => {
    served = alexaForm({ skillMode: 'custom' })
    renderTree(node())
    expect(await screen.findByText('Custom-skill security')).toBeTruthy()
  })
})
