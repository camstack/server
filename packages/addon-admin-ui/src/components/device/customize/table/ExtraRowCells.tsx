/**
 * The cells and the editor dialog of the table's per-field rows: a field of a
 * cap the catalog has no row for (a built device's own fields), one row each.
 */
import {
  compositionSourceKey,
  type CompositionCardFieldEntry,
  type CompositionFieldRead,
  type DeviceInfo,
  runtimeFieldUnit,
} from '@camstack/types'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  useDeviceLabel,
  useDeviceStateGetCapSlice,
} from '@camstack/ui-library'
import { Pencil, Trash2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../../../i18n/index'
import { LiveValueText } from '../assignments/LiveValueText'
import { formulaOneLiner } from '../cards/field-entry-copy'
import { currentComposition } from '../customization-read'
import { withoutFeature } from '../customization-save'
import { OverrideFieldRow } from '../override-row/OverrideFieldRow'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'
import { readPath } from '../source-picker-model'
import { type FieldRow, type FieldRowState } from './field-rows'

/** The leaves of a keyed item the form names (`remaining.value` is the Remaining field). */
const ITEM_LEAF: Readonly<Record<string, 'level' | 'status' | 'remaining'>> = {
  level: 'level',
  status: 'status',
  'remaining.value': 'remaining',
}

export function fieldRowTitle(language: string, row: FieldRow): string {
  if (row.item === null) return vocabularyFieldLabel(row.cap, row.path, language)
  const leaf = ITEM_LEAF[row.path]
  const field = leaf === undefined ? row.path : i18n.t(`customize.table.itemLeaf.${leaf}`)
  return `${row.item.label} · ${field}`
}

export function capGroupTitle(language: string, cap: string): string {
  return vocabularyCapTitle(cap, language)
}

function readText(
  read: CompositionFieldRead,
  names: ReadonlyMap<string, string>,
  language: string,
  unknown: string,
): string {
  const device = names.get(compositionSourceKey(read.source)) ?? unknown
  return `${device} · ${vocabularyFieldLabel(read.cap, read.fieldPath, language)}`
}

/** The entry as one line: which device and field it reads, or the formula. */
export function entrySourceText(
  entry: CompositionCardFieldEntry,
  names: ReadonlyMap<string, string>,
  language: string,
  unknownDevice: string,
): string | null {
  switch (entry.kind) {
    case 'from':
      return entry.sources.map((r) => readText(r, names, language, unknownDevice)).join(', ')
    case 'convert-unit':
      return `${readText(entry.source, names, language, unknownDevice)} → ${entry.to}`
    case 'formula':
      return formulaOneLiner(entry.expr, entry.bindings, names, language, unknownDevice)
    case 'companion':
      return null
  }
}

const STATE_BADGE = {
  toFill: 'warning',
  checking: 'default',
  bound: 'success',
  notAnswering: 'warning',
  missing: 'danger',
} as const

export function FieldStateBadge({ state }: { readonly state: FieldRowState }): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant={STATE_BADGE[state.kind]} data-testid={`field-state-${state.kind}`}>
      {t(`customize.table.fieldState.${state.kind}`)}
    </Badge>
  )
}

interface ItemFieldValueProps {
  readonly device: DeviceInfo
  readonly cap: string
  readonly item: string
  readonly path: string
}

/** One leaf of a keyed item in the live slice (`items[]` rows carry their `key`). */
function ItemFieldValue({ device, cap, item, path }: ItemFieldValueProps): ReactNode {
  const slice = useDeviceStateGetCapSlice({ deviceId: device.id, capName: cap })
  if (slice.status === 'pending') return <span className="text-xs text-foreground-subtle">…</span>
  const items: unknown = readPath(slice.data, 'items')
  const row = Array.isArray(items)
    ? items.find((candidate) => readPath(candidate, 'key') === item)
    : undefined
  const value = readPath(row, path)
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '—'
  return <span className="text-xs text-foreground">{text}</span>
}

