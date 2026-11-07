/**
 * The cells and the dialog host of one scalar Customize row. A scalar row
 * edits through the existing {@link ScalarOverrideDialog}; the cells only read
 * what {@link useScalarRow} projects and open it.
 */
import type { CustomizeCatalogTarget, DeviceInfo } from '@camstack/types'
import { Badge, IconButton } from '@camstack/ui-library'
import { Pencil, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LiveValueText } from '../assignments/LiveValueText'
import { FormulaEntryButton } from '../formula/FormulaEntryButton'
import type { CustomizationHandle } from '../use-customization'
import { FollowSwitchToggle } from '../scalar/FollowSwitchToggle'
import { currentComposition } from '../customization-read'
import { isFollowSwitchRow, readFollowSwitch } from '../scalar/follow-switch'
import { ScalarOverrideDialog } from '../scalar/ScalarOverrideDialog'
import { type ScalarRowModel, useScalarRow } from '../scalar/use-scalar-row'

export interface ScalarRowProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}

/** The live effective value of the target on the host device. */
export function ScalarValueCell({ device, cap, target }: ScalarRowProps): ReactNode {
  return <LiveValueText target={{ deviceId: device.id, cap, path: target.path ?? target.id }} />
}

function badgeText(
  t: (key: string, opts?: Record<string, string>) => string,
  row: ScalarRowModel,
): string {
  return row.badge.kind === 'assigned'
    ? t('customize.scalar.badge.assigned', { source: row.badge.source })
    : t(`customize.scalar.badge.${row.badge.kind}`)
}

/** Where the value comes from: the linked device and field, or the authority that owns it. */
export function ScalarSourceCell(props: ScalarRowProps): ReactNode {
  const source = <ScalarSource {...props} />
  if (!isFollowSwitchRow(props.cap, props.target.id)) return source
  return (
    <span className="flex flex-col gap-1">
      {source}
      <FollowSwitchToggle handle={props.handle} />
    </span>
  )
}

function ScalarSource(props: ScalarRowProps): ReactNode {
  const { t } = useTranslation()
  const row = useScalarRow(props.device, props.handle, props.cap, props.target)
  if (row.recognized && !row.released) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-foreground">
          {t('customize.table.sourceOf', {
            name: row.sourceName ?? '…',
            field: row.sourceField,
          })}
        </span>
        {row.presence === 'unknown' && (
          <span role="alert" className="text-[11px] text-warning">
            {t('customize.scalar.sourceUnreadable')}
          </span>
        )}
      </span>
    )
  }
  if (row.released) {
    return <Badge variant="warning">{t('customize.table.sourceMissing')}</Badge>
  }
  if (row.otherFormula) {
    return (
      <span className="flex flex-wrap items-center gap-1 text-xs text-foreground">
        {t('customize.table.otherFormula')}
        <FormulaEntryButton handle={props.handle} cap={props.cap} fieldPath={row.path} />
      </span>
    )
  }
  if (
    isFollowSwitchRow(props.cap, props.target.id) &&
    readFollowSwitch(currentComposition(props.handle.state)).offered &&
    row.stored.kind === 'known' &&
    row.stored.value === null
  ) {
    return <span className="text-xs text-foreground">{t('customize.followSwitch.default')}</span>
  }
  return <Badge>{badgeText(t, row)}</Badge>
}

export interface ScalarActionsProps extends ScalarRowProps {
  readonly onEdit: () => void
  readonly onError: (reason: string | null) => void
}

export function ScalarActionsCell(props: ScalarActionsProps): ReactNode {
  const { t } = useTranslation()
  const row = useScalarRow(props.device, props.handle, props.cap, props.target)
  const rowKey = `${props.cap}.${props.target.id}`
  // The running row that follows the switch can still be pointed at another source.
  const followOffered =
    isFollowSwitchRow(props.cap, props.target.id) &&
    readFollowSwitch(currentComposition(props.handle.state)).offered
  return (
    <span className="flex items-center justify-end gap-1">
      {(row.recognized || followOffered) && (
        <IconButton
          variant="ghost"
          size="sm"
          icon={Pencil}
          aria-label={t('customize.table.editWhat', { title: row.title })}
          data-testid={`scalar-change-${rowKey}`}
          disabled={row.saving}
          onClick={props.onEdit}
        />
      )}
      {(row.recognized || row.otherFormula) && (
        <IconButton
          variant="ghost"
          size="sm"
          icon={Trash2}
          aria-label={`${t('customize.table.remove')} ${row.title}`}
          data-testid={`scalar-remove-${rowKey}`}
          disabled={row.saving}
          onClick={() => void row.remove().then(props.onError)}
        />
      )}
    </span>
  )
}

export interface ScalarDialogHostProps extends ScalarRowProps {
  readonly mode: 'add' | 'replace'
  readonly onClose: () => void
  readonly onError: (reason: string | null) => void
}

/** The ONE open scalar dialog: add for an unlinked row, change for a linked one. */
export function ScalarDialogHost(props: ScalarDialogHostProps): ReactNode {
  const row = useScalarRow(props.device, props.handle, props.cap, props.target)
  return (
    <ScalarOverrideDialog
      open
      mode={row.seed === null ? 'add' : 'change'}
      title={row.title}
      cap={props.cap}
      targetId={props.target.id}
      host={props.device}
      target={props.handle.target}
      apply={props.mode}
      seed={row.seed}
      canSave={row.answered && !row.saving}
      onClose={props.onClose}
      onSave={(feature) => {
        props.onClose()
        void row.saveFeature(feature).then(props.onError)
      }}
    />
  )
}
