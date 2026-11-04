/**
 * The cells and the editor dialog of the table's non-catalog rows: a field
 * group the catalog does not know (Other fields).
 */
import { compositionSourceKey, type CompositionFieldsCard, type DeviceInfo } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  useDeviceLabel,
} from '@camstack/ui-library'
import { Pencil, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FieldsCardBody } from '../cards/FieldsCardBody'
import { LiveValueText } from '../assignments/LiveValueText'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyCapTitle } from '../vocabulary-field-label'
import { currentComposition } from '../customization-read'
import { withoutFeature } from '../customization-save'
import { useConfirmRemove } from '../use-confirm-remove'
import { entryReads } from './extra-rows'

function Checking(): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="status" className="text-xs text-foreground-subtle">
      {t('customize.event.checking')}
    </span>
  )
}

interface FieldsRowProps {
  readonly device: DeviceInfo
  readonly card: CompositionFieldsCard
}

/** One field: its live value; several: how many are overridden. */
export function OffCatalogValueCell({ device, card }: FieldsRowProps): ReactNode {
  const { t } = useTranslation()
  const paths = Object.keys(card.entries)
  const [only] = paths
  if (paths.length === 1 && only !== undefined) {
    return <LiveValueText target={{ deviceId: device.id, cap: card.cap, path: only }} />
  }
  return (
    <span className="text-xs text-foreground">
      {t('customize.table.fieldsCount', { count: paths.length })}
    </span>
  )
}

/** The devices the group's fields read, by name; a formula with no device says so. */
export function OffCatalogSourceCell({ card }: Pick<FieldsRowProps, 'card'>): ReactNode {
  const { t } = useTranslation()
  const fleet = useCandidateDevices(true)
  const sources = useMemo(() => {
    const seen = new Map<string, { addonId: string; stableId: string }>()
    for (const entry of Object.values(card.entries)) {
      for (const read of entryReads(entry)) seen.set(compositionSourceKey(read.source), read.source)
    }
    return [...seen.entries()]
  }, [card])
  if (sources.length === 0) {
    return <span className="text-xs text-foreground-subtle">{t('customize.table.noSource')}</span>
  }
  if (fleet.kind === 'pending') return <Checking />
  if (fleet.kind === 'unknown') {
    return (
      <span role="alert" className="text-xs text-warning" title={fleet.reason}>
        {t('customize.table.unknown')}
      </span>
    )
  }
  const names = new Map(
    fleet.value.map((row) => [
      compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }),
      row.name,
    ]),
  )
  return (
    <span className="text-xs text-foreground">
      {sources.map(([key]) => names.get(key) ?? t('customize.fieldsCard.unknownDevice')).join(', ')}
    </span>
  )
}

export interface ExtraRow {
  readonly kind: 'offCatalog'
  readonly key: string
  readonly card: CompositionFieldsCard
}

export function offCatalogTitle(language: string, card: CompositionFieldsCard): string {
  return vocabularyCapTitle(card.cap, language)
}

export interface ExtraActionsProps {
  readonly row: ExtraRow
  readonly title: string
  readonly handle: CustomizationHandle
  readonly onEdit: () => void
}

/** Edit opens the row's editor; an off-catalog group can also be removed whole. */
export function ExtraActionsCell({ row, title, handle, onEdit }: ExtraActionsProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const current = currentComposition(handle.state)
  return (
    <span className="flex items-center justify-end gap-1">
      <IconButton
        variant="ghost"
        size="sm"
        icon={Pencil}
        aria-label={t('customize.table.editWhat', { title })}
        data-testid={`customize-manage-${row.key}`}
        onClick={onEdit}
      />
      {row.kind === 'offCatalog' && current !== null && (
        <IconButton
          variant="ghost"
          size="sm"
          icon={Trash2}
          aria-label={`${t('customize.table.remove')} ${title}`}
          data-testid={`customize-remove-${row.key}`}
          disabled={handle.saving}
          onClick={() => {
            const next = withoutFeature(current, row.card.cap)
            void confirmRemove(
              t('customize.fieldsCard.removeWhat', { cap: title }),
              next === null,
            ).then((ok) => {
              if (ok) void handle.save(next)
            })
          }}
        />
      )}
    </span>
  )
}

export interface ExtraRowDialogProps {
  readonly row: ExtraRow
  readonly title: string
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly onClose: () => void
}

/** The existing editor of the row, opened on its own. */
export function ExtraRowDialog({
  row,
  title,
  device,
  handle,
  onClose,
}: ExtraRowDialogProps): ReactNode {
  const { t } = useTranslation()
  const selfLabel = useDeviceLabel(device, 'compact')
  const fleet = useCandidateDevices(row.kind === 'offCatalog')
  const names = useMemo(
    () =>
      new Map(
        fleet.kind === 'known'
          ? fleet.value.map((r) => [
              compositionSourceKey({
                addonId: r.addonId,
                stableId: r.stableId,
              }),
              r.name,
            ])
          : [],
      ),
    [fleet],
  )
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          <FieldsCardBody
            deviceId={device.id}
            selfName={selfLabel}
            card={row.card}
            handle={handle}
            names={names}
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
