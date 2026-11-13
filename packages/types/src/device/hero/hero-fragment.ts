/**
 * What ONE capability adds to a hero (D1023), and the context it reads.
 * Contributions return a fragment; `buildHeroModel` merges the fragments.
 */
import type { ReadingQuantity } from '../../units/quantity.js'
import type {
  HeroBadge,
  HeroConsumablesSlot,
  HeroConsumptionSlot,
  HeroFact,
  HeroOwnPowerSlot,
  HeroPowerSupplySlot,
  HeroRemoteSlot,
  HeroRow,
  HeroSideTile,
  HeroTimedRunSlot,
} from './hero-model.js'
import type { HeroMeasurement } from './hero-measurement.js'
import type { HeroSceneMode } from './hero-scene.js'
import type { HeroState } from './hero-state.js'
import type { HeroText } from './hero-text.js'

/** Which cap a state reading comes from; `STATE_SOURCE_ORDER` ranks them. */
export type StateSource =
  | 'media-player'
  | 'dishwasher'
  | 'lock-control'
  | 'alarm-panel'
  | 'vacuum-control'
  | 'lawn-mower-control'
  | 'fan-control'
  | 'pet-feeder'
  | 'pet-fountain'
  | 'automation-control'
  | 'script-runner'
  | 'event-emitter'
  | 'running-state'
  | 'switch'
  | 'contact'
  | 'group-active'
  | 'cover'
  | 'valve'
  | 'humidifier'
  | 'brightness'
  | 'smoke'
  | 'flood'
  | 'gas'
  | 'tamper'
  | 'vibration'
  | 'doorbell'
  | 'motion'
  | 'presence'
  | 'update'
  | 'weather'
  | 'image'
  | 'control'
  | 'meter'
  | 'binary'
  | 'button'
  | 'climate-control'
  | 'sensor'

export interface StateReading {
  readonly source: StateSource
  readonly state: HeroState
  /** The state is the driver's own bookkeeping, not a reading. */
  readonly assumed: boolean
  /**
   * The words for the state when the generic ones ("On", "Off") would mislead:
   * a lock is "Locked", an alarm "Armed away". Absent = the state's own words.
   */
  readonly title?: HeroText
}

export interface HeroContext {
  readonly deviceId: number
  readonly type: string
  /** The device's role: with the type, which thing it is (D1033). */
  readonly role: string | null
  readonly features: readonly string[]
  readonly now: number
  /** The `running-state` reading: `undefined` = not bound or not answered, `null` = unknown. */
  readonly running: boolean | null | undefined
  /** Saved remote commands; `null` = not known. */
  readonly remoteCommands: number | null
  /** The caps the device is bound to: a contribution that overlaps another cap's fact yields to it. */
  readonly caps: readonly string[]
  /** What a numeric-sensor measures (stored at adopt); `null`/absent = unknown, the number shows bare. */
  readonly quantity?: ReadingQuantity | null
}

export interface HeroFragment {
  readonly reading?: StateReading
  /** A way to switch the device's OWN power. The resolver picks one. */
  readonly ownPower?: HeroOwnPowerSlot
  readonly timedRun?: HeroTimedRunSlot
  readonly powerSupply?: HeroPowerSupplySlot
  /** A consumption value; the highest `priority` wins (power over a running state). */
  readonly consumption?: {
    readonly priority: number
    readonly slot: HeroConsumptionSlot
  }
  readonly consumables?: HeroConsumablesSlot
  readonly remote?: HeroRemoteSlot
  readonly badges?: readonly HeroBadge[]
  readonly rows?: readonly HeroRow[]
  readonly artworkUrl?: string
  /** Facts for the top line, in the order the cap wants them read. */
  readonly facts?: readonly HeroFact[]
  /** Tiles beside the scene; the builder keeps the first two of each side. */
  readonly tiles?: {
    readonly left?: readonly HeroSideTile[]
    readonly right?: readonly HeroSideTile[]
  }
  /** The tiles are a fallback: a side keeps them only when no other cap put a tile there. */
  readonly tilesFallback?: boolean
  /** What the scene is doing, when this cap knows. The first fragment that names a field wins. */
  /** What the hero's headline says instead of the state word (a mode, a reading). The first fragment that names one wins; offline and unknown are never overridden. */
  readonly title?: HeroText
  /** The scene's top line when it says more than the title ("Cooling · fan Auto"); the first fragment that names one wins. */
  readonly caption?: HeroText
  readonly scene?: { readonly mode?: HeroSceneMode; readonly level?: number }
  /** This cap's single reading, when a sensor that measures only it is drawn as that reading. */
  readonly measurement?: HeroMeasurement
}
