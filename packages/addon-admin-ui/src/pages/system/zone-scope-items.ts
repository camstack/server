/**
 * The zone scope's list (R14, D690): which cameras' zones a rule can pick, and
 * how each zone is named.
 *
 * A zone id is unique per camera and a rule routinely names several cameras,
 * so a zone is always shown with its camera — "camera:zone", grouped under the
 * camera. And it is offered in BOTH modes of the zone field: it used to be
 * listed only for the cameras of an "Only these" device scope, so a rule on
 * every device (or on all but some) could not pick a zone at all.
 */
import type { PickerItem } from './device-picker-model'
import type { RuleCameraOption } from './notification-condition-fields'
import type { PickOption } from './notification-rule-pickers'
import type { RuleScopeDraft } from './rule-scope-model'

/**
 * The cameras whose zones the rule can use, from its device scope: the chosen
 * cameras under "Only these", every camera still covered under "All except
 * these", every camera under "All". Never a non-camera device — it has no
 * zones to list.
 */
export function zoneCameraIds(
  deviceScope: RuleScopeDraft<number>,
  cameras: readonly RuleCameraOption[],
): readonly number[] {
  const ids = cameras.map((camera) => camera.id)
  switch (deviceScope.mode) {
    case 'only': {
      const chosen = new Set(deviceScope.include)
      return ids.filter((id) => chosen.has(id))
    }
    case 'except': {
      const excluded = new Set(deviceScope.exclude)
      return ids.filter((id) => !excluded.has(id))
    }
    case 'all':
      return ids
  }
}

/** One zone as the picker lists it: "camera:zone", grouped under its camera. */
export function zonePickerItems(options: readonly PickOption[]): readonly PickerItem<string>[] {
  return options.map((option) =>
    option.hint === undefined
      ? { id: option.value, name: option.label }
      : { id: option.value, name: `${option.hint}:${option.label}`, type: option.hint },
  )
}
