import type { ReactElement } from 'react'
import { deviceIconGlyph, useDeviceLabel } from '@camstack/ui-library'
import i18n from '../../i18n/index'
import { siteDeviceFields, type SiteDevice } from './site-locations'
/**
 * The two glyphs every Locations row carries: a type icon and a status dot.
 *
 * Shared by the room cards and the unassigned table so a device looks the same
 * on both surfaces — an operator moving a row from the table into a card must
 * recognise it there, and two icon vocabularies would break that.
 */
export interface DeviceTypeIconProps {
  readonly type: string
  /** The device's role, when it has one — it refines the type's icon (`deviceIconKey`). */
  readonly role?: string | null
  readonly className?: string
}

/** The device's icon from the shared type + role resolver — the same one cards, rows and the viewer use. */
export function DeviceTypeIcon({ type, role, className }: DeviceTypeIconProps) {
  const Icon = deviceIconGlyph(type, role)
  return (
    <Icon
      aria-hidden="true"
      className={className ?? 'h-3.5 w-3.5 shrink-0 text-foreground-subtle'}
    />
  )
}

export interface DeviceReachCellProps {
  readonly device: SiteDevice
}

/**
 * A device row's reachability. A reachable device shows a quiet green dot and
 * no word — the absence of Offline already says it. An offline device names
 * itself in text too (a colour-only status is a status half the operators do
 * not get), and the dot carries the device's name for a screen reader.
 */
export function DeviceReachCell({ device }: DeviceReachCellProps): ReactElement {
  const label = useDeviceLabel(siteDeviceFields(device), 'compact')
  if (device.online) {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
        data-status="online"
      />
    )
  }
  const offline = i18n.t('common.offline')
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-foreground-subtle"
        data-status="offline"
        role="img"
        aria-label={i18n.t('locations.deviceGlyphs.aria', { name: label, state: offline })}
        title={offline}
      />
      <span className="text-xs text-foreground-muted">{offline}</span>
    </span>
  )
}
