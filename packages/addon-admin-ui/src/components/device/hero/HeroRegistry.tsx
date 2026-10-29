import { DeviceType } from '@camstack/types'
import { RunningStatusLine, useDeviceState, useSystem } from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { ContainerHero } from './ContainerHero'
import { ControlHero } from './ControlHero'
import { CoverHero } from './CoverHero'
import { DummyHero } from './DummyHero'
import { EventEmitterHero } from './EventEmitterHero'
import { GenericHero } from './GenericHero'
import { HubHero } from './HubHero'

/**
 * Common hero props. All heroes receive the same identity bundle so
 * the registry can pick one without per-type prop branching at the
 * call site. Type-specific heroes ignore fields they don't need.
 */
export interface HeroProps {
  readonly deviceId: number
  readonly deviceName: string
  readonly deviceType: string
  readonly provider: string
  readonly isOnline: boolean
  readonly features: readonly string[]
}

/**
 * Hero component contract — every entry in the registry takes
 * `HeroProps` and returns a JSX node. Wrappers below adapt heroes that
 * accept extra (optional) props (e.g. `SwitchHero` sets `useSiren` for
 * the siren variant) into this contract.
 */
type HeroComponent = (props: HeroProps) => ReactElement

/**
 * Type-keyed registry. Camera is intentionally absent — DeviceDetail
 * routes cameras to `StreamPanelContent` directly; this registry
 * handles everything else. Adding a new device type means adding a
 * file here + an entry in this map; no DeviceDetail churn.
 *
 * Switch, Siren, Light, Lock, Fan, Thermostat, MediaPlayer, Control now
 * route to `ControlHero` — a generic registry-driven hero that looks up
 * the type's `HeroCard` from the ui-library control registry. This keeps
 * the registry DRY: adding a real HeroCard in `panel-controls.tsx` is
 * sufficient; no extra file or entry change here is needed.
 *
 * The existing dedicated SwitchHero and LightHero are retained as
 * ControlHero delegates to the registry-backed HeroCards from ui-library,
 * but the admin-ui registry routes Switch/Siren/Light to ControlHero so
 * all controllable types use one consistent code path.
 */
