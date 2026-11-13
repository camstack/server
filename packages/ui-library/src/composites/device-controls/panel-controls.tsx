/**
 * Panel-backed InlineControl and HeroCard wrappers for all non-Cover actuator types.
 *
 * Each wrapper:
 *  - Guards on `cap === undefined` → returns null (device has no such cap).
 *    Never disappears on a transient undefined slice; the panel itself handles that.
 *  - InlineControl: renders the panel at layout="compact" (row-sized).
 *  - HeroCard: renders the panel at layout="full" in the standard hero shell
 *    (rounded-lg border border-border bg-surface p-4, matching CoverHeroCard's shell).
 *
 * Mapped types:
 *   Switch / Siren → SwitchPanel
 *   Lock           → LockPanel
 *   Light          → SwitchPanel + BrightnessPanel (switch toggle + brightness slider)
 *   Fan            → SwitchPanel + FanPanel
 *   Thermostat     → ClimatePanel
 *   MediaPlayer    → MediaPlayerPanel
 *   Control        → ControlPanel
 */
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { ConnectedClimateCard } from '../device-card/connected/ConnectedClimateCard'
import {
  type ConnectedCardKind,
  ConnectedDeviceCard,
  useConnectedCardKind,
} from '../device-card/connected/ConnectedDeviceCard'
import { ConnectedPlugCard } from '../device-card/connected/ConnectedPlugCard'
import { ConnectedSirenCard } from '../device-card/connected/ConnectedSirenCard'
import { AcPanel } from './ac-panel'
import { BrightnessPanel } from './brightness-panel'
import { ClimatePanel } from './climate-panel'
import { ControlPanel } from './control-panel'
import type { DeviceControlProps } from './control-registry'
import { DummyHeroCard } from './dummy-hero-card'
import { FanPanel } from './fan-panel'
import { HeatingValveReadout } from './heating-valve-readout'
import { LockPanel } from './lock-panel'
import { MediaPlayerPanel } from './media-player-panel'
import { SwitchPanel } from './switch-panel'

// AlarmPanelInlineControl is the row-sized compact strip; AlarmHeroCard the
// full glyph+label+segments surface. Both live in alarm-hero-card.tsx and
// subscribe to the cap once (no double useDeviceCapability).
export { AlarmHeroCard, AlarmInlineControl as AlarmPanelInlineControl } from './alarm-hero-card'
export { FanHeroCard } from './fan-hero-card'
export { LightHeroCard } from './light-hero-card'
export { LockHeroCard } from './lock-hero-card'
// Script and Automation share one file: same shape (a thing that runs, a last
// run, an error), differing in one button.
export {
  AutomationHeroCard,
  AutomationInlineControl,
  ScriptHeroCard,
  ScriptInlineControl,
} from './script-automation-controls'

// ── Hero shell ────────────────────────────────────────────────────────────────

interface HeroShellProps {
  readonly children: ReactNode
}

/** Matches CoverHeroCard's outer container — real design tokens only. */
function HeroShell({ children }: HeroShellProps): ReactNode {
  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-surface p-4">
      {children}
    </div>
  )
}

// ── Switch / Siren ────────────────────────────────────────────────────────────

/** Cap guard: returns null when device has no `switch` cap. */
function useSwitchCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.switch,
    slice: (d) => d.state.switch,
  })
  return cap !== undefined
}

export function SwitchInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasSwitch = useSwitchCapGuard(trpc, deviceId)
  if (!hasSwitch) return null
  return (
    <SwitchPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

// ── Lock ──────────────────────────────────────────────────────────────────────

function useLockCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.lockControl,
    slice: (d) => d.state.lockControl,
  })
  return cap !== undefined
}

export function LockInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasLock = useLockCapGuard(trpc, deviceId)
  if (!hasLock) return null
  return (
    <LockPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

// ── Light ─────────────────────────────────────────────────────────────────────
// Light = switch toggle + optional brightness slider.
// Guard on switch cap (always present on a Light device).

export function LightInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasSwitch = useSwitchCapGuard(trpc, deviceId)
  if (!hasSwitch) return null
  return (
    <div className="inline-flex items-center gap-2">
      <SwitchPanel
        trpc={trpc}
        deviceId={deviceId}
        features={features}
        layout="compact"
        optimistic={optimistic}
      />
      <BrightnessPanel
        trpc={trpc}
        deviceId={deviceId}
        features={features}
        layout="compact"
        optimistic={optimistic}
      />
    </div>
  )
}

