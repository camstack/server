/**
 * NodeLoadOverview — the per-node LOAD reading on Pipeline → Cluster → Load
 * balancing: what the cluster's sessions are doing to each node, next to the
 * share each node is set to carry. It is deliberately a READING of the
 * balancer's own inputs, joined by `buildNodeLoadRows`, plus what placement
 * actually did over the last hour (`getPlacementStats`, D748 — passed in by
 * the tab, which reads it once for every panel):
 *
 *   `getAgentLoad`            → live attached/active sessions, per-accelerator
 *                               session counts, queue depth, and the capacity
 *                               score `balance()` minimises.
 *   `listAgentSettings`       → the operator's `detectWeight` (target share) and
 *                               `maxCameras` (hard ceiling).
 *   `getNodeInferenceDevices` → each accelerator with the DISPATCHER's own
 *                               `exclusion` verdict, so "why is this device
 *                               never used" is read, not deduced (D215).
 *
 * ## Polling budget (this panel talks to the whole cluster)
 *
 * `getAgentLoad` is NOT a hub-local read: it fans out one `getLocalLoad` plus
 * one `decoder.getInfo` to every runner (2N cross-node RPCs per call), and
 * `getNodeInferenceDevices` fans out a live `platformProbe.getCapabilities` per
 * node. So this panel is a PROSPECTUS on a slow clock, not a live meter:
 *
 *   - load          → `staleTime`/`refetchInterval` {@link LOAD_REFRESH_MS},
 *                     `keepPreviousData` so a refetch never blanks the panel,
 *                     and the age of the reading is stamped on the header
 *                     rather than hidden.
 *   - devices       → `staleTime` {@link DEVICE_STALE_MS`}. A node's accelerator
 *                     roster and its exclusion verdict change when the operator
 *                     changes config or hardware moves — never on a dispatch.
 *                     Writes invalidate it explicitly (`invalidatePlacementQueries`).
 *
 * The per-camera phase/fps ticker stays where it belongs: the camera strip,
 * which is event-driven and costs the cluster nothing.
 */

import type { AgentLoadSummary, NodeInferenceDevice, PlacementStats } from '@camstack/types'
import {
  SECTION_BODY,
  SectionCard,
  trpc,
  useClusterNodes,
  usePipelineOrchestratorGetAgentLoad,
  usePipelineOrchestratorListAgentSettings,
  useSystem,
} from '@camstack/ui-library'
import { keepPreviousData, useQueries } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { Activity, AlertTriangle, Cpu, Gauge, WifiOff } from 'lucide-react'
import { useMemo } from 'react'

import { effectiveCapabilitySettings } from './lib/node-enablement'
import {
  type AcceleratorLoad,
  buildNodeLoadRows,
  type ClusterNodeFacts,
  EXCLUSION_TEXT_KEY,
  type NodeLoadRow,
} from './node-load-model'
import { readNumberObjectField } from './placement-board/board-model'
import { useTranslation } from 'react-i18next'

/** How often the cluster-wide load fan-out is re-read (see the module doc). */
const LOAD_REFRESH_MS = 20_000
/** How long a node's accelerator roster + exclusion verdict is considered fresh. */
const DEVICE_STALE_MS = 300_000

interface NodeLoadOverviewProps {
  /** What placement did over the stats window; undefined while it loads. */
  readonly stats: PlacementStats | undefined
  /**
   * The shares placement actually holds when they are automatic (D750):
   * nodeId → share. Absent ⇒ the stored `detectWeight` sliders.
   */
  readonly targetWeights?: Readonly<Record<string, number>>
  /**
   * Show each node's accelerator list (default). Load balancing turns it off:
   * its per-node accelerator tables carry the same share and session facts.
   */
  readonly showAccelerators?: boolean
}

