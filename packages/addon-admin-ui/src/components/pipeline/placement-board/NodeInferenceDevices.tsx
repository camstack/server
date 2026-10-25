/**
 * NodeInferenceDevices — one node's accelerator table on Pipeline → Cluster →
 * Load balancing.
 *
 * One `DataTable` per node: each device the node reports (probed live via
 * `pipelineOrchestrator.getNodeInferenceDevices`), and each device it ONCE had
 * whose settings are still stored — shown ABSENT, with a Forget action (D919).
 * The same row carries the share placement holds for the device
 * (`getEffectiveShares`, with where it comes from) and the sessions it runs now
 * (`getPlacementStats`), so the per-device share lives in this table rather
 * than in a second list. The header's Rescan re-probes the node's accelerators
 * now (`platformProbe.rescanAccelerators`, routed by `nodeId`).
 *
 * Writes go through `setAgentInferenceDevices`, which REPLACES the node's stored
 * map wholesale — we send EVERY reported device with its honest `enabled` bit
 * (via the shared `buildInferenceDevicesWrite`). A disabled device is written
 * as `enabled: false`: the backend resolves an ABSENT key to its policy
 * default, which is ON for every non-CPU accelerator, so pruning disabled rows
 * (the pre-2026-08-01 shape) made "switch it off" store nothing — and nothing
 * meant on. Absence stays reserved for never-configured hardware.
 *
 * Under manual shares the accelerator weights are edited with the
 * `WeightSliderStack` under the table; under automatic shares the system owns
 * them and the table's Share column is the whole story.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  acceleratorLabel,
  Badge,
  Button,
  ConfirmActionButton,
  DataTable,
  type DataColumn,
  Input,
  Switch,
  trpc,
  usePipelineOrchestratorForgetInferenceDevice,
  usePipelineOrchestratorGetNodeInferenceDevices,
  usePipelineOrchestratorSetAgentInferenceDevices,
} from '@camstack/ui-library'
import type {
  DeviceStepConfig,
  EffectiveNodeShare,
  NodeInferenceDevice,
  PlacementNodeStats,
  ShareSource,
} from '@camstack/types'
import {
  ChevronRight,
  CircuitBoard,
  Cpu,
  Layers,
  RefreshCw,
  Scale,
  Trash2,
  Usb,
  WifiOff,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  buildInferenceDevicesWrite,
  type InferenceDeviceWriteSource,
} from '../inference-devices-write'
import {
  WeightSliderStack,
  type WeightCommitEntry,
  type WeightSliderNode,
} from './WeightSliderStack'
import { rootModelIdForDevice } from './root-model-note'
import {
  buildDeviceTableRows,
  DEVICE_STATE_VARIANT,
  type DeviceRowState,
  type DeviceTableRow,
} from './node-device-table-model'
import { Trans, useTranslation } from 'react-i18next'

/** Editable opt-in state for one accelerator (enabled + relative weight + cap +
 *  per-(node,device) BASE step provisioning — the step models are edited on the
 *  per-node Steps matrix, NOT here; this component only preserves them). */
interface DeviceDraft {
  readonly enabled: boolean
  readonly weight: number
  /** Hard ceiling on concurrent sessions the balancer may place; null = unlimited. */
  readonly maxSessions: number | null
  readonly steps: Readonly<Record<string, DeviceStepConfig>>
}

/** Visual identity for a physical accelerator, derived from its device key. */
interface AcceleratorFace {
  readonly label: string
  readonly Icon: LucideIcon
  readonly hue: 'sky' | 'violet' | 'emerald' | 'slate'
}

export function acceleratorFace(device: NodeInferenceDevice): AcceleratorFace {
  const label = acceleratorLabel(device)
  const backend = device.backend.toLowerCase()
  const dev = device.device.toLowerCase()
  if (device.key === 'cpu' || dev === 'cpu') return { label, Icon: Cpu, hue: 'slate' }
  if (dev === 'npu') return { label, Icon: Zap, hue: 'sky' }
  if (dev === 'gpu' || dev === 'igpu') return { label, Icon: CircuitBoard, hue: 'violet' }
  if (backend === 'edgetpu') return { label, Icon: Usb, hue: 'emerald' }
  return { label, Icon: Cpu, hue: 'slate' }
}

