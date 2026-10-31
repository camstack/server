/**
 * ClusterEventsTab — rendered on Recordings → Events (`EventsSection`); the
 * only place the events folder is managed (it left Pipeline → Cluster → Roles
 * & nodes, where it duplicated this one).
 *
 * Two cluster-wide controls for detection post-processing:
 *  1. Post-processing NODE — the single node that runs pipeline-analytics
 *     (events / media / audio / motion). All other nodes are inert (no
 *     balancing). Stored as the `postProcessingNodeId` global setting of the
 *     `pipeline-analytics` addon; takes effect on addon restart.
 *  2. Events FOLDER — the single `eventMedia` storage location.
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  useClusterNodes,
  useAddonSettingsGetGlobalSettings,
  useAddonSettingsUpdateGlobalSettings,
  Select,
} from '@camstack/ui-library'
import { StorageLocationsPanel } from './StorageLocationsPanel'
import { useTranslation } from 'react-i18next'

const ADDON_ID = 'pipeline-analytics'

interface SchemaField {
  readonly key?: string
  readonly value?: unknown
}
interface SchemaSection {
  readonly id?: string
  readonly fields?: readonly SchemaField[]
}

/** Pull `postProcessingNodeId`'s current value out of a global-settings schema. */
function readNodeValue(schema: { sections?: readonly SchemaSection[] } | null | undefined): string {
  for (const s of schema?.sections ?? []) {
    for (const f of s.fields ?? []) {
      if (f.key === 'postProcessingNodeId' && typeof f.value === 'string') return f.value
    }
  }
  return 'hub'
}

export function ClusterEventsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Needs the online node IDS for a picker — the roster, not the diagram (D317).
  const { nodes: clusterNodes } = useClusterNodes()
  const { data: settings, isLoading: settingsLoading } = useAddonSettingsGetGlobalSettings({
    addonId: ADDON_ID,
  })
  const currentNode = readNodeValue(settings)
  const updateGlobal = useAddonSettingsUpdateGlobalSettings({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['addonSettings', 'getGlobalSettings']] })
    },
  })
  const nodeOptions = useMemo(() => {
    const online = clusterNodes.filter((n) => n.isOnline).map((n) => n.id)
    return [...new Set(['hub', currentNode, ...online])].filter(Boolean)
  }, [clusterNodes, currentNode])

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-md border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold text-foreground">
          {t('pipeline.clusterEventsTab.postProcessingNode', 'Post-processing node')}
        </h3>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterEventsTab.theSingleNodeThatRuns',
            'The single node that runs detection post-processing (events, media, audio & motion). Every other node stays inert — no multi-node balancing. Takes effect on addon restart.',
          )}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {settingsLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
          ) : (
            <Select
              wrapperClassName="inline-block w-auto"
              value={currentNode}
              onChange={(e) => {
                if (e.target.value !== currentNode)
                  updateGlobal.mutate({
                    addonId: ADDON_ID,
                    patch: { postProcessingNodeId: e.target.value },
                  })
              }}
              disabled={updateGlobal.isPending}
            >
              {nodeOptions.map((id) => (
                <option key={id} value={id}>
                  {id === 'hub' ? t('pipeline.clusterEventsTab.hubDefault', 'hub (default)') : id}
                </option>
              ))}
            </Select>
          )}
          {updateGlobal.isPending && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        </div>
      </section>

      <section className="rounded-md border border-border bg-surface p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          {t('pipeline.clusterEventsTab.eventsFolder', 'Events folder')}
        </h3>
        <p className="mb-3 text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterEventsTab.whereEventCropsFullFrames',
            'Where event crops / full frames are stored. A single folder — no collection / equal-splitting.',
          )}
        </p>
        <StorageLocationsPanel types={['eventMedia']} />
      </section>
    </div>
  )
}
