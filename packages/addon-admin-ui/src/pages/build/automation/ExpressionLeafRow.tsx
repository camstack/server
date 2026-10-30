/**
 * The escape-hatch leaf: an expression over named device reads.
 *
 * This is where arithmetic between two device fields lives, and it is the ONLY
 * place it lives — a catalog leaf compares one field to one constant, and
 * anything past that is this. The engine behind it is the bounded one in
 * `@camstack/types/expression`: a parsed AST with hard step and node limits, no
 * member access and no loops. Nothing here evaluates anything.
 *
 * **Two binding kinds are offered, not three.** The source vocabulary also has
 * `field`, which addresses a SIBLING accessory by key — that is a composition
 * recipe's vocabulary, and the automation the generator emits resolves a binding
 * through `sourceStableId` alone. Offering `field` here would author a binding
 * that reads `undefined` at runtime and turns the whole leaf false, silently.
 *
 * A device is bound by `stableId`, never by numeric id: an id is reissued on
 * re-adoption, and a binding that follows one would quietly start reading a
 * different device.
 */

import type { ExpressionBindingSource, ExpressionLeaf } from '@camstack/types'
import { Button, Input, Select } from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'
import { FieldPicker, type FieldSelection, PickerLabel } from './FieldPicker'

export interface ExpressionLeafRowProps {
  readonly leaf: ExpressionLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: ExpressionLeaf) => void
}

type BindingMap = Readonly<Record<string, ExpressionBindingSource>>

const EMPTY_GLOBAL: ExpressionBindingSource = {
  kind: 'global',
  sourceStableId: '',
  cap: '',
  fieldPath: '',
}

export function ExpressionLeafRow({ leaf, devices, onChange }: ExpressionLeafRowProps) {
  const { t } = useTranslation()
  const entries = Object.entries(leaf.bindings)

  const withBindings = (bindings: BindingMap): void => {
    onChange({ kind: 'expression', expr: leaf.expr, bindings })
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <PickerLabel>{t('automation.expressionLeafRow.expression', 'Expression')}</PickerLabel>
        <Input
          value={leaf.expr}
          placeholder={t('automation.expressionLeafRow.indoorOutdoor5', 'indoor - outdoor > 5')}
          onChange={(e) =>
            onChange({ kind: 'expression', expr: e.target.value, bindings: leaf.bindings })
          }
        />
        <span className="mt-1 block text-xs text-foreground-subtle">
          {t(
            'automation.expressionLeafRow.mustEvaluateToTrueOr',
            'Must evaluate to true or false. Every name in it has to be bound below — an unbound name is refused when the automation is saved, not when it runs.',
          )}
        </span>
      </label>

      <div className="space-y-1.5">
        {entries.length === 0 && (
          <p className="text-xs text-foreground-subtle">
            {t(
              'automation.expressionLeafRow.noNamesBoundYetAn',
              'No names bound yet. An expression reads devices only through these.',
            )}
          </p>
        )}
        {entries.map(([alias, source]) => (
          <BindingRow
            key={alias}
            alias={alias}
            source={source}
            devices={devices}
            onRename={(next) => withBindings(renameBinding(leaf.bindings, alias, next))}
            onChange={(next) => withBindings({ ...leaf.bindings, [alias]: next })}
            onRemove={() => withBindings(removeBinding(leaf.bindings, alias))}
          />
        ))}
        <Button
          variant="ghost"
          onClick={() =>
            withBindings({ ...leaf.bindings, [freshAlias(leaf.bindings)]: EMPTY_GLOBAL })
          }
        >
          <Plus className="h-3.5 w-3.5" /> {t('common.name')}
        </Button>
      </div>
    </div>
  )
}

interface BindingRowProps {
  readonly alias: string
  readonly source: ExpressionBindingSource
  readonly devices: readonly AutomationDevice[]
  readonly onRename: (next: string) => void
  readonly onChange: (next: ExpressionBindingSource) => void
  readonly onRemove: () => void
}

