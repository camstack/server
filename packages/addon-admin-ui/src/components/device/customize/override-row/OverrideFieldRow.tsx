/**
 * One override row, shared by Advanced parameters and composition field cards.
 * Current value, no override or the entry, then + Add override:
 * from a device, formula, and — on a numeric field with another unit — convert unit.
 */
import {
  classifyFieldSource,
  compositionSourceKey,
  convertUnitTargets,
  type CompositionCardFieldEntry,
  type CompositionFieldKind,
  type CompositionFieldSource,
  type CompositionSourceRef,
  unitCompanionField,
} from '@camstack/types'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiveValueText } from '../assignments/LiveValueText'
import { aggregateMessageKey, formulaOneLiner } from '../cards/field-entry-copy'
import { currentComposition } from '../customization-read'
import { featureOf } from '../customization-save'
import { FormulaFieldDialog } from '../formula/FormulaFieldDialog'
import { SourcePicker, type SourcePick } from '../SourcePicker'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { ConvertUnitDialog } from './ConvertUnitDialog'
import {
  compositionWithField,
  compositionWithoutFields,
  convertCompanionDrop,
  convertExpression,
  unitConstant,
} from './merge-override'

export interface OverrideFieldRowProps {
  readonly deviceId: number
  readonly self: CompositionSourceRef
  readonly selfName: string
  readonly cap: string
  readonly fieldPath: string
  readonly label: string
  readonly unit: string | undefined
  readonly valueKind?: CompositionFieldKind | null
  readonly handle: CustomizationHandle
  readonly names: ReadonlyMap<string, string>
  readonly toFill?: boolean
}

type DialogKind = 'closed' | 'from' | 'formula' | 'convert'

