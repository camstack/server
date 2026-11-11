// @vitest-environment jsdom
/**
 * System → Settings is the aggregate panel (no capability, section, scope or
 * field list). A section whose capability is an InstancesTable function cap
 * is absent; a section owned by any other capability stays. A narrowed
 * surface (the passkey dialog passes `fieldScope`) still draws the function
 * cap — that page is the section's home.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues, ScopedSettingsDeclaration } from '@camstack/types'

function form(sectionId: string, label: string): ConfigUISchemaWithValues {
  return {
    sections: [
      {
        id: sectionId,
        title: sectionId,
        fields: [{ type: 'text', key: sectionId, label, value: 'v' }],
      },
    ],
  }
}

const FORMS: Readonly<Record<string, ConfigUISchemaWithValues>> = {
  'widget-sync:cluster': form('widget', 'Widget sync'),
  'retention:cluster': form('retention', 'Retention days'),
  'login-method:cluster': form('webauthn', 'Passkey identity'),
}

const DECLARATIONS: readonly ScopedSettingsDeclaration[] = [
  { cap: 'widget-sync', scope: 'cluster', sectionIds: ['widget'] },
  { cap: 'retention', scope: 'cluster', sectionIds: ['retention'] },
  { cap: 'login-method', scope: 'cluster', sectionIds: ['webauthn'] },
]

const listScopedSettings = vi.fn(async () => DECLARATIONS)
const getScopedSettings = vi.fn(async (input: { cap: string; scope: string }) => {
  return FORMS[`${input.cap}:${input.scope}`] ?? null
})

const listCapabilityProviders = vi.fn(async (input: { capName: string }) => {
  if (input.capName === 'integration-instances') {
    return [{ addonId: 'provider', mode: 'collection' as const, isActive: true }]
  }
  return []
})
const describeKinds = vi.fn(async () => ({
  kinds: [{ id: 'widget', label: 'Widget', functionCap: 'widget-sync' }],
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noop = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: {
          listScopedSettings: { query: listScopedSettings },
          getScopedSettings: { query: getScopedSettings },
        },
        addons: {
          custom: { mutate: vi.fn() },
          listCapabilityProviders: { query: listCapabilityProviders },
        },
        integrationInstances: { describe: { query: describeKinds } },
      },
    }),
    useAddonsList: () => ({ data: [{ manifest: { id: 'provider', name: 'Provider' } }] }),
    useAddonSettingsUpdateGlobalSettings: noop,
    useAddonSettingsUpdateScopedSettings: noop,
    useAddonSettingsUpdateDeviceSettings: noop,
    useDecoderReprobeHwaccel: noop,
    useAudioAnalyzerReprobeAudioEngine: noop,
  }
})

import { NodeAddonsSettingsPanel } from '../NodeAddonsSettingsPanel'

function renderPanel(props: Partial<React.ComponentProps<typeof NodeAddonsSettingsPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NodeAddonsSettingsPanel nodeId="hub" addonIds={['provider']} level="global" {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('aggregate System → Settings', () => {
  it('drops a function-cap section and login-method, and keeps a hub-wide section', async () => {
    renderPanel()
    expect(await screen.findByText('Retention days')).toBeTruthy()
    expect(screen.queryByText('Widget sync')).toBeNull()
    expect(screen.queryByText('Passkey identity')).toBeNull()
    const fetched = getScopedSettings.mock.calls.map(([input]) => input.cap)
    expect(fetched).toEqual(['retention'])
  })

  it('a narrowed surface still draws the function-cap section', async () => {
    renderPanel({ fieldScope: 'cluster' })
    expect(await screen.findByText('Widget sync')).toBeTruthy()
    expect(screen.getByText('Passkey identity')).toBeTruthy()
    expect(screen.getByText('Retention days')).toBeTruthy()
  })
})
