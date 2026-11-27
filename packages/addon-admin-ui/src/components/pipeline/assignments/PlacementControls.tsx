/**
 * The placement column of Cluster → Assignments: WHERE a camera's detection
 * may run — a node pin and, on that node, an accelerator pin. Both are the
 * library `Select`. Neither writes: a pick lands in the table's draft and is
 * saved with the table's Save bar (planning#675).
 */
import {
  acceleratorLabel,
  Select,
  usePipelineOrchestratorGetNodeInferenceDevices,
  usePipelineOrchestratorGetPipelineDevicePin,
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

/** What the operator picked for one camera and has not saved; an absent field is untouched. */
export interface PlacementDraft {
  /** `'auto'` unpins; anything else is a node id. */
  readonly node?: string
  /** `'auto'` is any accelerator; anything else is a device key. */
  readonly devicePin?: string
}

interface NamedNode {
  readonly id: string
  readonly name: string
}

export interface NodePinSelectProps {
  readonly state: RoleState
  readonly onlineNodes: readonly NamedNode[]
  readonly nameOf: (nodeId: string) => string
  readonly pending: boolean
  /** The unsaved pick, shown instead of the served pin. */
  readonly draft?: string
  /** `'auto'` unpins; anything else is a node id. Held in the draft, not written. */
  readonly onChange: (target: string) => void
}

export function NodePinSelect({
  state,
  onlineNodes,
  nameOf,
  pending,
  draft,
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
      value={draft ?? (state.pinned && state.nodeId !== null ? state.nodeId : 'auto')}
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
  /** The unsaved pick, shown instead of the served pin. */
  readonly draft?: string
  /** Held in the draft, not written; `undefined` means the pick equals the served pin. */
  readonly onDraft: (deviceKey: string | undefined) => void
  /** A node change is pending: this node's accelerators no longer apply to where the camera will run. */
  readonly disabled?: boolean
}

/**
 * The accelerator pin (soft affinity on the camera's node). Mounts only once
 * both the pin and the node's roster have answered: a controlled select that
 * mounts before its option exists falls back to the first option ("Auto") and
 * does not always re-sync when the option appears.
 */
export function DevicePinSelect({
  deviceId,
  nodeId,
  draft,
  onDraft,
  disabled,
}: DevicePinSelectProps) {
  const { t } = useTranslation()
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
  if (pin === undefined || nodeDevices === undefined) {
    return (
      <span className="text-[10px] italic text-foreground-subtle">
        {t('assignments.placementControls.accelerator', 'accelerator: …')}
      </span>
    )
  }

  const devices = nodeDevices.devices ?? []
  const enabled = devices.filter((d) => d.enabled)
  const served = pin?.deviceKey ?? 'auto'
  const value = draft ?? served
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
      options={options}
      {...(disabled === true ? { disabled: true } : {})}
      onChange={(event) => onDraft(event.target.value === served ? undefined : event.target.value)}
    />
  )
}