export function OverrideFieldRow({
  deviceId,
  self,
  selfName,
  cap,
  fieldPath,
  label,
  unit,
  valueKind = null,
  handle,
  names,
  toFill = false,
}: OverrideFieldRowProps): ReactNode {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const [dialog, setDialog] = useState<DialogKind>('closed')
  const current = currentComposition(handle.state)
  const feature = featureOf(current, cap)
  const stored = feature?.fields[fieldPath] ?? null
  const entry = stored === null ? null : classifyFieldSource(stored)
  const targets = unit === undefined ? [] : convertUnitTargets(unit)
  const namesWithSelf = new Map(names)
  namesWithSelf.set(compositionSourceKey(self), selfName)
  const close = (): void => setDialog('closed')

  const saveSource = (source: CompositionFieldSource, dropPaths: readonly string[]): void => {
    void handle.save(compositionWithField(current, self, cap, fieldPath, source, dropPaths))
  }

  const dropConvert = (): readonly string[] => {
    if (entry?.kind !== 'convert-unit') return []
    return convertCompanionDrop(feature, cap, fieldPath, entry.to)
  }

  const remove = (): void => {
    if (current === null) return
    const paths = [fieldPath, ...dropConvert()]
    const next = compositionWithoutFields(current, self, cap, paths)
    void confirmRemove(t('customize.fieldsCard.removeField', { field: label }), next === null).then(
      (ok) => {
        if (ok) void handle.save(next)
      },
    )
  }

  return (
    <div
      className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0"
      data-testid={`override-row-${cap}-${fieldPath}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-foreground">{label}</span>
        {toFill && stored === null && (
          <Badge variant="warning">{t('compositionEditor.toFill')}</Badge>
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-foreground">{t('customize.scalar.effective')}</span>
        <LiveValueText target={{ deviceId, cap, path: fieldPath }} />
      </div>
      {entry === null ? (
        <p className="text-xs text-foreground-subtle">{t('customize.scalar.noOverride')}</p>
      ) : (
        <EntryText
          entry={entry}
          names={namesWithSelf}
          language={i18n.language}
          unknownDevice={t('customize.fieldsCard.unknownDevice')}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {entry === null ? (
          <AddMenu
            cap={cap}
            fieldPath={fieldPath}
            saving={handle.saving}
            convert={targets.length > 0}
            onFrom={() => setDialog('from')}
            onFormula={() => setDialog('formula')}
            onConvert={() => setDialog('convert')}
          />
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={handle.saving}
              onClick={() => setDialog(changeKind(entry))}
            >
              {t('customize.scalar.change')}
            </Button>
            <Button variant="ghost" size="sm" disabled={handle.saving} onClick={remove}>
              {t('customize.scalar.remove')}
            </Button>
          </>
        )}
      </div>
      <Dialog
        open={dialog === 'from'}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent width="lg" scroll="body" placement="sheet-on-mobile">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {dialog === 'from' && (
              <SourcePicker
                title={t('customize.override.fromDevice')}
                targetKind={valueKind ?? (unit !== undefined ? 'number' : null)}
                onCancel={close}
                onPick={(pick: SourcePick) => {
                  saveSource(pick.source, dropConvert())
                  close()
                }}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      {dialog === 'formula' && (
        <FormulaFieldDialog
          open
          title={t('compositionEditor.formulaFor', { path: label })}
          fieldPath={fieldPath}
          fieldLabel={label}
          sourceNames={namesWithSelf}
          initial={
            stored?.kind === 'expression' ? stored : { kind: 'expression', expr: 'v', bindings: {} }
          }
          selfNative={{ source: self, cap, fieldPath }}
          onClose={close}
          onSave={(source) => {
            saveSource(source, dropConvert())
            close()
          }}
        />
      )}
      {dialog === 'convert' && unit !== undefined && (
        <ConvertUnitDialog
          open
          from={unit}
          initialTo={entry?.kind === 'convert-unit' ? entry.to : null}
          onClose={close}
          onSave={(to) => {
            const companion = unitCompanionField(cap, fieldPath)
            const withUnit = compositionWithField(
              current,
              self,
              cap,
              fieldPath,
              convertExpression(unit, to, self, cap, fieldPath),
              [],
            )
            const next =
              companion === null
                ? withUnit
                : compositionWithField(withUnit, self, cap, companion, unitConstant(to), [])
            void handle.save(next)
            close()
          }}
        />
      )}
    </div>
  )
}

function changeKind(entry: CompositionCardFieldEntry): DialogKind {
  if (entry.kind === 'convert-unit') return 'convert'
  if (entry.kind === 'from') return 'from'
  return 'formula'
}

interface AddMenuProps {
  readonly cap: string
  readonly fieldPath: string
  readonly saving: boolean
  readonly convert: boolean
  readonly onFrom: () => void
  readonly onFormula: () => void
  readonly onConvert: () => void
}

function AddMenu({
  cap,
  fieldPath,
  saving,
  convert,
  onFrom,
  onFormula,
  onConvert,
}: AddMenuProps): ReactNode {
  const { t } = useTranslation()
  return (
    <Dropdown>
      <DropdownTrigger
        className="h-7 px-2.5 text-xs rounded-md border border-border bg-surface text-foreground"
        disabled={saving}
        data-testid={`override-add-${cap}-${fieldPath}`}
      >
        {t('customize.scalar.add')}
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem onClick={onFrom}>{t('customize.override.fromDevice')}</DropdownItem>
        <DropdownItem onClick={onFormula}>{t('customize.override.formula')}</DropdownItem>
        {convert && (
          <DropdownItem onClick={onConvert}>{t('customize.override.convertUnit')}</DropdownItem>
        )}
      </DropdownContent>
    </Dropdown>
  )
}

interface EntryTextProps {
  readonly entry: CompositionCardFieldEntry
  readonly names: ReadonlyMap<string, string>
  readonly language: string
  readonly unknownDevice: string
}

function EntryText({ entry, names, language, unknownDevice }: EntryTextProps): ReactNode {
  const { t } = useTranslation()
  if (entry.kind === 'companion') {
    return <span className="text-xs text-foreground">{t('customize.fieldsCard.now')}</span>
  }
  if (entry.kind === 'convert-unit') {
    return (
      <p className="flex flex-wrap items-center gap-1 text-xs text-foreground">
        <span>{t('customize.override.convertSummary', { from: entry.from, to: entry.to })}</span>
        <Badge>{t('customize.override.convertUnit')}</Badge>
      </p>
    )
  }
  if (entry.kind === 'formula') {
    return (
      <p className="flex flex-wrap items-center gap-1 text-xs text-foreground">
        <span className="break-words">
          {formulaOneLiner(entry.expr, entry.bindings, names, language, unknownDevice)}
        </span>
        <Badge>{t('compositionEditor.formula')}</Badge>
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      {entry.sources.map((source) => {
        const key = compositionSourceKey(source.source)
        const name = names.get(key) ?? unknownDevice
        const field = vocabularyFieldLabel(source.cap, source.fieldPath, language)
        return (
          <span
            key={`${key}:${source.cap}:${source.fieldPath}`}
            className="text-xs text-foreground"
          >
            {t('customize.fieldsCard.from', { name, field })}
          </span>
        )
      })}
      {entry.aggregate !== null && (
        <span className="text-xs text-foreground-muted">
          {t(aggregateMessageKey(entry.aggregate))}
        </span>
      )}
    </div>
  )
}