function BindingRow({ alias, source, devices, onRename, onChange, onRemove }: BindingRowProps) {
  const { t } = useTranslation()
  const isLiteral = source.kind === 'literal'
  const selection: FieldSelection = isLiteral
    ? { deviceId: 0, cap: '', fieldPath: '' }
    : {
        deviceId: deviceIdForStableId(devices, stableIdOf(source)),
        cap: source.cap,
        fieldPath: source.fieldPath,
      }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-border p-2">
      <label className="w-32">
        <PickerLabel>{t('automation.expressionLeafRow.name', 'Name')}</PickerLabel>
        <Input
          value={alias}
          placeholder={t('automation.expressionLeafRow.aliasExample')}
          onChange={(e) => onRename(e.target.value)}
        />
      </label>

      <label className="w-36">
        <PickerLabel>{t('automation.expressionLeafRow.reads', 'Reads')}</PickerLabel>
        <Select
          value={isLiteral ? 'literal' : 'global'}
          onChange={(e) =>
            onChange(e.target.value === 'literal' ? { kind: 'literal', value: '' } : EMPTY_GLOBAL)
          }
          options={[
            {
              value: 'global',
              label: t('automation.expressionLeafRow.aDeviceField', 'A device field'),
            },
            { value: 'literal', label: t('automation.expressionLeafRow.aConstant', 'A constant') },
          ]}
        />
      </label>

      {isLiteral ? (
        <label className="min-w-[9rem] flex-1">
          <PickerLabel>{t('automation.expressionLeafRow.constant', 'Constant')}</PickerLabel>
          <Input
            value={source.value === null ? '' : String(source.value)}
            placeholder="5"
            onChange={(e) => onChange({ kind: 'literal', value: parseLiteral(e.target.value) })}
          />
        </label>
      ) : (
        <FieldPicker
          value={selection}
          devices={devices}
          onChange={(next) =>
            onChange({
              kind: 'global',
              sourceStableId: stableIdForDeviceId(devices, next.deviceId),
              cap: next.cap,
              fieldPath: next.fieldPath,
            })
          }
        />
      )}

      <Button
        variant="ghost"
        onClick={onRemove}
        title={t('automation.expressionLeafRow.removeThisName', 'Remove this name')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

/** A constant is read as the type it looks like: a number when it parses as
 *  one, true/false when it is one of those two words, text otherwise. A numeric
 *  field compared against the string "20" is never equal to 20. */
function parseLiteral(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  return raw
}

function stableIdOf(source: ExpressionBindingSource): string {
  return source.kind === 'global' ? source.sourceStableId : ''
}

function deviceIdForStableId(devices: readonly AutomationDevice[], stableId: string): number {
  return devices.find((d) => d.stableId === stableId)?.id ?? 0
}

function stableIdForDeviceId(devices: readonly AutomationDevice[], deviceId: number): string {
  return devices.find((d) => d.id === deviceId)?.stableId ?? ''
}

/** `a`, `b`, `c`… The engine's identifiers must match
 *  `EXPRESSION_IDENTIFIER_RE`, so a generated one is never illegal. */
function freshAlias(bindings: BindingMap): string {
  for (let i = 0; i < 26; i += 1) {
    const candidate = String.fromCharCode(97 + i)
    if (!(candidate in bindings)) return candidate
  }
  return `n${String(Object.keys(bindings).length)}`
}

/** Rename in place — the ORDER is preserved, because the rows are rendered from
 *  `Object.entries` and a renamed binding jumping to the bottom of the list
 *  reads as a different binding. */
function renameBinding(bindings: BindingMap, from: string, to: string): BindingMap {
  const next: Record<string, ExpressionBindingSource> = {}
  for (const [key, value] of Object.entries(bindings)) {
    if (key === from) next[to] = value
    else next[key] = value
  }
  return next
}

function removeBinding(bindings: BindingMap, alias: string): BindingMap {
  const next: Record<string, ExpressionBindingSource> = {}
  for (const [key, value] of Object.entries(bindings)) {
    if (key !== alias) next[key] = value
  }
  return next
}