/** i18n key + English default of each row state. */
const STATE_TEXT: Readonly<Record<DeviceRowState, readonly [string, string]>> = {
  active: ['placementBoard.nodeInferenceDevices.state.active', 'in use'],
  disabled: ['placementBoard.nodeInferenceDevices.state.disabled', 'switched off'],
  absent: ['placementBoard.nodeInferenceDevices.state.absent', 'absent'],
  unknown: ['placementBoard.nodeInferenceDevices.state.unknown', 'unknown'],
  unavailable: ['placementBoard.nodeInferenceDevices.state.unavailable', 'unavailable'],
  backoff: ['placementBoard.nodeInferenceDevices.state.backoff', 'pool down'],
  'root-incapable': ['placementBoard.nodeInferenceDevices.state.rootIncapable', 'no root model'],
  standby: ['placementBoard.nodeInferenceDevices.state.standby', 'fallback'],
}

/** i18n key + English default of the tooltip that explains each state. */
const STATE_HINT: Readonly<Record<DeviceRowState, readonly [string, string]>> = {
  active: [
    'placementBoard.nodeInferenceDevices.stateHint.active',
    'A camera-root candidate: placement may start sessions on it.',
  ],
  disabled: [
    'placementBoard.nodeInferenceDevices.stateHint.disabled',
    'Switched off: it takes no sessions.',
  ],
  absent: [
    'placementBoard.nodeInferenceDevices.stateHint.absent',
    'The node no longer reports this device (unplugged, or moved to another node). Its settings are kept; it is never used. Forget it to delete them.',
  ],
  unknown: [
    'placementBoard.nodeInferenceDevices.stateHint.unknown',
    "The node's probe did not answer, so whether the device is there is not known.",
  ],
  unavailable: [
    'placementBoard.nodeInferenceDevices.stateHint.unavailable',
    'On the node, but the probe reports it unusable.',
  ],
  backoff: [
    'placementBoard.nodeInferenceDevices.stateHint.backoff',
    'Reported by the node, but its inference pool is down or backing off.',
  ],
  'root-incapable': [
    'placementBoard.nodeInferenceDevices.stateHint.rootIncapable',
    'Its format cannot run the camera root detector; it serves enrichment steps only.',
  ],
  standby: [
    'placementBoard.nodeInferenceDevices.stateHint.standby',
    'The CPU fallback: it takes no sessions while an accelerator is serving this node.',
  ],
}

interface NodeInferenceDevicesProps {
  readonly nodeId: string
  readonly nodeName: string
  readonly isOnline: boolean
  /**
   * ADVISORY session cap per deviceKey from the hardware suggestion (D748).
   * Shown beside the cap with a one-click apply; never written on its own.
   */
  readonly suggestedMaxSessions?: Readonly<Record<string, number | null>>
  /** Where the shares come from; undefined while `getEffectiveShares` loads. */
  readonly shareSource?: ShareSource
  /** True when the system owns the device shares (automatic source, computed). */
  readonly sharesAutomatic: boolean
  /** This node's effective shares (D750); undefined while they load. */
  readonly share?: EffectiveNodeShare
  /** What placement runs on this node now; undefined while it loads. */
  readonly placed?: PlacementNodeStats
}