const HERO_REGISTRY: Readonly<Partial<Record<DeviceType, HeroComponent>>> = {
  [DeviceType.Switch]: ControlHero,
  [DeviceType.Siren]: ControlHero,
  [DeviceType.Light]: ControlHero,
  [DeviceType.Sensor]: ControlHero,
  // HA button/input_button: routes to ControlHero which uses the registry-backed
  // ButtonHeroCard (press-actuator UI). The doorbell ButtonHero (ButtonHero.tsx)
  // is retained for doorbells but no longer mapped to DeviceType.Button here.
  [DeviceType.Button]: ControlHero,
  [DeviceType.Hub]: HubHero,
  [DeviceType.Cover]: CoverHero,
  // Valve: ControlHero renders the registry-backed ValveHeroCard
  // (open/stop/close + position drag) — the DRY path (no dedicated ValveHero).
  [DeviceType.Valve]: ControlHero,
  // Humidifier / water heater: ControlHero renders the registry-backed
  // HumidifierHeroCard / WaterHeaterHeroCard (climate-family hero graphics).
  [DeviceType.Humidifier]: ControlHero,
  [DeviceType.WaterHeater]: ControlHero,
  // Container renders AS its primary child (same hero + discreet picker);
  // other children remain as detail tabs. See ContainerHero.
  [DeviceType.Container]: ContainerHero,
  [DeviceType.Lock]: ControlHero,
  [DeviceType.Fan]: ControlHero,
  [DeviceType.Thermostat]: ControlHero,
  // Air-conditioner: ControlHero renders the registry-backed AcHeroCard
  // (mode chips + fan speed + independent V/H swing toggles + presets).
  [DeviceType.Climate]: ControlHero,
  [DeviceType.MediaPlayer]: ControlHero,
  [DeviceType.Control]: ControlHero,
  // The alarm panel's real hero card has existed in ui-library
  // (`alarm-hero-card.tsx`, keyed `alarm` in the control registry) the whole
  // time — only this entry still said DummyHero, so the one device whose state
  // matters most rendered "Controls coming soon". `ControlHero` resolves the
  // card from the type's control kind, which is already `alarm`.
  [DeviceType.AlarmPanel]: ControlHero,
  // Event emitter (wall switch / remote / scene controller): a PURE INPUT
  // device — nothing to actuate, so it has no control kind and no HeroCard.
  // `EventEmitterHero` is the observational readout instead: which button, which
  // event type, how long ago, and the declared vocabulary. It is cap-derived
  // (reads the `event-emitter` slice), so it serves every provider.
  [DeviceType.EventEmitter]: EventEmitterHero,
  [DeviceType.Notifier]: DummyHero,
  // Script / Automation: real cards keyed `script` / `automation` in the
  // control registry. Both carried a cap with real runtime state
  // (`script-runner`, `automation-control`) while resolving to `dummy`, so the
  // one thing an operator wants from each — run it, is it on — read as
  // "Controls coming soon".
  [DeviceType.Script]: ControlHero,
  [DeviceType.Automation]: ControlHero,
  [DeviceType.Presence]: ControlHero,
  // Firmware update entity: ControlHero renders the registry-backed UpdateHeroCard
  // (version transition + Install action).
  [DeviceType.Update]: ControlHero,
  // Robot vacuum / lawn mower: ControlHero renders the registry-backed
  // VacuumHeroCard / LawnMowerHeroCard (lifecycle actions + battery).
  [DeviceType.Vacuum]: ControlHero,
  [DeviceType.LawnMower]: ControlHero,
  // Weather / image: ControlHero renders the registry-backed
  // WeatherHeroCard / ImageHeroCard (read-only sky scene / framed image).
  [DeviceType.Weather]: ControlHero,
  [DeviceType.Image]: ControlHero,
  [DeviceType.PetFeeder]: ControlHero,
  // Pet fountain: ControlHero renders the registry-backed PetFountainHeroCard
  // (tank level, water drunk, pump controls).
  [DeviceType.PetFountain]: ControlHero,
  // Dishwasher: ControlHero renders the registry-backed DishwasherHeroCard
  // (program state + start/stop/pause).
  [DeviceType.Dishwasher]: ControlHero,
}

/**
 * Which hero a type resolves to.
 *
 * Exported so the mapping can be ASSERTED rather than trusted: a type whose
 * real hero card exists in ui-library but which is still routed to
 * `DummyHero` renders "Controls coming soon" over work that was already done,
 * and nothing says so. `AlarmPanel` sat like that.
 */
export function resolveHero(deviceType: DeviceType): HeroComponent {
  return HERO_REGISTRY[deviceType] ?? GenericHero
}

/**
 * Render the hero for a non-camera device. Falls back to
 * `GenericHero` when no registry entry matches (Hub / Thermostat /
 * Generic, or an unknown future type).
 */
function DeviceHeroRunningLine({ deviceId }: { readonly deviceId: number }): ReactElement {
  const system = useSystem()
  const slice = useDeviceState(system.trpcClient, deviceId, (s) => s.runningState)
  if (slice === undefined || (slice.running !== true && slice.running !== false)) return <></>
  const running = slice.running
  return (
    <RunningStatusLine
      running={running}
      since={slice?.since ?? null}
      phase={slice?.phase ?? null}
      className="px-3 pt-2 sm:px-4"
    />
  )
}

export function DeviceHero(props: HeroProps): ReactElement {
  const Hero = resolveHero(props.deviceType as DeviceType)
  return (
    <>
      <DeviceHeroRunningLine deviceId={props.deviceId} />
      <Hero {...props} />
    </>
  )
}
