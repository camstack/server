/**
 * Faces, zones and labels as ONE include-or-exclude field each (R8, D690) —
 * the object classes' control (`ClassScopeField`, D641): the "All | Only these
 * | All except these" pre-selector (`RuleScopeField`) over one picker.
 *
 * Each field keeps its draft (which mode, and the list the other mode left
 * behind) while the dialog is open and writes the rule's conditions on every
 * change through `applyConditionScope` — the wire keys are unchanged, and a
 * zone list is written with no "any of / all of".
 *
 *  - ZONES are offered in both modes, from every camera the rule can see, each
 *    named "camera:zone" (R14, `zone-scope-items.ts`).
 *  - FACES: "Only these" with nobody picked is "any known face" — the stored
 *    `identities: []` — and says so instead of "every face".
 *  - LABELS have no exclusion on the wire, so "All except these" is not
 *    offered, and there is no vocabulary to pick from: the list is typed.
 */
import type { NcConditions } from '@camstack/types'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PickerFleetView } from './device-fleet-view'
import type { DeviceListState } from './device-selection'
import { DevicePicker } from './DevicePicker'
import type { RuleCameraOption } from './notification-condition-fields'
import { HINT_CLASS, TagListField } from './notification-condition-widgets'
import { useIdentityOptions, useZoneOptions } from './notification-rule-pickers'
import {
  applyConditionScope,
  type ConditionScopeAxis,
  conditionScopeDraftOf,
} from './rule-condition-scopes'
import type { RuleScopeDraft } from './rule-scope-model'
import { RuleScopeField } from './RuleScopeField'
import { zonePickerItems } from './zone-scope-items'

interface ConditionScopeFieldProps {
  readonly conditions: NcConditions
  readonly onConditionsChange: (next: NcConditions) => void
  /** The hub serves the axis's exclusion for this rule (`zonesExclude`, `identitiesExclude`). */
  readonly exceptOffered: boolean
}

/** The draft of one axis, and the change that writes it into the conditions. */
function useConditionScope(
  axis: ConditionScopeAxis,
  conditions: NcConditions,
  onConditionsChange: (next: NcConditions) => void,
): readonly [RuleScopeDraft<string>, (next: RuleScopeDraft<string>) => void] {
  const [draft, setDraft] = useState(() => conditionScopeDraftOf(axis, conditions))
  const change = (next: RuleScopeDraft<string>): void => {
    setDraft(next)
    onConditionsChange(applyConditionScope(axis, conditions, next))
  }
  return [draft, change]
}

function listStateOf(loading: boolean, failed: boolean): DeviceListState {
  if (failed) return 'failed'
  return loading ? 'pending' : 'answered'
}

export interface ZoneScopeFieldProps extends ConditionScopeFieldProps {
  /** The cameras whose zones are listed (`zoneCameraIds`). */
  readonly cameraIds: readonly number[]
  readonly cameras: readonly RuleCameraOption[]
}

export function ZoneScopeField({
  conditions,
  onConditionsChange,
  exceptOffered,
  cameraIds,
  cameras,
}: ZoneScopeFieldProps) {
  const { t } = useTranslation()
  const [draft, change] = useConditionScope('zones', conditions, onConditionsChange)
  const { options, loading, failed } = useZoneOptions(cameraIds, cameras)
  const items = useMemo(() => zonePickerItems(options), [options])
  // What answered is DRAWN; a stored zone is JUDGED against the list only when
  // every camera answered — one failed read makes its zones unknown, never
  // "not found" (D315, review M5).
  const listState = listStateOf(loading, false)
  const judge: PickerFleetView<string> = failed
    ? { state: 'failed', devices: undefined }
    : { state: listState, devices: listState === 'answered' ? items : undefined }
  const names = useMemo(() => new Map(items.map((item) => [item.id, item.name])), [items])
  return (
    <RuleScopeField
      draft={draft}
      onChange={change}
      exceptOffered={exceptOffered}
      plural="zones"
      describe={(id) => names.get(id) ?? id}
      testId="rule-zone-scope"
      renderPicker={(value, onChange, mode) =>
        cameraIds.length === 0 ? (
          <p className={HINT_CLASS}>
            {t(
              'notificationRules.zones.noCameras',
              'This rule covers no camera, so it has no zones.',
            )}
          </p>
        ) : (
          <DevicePicker<string>
            key={mode}
            devices={items}
            listState={listState}
            fleet={judge}
            value={value}
            onChange={onChange}
            emptyMeansAll
            noun="zone"
            groupTitle={(group) => group.type ?? t('notificationRules.zones.group', 'Zones')}
            testId="zone-picker"
          />
        )
      }
    />
  )
}

export function IdentityScopeField({
  conditions,
  onConditionsChange,
  exceptOffered,
}: ConditionScopeFieldProps) {
  const { t } = useTranslation()
  const [draft, change] = useConditionScope('identities', conditions, onConditionsChange)
  const { options, loading, failed } = useIdentityOptions()
  const items = useMemo(
    () => options.map((option) => ({ id: option.value, name: option.label })),
    [options],
  )
  const names = useMemo(() => new Map(items.map((item) => [item.id, item.name])), [items])
  return (
    <RuleScopeField
      draft={draft}
      onChange={change}
      exceptOffered={exceptOffered}
      plural="faces"
      describe={(id) => names.get(id) ?? id}
      testId="rule-identity-scope"
      renderPicker={(value, onChange, mode) => (
        <DevicePicker<string>
          key={mode}
          devices={items}
          listState={listStateOf(loading, failed)}
          value={value}
          onChange={onChange}
          // "Only these" with nobody picked is "any known face", not "every face".
          emptyMeansAll={mode === 'except'}
          {...(mode === 'only'
            ? {
                emptyLabel: t(
                  'notificationRules.faces.anyKnown',
                  'Any known face — nobody in particular',
                ),
              }
            : {})}
          noun="face"
          groupTitle={() => t('notificationRules.faces.group', 'Known faces')}
          testId="identity-picker"
        />
      )}
    />
  )
}

export function LabelScopeField({
  conditions,
  onConditionsChange,
}: Omit<ConditionScopeFieldProps, 'exceptOffered'>) {
  const { t } = useTranslation()
  const [draft, change] = useConditionScope('labels', conditions, onConditionsChange)
  return (
    <RuleScopeField
      draft={draft}
      onChange={change}
      exceptOffered={false}
      plural="labels"
      describe={(id) => id}
      testId="rule-label-scope"
      renderPicker={(value, onChange) => (
        <TagListField
          value={value}
          placeholder={t('notificationRules.labels.add', 'Add a label…')}
          onChange={onChange}
        />
      )}
    />
  )
}
