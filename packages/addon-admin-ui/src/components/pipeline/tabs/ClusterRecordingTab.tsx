/**
 * ClusterRecordingTab — Pipeline → Cluster → "Recording" tab.
 *
 * Two cluster-wide controls for recording:
 *  1. Recording NODE — the single node that runs the recorder write path
 *     (continuous + events) and serves playback. All other nodes are inert (no
 *     balancing). Stored as the `recordingNodeId` global setting of the
 *     `recorder` addon; takes effect on addon restart. The stream-broker is
 *     hub-only, so a NON-hub node pulls streams cross-node — set the optional
 *     "Hub host" override below if the auto-derived host isn't reachable.
 *  2. Recordings FOLDERS — multi-location collections (`recordings` +
 *     `recordingsLow`) with equal-splitting — managed with the standard panel.
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
import { Trans, useTranslation } from 'react-i18next'

const ADDON_ID = 'recorder'

interface SchemaField {
  readonly key?: string
  readonly value?: unknown
}
interface SchemaSection {
  readonly id?: string
  readonly fields?: readonly SchemaField[]
}

/** Pull a string field's current value out of a global-settings schema. */
function readField(
  schema: { sections?: readonly SchemaSection[] } | null | undefined,
  key: string,
  fallback: string,
): string {
  for (const s of schema?.sections ?? []) {
    for (const f of s.fields ?? []) {
      if (f.key === key && typeof f.value === 'string') return f.value
    }
  }
  return fallback
}

export function ClusterRecordingTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Needs the online node IDS for a picker — the roster, not the diagram (D317).
  const { nodes: clusterNodes } = useClusterNodes()
  const { data: settings, isLoading: settingsLoading } = useAddonSettingsGetGlobalSettings({
    addonId: ADDON_ID,
  })
  const currentNode = readField(settings, 'recordingNodeId', 'hub')
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
          {t('pipeline.clusterRecordingTab.recordingNode', 'Recording node')}
        </h3>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterRecordingTab.theSingleNodeThatRecords',
            'The single node that records (continuous & events) and serves playback. Every other node stays inert — no multi-node balancing. Takes effect on addon restart.',
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
                    patch: { recordingNodeId: e.target.value },
                  })
              }}
              disabled={updateGlobal.isPending}
            >
              {nodeOptions.map((id) => (
                <option key={id} value={id}>
                  {id === 'hub'
                    ? t('pipeline.clusterRecordingTab.hubDefault', 'hub (default)')
                    : id}
                </option>
              ))}
            </Select>
          )}
          {updateGlobal.isPending && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        </div>
        {currentNode !== 'hub' && (
          <p className="mt-2 text-[11px] text-amber-500">
            <Trans
              i18nKey="pipeline.clusterRecordingTab.hubOnlyNote"
              values={{ node: currentNode }}
              components={{ b: <span className="font-medium" /> }}
            />
          </p>
        )}
      </section>

      <section className="rounded-md border border-border bg-surface p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          {t('pipeline.clusterRecordingTab.recordingsFolders', 'Recordings folders')}
        </h3>
        <p className="mb-3 text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterRecordingTab.whereRecordingsAreStoredMulti',
            'Where recordings are stored. Multi-location collections — segments are split across the locations of a type. Add a location to grow capacity; mark one default per type.',
          )}
        </p>
        <StorageLocationsPanel types={['recordings', 'recordingsLow']} />
      </section>
    </div>
  )
}