export interface FieldCellProps {
  readonly device: DeviceInfo
  readonly row: FieldRow
  readonly state: FieldRowState
  readonly names: ReadonlyMap<string, string>
}

/** The live value of a bound field; an unbound one has none to show. */
export function FieldValueCell({ device, row, state }: Omit<FieldCellProps, 'names'>): ReactNode {
  if (state.kind === 'toFill') return <FieldStateBadge state={state} />
  if (row.item !== null)
    return <ItemFieldValue device={device} cap={row.cap} item={row.item.key} path={row.path} />
  return <LiveValueText target={{ deviceId: device.id, cap: row.cap, path: row.path }} />
}

/** What the field reads, with the row state next to it when it is not simply bound. */
export function FieldSourceCell({ row, state, names }: Omit<FieldCellProps, 'device'>): ReactNode {
  const { t, i18n } = useTranslation()
  const text =
    row.entry === null
      ? null
      : entrySourceText(row.entry, names, i18n.language, t('customize.fieldsCard.unknownDevice'))
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs text-foreground">
      {text ?? <span className="text-foreground-subtle">{t('customize.table.noSource')}</span>}
      {state.kind !== 'bound' && state.kind !== 'toFill' && <FieldStateBadge state={state} />}
    </span>
  )
}

export interface FieldActionsProps {
  readonly row: FieldRow
  readonly title: string
  readonly onEdit: () => void
}

export function FieldActionsCell({ row, title, onEdit }: FieldActionsProps): ReactNode {
  const { t } = useTranslation()
  if (row.entry === null) {
    return (
      <Button
        variant="outline"
        size="sm"
        data-testid={`customize-manage-${row.key}`}
        aria-label={`${t('customize.table.bind')} ${title}`}
        onClick={onEdit}
      >
        {t('customize.table.bind')}
      </Button>
    )
  }
  return (
    <IconButton
      variant="ghost"
      size="sm"
      icon={Pencil}
      aria-label={t('customize.table.editWhat', { title })}
      data-testid={`customize-manage-${row.key}`}
      onClick={onEdit}
    />
  )
}

export interface CapActionsProps {
  readonly cap: string
  readonly title: string
  readonly handle: CustomizationHandle
}

/** A cap's header line: the whole group can be removed. */
export function CapActionsCell({ cap, title, handle }: CapActionsProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const current = currentComposition(handle.state)
  if (current === null) return null
  return (
    <IconButton
      variant="ghost"
      size="sm"
      icon={Trash2}
      aria-label={`${t('customize.table.remove')} ${title}`}
      data-testid={`customize-remove-offcatalog.${cap}`}
      disabled={handle.saving}
      onClick={() => {
        const next = withoutFeature(current, cap)
        void confirmRemove(
          t('customize.fieldsCard.removeWhat', { cap: title }),
          next === null,
        ).then((ok) => {
          if (ok) void handle.save(next)
        })
      }}
    />
  )
}

export interface FieldRowDialogProps {
  readonly row: FieldRow
  readonly title: string
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly names: ReadonlyMap<string, string>
  readonly onClose: () => void
}

/** The existing one-field editor (from device, formula, convert unit), opened on its own. */
export function FieldRowDialog({
  row,
  title,
  device,
  handle,
  names,
  onClose,
}: FieldRowDialogProps): ReactNode {
  const { t, i18n } = useTranslation()
  const selfLabel = useDeviceLabel(device, 'compact')
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          <OverrideFieldRow
            deviceId={device.id}
            self={handle.target}
            selfName={selfLabel}
            cap={row.cap}
            fieldPath={row.path}
            label={vocabularyFieldLabel(row.cap, row.path, i18n.language)}
            unit={runtimeFieldUnit(row.cap, row.path)}
            handle={handle}
            names={names}
            toFill={row.entry === null}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('customize.table.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
