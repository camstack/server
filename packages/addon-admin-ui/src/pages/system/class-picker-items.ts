/**
 * The detection-class picker's list (D641): the SAME smart picker the device
 * scope uses (`DevicePicker`, generic over the id), over the class taxonomy
 * (`pickerForRuleClasses` from `@camstack/types` — the one source of truth; no
 * class list lives here). It never lists a sound: a detection rule that picked
 * one broke itself, and sounds are a Sound rule's (R13, D690).
 *
 * Each taxonomy option is one item keyed by its class name, and its GROUP is
 * the taxonomy category it sits under (Person, Vehicle, Animal …): a
 * macro and its sub-labels share one group, so "select group" picks a whole
 * category. Search matches the class and its category.
 *
 * `null` when the hub serves no taxonomy — the caller keeps its free-text
 * input rather than drawing an empty picker that reads as "no classes".
 */
import type { NcTaxonomy } from '@camstack/types'
import { pickerForRuleClasses } from '@camstack/types'
import type { PickerGroup, PickerItem } from './device-picker-model'
import i18n from '../../i18n/index'

export function classPickerItems(
  taxonomy: NcTaxonomy | undefined,
): readonly PickerItem<string>[] | null {
  const picker = pickerForRuleClasses(taxonomy)
  if (picker === null) return null
  return picker.groups.flatMap((group) =>
    group.options.map((option) => ({
      id: option.value,
      name: option.label,
      type: group.fallbackLabel,
    })),
  )
}

/** A class group's title: its taxonomy category. */
export function classGroupTitle(group: PickerGroup<string>): string {
  return group.type ?? i18n.t('helpers.classPickerItems.other')
}