export function NodeLoadOverview({
  stats,
  targetWeights,
  showAccelerators = true,
}: NodeLoadOverviewProps) {
  const { t } = useTranslation()
  const { nodes } = useClusterNodes()
  const trpcClient = useSystem().trpcClient

  const loadQuery = usePipelineOrchestratorGetAgentLoad(undefined, {
    // A background refetch must never blank the panel — that flash is exactly
    // the artefact this surface is supposed to not have.
    placeholderData: keepPreviousData,
    staleTime: LOAD_REFRESH_MS,
    refetchInterval: LOAD_REFRESH_MS,
    refetchOnWindowFocus: true,
  })
  const settingsQuery = usePipelineOrchestratorListAgentSettings(undefined, {
    staleTime: DEVICE_STALE_MS,
  })

  const nodeIds = useMemo(() => nodes.map((n) => n.id), [nodes])

  // One device query per NODE (3-ish), never per camera. React Query dedupes by
  // key, so the same roster shared with the placement matrix costs one probe.
  const deviceQueries = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: getQueryKey(trpc.pipelineOrchestrator.getNodeInferenceDevices, { nodeId }, 'query'),
      queryFn: (): Promise<{ readonly devices: readonly NodeInferenceDevice[] }> =>
        trpcClient.pipelineOrchestrator.getNodeInferenceDevices.query({ nodeId }),
      staleTime: DEVICE_STALE_MS,
      refetchOnWindowFocus: false,
      placeholderData: keepPreviousData,
    })),
  })

  // `useQueries` hands back a NEW array on every render, so a memo keyed on it
  // would never hit — and its output re-seeds `rows`, which re-renders, which
  // rebuilds `queries`… (React reports that loop as "Maximum update depth
  // exceeded"; see the same note in NodeAddonsSettingsPanel). Key on the
  // per-query `dataUpdatedAt` fingerprint instead: it moves only when a query
  // actually resolved new data.
  const devicesFingerprint = deviceQueries.map((q) => q.dataUpdatedAt).join('|')
  const devicesByNode = useMemo<Readonly<Record<string, readonly NodeInferenceDevice[]>>>(() => {
    const out: Record<string, readonly NodeInferenceDevice[]> = {}
    nodeIds.forEach((nodeId, index) => {
      const data = deviceQueries[index]?.data
      if (data) out[nodeId] = data.devices
    })
    return out
    // `deviceQueries` is deliberately absent — see the fingerprint note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIds, devicesFingerprint])

  const settingsByNode = useMemo(() => {
    const map = new Map<string, object>()
    for (const row of settingsQuery.data ?? []) map.set(row.nodeId, row.settings)
    return map
  }, [settingsQuery.data])

  const facts = useMemo<readonly ClusterNodeFacts[]>(
    () =>
      nodes.map((node): ClusterNodeFacts => {
        const settings = settingsByNode.get(node.id)
        return {
          id: node.id,
          name: node.name,
          isOnline: node.isOnline,
          detectEnabled: effectiveCapabilitySettings(settings).pipeline,
          weight: targetWeights?.[node.id] ?? readNumberObjectField(settings, 'detectWeight') ?? 1,
          maxCameras: readNumberObjectField(settings, 'maxCameras'),
        }
      }),
    [nodes, settingsByNode, targetWeights],
  )

  const loads: readonly AgentLoadSummary[] = loadQuery.data ?? []
  const rows = useMemo(
    () => buildNodeLoadRows({ nodes: facts, loads, devicesByNode }),
    [facts, loads, devicesByNode],
  )

  const totalAttached = rows.reduce((sum, r) => sum + (r.attachedCameras ?? 0), 0)
  const totalActive = rows.reduce((sum, r) => sum + (r.activeCameras ?? 0), 0)
  const readingAge = loadQuery.dataUpdatedAt > 0 ? Date.now() - loadQuery.dataUpdatedAt : null

  const statsByNode = new Map((stats?.nodes ?? []).map((n) => [n.nodeId, n]))

  return (
    <SectionCard
      headingId="load-balancing-node-load"
      title={t('pipeline.nodeLoadOverview.nodeLoad', 'Node load')}
      icon={Activity}
      actions={
        <span className="text-[10px] text-foreground-subtle tabular-nums">
          {t('pipeline.nodeLoadOverview.summaryLine', {
            active: totalActive,
            attached: totalAttached,
            reading:
              loadQuery.data === undefined
                ? t('pipeline.nodeLoadOverview.reading', 'reading…')
                : t('pipeline.nodeLoadOverview.readingAge', {
                    age: readingAge !== null ? `${Math.round(readingAge / 1000)}s` : '—',
                  }),
          })}
        </span>
      }
    >
      <div className={SECTION_BODY}>
        {rows.length === 0 ? (
          <p className="text-[11px] italic text-foreground-subtle">
            {t(
              'pipeline.nodeLoadOverview.noClusterNodesReportedYet',
              'No cluster nodes reported yet.',
            )}
          </p>
        ) : (
          <div className="grid gap-2 @2xl/clustertab:grid-cols-2 @5xl/clustertab:grid-cols-3">
            {rows.map((row) => (
              <NodeLoadCard
                key={row.nodeId}
                row={row}
                placed={statsByNode.get(row.nodeId)}
                showAccelerators={showAccelerators}
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

interface NodeLoadCardProps {
  readonly row: NodeLoadRow
  readonly placed: PlacementStats['nodes'][number] | undefined
  readonly showAccelerators: boolean
}

function NodeLoadCard({ row, placed, showAccelerators }: NodeLoadCardProps) {
  const { t } = useTranslation()
  const sessions =
    row.attachedCameras === null
      ? '—'
      : `${row.activeCameras ?? 0} / ${row.attachedCameras}${row.maxCameras !== null ? ` of ${row.maxCameras}` : ''}`

  return (
    <div className="rounded-lg border border-border bg-surface/60 p-2.5 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            row.isOnline ? 'bg-emerald-400' : 'bg-foreground-subtle/40'
          }`}
        />
        <span className="truncate text-xs font-medium text-foreground" title={row.nodeId}>
          {row.name}
        </span>
        {!row.detectEnabled && (
          <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] uppercase tracking-wide text-foreground-subtle">
            {t('pipeline.nodeLoadOverview.noDetect', 'no detect')}
          </span>
        )}
        {!row.reported && row.isOnline && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[9px] text-amber-400"
            title={t(
              'pipeline.nodeLoadOverview.onlineButItDidNot',
              'Online, but it did not answer the last load read — its numbers below are unknown, not zero.',
            )}
          >
            <AlertTriangle className="h-2.5 w-2.5" /> {t('pipeline.nodeLoadOverview.noReading')}
          </span>
        )}
        {!row.isOnline && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[9px] text-foreground-subtle">
            <WifiOff className="h-2.5 w-2.5" /> {t('common.offline')}
          </span>
        )}
      </div>

      <dl className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <Stat
          label={t('pipeline.nodeLoadOverview.runningAttached', 'Running / attached')}
          value={sessions}
          title={t(
            'pipeline.nodeLoadOverview.sessionsInInferenceNowCameras',
            "Sessions in inference now / cameras attached to this runner (the balancer's committed load) / operator cap.",
          )}
        />
        <Stat
          label={t('pipeline.nodeLoadOverview.targetShare', 'Target share')}
          value={row.weightSharePct === null ? 'out of play' : `${row.weightSharePct}%`}
          title={t(
            'pipeline.nodeLoadOverview.theNodeShareAutomaticOr',
            'The node share (automatic or manual) normalised over the nodes the balancer actually ranks (online AND detect-enabled).',
          )}
        />
        <Stat
          label={t('pipeline.nodeLoadOverview.actualShare1H', 'Actual share (1 h)')}
          value={
            placed?.observedShare === null || placed === undefined
              ? '—'
              : `${Math.round(placed.observedShare * 100)}%`
          }
          title={t(
            'pipeline.nodeLoadOverview.timeWeightedShareOfThe',
            "Time-weighted share of the cluster's PARALLEL detection sessions this node carried over the last hour — the quantity a share holds. '—' = no session ran here in the window.",
          )}
        />
        <Stat
          label={t('pipeline.nodeLoadOverview.peakYields', 'Peak · yields')}
          value={placed === undefined ? '—' : `${placed.peakSessions} · ${placed.yieldsAway}`}
          title={t(
            'pipeline.nodeLoadOverview.mostSessionsThisNodeRan',
            'Most sessions this node ran at once in the last hour, and how many share turns it handed to another node because it was full or drowning.',
          )}
        />
        <Stat
          label={t('pipeline.nodeLoadOverview.scoreQueue', 'Score · queue')}
          value={row.score === null ? '—' : `${row.score} · ${row.queueDepthTotal ?? 0}`}
          title={t(
            'pipeline.nodeLoadOverview.theCapacityScoreBalanceMinimises',
            'The capacity score balance() minimises (attached + queue depth), and the raw queue depth.',
          )}
        />
        {row.capacityPct !== null && (
          <Stat
            label={t('pipeline.nodeLoadOverview.capFill', 'Cap fill')}
            value={`${row.capacityPct}%`}
            title={t('pipeline.nodeLoadOverview.attachedMaxcameras', 'attached / maxCameras.')}
          />
        )}
        {row.avgInferenceTimeMs !== null && (
          <Stat
            label={t('pipeline.nodeLoadOverview.avgInfer', 'Avg infer')}
            value={`${Math.round(row.avgInferenceTimeMs)} ms`}
            title={t(
              'pipeline.nodeLoadOverview.meanInferenceTimeAcrossThis',
              "Mean inference time across this node's attached cameras.",
            )}
          />
        )}
        {row.decodeHwaccel !== null && (
          <Stat
            label={t('pipeline.nodeLoadOverview.decode', 'Decode')}
            value={row.decodeHwaccel}
            title={t(
              'pipeline.nodeLoadOverview.thisNodeSProbedDecode',
              "This node's probed decode hwaccel.",
            )}
          />
        )}
      </dl>

      {showAccelerators && <NodeAccelerators row={row} />}
    </div>
  )
}

function NodeAccelerators({ row }: { readonly row: NodeLoadRow }) {
  const { t } = useTranslation()
  if (row.devices.length === 0) {
    return (
      <p className="mt-2 text-[10px] italic text-foreground-subtle">
        {t('pipeline.nodeLoadOverview.acceleratorsNotReadYet', 'Accelerators not read yet.')}
      </p>
    )
  }
  return (
    <div className="mt-2 border-t border-border pt-1.5">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-foreground-subtle">
        <Gauge className="h-2.5 w-2.5" />
        {t('pipeline.nodeLoadOverview.accelerators', 'Accelerators')}
        {row.eligibleDeviceCount === 0 && (
          <span
            className="ml-1 normal-case tracking-normal text-amber-400"
            title={t(
              'pipeline.nodeLoadOverview.noDeviceIsACamera',
              "No device is a camera-root candidate on this node — sessions run on the runner's default (CPU) pool.",
            )}
          >
            {t(
              'pipeline.nodeLoadOverview.noneInPlayRunnerDefault',
              'none in play · runner default pool',
            )}
          </span>
        )}
      </div>
      <ul className="mt-1 space-y-0.5">
        {row.devices.map((device) => (
          <AcceleratorRow key={device.key} device={device} />
        ))}
      </ul>
    </div>
  )
}

interface AcceleratorRowProps {
  readonly device: AcceleratorLoad
}

function AcceleratorRow({ device }: AcceleratorRowProps) {
  const { t } = useTranslation()
  const exclusion = device.exclusion
  return (
    <li className="flex items-baseline gap-1.5 text-[10px] min-w-0">
      <Cpu
        className={`h-2.5 w-2.5 shrink-0 ${exclusion !== null ? 'text-foreground-subtle/50' : 'text-foreground-subtle'}`}
      />
      <span
        className={`shrink-0 font-medium ${exclusion !== null ? 'text-foreground-subtle' : 'text-foreground'}`}
        title={`${device.key} · ${device.format}`}
      >
        {device.label}
      </span>
      {exclusion !== null ? (
        <span
          className="truncate text-foreground-subtle/80"
          title={t(EXCLUSION_TEXT_KEY[exclusion])}
        >
          {t('pipeline.nodeLoadOverview.excludedWith', {
            reason: t(EXCLUSION_TEXT_KEY[exclusion]),
          })}
        </span>
      ) : (
        <>
          <span className="shrink-0 tabular-nums text-foreground-subtle">
            {t('pipeline.nodeLoadOverview.sharePct', { pct: device.weightSharePct })}
          </span>
          <span
            className="shrink-0 tabular-nums text-foreground-subtle"
            title={
              device.sessions === null
                ? t(
                    'pipeline.nodeLoadOverview.notKnownTheNodeDid',
                    'Not known: the node did not report, or runs a session no device accounts for.',
                  )
                : undefined
            }
          >
            · {t('common.sessionsCount', { count: device.sessions ?? 0 })}
            {device.maxSessions !== null ? `/${device.maxSessions}` : ''}
          </span>
          {device.atCap && (
            <span
              className="shrink-0 text-amber-400"
              title={t(
                'pipeline.nodeLoadOverview.atItsMaxsessionsCapThe',
                'At its maxSessions cap — the balancer skips it until a session ends.',
              )}
            >
              {t('pipeline.nodeLoadOverview.atCap', '· at cap')}
            </span>
          )}
        </>
      )}
    </li>
  )
}

interface StatProps {
  readonly label: string
  readonly value: string
  readonly title: string
}

function Stat({ label, value, title }: StatProps) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[9px] uppercase tracking-wide text-foreground-subtle">{label}</dt>
      <dd className="truncate font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  )
}