// LightHeroCard lives in light-hero-card.tsx (radial dimmer + tap toggle + CT
// strip) and is re-exported above — it supersedes the panel-stack hero.

// ── Fan ───────────────────────────────────────────────────────────────────────
// Fan = switch toggle + fan-specific controls (speed/preset).
// Guard on fanControl cap.

function useFanCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.fanControl,
    slice: (d) => d.state.fanControl,
  })
  return cap !== undefined
}

export function FanInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasFan = useFanCapGuard(trpc, deviceId)
  if (!hasFan) return null
  return (
    <div className="inline-flex items-center gap-2">
      <SwitchPanel
        trpc={trpc}
        deviceId={deviceId}
        features={features}
        layout="compact"
        optimistic={optimistic}
      />
      <FanPanel
        trpc={trpc}
        deviceId={deviceId}
        features={features}
        layout="compact"
        optimistic={optimistic}
      />
    </div>
  )
}

// FanHeroCard lives in fan-hero-card.tsx (radial speed dial + tap toggle +
// oscillate) and is re-exported above — it supersedes the panel-stack hero.

// ── Thermostat (climate) ──────────────────────────────────────────────────────

function useClimateCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.climateControl,
    slice: (d) => d.state.climateControl,
  })
  return cap !== undefined
}

function useHeatingValveCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.heatingValve,
    slice: (d) => d.state.heatingValve,
  })
  return cap !== undefined
}

export function ThermostatInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasClimate = useClimateCapGuard(trpc, deviceId)
  const hasValve = useHeatingValveCapGuard(trpc, deviceId)
  if (!hasClimate && !hasValve) return null
  return (
    <span className="inline-flex items-center gap-2">
      {hasClimate ? (
        <ClimatePanel
          trpc={trpc}
          deviceId={deviceId}
          features={features}
          layout="compact"
          optimistic={optimistic}
        />
      ) : null}
      {hasValve ? <HeatingValveReadout trpc={trpc} deviceId={deviceId} layout="compact" /> : null}
    </span>
  )
}

// ── Climate (air-conditioner) ─────────────────────────────────────────────────

export function AcInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasClimate = useClimateCapGuard(trpc, deviceId)
  if (!hasClimate) return null
  return (
    <AcPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

/**
 * The plug and climate heroes ARE the device card (`composites/device-card`):
 * one frame for every device type, the scene filling its zones. The registry
 * keeps handing a hero per control kind; these two adapt its props.
 */
export function PlugCardHero({ deviceId, optimistic }: DeviceControlProps): ReactNode {
  // A siren device or a switch in the siren role is drawn as the siren.
  const kind = useConnectedCardKind(deviceId)
  if (kind === 'pending') return null
  if (kind === 'siren') return <ConnectedSirenCard deviceId={deviceId} optimistic={optimistic} />
  return <ConnectedPlugCard deviceId={deviceId} optimistic={optimistic} />
}

export function ClimateCardHero({ deviceId, optimistic }: DeviceControlProps): ReactNode {
  return <ConnectedClimateCard deviceId={deviceId} optimistic={optimistic} />
}

/**
 * The card of a device whose scene depends on what it binds (a dishwasher
 * that speaks for itself, or one known only by its supply): drawn only when
 * the bindings name one of `kinds`, nothing while they are still unknown.
 */
function ResolvedCardHero({
  deviceId,
  optimistic,
  kinds,
}: DeviceControlProps & { readonly kinds: readonly ConnectedCardKind[] }): ReactNode {
  const kind = useConnectedCardKind(deviceId)
  if (kind === null || kind === 'pending' || !kinds.includes(kind)) return null
  return <ConnectedDeviceCard kind={kind} deviceId={deviceId} optimistic={optimistic} />
}

const APPLIANCE_KINDS: readonly ConnectedCardKind[] = ['appliance']
const DISHWASHER_KINDS: readonly ConnectedCardKind[] = ['dishwasher', 'appliance']
const MEDIA_KINDS: readonly ConnectedCardKind[] = ['media']
const VACUUM_KINDS: readonly ConnectedCardKind[] = ['vacuum']
const MOWER_KINDS: readonly ConnectedCardKind[] = ['mower']
const WATER_HEATER_KINDS: readonly ConnectedCardKind[] = ['water-heater']
const ENERGY_KINDS: readonly ConnectedCardKind[] = ['energy']
const LOCK_KINDS: readonly ConnectedCardKind[] = ['lock']
const ALARM_KINDS: readonly ConnectedCardKind[] = ['alarm']
const HUMIDIFIER_KINDS: readonly ConnectedCardKind[] = ['humidifier']
const VALVE_KINDS: readonly ConnectedCardKind[] = ['valve']
const PET_FEEDER_KINDS: readonly ConnectedCardKind[] = ['pet-feeder']
const PET_FOUNTAIN_KINDS: readonly ConnectedCardKind[] = ['pet-fountain']
const WEATHER_KINDS: readonly ConnectedCardKind[] = ['weather']

export function ApplianceCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={APPLIANCE_KINDS} />
}

