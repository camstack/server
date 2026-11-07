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
import { ALEXA_SKILL_DEFAULT_BODY } from '../../../../../addon-export-alexa/src/skill-records'
import { buildAlexaInstanceSections } from '../../../../../addon-export-alexa/src/settings-schema'

function alexaForm(stored: Record<string, unknown>): ConfigUISchemaWithValues {
  return hydrateSchema(
    {
      sections: buildAlexaInstanceSections({
        defaults: ALEXA_SKILL_DEFAULT_BODY,
        instanceId: 'export-alexa',
        legacy: true,
        linkedAccounts: [],
        tokens: [],
        now: 0,
      }),
    },
    stored,
  )
}

let served: ConfigUISchemaWithValues = alexaForm({})
/** Alexa declares its whole form on the cluster scope of the `device-export` capability. */
const listScopedSettings = vi.fn(async () => [
  { cap: 'device-export', scope: 'cluster' as const, sectionIds: served.sections.map((s) => s.id) },
])
const getScopedSettings = vi.fn(async () => served)
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
        addonSettings: {
          listScopedSettings: { query: listScopedSettings },
          getScopedSettings: { query: getScopedSettings },
        },
        addons: { custom: { mutate: customMutate } },
      },
    }),
    useAddonsList: () => ({
      data: [{ manifest: { id: 'export-alexa', name: 'Alexa' } }],
    }),
    useAddonSettingsUpdateGlobalSettings: noopMutation,
    useAddonSettingsUpdateScopedSettings: noopMutation,
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
    for (const title of ['Account link', 'Troubleshooting']) {
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

  it('draws no empty section frame: public mode has no Custom-skill ingress token at all', async () => {
    const { container } = renderTree(node())
    await screen.findByText('Account link')
    expect(screen.queryByText('Ingress token')).toBeNull()
    expect(
      container.querySelector('[data-settings-section="export-alexa-custom-security-token"]'),
    ).toBeNull()
    for (const section of container.querySelectorAll('[data-settings-section]')) {
      expect(section.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('a hub already in custom mode shows the section on load', async () => {
    served = alexaForm({ skillMode: 'custom' })
    renderTree(node())
    expect(await screen.findByText('Ingress token')).toBeTruthy()
  })
})
