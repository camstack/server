/**
 * Which declared Customize target this device is OFFERED. A target that cannot
 * apply is not rendered (D676 ruling 13); a fact not read yet is `pending` /
 * `unknown`, never absent (D315). The catalog target decides the rule: a
 * camera-sensors span follows the sensor read, a keyed array with read-only
 * native items stays addable, and every other extension is absent when the
 * device already serves the cap (D944).
 * Whether a cap is the device's OWN is the validator's rule over `getBindings`
 * (G8): a non-blank owner that is not the composer.
 */
import { COMPOSER_ADDON_ID, DeviceType, type CustomizeCatalogTarget } from '@camstack/types'
import type { Known } from './known'
import i18n from '../../../i18n/index'
import type { CameraSensorsPresence } from './use-camera-sensors-presence'

/** A binding entry as `getBindings` reports it — only the fields read here. */
export interface BindingEntryView {
  readonly capName: string
  readonly nativeAddonId?: string | null
}

export function nativeCapNames(entries: readonly BindingEntryView[]): ReadonlySet<string> {
  return new Set(
    entries
      .filter((e) => {
        const owner = e.nativeAddonId?.trim() ?? ''
        return owner !== '' && owner !== COMPOSER_ADDON_ID
      })
      .map((e) => e.capName),
  )
}

export interface AssignmentFacts {
  readonly deviceType: string
  /** `listComposableCaps` for the device type. */
  readonly composable: Known<ReadonlySet<string>>
  /** Caps the device serves itself. */
  readonly nativeCaps: Known<ReadonlySet<string>>
  readonly cameraSensors: CameraSensorsPresence
}

export interface CustomizeOffer {
  readonly cap: string
  readonly apply: CustomizeCatalogTarget['apply']
  readonly authority: 'composition-claim' | 'camera-sensors'
  readonly nativeItemsReadOnly: boolean
}

export function offerFromCatalog(cap: string, target: CustomizeCatalogTarget): CustomizeOffer {
  return {
    cap,
    apply: target.apply,
    authority: target.applyAuthority?.kind ?? 'composition-claim',
    nativeItemsReadOnly: target.nativeItems === 'read-only',
  }
}

export type AssignmentAvailability =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly mode: 'add' }

type Unread = { readonly kind: 'pending' } | { readonly kind: 'unknown'; readonly reason: string }

function unread<T>(fact: Known<T>): Unread | null {
  return fact.kind === 'known' ? null : fact
}

function addable(facts: AssignmentFacts, cap: string): AssignmentAvailability {
  if (facts.composable.kind !== 'known') return facts.composable
  return facts.composable.value.has(cap) ? { kind: 'present', mode: 'add' } : { kind: 'absent' }
}

function cameraSensorsAvailability(facts: AssignmentFacts): AssignmentAvailability {
  if (facts.deviceType !== DeviceType.Camera) return { kind: 'absent' }
  switch (facts.cameraSensors) {
    case 'pending':
      return { kind: 'pending' }
    case 'unknown':
      return { kind: 'unknown', reason: i18n.t('helpers.assignmentAvailability.sensorsUnchecked') }
    case 'absent':
      return { kind: 'absent' }
    case 'present':
      return { kind: 'present', mode: 'add' }
  }
}

export function assignmentAvailability(
  offer: CustomizeOffer,
  facts: AssignmentFacts,
): AssignmentAvailability {
  if (offer.authority === 'camera-sensors') return cameraSensorsAvailability(facts)
  const pendingNative = unread(facts.nativeCaps)
  if (pendingNative !== null) return pendingNative
  const native = facts.nativeCaps.kind === 'known' ? facts.nativeCaps.value : new Set<string>()
  if (offer.nativeItemsReadOnly) return addable(facts, offer.cap)
  return native.has(offer.cap) ? { kind: 'absent' } : addable(facts, offer.cap)
}