export function DishwasherCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={DISHWASHER_KINDS} />
}

export function MediaCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={MEDIA_KINDS} />
}

export function VacuumCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={VACUUM_KINDS} />
}

export function MowerCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={MOWER_KINDS} />
}

export function WaterHeaterCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={WATER_HEATER_KINDS} />
}

export function EnergyCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={ENERGY_KINDS} />
}

export function LockCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={LOCK_KINDS} />
}

export function AlarmCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={ALARM_KINDS} />
}

export function HumidifierCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={HUMIDIFIER_KINDS} />
}

export function ValveCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={VALVE_KINDS} />
}

export function PetFeederCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={PET_FEEDER_KINDS} />
}

export function PetFountainCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={PET_FOUNTAIN_KINDS} />
}

export function WeatherCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={WEATHER_KINDS} />
}

const BUTTON_KINDS: readonly ConnectedCardKind[] = ['button']
const UPDATE_KINDS: readonly ConnectedCardKind[] = ['update']
const SCRIPT_KINDS: readonly ConnectedCardKind[] = ['script']
const AUTOMATION_KINDS: readonly ConnectedCardKind[] = ['automation']
const CONTROL_KINDS: readonly ConnectedCardKind[] = ['control']
const IMAGE_KINDS: readonly ConnectedCardKind[] = ['image']
/** The `dummy` control kind's types that have a card of their own. */
const DUMMY_CARD_KINDS: readonly ConnectedCardKind[] = ['event', 'notifier', 'gateway']

export function ButtonCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={BUTTON_KINDS} />
}

export function UpdateCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={UPDATE_KINDS} />
}

export function ScriptCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={SCRIPT_KINDS} />
}

export function AutomationCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={AUTOMATION_KINDS} />
}

export function ControlCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={CONTROL_KINDS} />
}

export function ImageCardHero(props: DeviceControlProps): ReactNode {
  return <ResolvedCardHero {...props} kinds={IMAGE_KINDS} />
}

/**
 * The `dummy` control kind: an event source, a notifier and a gateway draw
 * their card; every other type keeps the placeholder.
 */
export function DummyCardHero(props: DeviceControlProps): ReactNode {
  const kind = useConnectedCardKind(props.deviceId)
  if (kind === 'pending') return null
  if (kind !== null && DUMMY_CARD_KINDS.includes(kind))
    return (
      <ConnectedDeviceCard kind={kind} deviceId={props.deviceId} optimistic={props.optimistic} />
    )
  return <DummyHeroCard {...props} />
}

// ── MediaPlayer ───────────────────────────────────────────────────────────────

function useMediaPlayerCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.mediaPlayer,
    slice: (d) => d.state.mediaPlayer,
  })
  return cap !== undefined
}

export function MediaPlayerInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasMedia = useMediaPlayerCapGuard(trpc, deviceId)
  if (!hasMedia) return null
  return (
    <MediaPlayerPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

// The media player's hero is the device card (`MediaCardHero` above).

// ── AlarmPanel ──────────────────────────────────────────────────────────────
// AlarmInlineControl (row-sized segment strip) and AlarmHeroCard (full
// glyph+label+segments) both live in alarm-hero-card.tsx and are re-exported
// above. AlarmInlineControl is surfaced here as AlarmPanelInlineControl.

// ── Control ───────────────────────────────────────────────────────────────────

function useControlCapGuard(trpc: DeviceControlProps['trpc'], deviceId: number): boolean {
  const { cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.control,
    slice: (d) => d.state.control,
  })
  return cap !== undefined
}

export function ControlInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasControl = useControlCapGuard(trpc, deviceId)
  if (!hasControl) return null
  return (
    <ControlPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

export function ControlHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const hasControl = useControlCapGuard(trpc, deviceId)
  if (!hasControl) return null
  return (
    <HeroShell>
      <ControlPanel
        trpc={trpc}
        deviceId={deviceId}
        features={features}
        layout="full"
        optimistic={optimistic}
      />
    </HeroShell>
  )
}
