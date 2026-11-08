/**
 * Opens the formula dialog for one stored field on a cap feature.
 */
import type { CompositionFieldSource, CompositionFieldsFeature } from '@camstack/types'
import { Button, IconButton } from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { featureOf, withFeature } from '../customization-save'
import type { CustomizationHandle } from '../use-customization'
import { currentComposition } from '../customization-read'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { FormulaFieldDialog } from './FormulaFieldDialog'

const NO_NAMES: ReadonlyMap<string, string> = new Map()

export interface FormulaEntryButtonProps {
  readonly handle: CustomizationHandle
  readonly cap: string
  readonly fieldPath: string
  /** When set, reads/writes `feature.items[itemKey].fields[fieldPath]`. */
  readonly itemKey?: string
  readonly label?: string
  readonly testId?: string
  readonly sourceNames?: ReadonlyMap<string, string>
  /** A pencil in a table's Actions cell instead of a text button; `label` becomes its accessible name. */
  readonly icon?: boolean
}

export function FormulaEntryButton({
  handle,
  cap,
  fieldPath,
  itemKey,
  label,
  testId,
  sourceNames = NO_NAMES,
  icon = false,
}: FormulaEntryButtonProps): ReactNode {
  const { t, i18n } = useTranslation()
  const fieldLabel = vocabularyFieldLabel(cap, fieldPath, i18n.language)
  const [open, setOpen] = useState(false)
  const current = currentComposition(handle.state)
  const feature = featureOf(current, cap)
  const source: CompositionFieldSource | undefined =
    itemKey === undefined
      ? feature?.fields[fieldPath]
      : feature?.items?.[itemKey]?.fields[fieldPath]
  if (source === undefined) return null

  const save = async (nextSource: CompositionFieldSource): Promise<void> => {
    if (feature === null) return
    let nextFeature: CompositionFieldsFeature
    if (itemKey === undefined) {
      nextFeature = {
        ...feature,
        fields: { ...feature.fields, [fieldPath]: nextSource },
      }
    } else {
      const item = feature.items?.[itemKey]
      if (item === undefined) return
      nextFeature = {
        ...feature,
        items: {
          ...feature.items,
          [itemKey]: { ...item, fields: { ...item.fields, [fieldPath]: nextSource } },
        },
      }
    }
    await handle.save(withFeature(current, handle.target, nextFeature))
  }

  return (
    <>
      {icon ? (
        <IconButton
          variant="ghost"
          size="sm"
          icon={Pencil}
          aria-label={label ?? t('customize.table.editWhat', { title: fieldLabel })}
          data-testid={testId ?? `formula-entry-${cap}-${fieldPath}`}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          data-testid={testId ?? `formula-entry-${cap}-${fieldPath}`}
          onClick={() => setOpen(true)}
        >
          {label ?? t('compositionEditor.formula')}
        </Button>
      )}
      <FormulaFieldDialog
        open={open}
        title={t('compositionEditor.formulaFor', { path: fieldLabel })}
        fieldPath={fieldPath}
        fieldLabel={fieldLabel}
        sourceNames={sourceNames}
        initial={source}
        onClose={() => setOpen(false)}
        onSave={(next) => void save(next)}
      />
    </>
  )
}
