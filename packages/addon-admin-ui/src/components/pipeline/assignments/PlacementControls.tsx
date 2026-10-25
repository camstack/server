/**
 * The placement column of Cluster → Assignments: WHERE a camera's detection
 * may run — a node pin and, on that node, an accelerator pin. Both are the
 * library `Select`; this is the only place either is edited from the table.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  acceleratorLabel,
  Select,
  usePipelineOrchestratorGetNodeInferenceDevices,
  usePipelineOrchestratorGetPipelineDevicePin,
  usePipelineOrchestratorSetPipelineDevicePin,
} from '@camstack/ui-library'
import { nodePinOptions, type RoleState } from './assignment-rows'
import { useTranslation } from 'react-i18next'

/**
 * Freshness window for a node's accelerator roster (`getNodeInferenceDevices`).
 * That call is a live cross-node platform probe, and the roster only changes
 * when the operator edits device config or hardware moves — never on a session
 * dispatch. Writes invalidate the query explicitly.
 */
const NODE_DEVICES_STALE_MS = 300_000

interface NamedNode {
  readonly id: string
  readonly name: string
}

export interface NodePinSelectProps {
  readonly state: RoleState
  readonly onlineNodes: readonly NamedNode[]
  readonly nameOf: (nodeId: string) => string
  readonly pending: boolean
  /** `'auto'` unpins; anything else is a node id. */
  readonly onChange: (target: string) => void
}

export function NodePinSelect({
  state,
  onlineNodes,
  nameOf,
  pending,
  onChange,
}: NodePinSelectProps) {
  const { t } = useTranslation()
  return (
    <Select
      aria-label={t('assignments.placementControls.nodePin', 'Node pin')}
      title={t(
        'assignments.placementControls.autoLetsEachSessionPick',
        'Auto lets each session pick its node; a pin keeps the camera on one node.',
      )}
      value={state.pinned && state.nodeId !== null ? state.nodeId : 'auto'}
      disabled={pending}
      options={[...nodePinOptions(state, onlineNodes, nameOf)]}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export interface DevicePinSelectProps {
  readonly deviceId: number
  /** The node whose accelerators are offered: the pinned node, else the last one it ran on. */
  readonly nodeId: string
}

/**
 * The accelerator pin (soft affinity on the camera's node). Mounts only once
 * both the pin and the node's roster have answered: a controlled select that
 * mounts before its option exists falls back to the first option ("Auto") and
 * does not always re-sync when the option appears.
 */
export function DevicePinSelect({ deviceId, nodeId }: DevicePinSelectProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: pin } = usePipelineOrchestratorGetPipelineDevicePin(
    { deviceId },
    { refetchOnMount: 'always' },
  )
  // Not `refetchOnMount: 'always'`: this is a live probe of the node, and the
  // roster does not change on a dispatch.
  const { data: nodeDevices } = usePipelineOrchestratorGetNodeInferenceDevices(
    { nodeId },
    { staleTime: NODE_DEVICES_STALE_MS },
  )
  const setDevicePin = usePipelineOrchestratorSetPipelineDevicePin({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getPipelineDevicePin']],
      })
    },
  })

  if (pin === undefined || nodeDevices === undefined) {
    return (
      <span className="text-[10px] italic text-foreground-subtle">
        {t('assignments.placementControls.accelerator', 'accelerator: …')}
      </span>
    )
  }

  const devices = nodeDevices.devices ?? []
  const enabled = devices.filter((d) => d.enabled)
  const value = pin?.deviceKey ?? 'auto'
  // A pin to an accelerator the node no longer offers stays visible, selected.
  const pinnedMissing = value !== 'auto' && !enabled.some((d) => d.key === value)
  const pinnedDevice = devices.find((d) => d.key === value)
  const options = [
    { value: 'auto', label: t('assignments.placementControls.anyAccelerator', 'Any accelerator') },
    ...(pinnedMissing
      ? [
          {
            value,
            label: t('pipeline.placementControls.notEnabled', {
              name: pinnedDevice ? `${acceleratorLabel(pinnedDevice)} (${value})` : value,
            }),
          },
        ]
      : []),
    ...enabled.map((d) => ({ value: d.key, label: `${acceleratorLabel(d)} · ${d.format}` })),
  ]
  return (
    <Select
      aria-label={t('assignments.placementControls.inferenceDevicePin', 'Inference device pin')}
      title={t(
        'assignments.placementControls.pinDetectionToOneAccelerator',
        'Pin detection to one accelerator of the node, or let each session pick.',
      )}
      value={value}
      disabled={setDevicePin.isPending}
      options={options}
      onChange={(event) => setDevicePin.mutate({ deviceId, deviceKey: event.target.value })}
    />
  )
}
