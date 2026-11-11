/**
 * The rows of a `set` step: a name and a value per variable. A value is text
 * and may name another variable (`{{vars.x}}`); the steps after this one read
 * what it wrote.
 */
import { Button, Input } from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PickerLabel } from './FieldPicker'
import {
  addVar,
  canAddVar,
  removeVar,
  renameVar,
  type SetVars,
  setVarRows,
  setVarValue,
} from './set-vars-model'

/** Shown as written: how a later step reads a variable this one set. */
const VAR_SLOT_EXAMPLE = '{{vars.name}}'

export interface SetVarsFieldsProps {
  /** The step's position in its list, for the rows' test ids. */
  readonly index: number
  readonly vars: SetVars
  readonly onChange: (next: SetVars) => void
}

export function SetVarsFields({ index, vars, onChange }: SetVarsFieldsProps) {
  const { t } = useTranslation()
  const rows = setVarRows(vars)
  return (
    <div className="space-y-2">
      {rows.map((row, at) => (
        <div key={String(at)} className="flex flex-wrap items-end gap-2">
          <label className="w-40">
            <PickerLabel>{t('automation.actionList.setName', 'Variable')}</PickerLabel>
            <Input
              data-testid={`set-name-${String(index)}-${String(at)}`}
              value={row.name}
              spellCheck={false}
              onChange={(e) => onChange(renameVar(vars, at, e.target.value))}
            />
          </label>
          <label className="min-w-40 flex-1">
            <PickerLabel>{t('automation.actionList.setValue', 'Value')}</PickerLabel>
            <Input
              data-testid={`set-value-${String(index)}-${String(at)}`}
              value={String(row.value)}
              onChange={(e) => onChange(setVarValue(vars, at, e.target.value))}
            />
          </label>
          <Button
            variant="ghost"
            onClick={() => onChange(removeVar(vars, at))}
            title={t('automation.actionList.setRemove', 'Remove this variable')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          data-testid={`set-add-${String(index)}`}
          disabled={!canAddVar(vars)}
          onClick={() => onChange(addVar(vars))}
        >
          <Plus className="h-4 w-4" /> {t('automation.actionList.setAdd', 'Add a variable')}
        </Button>
        <span className="text-xs text-foreground-subtle">
          {t('automation.actionList.setHint', 'The steps after this one can use it as {{slot}}.', {
            slot: VAR_SLOT_EXAMPLE,
            interpolation: { escapeValue: false },
          })}
        </span>
      </div>
    </div>
  )
}