export function NodeInferenceDevices({
  nodeId,
  nodeName,
  isOnline,
  suggestedMaxSessions,
  shareSource,
  sharesAutomatic,
  share,
  placed,
}: NodeInferenceDevicesProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: nodeDevices, isLoading: devicesLoading } =
    usePipelineOrchestratorGetNodeInferenceDevices({ nodeId }, { refetchInterval: 15_000 })

  // Nested key: tRPC stores queries as `[[router, proc], {input, type}]`.
  const invalidateDevices = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getNodeInferenceDevices']],
    })
  }
  const setDevicesMutation = usePipelineOrchestratorSetAgentInferenceDevices({
    onSettled: invalidateDevices,
  })
  const forgetMutation = usePipelineOrchestratorForgetInferenceDevice({
    onSettled: invalidateDevices,
  })
  const rescanMutation = trpc.platformProbe.rescanAccelerators.useMutation({
    onSettled: invalidateDevices,
  })

  const devices: readonly NodeInferenceDevice[] = nodeDevices?.devices ?? []
  const reachable = nodeDevices?.reachable ?? isOnline

  // Optimistic draft of the opt-in map, keyed by device key. Reseeded from the
  // server whenever the persisted set changes so an in-flight edit isn't
  // clobbered by our own commit round-tripping back.
  const [draft, setDraft] = useState<Record<string, DeviceDraft>>({})
  const signature = devices
    .map(
      (d) => `${d.key}:${d.enabled}:${d.weight}:${d.maxSessions}:${JSON.stringify(d.steps ?? {})}`,
    )
    .join('|')
  useEffect(() => {
    setDraft(Object.fromEntries(devices.map((d) => [d.key, deviceDefault(d)])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const enabledCount = useMemo(
    () => devices.filter((d) => (draft[d.key]?.enabled ?? d.enabled) && d.available).length,
    [devices, draft],
  )

  const [expanded, setExpanded] = useState<boolean | null>(null)
  const isExpanded = expanded ?? true

  /** Commit the FULL device roster — every row, each with its honest `enabled`
   *  bit (see the module doc). Weight floor / cap omission live in
   *  `buildInferenceDevicesWrite`. */
  const commit = (next: Record<string, DeviceDraft>): void => {
    const sources: readonly InferenceDeviceWriteSource[] = devices.map((d) => {
      const state = next[d.key] ?? deviceDefault(d)
      return {
        key: d.key,
        enabled: state.enabled,
        weight: state.weight,
        maxSessions: state.maxSessions,
        steps: state.steps,
      }
    })
    setDevicesMutation.mutate({
      agentNodeId: nodeId,
      inferenceDevices: buildInferenceDevicesWrite(sources),
    })
  }

  const update = (device: NodeInferenceDevice, patch: Partial<DeviceDraft>): void => {
    const current = draft[device.key] ?? deviceDefault(device)
    const next = { ...draft, [device.key]: { ...current, ...patch } }
    setDraft(next)
    commit(next)
  }

  const rows = useMemo(() => buildDeviceTableRows(devices, share, placed), [devices, share, placed])

  const enabledDevices = useMemo(
    () => devices.filter((d) => (draft[d.key]?.enabled ?? d.enabled) && d.available),
    [devices, draft],
  )
  const weightNodes = useMemo<readonly WeightSliderNode[]>(
    () =>
      enabledDevices.map((d) => ({
        id: d.key,
        name: acceleratorFace(d).label,
        weight: draft[d.key]?.weight ?? d.weight,
      })),
    [enabledDevices, draft],
  )

  const commitDeviceWeights = (entries: readonly WeightCommitEntry[]): void => {
    const next = { ...draft }
    for (const entry of entries) {
      const current = next[entry.nodeId]
      if (current) next[entry.nodeId] = { ...current, weight: entry.weight }
    }
    setDraft(next)
    commit(next)
  }

  const pending = setDevicesMutation.isPending || forgetMutation.isPending
  const sourceLabel = shareSourceLabel(t, sharesAutomatic ? shareSource : 'manual')

  const columns: readonly DataColumn<DeviceTableRow>[] = [
    {
      key: 'device',
      header: t('placementBoard.nodeInferenceDevices.colDevice', 'Device'),
      // The key and the root model wrap under the name rather than push the
      // controls off the table.
      nowrap: false,
      sortValue: (row) => acceleratorFace(row.device).label,
      render: (row) => <DeviceCell row={row} steps={draft[row.device.key]?.steps} />,
    },
    {
      key: 'state',
      header: t('placementBoard.nodeInferenceDevices.colState', 'State'),
      sortValue: (row) => row.state,
      render: (row) => (
        <span title={t(STATE_HINT[row.state][0], STATE_HINT[row.state][1])}>
          <Badge variant={DEVICE_STATE_VARIANT[row.state]} size="sm">
            {t(STATE_TEXT[row.state][0], STATE_TEXT[row.state][1])}
          </Badge>
        </span>
      ),
    },
    {
      key: 'share',
      header: t('placementBoard.nodeInferenceDevices.colShare', 'Share'),
      align: 'right',
      sortValue: (row) => row.share?.effectivePct ?? null,
      render: (row) => <ShareCell row={row} sourceLabel={sourceLabel} />,
    },
    {
      key: 'sessions',
      header: t('placementBoard.nodeInferenceDevices.colSessions', 'Sessions'),
      align: 'right',
      sortValue: (row) => row.sessionsNow,
      render: (row) => (
        <span className="tabular-nums text-xs text-foreground">
          {row.sessionsNow ?? '—'}
          {row.atCap && (
            <Badge variant="warning" size="sm" className="ml-1">
              {t('placementBoard.nodeInferenceDevices.atCap', 'at cap')}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'cap',
      header: t('placementBoard.nodeInferenceDevices.colCap', 'Max sessions'),
      notSortableReason: t(
        'placementBoard.nodeInferenceDevices.capNotSortable',
        'An editable field: sort by Sessions instead.',
      ),
      render: (row) => {
        const state = draft[row.device.key] ?? deviceDefault(row.device)
        const enabled = state.enabled && row.device.available
        if (!enabled) return <span className="text-xs text-foreground-subtle">—</span>
        const label = acceleratorFace(row.device).label
        return (
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              min={1}
              placeholder="∞"
              value={state.maxSessions ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim()
                const parsed = raw === '' ? null : Number.parseInt(raw, 10)
                update(row.device, {
                  maxSessions: parsed !== null && parsed > 0 ? parsed : null,
                })
              }}
              disabled={pending}
              aria-label={t(
                'placementBoard.nodeInferenceDevices.maxConcurrentSessionsFor',
                'Max concurrent sessions for {{label}}',
                { label },
              )}
              className="w-16 text-right"
            />
            <SuggestedCap
              suggested={suggestedMaxSessions?.[row.device.key] ?? null}
              current={state.maxSessions}
              pending={pending}
              onApply={(value) => update(row.device, { maxSessions: value })}
            />
          </div>
        )
      },
    },
    {
      key: 'enabled',
      header: t('placementBoard.nodeInferenceDevices.colEnabled', 'Enabled'),
      align: 'right',
      notSortableReason: t(
        'placementBoard.nodeInferenceDevices.enabledNotSortable',
        'A switch: sort by State instead.',
      ),
      render: (row) => {
        const label = acceleratorFace(row.device).label
        if (row.state === 'absent') {
          return (
            <ConfirmActionButton
              label={t('placementBoard.nodeInferenceDevices.forget', 'Forget')}
              icon={Trash2}
              size="sm"
              triggerVariant="ghost"
              disabled={pending}
              title={t(
                'placementBoard.nodeInferenceDevices.forgetTitle',
                'Forget {{label}} on {{node}}?',
                { label, node: nodeName },
              )}
              description={t(
                'placementBoard.nodeInferenceDevices.forgetDescription',
                'Its stored settings (switch, weight, cap, step models) are deleted. If the device comes back it starts from the defaults.',
              )}
              action={() =>
                forgetMutation.mutateAsync({ agentNodeId: nodeId, deviceKey: row.device.key })
              }
            />
          )
        }
        const state = draft[row.device.key] ?? deviceDefault(row.device)
        return (
          <Switch
            checked={state.enabled && row.device.available}
            onCheckedChange={() => update(row.device, { enabled: !state.enabled })}
            disabled={!row.device.available || pending}
            aria-label={t('placementBoard.nodeInferenceDevices.enable', 'Enable {{label}}', {
              label,
            })}
          />
        )
      },
    },
  ]

  const mutationError = setDevicesMutation.error ?? forgetMutation.error ?? rescanMutation.error

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!isExpanded)}
          className="min-w-0 flex-1 justify-start"
          aria-expanded={isExpanded}
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-foreground-subtle transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
          <span className="truncate text-sm font-medium text-foreground">{nodeName}</span>
          <span className="ml-auto flex items-center gap-1 text-xs text-foreground-subtle">
            {!reachable ? (
              <>
                <WifiOff className="h-3.5 w-3.5" /> {t('common.unreachable')}
              </>
            ) : (
              <>
                <Layers className="h-3.5 w-3.5" />
                {t('pipeline.nodeInferenceDevices.accelerators', { count: enabledCount })}
              </>
            )}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => rescanMutation.mutate({ nodeId })}
          disabled={rescanMutation.isPending || !reachable}
          title={t(
            'placementBoard.nodeInferenceDevices.rescanTitle',
            'Probe this node for accelerators now (a Coral plugged in or pulled out). The node also re-probes every minute.',
          )}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${rescanMutation.isPending ? 'animate-spin' : ''}`} />
          {t('placementBoard.nodeInferenceDevices.rescan', 'Rescan')}
        </Button>
      </div>

      {isExpanded && (
        <div className="space-y-3 border-t border-border p-3">
          {!reachable ? (
            <NodeUnreachableState />
          ) : devicesLoading && devices.length === 0 ? (
            <p className="text-center text-xs text-foreground-subtle">
              {t(
                'placementBoard.nodeInferenceDevices.probingAccelerators',
                'Probing accelerators…',
              )}
            </p>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.device.key}
              minWidthPx={640}
              bordered={false}
              emptyMessage={t(
                'placementBoard.nodeInferenceDevices.noInferenceDevicesReportedBy',
                "No inference devices reported by this node's platform probe.",
              )}
            />
          )}

          {rescanMutation.data !== undefined && (
            <p className="text-xs text-foreground-subtle">
              {rescanSummary(t, rescanMutation.data.appeared, rescanMutation.data.disappeared)}
            </p>
          )}

          {reachable && !sharesAutomatic && enabledDevices.length >= 2 && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                <Scale className="h-3.5 w-3.5" />
                {t('placementBoard.nodeInferenceDevices.acceleratorShare', 'Accelerator share')}
              </h4>
              <WeightSliderStack
                nodes={weightNodes}
                pending={pending}
                onCommitWeights={commitDeviceWeights}
                weightLabel="Accelerator share"
                footnote={t(
                  'placementBoard.nodeInferenceDevices.dragToShiftTheShare',
                  'Drag to shift the share of detection sessions each accelerator handles; lock one to pin its share while the others rebalance. Shares always sum to 100%.',
                )}
              />
            </div>
          )}

          {mutationError != null && (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {t(
                'placementBoard.nodeInferenceDevices.failedToSaveInferenceDevices',
                'Failed to save inference devices:',
              )}{' '}
              {mutationError.message}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function deviceDefault(device: NodeInferenceDevice): DeviceDraft {
  return {
    enabled: device.enabled,
    weight: device.weight,
    maxSessions: device.maxSessions,
    steps: device.steps ?? {},
  }
}

type TFn = ReturnType<typeof useTranslation>['t']

function shareSourceLabel(t: TFn, source: ShareSource | undefined): string | null {
  switch (source) {
    case 'benchmark':
      return t('placementBoard.nodeInferenceDevices.sourceBenchmark', 'benchmark')
    case 'hardware':
      return t('placementBoard.nodeInferenceDevices.sourceHardware', 'hardware')
    case 'manual':
      return t('placementBoard.nodeInferenceDevices.sourceManual', 'manual')
    case undefined:
      return null
  }
}

function rescanSummary(
  t: TFn,
  appeared: readonly string[],
  disappeared: readonly string[],
): string {
  if (appeared.length === 0 && disappeared.length === 0)
    return t('placementBoard.nodeInferenceDevices.rescanNoChange', 'Rescanned: no change.')
  return t(
    'placementBoard.nodeInferenceDevices.rescanChanged',
    'Rescanned: appeared {{appeared}} · disappeared {{disappeared}}',
    {
      appeared: appeared.length > 0 ? appeared.join(', ') : '—',
      disappeared: disappeared.length > 0 ? disappeared.join(', ') : '—',
    },
  )
}

interface DeviceCellProps {
  readonly row: DeviceTableRow
  readonly steps: Readonly<Record<string, DeviceStepConfig>> | undefined
}

function DeviceCell({ row, steps }: DeviceCellProps) {
  const face = acceleratorFace(row.device)
  const rootModelId = rootModelIdForDevice({
    defaultModelId: row.device.defaultModelId,
    steps: steps ?? row.device.steps ?? {},
  })
  return (
    <div className="flex min-w-0 items-center gap-2">
      <face.Icon className="h-4 w-4 shrink-0 text-foreground-subtle" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{face.label}</span>
          <Badge variant="neutral" size="sm" className="font-mono">
            {row.device.format}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-foreground-subtle">
          <span className="font-mono">{row.device.key}</span>
          {rootModelId !== null && (
            <>
              <span aria-hidden>·</span>
              <span>
                <Trans
                  i18nKey="pipeline.nodeInferenceDevices.rootModel"
                  values={{ model: rootModelId }}
                  components={{ mono: <span className="font-mono text-foreground-muted" /> }}
                />
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface ShareCellProps {
  readonly row: DeviceTableRow
  readonly sourceLabel: string | null
}

function ShareCell({ row, sourceLabel }: ShareCellProps) {
  const { t } = useTranslation()
  if (row.share === null) return <span className="text-xs text-foreground-subtle">—</span>
  const { configuredPct, effectivePct } = row.share
  const redistributed = Math.round(configuredPct) !== Math.round(effectivePct)
  return (
    <div className="text-right">
      <div className="tabular-nums text-sm text-foreground">{Math.round(effectivePct)}%</div>
      <div className="text-xs text-foreground-subtle">
        {redistributed
          ? t('placementBoard.nodeInferenceDevices.shareConfigured', 'set {{pct}}%', {
              pct: Math.round(configuredPct),
            })
          : null}
        {redistributed && sourceLabel !== null ? ' · ' : null}
        {sourceLabel}
      </div>
    </div>
  )
}

interface SuggestedCapProps {
  readonly suggested: number | null
  readonly current: number | null
  readonly pending: boolean
  readonly onApply: (value: number) => void
}

/** The advisory cap from the hardware suggestion, applied only on a click (D748). */
function SuggestedCap({ suggested, current, pending, onApply }: SuggestedCapProps) {
  const { t } = useTranslation()
  if (suggested === null || suggested < 1 || suggested === current) return null
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onApply(suggested)}
      disabled={pending}
      title={t(
        'placementBoard.nodeInferenceDevices.advisoryCapFromTheMeasured',
        "Advisory cap from the measured throughput at the suggested model, with the headroom kept free. Applying it writes this device's cap.",
      )}
    >
      {t('pipeline.nodeInferenceDevices.use', { value: suggested })}
    </Button>
  )
}

function NodeUnreachableState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <WifiOff className="h-6 w-6 text-foreground-subtle" />
      <p className="text-xs font-medium text-foreground">
        {t('placementBoard.nodeInferenceDevices.nodeUnreachable', 'Node unreachable')}
      </p>
      <p className="max-w-sm text-xs text-foreground-subtle">
        {t(
          'placementBoard.nodeInferenceDevices.thePlatformProbeCouldnT',
          "The platform probe couldn't be reached, so its live accelerator set is unavailable. Settings resume once the node reconnects.",
        )}
      </p>
    </div>
  )
}
