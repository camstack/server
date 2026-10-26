/**
 * DeviceDeleteAction — built-in confirmed per-row delete trash button.
 *
 * The unified device table owns delete as a first-class action: when a
 * consumer passes `onDelete` to `<DeviceList>`/`<DeviceItem>`, this red trash
 * button renders in the merged previewActions cell. Delete is destructive, so
 * it MUST ask first — clicking the trash opens the shared centered confirm
 * dialog (`useConfirm`, provider mounted app-wide) and only calls `onDelete`
 * once the operator confirms.
 *
 * Cap/feature-agnostic by design: delete is generic and never branches on the
 * device's capabilities. Context gating lives entirely at the call site — a
 * consumer that doesn't pass `onDelete` gets no trash.
 *
 * Encapsulating `useConfirm` here (rather than inline in the row) keeps the
 * presentational `DeviceItemTableRow` free of side-effecting hooks and lets
 * the trash + confirm contract be tested in isolation.
 */
import { type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceLabel } from '../device-name'
import { useConfirm } from '../confirm-dialog'
import { IconAction } from '../device-list/icon-action'
import type { DeviceItemDevice } from './helpers'

export interface DeviceDeleteActionProps {
  readonly device: DeviceItemDevice
  /** Called only after the operator confirms the destructive delete. */
  readonly onDelete: (device: DeviceItemDevice) => void
}

export function DeviceDeleteAction({ device, onDelete }: DeviceDeleteActionProps): ReactNode {
  const t = useUiText()
  const confirm = useConfirm()
  const deviceLabel = useDeviceLabel(device, 'full')

  const requestDelete = async (): Promise<void> => {
    const label = deviceLabel.trim() !== '' ? deviceLabel : `#${String(device.id)}`
    const confirmed = await confirm({
      title: t('uiLibrary.deviceDeleteAction.title', 'Delete device?'),
      message: t(
        'uiLibrary.deviceDeleteAction.message',
        'This will remove "{{label}}" and all its settings. This action cannot be undone.',
        { label },
      ),
      confirmLabel: t('uiLibrary.deviceDeleteAction.confirm', 'Delete'),
      variant: 'danger',
    })
    if (confirmed) onDelete(device)
  }

  // Wrap in a stopPropagation span so a click on the trash never bubbles to the
  // row's navigate/select handler. The IconAction's own onClick fires the
  // confirm flow; we intentionally do not await it inside the handler (fire and
  // forget — the dialog drives the rest).
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <IconAction
        icon={Trash2}
        label={t('uiLibrary.deviceDeleteAction.deleteDevice', 'Delete device')}
        danger
        onClick={() => {
          void requestDelete()
        }}
      />
    </span>
  )
}
