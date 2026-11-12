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

export interface StatusDotProps {
  readonly online: boolean
  /** Name of the device the dot belongs to — the dot's only accessible text. */
  readonly deviceName: string
}

/**
 * Online/offline as a dot, with the state ALSO in text for a reader that
 * cannot see colour. A colour-only status is a status half the operators do
 * not get.
 */
interface LabeledStatusDotProps {
  readonly device: SiteDevice
}

/** Status dot named with the same label the row paints. */
export function LabeledStatusDot({ device }: LabeledStatusDotProps): ReactElement {
  const label = useDeviceLabel(siteDeviceFields(device), 'compact')
  return <StatusDot online={device.online} deviceName={label} />
}

export function StatusDot({ online, deviceName }: StatusDotProps) {
  return (
    <span
      className={
        online
          ? 'inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success'
          : 'inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-foreground-subtle'
      }
      role="img"
      aria-label={i18n.t('locations.deviceGlyphs.aria', {
        name: deviceName,
        state: online ? i18n.t('common.online') : i18n.t('common.offline'),
      })}
      title={online ? i18n.t('common.online') : i18n.t('common.offline')}
    />
  )
}
