/**
 * The INTEGRATION-LEVEL SETTINGS surface, driven through the REAL panel.
 *
 * Only the tRPC transport is stubbed: `addonSettings.getIntegrationSettings`
 * answers as core would (the declared sections, already selected and already
 * stripped of `perNode` fields), `getGlobalSettings` answers the full schema,
 * and `updateGlobalSettings` records what a Save actually sent. Everything
 * between — the query routing, the scope statement, the form, the save
 * controller — is shipping code, because the failures this guards against are
 * precisely a prop that is passed and then not used, and a fake that supplies
 * the value production forgot to fetch.
 *
 * The assertions are about what an operator SEES and what the store RECEIVES:
 *   1. the surface asks CORE for the declared sections, not the full schema;
 *   2. a provider that declared nothing renders nothing;
 *   3. a control here writes the SAME store key, at the same target, as the
 *      addon's own page — the `btmPath@hub` regression, asserted by comparing
 *      two real saves rather than by reading the code;
 *   4. the surface says the scope it edits;
 *   5. the mounts that would change scope throw.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues } from '@camstack/types'

const DECLARED_LABEL = 'SMTP Port'
const DECLARED_AUTH_LABEL = 'Auth Username'
const UNDECLARED_LABEL = 'Discovery timeout'

/** The addon's FULL schema — what its own page renders. */
const FULL_SCHEMA: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'email-push',
      title: 'Battery-cam Motion (Email/SMTP Push)',
      fields: [
        { type: 'number', key: 'emailPushPort', label: DECLARED_LABEL, value: 2525 },
        {
          type: 'info',
          key: 'emailPushRecommendedHost',
          label: 'Camera-facing host',
          content: 'Point cameras at 192.168.10.9',
        },
      ],
    },
    {
      id: 'email-push-auth',
      title: 'Email Push Authentication',
      fields: [
        { type: 'text', key: 'emailPushAuthUsername', label: DECLARED_AUTH_LABEL, value: 'cam' },
      ],
    },
    {
      id: 'discovery',
      title: 'Discovery',
      fields: [{ type: 'text', key: 'discoveryTimeoutMs', label: UNDECLARED_LABEL, value: '' }],
    },
  ],
}

/**
 * What CORE returns for a declaring addon: the declared sections only. Built by
 * SELECTING from `FULL_SCHEMA` rather than by retyping the fields, so the test
 * cannot accidentally assert against a second schema that production does not
 * produce — the subset property is the whole guarantee.
 */
const DECLARED_SCHEMA: ConfigUISchemaWithValues = {
  sections: FULL_SCHEMA.sections.filter((s) => s.id !== 'discovery'),
}

/**
 * What core returns for an addon that declared nothing: `null`, not an empty
 * schema. The two must stay distinguishable.
 */
let servedIntegration: ConfigUISchemaWithValues | null = DECLARED_SCHEMA

interface UpdateGlobalSettingsInput {
  readonly addonId: string
  readonly nodeId: string
  readonly patch: Record<string, unknown>
}

const getIntegrationSettings = vi.fn(async () => servedIntegration)
const getGlobalSettings = vi.fn(async () => FULL_SCHEMA)
const updateGlobalSettings = vi.fn(async (_input: UpdateGlobalSettingsInput) => ({
  success: true,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noopMutation = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: {
          getGlobalSettings: { query: getGlobalSettings },
          getIntegrationSettings: { query: getIntegrationSettings },
        },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    useAddonsList: () => ({ data: [{ manifest: { id: 'provider-reolink', name: 'Reolink' } }] }),
    useAddonSettingsUpdateGlobalSettings: () => ({
      mutateAsync: updateGlobalSettings,
      mutate: updateGlobalSettings,
      isPending: false,
    }),
    useAddonSettingsUpdateDeviceSettings: noopMutation,
    useDecoderReprobeHwaccel: noopMutation,
    useAudioAnalyzerReprobeAudioEngine: noopMutation,
  }
})

import { NodeAddonsSettingsPanel } from '../NodeAddonsSettingsPanel'

function renderTree(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

/** The integration surface, exactly as `IntegrationDetail` mounts it. */
function integrationSurface() {
  return (
    <NodeAddonsSettingsPanel
      nodeId={null}
      addonIds={['provider-reolink']}
      level="global"
      surface="integration"
      title="Reolink"
    />
  )
}

/** The addon's own page, exactly as `AddonCard`'s dialog mounts it. */
function addonPageSurface() {
  return (
    <NodeAddonsSettingsPanel
      nodeId={null}
      addonIds={['provider-reolink']}
      level="global"
      fieldScope="cluster"
    />
  )
}

/**
 * Edit the one number input on screen and click Save. Returns what the save
 * mutation was called with — the store-facing truth, not a rendered string.
 */
async function editPortAndSave(
  container: HTMLElement,
  next: string,
): Promise<UpdateGlobalSettingsInput | undefined> {
  const input = await waitFor(() => {
    const found = container.querySelector('input[type="number"]')
    // `instanceof` rather than a cast: the narrowing is the assertion, so a
    // missing input fails here instead of further down as a null dereference.
    if (!(found instanceof HTMLInputElement)) throw new Error('no number input rendered')
    return found
  })
  fireEvent.change(input, { target: { value: next } })
  const save = await screen.findByRole('button', { name: 'Save' })
  fireEvent.click(save)
  await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalled())
  return updateGlobalSettings.mock.calls[0]?.[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  servedIntegration = DECLARED_SCHEMA
})

