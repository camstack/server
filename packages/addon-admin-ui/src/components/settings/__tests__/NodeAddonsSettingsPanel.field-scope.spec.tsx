/**
 * The two settings surfaces, driven through the REAL panel.
 *
 * Only the tRPC transport is stubbed — `addonSettings.getGlobalSettings`
 * answers a schema mixing a per-node field with cluster ones. Everything
 * between (the scope filter, the section drop, the tab bar, the empty state)
 * is shipping code, because the failure this guards against is precisely a
 * prop that is passed and then not used.
 *
 * The assertions are about what an operator SEES:
 *   1. a node's Settings tab shows the per-node field and NOT the cluster ones;
 *   2. it says why it is empty when a node has no per-node settings at all;
 *   3. the addon card's dialog shows the cluster fields and NOT the per-node one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues } from '@camstack/types'

const PER_NODE_LABEL = 'btm binary path'
const CLUSTER_LABEL = 'Loki URL'
const CLUSTER_LABEL_2 = 'Join burst span'

const MIXED_SCHEMA: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'node-things',
      title: 'Node things',
      fields: [
        {
          type: 'text',
          key: 'btmPath',
          label: PER_NODE_LABEL,
          perNode: true,
          value: '/usr/bin/btm',
        },
        { type: 'number', key: 'joinBurstMaxSpanMs', label: CLUSTER_LABEL_2, value: 250 },
      ],
    },
    {
      id: 'cluster-things',
      title: 'Cluster things',
      fields: [{ type: 'text', key: 'lokiUrl', label: CLUSTER_LABEL, value: 'http://loki' }],
    },
  ],
}

const CLUSTER_ONLY_SCHEMA: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'cluster-things',
      title: 'Cluster things',
      fields: [{ type: 'text', key: 'lokiUrl', label: CLUSTER_LABEL, value: 'http://loki' }],
    },
  ],
}

let served: ConfigUISchemaWithValues = MIXED_SCHEMA
const getGlobalSettings = vi.fn(async () => served)

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noopMutation = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: { getGlobalSettings: { query: getGlobalSettings } },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    useAddonsList: () => ({ data: [{ manifest: { id: 'terminal', name: 'Terminal' } }] }),
    useAddonSettingsUpdateGlobalSettings: noopMutation,
    useAddonSettingsUpdateDeviceSettings: noopMutation,
    useDecoderReprobeHwaccel: noopMutation,
    useAudioAnalyzerReprobeAudioEngine: noopMutation,
  }
})

import { NodeDetailSettingsTab } from '../../cluster/tabs/NodeDetailSettingsTab'
import { NodeAddonsSettingsPanel } from '../NodeAddonsSettingsPanel'

function renderTree(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  served = MIXED_SCHEMA
})

describe("a node's Settings tab", () => {
  it('renders the per-node field and NOT the cluster fields drawn under its name', async () => {
    renderTree(<NodeDetailSettingsTab nodeId="agent-a" addonIds={['terminal']} />)

    expect(await screen.findByText(PER_NODE_LABEL)).toBeTruthy()
    await waitFor(() => expect(getGlobalSettings).toHaveBeenCalled())
    expect(screen.queryByText(CLUSTER_LABEL)).toBeNull()
    expect(screen.queryByText(CLUSTER_LABEL_2)).toBeNull()
  })

  it('drops the section that had no per-node field in it', async () => {
    renderTree(<NodeDetailSettingsTab nodeId="agent-a" addonIds={['terminal']} />)
    await screen.findByText(PER_NODE_LABEL)
    expect(screen.queryByText('Cluster things')).toBeNull()
  })

  it('asks the addon for THAT node, not for the hub', async () => {
    renderTree(<NodeDetailSettingsTab nodeId="agent-a" addonIds={['terminal']} />)
    await screen.findByText(PER_NODE_LABEL)
    expect(getGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'terminal', nodeId: 'agent-a' }),
    )
  })

  it('SAYS why it is empty when the node has no per-node settings', async () => {
    served = CLUSTER_ONLY_SCHEMA
    renderTree(<NodeDetailSettingsTab nodeId="agent-a" addonIds={['terminal']} />)

    expect(await screen.findByText(/No per-node settings on this node/)).toBeTruthy()
    expect(screen.getByText(/System → Settings/)).toBeTruthy()
    expect(screen.queryByText(CLUSTER_LABEL)).toBeNull()
  })
})

describe("the addon card's Settings dialog", () => {
  it('renders the cluster fields and NOT the per-node one it cannot address', async () => {
    renderTree(
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={['terminal']}
        level="global"
        fieldScope="cluster"
        emptyMessage="no cluster settings"
      />,
    )

    expect(await screen.findByText(CLUSTER_LABEL)).toBeTruthy()
    expect(screen.getByText(CLUSTER_LABEL_2)).toBeTruthy()
    expect(screen.queryByText(PER_NODE_LABEL)).toBeNull()
  })

  it('says so when an addon is entirely per-node', async () => {
    served = {
      sections: [
        {
          id: 'node-things',
          title: 'Node things',
          fields: [
            { type: 'text', key: 'btmPath', label: PER_NODE_LABEL, perNode: true, value: '/x' },
          ],
        },
      ],
    }
    renderTree(
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={['terminal']}
        level="global"
        fieldScope="cluster"
        emptyMessage="This addon exposes no cluster-wide settings."
      />,
    )
    expect(await screen.findByText(/no cluster-wide settings/)).toBeTruthy()
    expect(screen.queryByText(PER_NODE_LABEL)).toBeNull()
  })
})

describe('an unscoped caller is unchanged', () => {
  it('still renders everything when no fieldScope is given', async () => {
    renderTree(<NodeAddonsSettingsPanel nodeId="hub" addonIds={['terminal']} level="global" />)
    expect(await screen.findByText(PER_NODE_LABEL)).toBeTruthy()
    expect(screen.getByText(CLUSTER_LABEL)).toBeTruthy()
  })
})
