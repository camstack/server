/**
 * What ONE capability adds to a hero (D1023), and the context it reads.
 * Contributions return a fragment; `buildHeroModel` merges the fragments.
 */
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
import type { HeroSceneMode } from './hero-scene.js'
import type { HeroState } from './hero-state.js'

/** Which cap a state reading comes from; `STATE_SOURCE_ORDER` ranks them. */
export type StateSource = 'media-player' | 'dishwasher' | 'running-state' | 'switch' | 'contact'

export interface StateReading {
  readonly source: StateSource
  readonly state: HeroState
  /** The state is the driver's own bookkeeping, not a reading. */
  readonly assumed: boolean
}

export interface HeroContext {
  readonly deviceId: number
  readonly type: string
  readonly features: readonly string[]
  readonly now: number
  /** The `running-state` reading: `undefined` = not bound or not answered, `null` = unknown. */
  readonly running: boolean | null | undefined
  /** Saved remote commands; `null` = not known. */
  readonly remoteCommands: number | null
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
  /** What the scene is doing, when this cap knows. The first fragment that names a field wins. */
  readonly scene?: { readonly mode?: HeroSceneMode; readonly level?: number }
}
