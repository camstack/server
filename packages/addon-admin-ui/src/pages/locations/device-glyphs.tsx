import type { ReactElement } from 'react'
import { useDeviceLabel } from '@camstack/ui-library'
import i18n from '../../i18n/index'
import { siteDeviceFields, type SiteDevice } from './site-locations'
/**
 * The two glyphs every Locations row carries: a type icon and a status dot.
 *
 * Shared by the room cards and the unassigned table so a device looks the same
 * on both surfaces — an operator moving a row from the table into a card must
 * recognise it there, and two icon vocabularies would break that.
 */
import {
  Activity,
  AirVent,
  AlarmSmoke,
  ArrowUpCircle,
  BellRing,
  Blinds,
  Bot,
  Boxes,
  Camera,
  CircleDot,
  CloudSun,
  Droplet,
  Droplets,
  Fan,
  Flame,
  Image,
  Lightbulb,
  Lock,
  type LucideIcon,
  Router,
  ScrollText,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Speaker,
  Thermometer,
  ToggleRight,
  Tractor,
  UserRound,
  Workflow,
  Zap,
} from 'lucide-react'

/**
 * `DeviceType` → icon. Keyed by the WIRE value (the enum's string), not by the
 * enum member, because the page reads `String(device.type)` off a slim
 * projection and a provider is free to stamp a type this map has never seen.
 * An unknown type falls back rather than rendering nothing — a row with no
 * icon reads as a broken row.
 */
const DEVICE_TYPE_ICONS: Readonly<Record<string, LucideIcon>> = {
  camera: Camera,
  hub: Router,
  container: Boxes,
  light: Lightbulb,
  siren: Siren,
  switch: ToggleRight,
  sensor: Activity,
  thermostat: Thermometer,
  climate: AirVent,
  button: CircleDot,
  'event-emitter': Zap,
  update: ArrowUpCircle,
  notifier: BellRing,
  script: ScrollText,
  automation: Workflow,
  lock: Lock,
  cover: Blinds,
  valve: Droplet,
  humidifier: Droplets,
  'water-heater': Flame,
  fan: Fan,
  'media-player': Speaker,
  'alarm-panel': ShieldAlert,
  control: SlidersHorizontal,
  presence: UserRound,
  weather: CloudSun,
  vacuum: Bot,
  'lawn-mower': Tractor,
  image: Image,
  smoke: AlarmSmoke,
}

export interface DeviceTypeIconProps {
  readonly type: string
  readonly className?: string
}

export function DeviceTypeIcon({ type, className }: DeviceTypeIconProps) {
  const Icon = DEVICE_TYPE_ICONS[type] ?? CircleDot
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
