/**
 * The per-row cells of Cluster → Assignments that need a hook of their own:
 * the placement column (node pin + accelerator pin), the resolved node, and
 * the stream-broker drill-down.
 */
import { useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  IconButton,
  Select,
  WidgetSlot,
} from '@camstack/ui-library'
import type { RoleState } from './assignment-rows'
import { DevicePinSelect, NodePinSelect, type NodePinSelectProps } from './PlacementControls'
import { useTranslation } from 'react-i18next'

/**
 * The last placement this camera was OBSERVED on — a render-time latch.
 *
 * An on-motion camera's assignment record exists only WHILE a session runs,
 * and an unpinned camera is re-elected per session (measured 2026-08-21: 57%
 * of sessions landed on another node than the camera's previous one). Shown
 * raw, the row blanked between sessions and remounted its selects several
 * times a minute. Latching the last node keeps the row still; the running /
 * idle word is what moves.
 */
function useLastPlacement(state: RoleState): RoleState | null {
  const last = useRef<RoleState | null>(null)
  if (state.nodeId !== null) last.current = state
  return last.current
}

export interface PlacementCellProps extends Omit<NodePinSelectProps, 'state'> {
  readonly deviceId: number
  readonly state: RoleState
}

/** Node pin, then the accelerator pin on the pinned (else last resolved) node. */
export function PlacementCell({ deviceId, state, ...nodePin }: PlacementCellProps) {
  const { t } = useTranslation()
  const placement = useLastPlacement(state)
  return (
    <div className="grid w-80 grid-cols-2 gap-1.5">
      <NodePinSelect state={state} {...nodePin} />
      {placement?.nodeId != null ? (
        <DevicePinSelect deviceId={deviceId} nodeId={placement.nodeId} />
      ) : (
        <Select
          aria-label={t(
            'assignments.clusterRowCells.inferenceDevicePinNoNode',
            'Inference device pin (no node yet)',
          )}
          title={t(
            'assignments.clusterRowCells.anAcceleratorIsPinnedOn',
            "An accelerator is pinned on the camera's node; this camera has not run on one yet.",
          )}
          disabled
          defaultValue="auto"
          options={[
            {
              value: 'auto',
              label: t('assignments.clusterRowCells.anyAccelerator', 'Any accelerator'),
            },
          ]}
        />
      )}
    </div>
  )
}

export function ResolvedPlacementCell({
  state,
  nameOf,
}: {
  readonly state: RoleState
  readonly nameOf: (nodeId: string) => string
}) {
  const { t } = useTranslation()
  const placement = useLastPlacement(state)
  if (placement?.nodeId == null) {
    return (
      <span className="text-[11px] text-foreground-subtle">
        {t('assignments.clusterRowCells.noSessionYet', '— no session yet')}
      </span>
    )
  }
  const running = state.active && state.nodeId !== null
  const how = placement.pinned ? 'pinned' : `auto · ${placement.reason || 'capacity'}`
  return (
    <div
      data-testid="resolved-placement"
      className="flex w-40 min-w-0 flex-col leading-tight"
      title={
        placement.pinned
          ? undefined
          : t(
              'assignments.clusterRowCells.anUnpinnedCameraIsPlaced',
              'An unpinned camera is placed again at every session start, so this can change between sessions.',
            )
      }
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'bg-success' : 'bg-foreground-subtle/40'}`}
        />
        <span
          data-testid="resolved-placement-node"
          className={`truncate font-medium ${running ? 'text-foreground' : 'text-foreground-muted'}`}
        >
          {nameOf(placement.nodeId)}
        </span>
      </span>
      <span
        className={`truncate pl-3 text-[10px] ${placement.pinned ? 'text-warning' : 'text-foreground-subtle'}`}
      >
        {running
          ? how
          : t('assignments.clusterRowCells.idleLastSession', '{{how}} · idle, last session', {
              how,
            })}
      </span>
    </div>
  )
}

/** The per-camera stream brokers and clients, in a dialog rather than an expanding row. */
export function BrokerDrillDown({
  deviceId,
  deviceName,
}: {
  readonly deviceId: number
  readonly deviceName: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        icon={Radio}
        variant="ghost"
        size="sm"
        aria-label={t(
          'assignments.clusterRowCells.streamBrokersOf',
          'Stream brokers of {{deviceName}}',
          { deviceName },
        )}
        title={t('assignments.clusterRowCells.streamBrokersClients', 'Stream brokers & clients')}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent width="lg" scroll="body" placement="sheet-on-mobile">
          <DialogHeader>
            <DialogTitle>
              {t('pipeline.clusterRowCells.brokersTitle', { device: deviceName })}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {open && (
              <WidgetSlot
                widgetId="stream-broker/stream-broker-panel"
                host="device-tab"
                deviceId={deviceId}
                instanceId={`pipeline-row/${deviceId}`}
                config={{ variant: 'compact' }}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
