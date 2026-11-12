import { DeviceRole } from '@camstack/types'
import type { CoverDrag, CoverDrawing } from '../../illustrations/CoverIllustration'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/**
 * How a cover reads its position: a shutter is CLOSED by N%, an awning is
 * EXTENDED by N%, a window is OPEN by N%.
 */
export type CoverKind = 'closure' | 'extend' | 'open'
/** The grammatical gender of the role's noun, for the state words. */
export type CoverGender = 'f' | 'm'
export type CoverMotion = 'opening' | 'closing'

export interface CoverRoleSpec {
  readonly drawing: CoverDrawing
  readonly kind: CoverKind
  readonly gender: CoverGender
  readonly drag: CoverDrag
  /** A gate, a garage, a door: moving it needs a second press. */
  readonly secure: boolean
}

const SHUTTER: CoverRoleSpec = {
  drawing: 'shutter',
  kind: 'closure',
  gender: 'f',
  drag: 'y',
  secure: false,
}

const SPEC: Readonly<Record<string, CoverRoleSpec>> = {
  [DeviceRole.CoverShutter]: SHUTTER,
  [DeviceRole.CoverBlind]: {
    drawing: 'blind',
    kind: 'closure',
    gender: 'f',
    drag: 'y',
    secure: false,
  },
  [DeviceRole.CoverCurtain]: {
    drawing: 'curtain',
    kind: 'closure',
    gender: 'f',
    drag: 'x',
    secure: false,
  },
  [DeviceRole.CoverAwning]: {
    drawing: 'awning',
    kind: 'extend',
    gender: 'f',
    drag: 'x',
    secure: false,
  },
  [DeviceRole.CoverWindow]: {
    drawing: 'window',
    kind: 'open',
    gender: 'm',
    drag: 'none',
    secure: false,
  },
  [DeviceRole.CoverGarage]: {
    drawing: 'garage',
    kind: 'closure',
    gender: 'm',
    drag: 'none',
    secure: true,
  },
  [DeviceRole.CoverGate]: {
    drawing: 'gate',
    kind: 'closure',
    gender: 'm',
    drag: 'none',
    secure: true,
  },
  [DeviceRole.CoverDoor]: {
    drawing: 'door',
    kind: 'closure',
    gender: 'f',
    drag: 'none',
    secure: true,
  },
}

/** A cover with no role, or one this card does not know, is drawn as a shutter. */
export function coverRoleSpec(role: string | null): CoverRoleSpec {
  return (role === null ? undefined : SPEC[role]) ?? SHUTTER
}

/** The cap's position (100 = open) in the role's own sense (closed / extended / open). */
export function drawnOf(kind: CoverKind, position: number): number {
  return kind === 'closure' ? 100 - position : position
}

/** The role's value back to the cap's position. */
export function positionOf(kind: CoverKind, drawn: number): number {
  return kind === 'closure' ? 100 - drawn : drawn
}

export interface CoverCardModel {
  readonly common: CardCommon
  readonly spec: CoverRoleSpec
  /** 0..100, 100 = open (the cap's sense); null when the cover reports none. */
  readonly position: number | null
  /** Null until the cover reported a state. */
  readonly state: 'open' | 'closed' | 'stopped' | CoverMotion | null
  /** It accepts a position: the slider and the arrows, else Open / Close. */
  readonly positionable: boolean
  readonly stoppable: boolean
  /** 0..100, 100 = open slats; null when it has no tilt. */
  readonly tilt: number | null
  readonly since: string | null
}

export interface CoverCardActions extends CardCommonActions {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onStop: () => void
  /** In the cap's sense: 100 = open. */
  /**
   * Moves to a position. A promise that settles `false` says the command
   * failed: the card then lets go of the position it was showing.
   */
  readonly onPosition: (position: number) => void | PromiseLike<boolean>
  readonly onTilt: (tilt: number) => void
}

/** The role's value the drawing shows: the position, else what the state implies. */
export function drawnValueOf(model: Pick<CoverCardModel, 'position' | 'state' | 'spec'>): number {
  if (model.position !== null) return drawnOf(model.spec.kind, model.position)
  const open = model.state === 'open' || model.state === 'opening'
  return drawnOf(model.spec.kind, open ? 100 : 0)
}
