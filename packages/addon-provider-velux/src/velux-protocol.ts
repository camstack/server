import type { CoverState, CoverStatus, FloodStatus } from '@camstack/types'
import type { VeluxCoverClass } from './config.js'
import type { VeluxNode } from './velux-client-contract.js'

/**
 * Pure KLF-200 wire semantics: position encoding, actuator classification,
 * rain detection and node identity. No I/O and no library import, so every rule
 * here is unit-testable on its own and the adapter over the gateway library stays
 * a thin translation layer.
 */

/** Largest valid wire position (0xC800 = 51200 = 100 %). */
export const KLF_POSITION_MAX = 0xc800

/**
 * KLF-200 actuator type ids (the high 10 bits of the node's type word, per the
 * gateway's API specification). Only the ones this addon classifies are named.
 */
export const ACTUATOR = {
  VenetianBlind: 1,
  RollerShutter: 2,
  Awning: 3,
  WindowOpener: 4,
  GarageOpener: 5,
  Light: 6,
  GateOpener: 7,
  RollingDoorOpener: 8,
  Lock: 9,
  Blind: 10,
  DualShutter: 13,
  OnOffSwitch: 15,
  HorizontalAwning: 16,
  ExternalVenetianBlind: 17,
  LouvreBlind: 18,
  CurtainTrack: 19,
  VentilationPoint: 20,
  ExteriorHeating: 21,
  HeatPump: 22,
  SwingingShutter: 24,
} as const

/**
 * Wire position -> CamStack `cover` position (0 closed .. 100 open).
 *
 * On the KLF-200 a wire value of 0 is FULLY OPEN and 0xC800 is fully closed, for
 * every cover-like actuator: a window opener and a roller shutter alike. (The
 * vendor library inverts the window type only to present "100 % = open"; the
 * Home Assistant integration reads `100 - position_percent` for every cover.)
 * A value above 0xC800 is one of the protocol's markers (target, current,
 * ignore, unknown) and is no position at all: `null`.
 */
export function rawToOpenPercent(raw: number): number | null {
  if (!Number.isFinite(raw) || raw < 0 || raw > KLF_POSITION_MAX) return null
  return Math.round(100 * (1 - raw / KLF_POSITION_MAX))
}

/** CamStack `cover` position (0 closed .. 100 open) -> wire position. */
export function openPercentToRaw(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.round(KLF_POSITION_MAX * (1 - clamped / 100))
}

const COVER_CLASS_BY_ACTUATOR: ReadonlyMap<number, VeluxCoverClass> = new Map([
  [ACTUATOR.WindowOpener, 'window'],
  [ACTUATOR.RollerShutter, 'shutter'],
  [ACTUATOR.SwingingShutter, 'shutter'],
  [ACTUATOR.DualShutter, 'shutter'],
  [ACTUATOR.Awning, 'awning'],
  [ACTUATOR.HorizontalAwning, 'awning'],
  [ACTUATOR.VenetianBlind, 'blind'],
  [ACTUATOR.Blind, 'blind'],
  [ACTUATOR.ExternalVenetianBlind, 'blind'],
  [ACTUATOR.LouvreBlind, 'blind'],
  [ACTUATOR.CurtainTrack, 'blind'],
  [ACTUATOR.GarageOpener, 'garage'],
  [ACTUATOR.RollingDoorOpener, 'garage'],
  [ACTUATOR.GateOpener, 'gate'],
])

/** The cover class of an actuator type, or `null` when it is not a cover (light, lock, switch...). */
export function coverClassOf(actuatorType: number): VeluxCoverClass | null {
  return COVER_CLASS_BY_ACTUATOR.get(actuatorType) ?? null
}

/** Window opener subtype 1 = "window opener with integrated rain sensor". */
const WINDOW_OPENER_RAIN_SUBTYPE = 1

/** True for a window opener that carries the integrated rain sensor. */
export function hasRainSensor(actuatorType: number, subType: number): boolean {
  return actuatorType === ACTUATOR.WindowOpener && subType === WINDOW_OPENER_RAIN_SUBTYPE
}

/** A window with a rain sensor reports an opening limitation of 89, 91, 93 or 100 % while it rains. */
const RAIN_LIMITATION_PERCENT = 89

/**
 * Rain from a window's MINIMUM limitation (wire value). A large minimum means the
 * window may not open: that is what a wet rain sensor does. `null` when the
 * gateway reported no usable limitation (a marker above 0xC800).
 */
export function isRainLimitation(minLimitationRaw: number): boolean | null {
  if (minLimitationRaw > KLF_POSITION_MAX || minLimitationRaw < 0) return null
  return (minLimitationRaw / KLF_POSITION_MAX) * 100 >= RAIN_LIMITATION_PERCENT
}

/** The 8-byte node serial as lowercase hex; an all-zero serial means "not reported" and renders ''. */
export function serialToHex(serial: Uint8Array): string {
  let hex = ''
  let any = false
  for (const byte of serial) {
    if (byte !== 0) any = true
    hex += byte.toString(16).padStart(2, '0')
  }
  return any ? hex : ''
}

/** Identity of a node for the adopt flow: its serial when the gateway reports one, else its node id. */
export function nodeNativeKey(
  gatewayId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return node.serial.length > 0
    ? `${gatewayId}:serial:${node.serial}`
    : `${gatewayId}:node:${node.nodeId}`
}

/** Inputs of {@link coverStateOf}. */
export interface CoverStateInput {
  readonly position: number | null
  readonly targetPosition: number | null
  readonly executing: boolean
}

/** The `cover` lifecycle state of a node. An unknown position is `stopped`, never `closed`. */
export function coverStateOf(input: CoverStateInput): CoverState {
  const { position, targetPosition, executing } = input
  if (position === null) return 'stopped'
  if (executing && targetPosition !== null && targetPosition !== position) {
    return targetPosition > position ? 'opening' : 'closing'
  }
  return position <= 0 ? 'closed' : 'open'
}

/** Map a live node onto the `cover` cap status. Positional: a KLF-200 actuator has no tilt. */
export function nodeToCoverStatus(node: VeluxNode, now: number): CoverStatus {
  return {
    state: coverStateOf({
      position: node.position,
      targetPosition: node.targetPosition,
      executing: node.moving,
    }),
    position: node.position,
    tiltPosition: null,
    lastChangedAt: now,
  }
}

/**
 * Map a window's rain state onto the `flood` cap status. Unknown rain keeps the
 * prior level (a failed limitation read says nothing about the weather), and the
 * change time moves only on a real transition.
 */
export function nodeToFloodStatus(node: VeluxNode, prior: FloodStatus, now: number): FloodStatus {
  if (node.raining === null || node.raining === prior.flooded) return prior
  return { flooded: node.raining, lastChangedAt: now }
}
