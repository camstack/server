import type { EspState } from './esphome-link.js'

/** ESPHome `CoverOperation` wire values. */
export const COVER_OPERATION_IDLE = 0
export const COVER_OPERATION_OPENING = 1
export const COVER_OPERATION_CLOSING = 2

type StateOf<T extends EspState['type']> = Extract<EspState, { type: T }>

export type DecodedCoverState = 'open' | 'opening' | 'closing' | 'closed' | 'stopped'

export interface DecodedCover {
  readonly state: DecodedCoverState
  /** 0 closed .. 100 open. */
  readonly position: number
}

/**
 * The wire format omits a field that holds its protobuf default, so a relay
 * that is OFF arrives with no `state` at all. "Absent" is therefore the
 * default value, never "unknown" (D952); only `missingState` means unknown.
 */
export function decodeSwitch(state: StateOf<'switch'>): boolean {
  return state.state ?? false
}

export function decodeBinary(state: StateOf<'binary_sensor'>): boolean {
  return state.state ?? false
}

/** A measurement that failed is `null`, never 0 (D393). */
export function decodeNumber(state: StateOf<'sensor' | 'number'>): number | null {
  if (state.missingState === true) return null
  const value = state.state ?? 0
  return Number.isFinite(value) ? value : null
}

export function decodeText(state: StateOf<'text_sensor' | 'select'>): string | null {
  if (state.missingState === true) return null
  return state.state ?? ''
}

export function decodeCover(state: StateOf<'cover'>): DecodedCover {
  const fraction = Math.min(1, Math.max(0, state.position ?? 0))
  const position = Math.round(fraction * 100)
  const operation = state.currentOperation ?? COVER_OPERATION_IDLE
  if (operation === COVER_OPERATION_OPENING) return { state: 'opening', position }
  if (operation === COVER_OPERATION_CLOSING) return { state: 'closing', position }
  if (position >= 100) return { state: 'open', position }
  if (position <= 0) return { state: 'closed', position }
  return { state: 'stopped', position }
}

export function decodeBrightnessPercent(state: StateOf<'light'>): number {
  const fraction = Math.min(1, Math.max(0, state.brightness ?? 0))
  return Math.round(fraction * 100)
}

export function decodeLightOn(state: StateOf<'light'>): boolean {
  return state.state ?? false
}
