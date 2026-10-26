/**
 * <DeviceItemPreview> — type-dispatched preview slot.
 *
 * Renders, in order:
 *   1. Status pills — battery %, charging plug, sleeping moon (when
 *      the device exposes a battery slice). These were previously in
 *      the Features cell; they belong here because they describe the
 *      preview-relevant state (a sleeping cam can't snapshot, a low
 *      battery cam may drop frames).
 *   2. Snapshot thumbnail — a small camera snapshot that expands into a
 *      portal-positioned enlarged preview on hover/focus (shared
 *      `HoverZoomImage`). The portal + flip-on-collision keep the preview
 *      from being clipped by the device-grid's overflow ancestors. Gated
 *      on `enabled` (camera + showSnapshot flag) AND device.online for the
 *      live snapshot fetch; offline/unfetched shows a placeholder box so
 *      the cell stays compact.
 *
 * The status-pills section renders for ANY battery-operated device,
 * camera or otherwise; the snapshot thumbnail stays gated on cameras.
 */
import { type ReactNode } from 'react'
import { useDeviceBattery } from '../../hooks/use-device-battery'
import { useDeviceNetworkLink } from '../../hooks/use-device-network-link'
import { useDeviceSnapshotImage } from '../../hooks/use-device-snapshot'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { BatteryBadge } from '../battery-badge'
import { NetworkLinkBadge } from '../network-link-badge'
import { HoverZoomImage } from '../hover-zoom-image'
import { useDeviceLabel } from '../device-name'
import type { DeviceItemDevice } from './helpers'

export interface DeviceItemPreviewProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly status: 'online' | 'offline' | 'disabled'
  /**
   * Render gate for the snapshot thumbnail (typically
   * `flags.showSnapshot && isCamera` from the orchestrator). Even when
   * `false`, the component still renders the status-pills row when
   * `showStatusPills` is on.
   */
  readonly enabled: boolean
  /**
   * When true, render the battery / charging / sleeping pills next to
   * the snapshot thumbnail. Driven by table view (where the Preview cell
   * is the natural home for status indicators); off in card view to keep
   * the row narrow.
   */
  readonly showStatusPills?: boolean
}

/** Ladder rung for the device-row preview: sharp at 28 px, sharp enough at
 *  the 288 px hover zoom. */
const PREVIEW_SNAPSHOT_WIDTH = 480

export function DeviceItemPreview({
  trpc,
  device,
  status,
  enabled,
  showStatusPills = false,
}: DeviceItemPreviewProps): ReactNode {
  const liveActive = enabled && device.online
  const deviceLabel = useDeviceLabel(device, 'compact')
  // 480 px covers both states this one `src` has to serve: a 28 px thumbnail
  // and the 288 x 196 hover-zoom portal. It used to be the frame AS CAPTURED —
  // a 4 K JPEG, base64 over the WebSocket, into a 28 px box, once per camera row.
  const snapshot = useDeviceSnapshotImage(liveActive ? device.id : null, {
    width: PREVIEW_SNAPSHOT_WIDTH,
  })

  const isBatteryOperated = (device.features ?? []).includes('battery-operated')
  const wantPills = showStatusPills && isBatteryOperated && !device.disabled
  const batteryStatus = useDeviceBattery(trpc, wantPills ? device.id : null)
  // The link pill needs no feature flag: a device without the cap has no
  // slice and the badge renders nothing. Gated on the same operator switch.
  const wantLinkPill = showStatusPills && !device.disabled
  const linkStatus = useDeviceNetworkLink(trpc, wantLinkPill ? device.id : null)

  if (!enabled && !wantPills && !(wantLinkPill && linkStatus)) return null

  const offline = status === 'offline' || status === 'disabled'
  const placeholder =
    status === 'offline'
      ? 'Offline — no snapshot'
      : status === 'disabled'
        ? 'Disabled'
        : 'No snapshot yet'

  return (
    <span className="inline-flex items-center gap-1.5 flex-nowrap whitespace-nowrap">
      {wantPills && batteryStatus && <BatteryBadge status={batteryStatus} />}
      {wantLinkPill && <NetworkLinkBadge status={linkStatus} />}
      {enabled && (
        <HoverZoomImage
          src={offline ? null : snapshot.src}
          alt={deviceLabel}
          placeholder={placeholder}
          thumbClassName="h-7 w-7 rounded"
        />
      )}
    </span>
  )
}
