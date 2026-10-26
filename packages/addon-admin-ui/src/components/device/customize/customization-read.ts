/**
 * What the Customize tab may CLAIM about a device's customization (D315,
 * D663): five states, never collapsed. Only `none` may say "not customized";
 * `pending`, `unknown` and `not-loaded` are three different sentences, and no
 * write is planned from any of them.
 */
import {
  type Composition,
  type CompositionCustomizationRead,
  type CompositionView,
  coreBlockComposition,
} from '@camstack/types'
import i18n from '../../../i18n/index'

/** The one field of a query error this module reads. */
export interface CustomizationQueryError {
  readonly message: string
}

/** The fields of a query result this module reads — nothing else. */
export interface CustomizationQueryView {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: CompositionCustomizationRead | undefined
  readonly error?: CustomizationQueryError | null
}

/** Nobody has answered yet. */
export interface CustomizationPending {
  readonly kind: 'pending'
}
/** The read FAILED — not an answer, so not absence either. */
export interface CustomizationUnknown {
  readonly kind: 'unknown'
  readonly reason: string
}
/** The server answered that the `core_blocks` table has not been read yet. */
export interface CustomizationNotLoaded {
  readonly kind: 'not-loaded'
  readonly reason: string
}
/** Answered: no composition customizes this device. */
export interface CustomizationNone {
  readonly kind: 'none'
}
/** Answered: the ONE block that customizes this device (D663). */
export interface CustomizationPresent {
  readonly kind: 'present'
  readonly view: CompositionView
  readonly composition: Composition
}
export type CustomizationState =
  | CustomizationPending
  | CustomizationUnknown
  | CustomizationNotLoaded
  | CustomizationNone
  | CustomizationPresent

function failureReason(message: string | undefined): string {
  const trimmed = message?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : i18n.t('helpers.customize.requestFailed')
}

export function resolveCustomization(query: CustomizationQueryView): CustomizationState {
  // A failed background refetch keeps `data`. Only a read that never answered
  // is unknown — the same rule as the palette gate.
  const data = query.data
  if (data !== undefined) {
    if (data.state === 'not-loaded') return { kind: 'not-loaded', reason: data.reason }
    if (data.view === null) return { kind: 'none' }
    const composition = coreBlockComposition(data.view.block)
    if (composition === null) {
      return {
        kind: 'unknown',
        reason: i18n.t('helpers.customizationRead.notAComposition', { id: data.view.block.id }),
      }
    }
    return { kind: 'present', view: data.view, composition }
  }
  if (query.status === 'pending') return { kind: 'pending' }
  if (query.status === 'error') {
    return { kind: 'unknown', reason: failureReason(query.error?.message) }
  }
  return { kind: 'pending' }
}

export function currentComposition(state: CustomizationState): Composition | null {
  return state.kind === 'present' ? state.composition : null
}
