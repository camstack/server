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
import { SwitchPanel } from './switch-panel'
import { LockPanel } from './lock-panel'
import { BrightnessPanel } from './brightness-panel'
import { FanPanel } from './fan-panel'
import { ClimatePanel } from './climate-panel'
import { HeatingValveReadout } from './heating-valve-readout'
import { AcPanel } from './ac-panel'
import { MediaPlayerPanel } from './media-player-panel'
import { ControlPanel } from './control-panel'
import type { DeviceControlProps } from './control-registry'
export { ThermostatHeroCard } from './thermostat-hero-card'
export { LockHeroCard } from './lock-hero-card'
export { LightHeroCard } from './light-hero-card'
export { FanHeroCard } from './fan-hero-card'
export { SwitchHeroCard } from './switch-hero-card'
export { MediaPlayerHeroCard } from './media-player-hero-card'
// AlarmPanelInlineControl is the row-sized compact strip; AlarmHeroCard the
// full glyph+label+segments surface. Both live in alarm-hero-card.tsx and
// subscribe to the cap once (no double useDeviceCapability).
export { AlarmHeroCard, AlarmInlineControl as AlarmPanelInlineControl } from './alarm-hero-card'
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

// SwitchHeroCard lives in switch-hero-card.tsx (large TAP toggle, Spec §3) and
// is re-exported above — it supersedes the panel-stack hero.

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

export function AcHeroCard({
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
      layout="full"
      optimistic={optimistic}
    />
  )
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

// MediaPlayerHeroCard lives in media-player-hero-card.tsx (now-playing +
// lucide transport + seek/volume GripTracks, Spec §3) and is re-exported
// above — it supersedes the panel-stack hero.

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
