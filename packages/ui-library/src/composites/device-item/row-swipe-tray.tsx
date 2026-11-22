/**
 * <DeviceRowSwipeTray> — everything a device row offers beyond its main
 * control, on a phone.
 *
 * Below `md` a device row is its full name, its one main control and its
 * status dot. The rest lives in this tray, which a left swipe (or keyboard
 * focus) brings in from the row's right edge, in this order: the device's most
 * important action (`lead` — a timed run, a camera's PTZ, the list's own row
 * action), then Open and Delete, then the remaining ones (`rest`). The row
 * mounts the tray only below `md`; a wide row keeps its inline buttons.
 */
import { ArrowUpRight, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import {
  type SwipeAction,
  type SwipeActionsState,
  SwipeActionsTray,
} from '../../primitives/swipe-actions'
import { useConfirmedDeviceDelete } from './device-delete-action'
import type { DeviceItemDevice } from './helpers'

export interface DeviceRowSwipeTrayProps {
  readonly swipe: SwipeActionsState
  readonly device: DeviceItemDevice
  /** The row's label, for the tray's accessible name. */
  readonly rowLabel: string
  readonly onOpenPage: ((deviceId: number) => void) | null
  /** Called only after the operator confirms. */
  readonly onDelete: ((device: DeviceItemDevice) => void) | null
  /** The device's most important action; shown first. */
  readonly lead?: ReactNode
  /** The remaining controls; shown last. */
  readonly rest?: ReactNode
}

export function DeviceRowSwipeTray(props: DeviceRowSwipeTrayProps): ReactNode {
  // The confirmed delete needs the confirm dialog's provider, which a list
  // that deletes nothing may not have: only a deleting row asks for it.
  return props.onDelete === null ? (
    <TrayBody {...props} deleteAction={null} />
  ) : (
    <DeletingTray {...props} onDelete={props.onDelete} />
  )
}

interface DeletingTrayProps extends DeviceRowSwipeTrayProps {
  readonly onDelete: (device: DeviceItemDevice) => void
}

function DeletingTray(props: DeletingTrayProps): ReactNode {
  const t = useUiText()
  const requestDelete = useConfirmedDeviceDelete(props.device, props.onDelete)
  const deleteAction: SwipeAction = {
    id: 'delete',
    label: t('uiLibrary.deviceDeleteAction.confirm', 'Delete'),
    icon: Trash2,
    danger: true,
    onClick: requestDelete,
  }
  return <TrayBody {...props} deleteAction={deleteAction} />
}

interface TrayBodyProps extends DeviceRowSwipeTrayProps {
  readonly deleteAction: SwipeAction | null
}

function TrayBody({
  swipe,
  device,
  rowLabel,
  onOpenPage,
  lead,
  rest,
  deleteAction,
}: TrayBodyProps): ReactNode {
  const t = useUiText()
  const actions: readonly SwipeAction[] = [
    ...(onOpenPage !== null
      ? [
          {
            id: 'open',
            label: t('uiLibrary.deviceRow.open', 'Open'),
            icon: ArrowUpRight,
            onClick: () => onOpenPage(device.id),
          },
        ]
      : []),
    ...(deleteAction !== null ? [deleteAction] : []),
  ]
  return (
    <SwipeActionsTray
      swipe={swipe}
      actions={actions}
      lead={lead}
      label={t('uiLibrary.deviceRow.actions', 'Actions for {{name}}', { name: rowLabel })}
    >
      {rest}
    </SwipeActionsTray>
  )
}