describe('the integration surface asks core, not the addon page', () => {
  it('calls getIntegrationSettings and never getGlobalSettings', async () => {
    renderTree(integrationSurface())

    await screen.findByText(DECLARED_LABEL)
    expect(getIntegrationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'provider-reolink', nodeId: 'hub' }),
    )
    // The selection is core's. A client-side filter over the full schema would
    // be a second opinion about which settings are integration-level.
    expect(getGlobalSettings).not.toHaveBeenCalled()
  })

  it('renders the declared sections', async () => {
    renderTree(integrationSurface())

    expect(await screen.findByText(DECLARED_LABEL)).toBeTruthy()
    expect(screen.getByText(DECLARED_AUTH_LABEL)).toBeTruthy()
  })

  it('does not render what the addon did not declare', async () => {
    renderTree(integrationSurface())

    await screen.findByText(DECLARED_LABEL)
    expect(screen.queryByText(UNDECLARED_LABEL)).toBeNull()
    expect(screen.queryByText('Discovery')).toBeNull()
  })

  it('renders NO scope paragraph above the form', async () => {
    // The operator asked for the "Integration-wide settings — …" paragraph to
    // go. It is asserted absent HERE, on a rendered surface, and not only by
    // the source-text guard in `settings-surface-scope.spec.ts`: a deleted
    // constant that some other branch still interpolates would satisfy the
    // filesystem check and still put the sentence on screen.
    //
    // The scope itself is still enforced — by the refusals in
    // `NodeAddonsSettingsPanel` (device level / deviceId / nodeId /
    // fieldScope), which throw rather than describe. Those are covered by
    // "refuses a mount that would re-scope the settings" below.
    renderTree(integrationSurface())

    await screen.findByText(DECLARED_LABEL)
    expect(screen.queryByTestId('settings-scope-statement')).toBeNull()
    expect(screen.queryByText(/Integration-wide settings/)).toBeNull()
  })

  it('renders no tab named after the mechanism', async () => {
    // The design this replaced declared placement as `tab: 'integration'`,
    // which fed the settings tab bar and put the literal word "integration"
    // on screen as a tab label. `tab` is visual grouping only (D269).
    renderTree(integrationSurface())

    await screen.findByText(DECLARED_LABEL)
    expect(screen.queryByText(/^integration$/i)).toBeNull()
  })
})

describe('a provider that declared NOTHING', () => {
  it('renders no integration settings at all', async () => {
    servedIntegration = null
    renderTree(integrationSurface())

    // Wait for the panel to SETTLE on its empty state, not merely for the
    // query fn to have been called. An earlier version of this test awaited
    // `getIntegrationSettings` having been invoked and then asserted the
    // absence of labels — which the empty initial DOM satisfies, so it passed
    // with the mechanism deliberately disabled. An absence assertion is only
    // worth anything once something present proves the render completed.
    expect(await screen.findByText(/expose global-level settings/)).toBeTruthy()
    expect(screen.queryByText(DECLARED_LABEL)).toBeNull()
    expect(screen.queryByText(UNDECLARED_LABEL)).toBeNull()
  })
})

describe('a control here writes where the addon page writes', () => {
  it('sends the SAME bare key at the SAME target as the addon page — no second copy', async () => {
    const integration = renderTree(integrationSurface())
    const fromIntegration = await editPortAndSave(integration.container, '2600')
    integration.unmount()

    vi.clearAllMocks()

    const addonPage = renderTree(addonPageSurface())
    const fromAddonPage = await editPortAndSave(addonPage.container, '2600')

    // Not "both look plausible" — byte-identical mutation input. A scoped key
    // (`emailPushPort@hub`), a different nodeId, or an integration-specific
    // writer would all fail here.
    expect(fromIntegration).toEqual(fromAddonPage)
    expect(fromIntegration).toEqual({
      addonId: 'provider-reolink',
      nodeId: 'hub',
      patch: { emailPushPort: 2600 },
    })
  })
})

describe('the mounts that would change scope are refused', () => {
  /** React logs the thrown render error; the assertion is the throw itself. */
  function expectRefusal(node: React.ReactNode, match: RegExp): void {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => renderTree(node)).toThrow(match)
    } finally {
      spy.mockRestore()
    }
  }

  it('refuses a device mount — the ProviderSettingsTab defect', () => {
    expectRefusal(
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={['provider-reolink']}
        level="device"
        deviceId={102}
        surface="integration"
      />,
      /cannot be mounted at device level/,
    )
  })

  it('refuses a node id — the AddonCard `nodeId="hub"` defect', () => {
    expectRefusal(
      <NodeAddonsSettingsPanel
        nodeId="agent-a"
        addonIds={['provider-reolink']}
        level="global"
        surface="integration"
      />,
      /no node behind it/,
    )
  })

  it('refuses a competing fieldScope rather than letting two scopes agree by luck', () => {
    expectRefusal(
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={['provider-reolink']}
        level="global"
        surface="integration"
        fieldScope="perNode"
      />,
      /already cluster-scoped from core/,
    )
  })
})
