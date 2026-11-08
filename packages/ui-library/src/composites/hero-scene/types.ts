/**
 * Plain-data contract of the hero scene. A model (hero-layout cap) maps onto it
 * 1:1: a scene id, a state string, a few numeric params, side tiles and facts.
 * Nothing here is a component or a colour; tones are theme-token names.
 */

import { HERO_SCENES, type HeroSceneId } from '@camstack/types'

/** Every scene a device hero (or row mini scene) can draw — the model's list, not a copy. */
export const HERO_SCENE_IDS: typeof HERO_SCENES = HERO_SCENES
export type { HeroSceneId }

/** Theme-token accent of a scene. Resolved to `text-<tone>`; particles use `currentColor`. */
export type SceneTone = 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'muted' | 'subtle'

export type SceneSpeed = 'slow' | 'normal' | 'fast'

/** Optional knobs; every scene ignores the ones it has no use for. */
export interface HeroSceneParams {
  /** 0..1 — cover position, timer progress, fan strength. */
  readonly level?: number
  readonly speed?: SceneSpeed
  /** Heater (and any appliance) running on a timer: draws the timer track. */
  readonly timer?: boolean
  /** sensor-sparkline: raw samples, scaled to the box. */
  readonly points?: readonly number[]
  /** Overrides the tone the scene derives from its state. */
  readonly tone?: SceneTone
}

/** The data a model hands over for one scene. */
export interface HeroSceneSpec extends HeroSceneParams {
  readonly scene: HeroSceneId
  /** Scene-specific state (`ac`: cool|heat|dry|fan|auto|off; `washer`: run|idle|done|off; ...). */
  readonly state?: string
}

/** A label + value tile on the left or right of the scene (≤2 per side). */
export interface SceneTile {
  readonly label: string
  readonly value: string
  /** Draws the value in a state tone (an appliance's end time in `warning`). */
  readonly tone?: 'success' | 'warning' | 'danger'
}

/** The visual a (scene, state) pair resolves to. */
export type BackdropKind =
  | 'none'
  | 'airflow'
  | 'rise'
  | 'fall'
  | 'drop'
  | 'fan'
  | 'drum'
  | 'ripple'
  | 'sweep'
  | 'bars'
  | 'breathe'
  | 'slats'
  | 'ring'
  | 'spark'
  | 'stream'
  | 'orbit'

export interface SceneVisual {
  readonly kind: BackdropKind
  readonly tone: SceneTone
  readonly speed: SceneSpeed
  /** The `ac` mode the airflow backdrop draws (only for `kind: 'airflow'`). */
  readonly airflowMode?: 'cool' | 'heat' | 'dry' | 'auto' | 'fan_only' | 'off'
  /** Nothing moves: the dim "idle / off" look. */
  readonly dim: boolean
}
