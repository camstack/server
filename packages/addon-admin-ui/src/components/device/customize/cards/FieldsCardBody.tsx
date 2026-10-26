/**
 * One generic composition card: a row per field
 * (Current value / No override / + Add override).
 */
import { runtimeFieldUnit, type CompositionFieldsCard } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { unfilledRequiredFields } from '../../../composition-editor/build-skeleton'
import { currentComposition } from '../customization-read'
import { withoutFeature } from '../customization-save'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'
import { OverrideFieldRow } from '../override-row/OverrideFieldRow'

export interface FieldsCardBodyProps {
  readonly deviceId: number
  readonly selfName: string
  readonly card: CompositionFieldsCard
  readonly handle: CustomizationHandle
  readonly names: ReadonlyMap<string, string>
}

function fieldUnit(cap: string, path: string): string | undefined {
  return runtimeFieldUnit(cap, path)
}

export function FieldsCardBody({
  deviceId,
  selfName,
  card,
  handle,
  names,
}: FieldsCardBodyProps): ReactNode {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const current = currentComposition(handle.state)
  const language = i18n.language
  const capTitle = vocabularyCapTitle(card.cap, language)
  const filled = new Set(Object.keys(card.entries))
  const missing = unfilledRequiredFields(card.cap, filled)

  const removeCard = (): void => {
    if (current === null) return
    const next = withoutFeature(current, card.cap)
    void confirmRemove(t('customize.fieldsCard.removeWhat', { cap: capTitle }), next === null).then(
      (ok) => {
        if (ok) void handle.save(next)
      },
    )
  }

  const row = (path: string, toFill: boolean): ReactNode => (
    <OverrideFieldRow
      key={path}
      deviceId={deviceId}
      self={handle.target}
      selfName={selfName}
      cap={card.cap}
      fieldPath={path}
      label={vocabularyFieldLabel(card.cap, path, language)}
      unit={fieldUnit(card.cap, path)}
      handle={handle}
      names={names}
      toFill={toFill}
    />
  )

  return (
    <div className="flex flex-col gap-3 px-3 py-2 sm:px-4">
      {missing.map((path) => row(path, true))}
      {Object.keys(card.entries)
        .filter((path) => !missing.includes(path))
        .map((path) => row(path, false))}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" disabled={handle.saving} onClick={removeCard}>
          {t('customize.fieldsCard.removeFeature', { cap: capTitle })}
        </Button>
      </div>
    </div>
  )
}
