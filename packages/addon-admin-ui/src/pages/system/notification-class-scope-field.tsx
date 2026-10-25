/**
 * A rule's detection-class scope as ONE field (D641): the scope pre-selector
 * (`RuleScopeField`) over the SAME smart picker the devices use —
 * `DevicePicker<string>` over the class taxonomy (`class-picker-items.ts`),
 * grouped by taxonomy category, searchable, chips, select/clear per category.
 *
 * `conditions.classes` is Only, `conditions.classesExclude` is Except; the two
 * catalog rows (wire ids, unchanged) render here as one field.
 *
 * "Group by" does not apply: the groups ARE the taxonomy categories, so the
 * picker is drawn with the `class` noun, which has none. A stored class the
 * taxonomy does not list is a removable chip ("not in the class list"), never
 * dropped (D49). A hub with no taxonomy keeps the free-text input.
 */

import type { NcTaxonomy } from '@camstack/types'
import { useMemo } from 'react'
import { classGroupTitle, classPickerItems } from './class-picker-items'
import { DevicePicker } from './DevicePicker'
import { TagListField } from './notification-condition-widgets'
import type { RuleScopeDraft } from './rule-scope-model'
import { RuleScopeField } from './RuleScopeField'
import { useTranslation } from 'react-i18next'

export interface ClassScopeFieldProps {
  readonly taxonomy: NcTaxonomy | undefined
  readonly scope: RuleScopeDraft<string>
  readonly onChange: (next: RuleScopeDraft<string>) => void
  /** The hub serves `classesExclude` for this rule (D641). */
  readonly exceptOffered: boolean
}

export function ClassScopeField({
  taxonomy,
  scope,
  onChange,
  exceptOffered,
}: ClassScopeFieldProps) {
  const { t } = useTranslation()
  const items = useMemo(() => classPickerItems(taxonomy), [taxonomy])
  const labels = useMemo(() => new Map((items ?? []).map((item) => [item.id, item.name])), [items])
  return (
    <RuleScopeField
      draft={scope}
      onChange={onChange}
      exceptOffered={exceptOffered}
      plural="classes"
      describe={(id) => labels.get(id) ?? id}
      testId="rule-class-scope"
      renderPicker={(value, change, mode) =>
        items === null ? (
          <TagListField
            value={value}
            placeholder={t('system.notificationClassScopeField.addValue', 'Add value…')}
            onChange={change}
          />
        ) : (
          <DevicePicker<string>
            key={mode}
            devices={items}
            listState="answered"
            value={value}
            onChange={change}
            emptyMeansAll
            noun="class"
            groupTitle={classGroupTitle}
            testId="class-picker"
          />
        )
      }
    />
  )
}
