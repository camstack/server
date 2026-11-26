/**
 * The "Source device" row of a whole-capability link the cap declares (D1076),
 * as the cells of one `CustomizeTable` line like every other kind: the linked
 * device in Source, the link's state in Value, and Edit (the `SourceSelector`
 * device dialog), the active Switch and the confirmed Remove in Actions. Every
 * change is a draft the tab's one Save writes; the server's refusal of a link
 * that would also take a field one of the readings stores is shown on Save.
 */
import type { DeviceInfo } from '@camstack/types'
import { Badge, IconButton } from '@camstack/ui-library'
import { Pencil, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { currentComposition } from '../customization-read'
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import {
  type OfferedCapLink,
  withCapLink,
  withCapLinkEnabled,
  withoutCapLink,
} from './cap-link-edit'
import { RowActiveSwitch } from './RowActiveSwitch'
import { useCapLinkRow } from './use-cap-link-row'

export interface CapLinkCellProps {
  readonly device: Pick<DeviceInfo, 'id'>
  readonly handle: CustomizationHandle
  readonly offered: OfferedCapLink
}

const testIdOf = (offered: OfferedCapLink): string => `cap-link-${offered.cap}-${offered.link.id}`

/** The linked device, or "Not linked". */
export function CapLinkSourceCell(props: CapLinkCellProps): ReactNode {
  const { t } = useTranslation()
  const facts = useCapLinkRow(props.device, props.handle, props.offered)
  return (
    <span className="flex flex-col gap-0.5" data-testid={testIdOf(props.offered)}>
      <span className="text-xs text-foreground">
        {facts.stored === null
          ? t('customize.table.capLink.none')
          : (facts.source?.name ?? `#${facts.stored.source.stableId}`)}
      </span>
    </span>
  )
}

/** The state the server reads for the stored link, and the one-line hint. */
export function CapLinkValueCell(props: CapLinkCellProps): ReactNode {
  const { t } = useTranslation()
  const facts = useCapLinkRow(props.device, props.handle, props.offered)
  return (
    <span className="flex flex-col gap-1">
      {facts.state === 'source-gone' && (
        <Badge variant="warning">{t('customize.table.capLink.gone')}</Badge>
      )}
      {facts.state === 'disabled' && (
        <Badge variant="neutral">{t('customize.table.capLink.off')}</Badge>
      )}
      <span className="text-[11px] text-foreground-muted">
        {props.offered.link.mode === 'reference'
          ? t('customize.table.capLink.referenceHint')
          : t('customize.table.capLink.projectHint')}
      </span>
    </span>
  )
}

export interface CapLinkActionsProps extends CapLinkCellProps {
  readonly title: string
  readonly onEdit: () => void
  readonly onError: (reason: string | null) => void
}

/** Edit, active switch and remove; the switch and the bin exist once a link is stored. */
export function CapLinkActionsCell(props: CapLinkActionsProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const facts = useCapLinkRow(props.device, props.handle, props.offered)
  const current = currentComposition(props.handle.state)
  const stored = facts.stored
  const report = async (next: Parameters<CustomizationHandle['save']>[0]): Promise<void> => {
    const outcome = await props.handle.save(next)
    props.onError(outcome.kind === 'refused' ? outcome.reason : null)
  }
  const disabled = !facts.answered || props.handle.saving
  return (
    <span className="flex items-center justify-end gap-1">
      <IconButton
        variant="ghost"
        size="sm"
        icon={Pencil}
        aria-label={t('customize.table.editWhat', { title: props.title })}
        data-testid={`${testIdOf(props.offered)}-edit`}
        disabled={disabled || facts.candidates.kind !== 'known'}
        onClick={props.onEdit}
      />
      {stored !== null && current !== null && (
        <RowActiveSwitch
          title={props.title}
          checked={stored.enabled !== false}
          disabled={disabled}
          testId={`${testIdOf(props.offered)}-active`}
          onChange={(enabled) => void report(withCapLinkEnabled(current, props.offered, enabled))}
        />
      )}
      {stored !== null && current !== null && (
        <IconButton
          variant="ghost"
          size="sm"
          icon={Trash2}
          aria-label={`${t('customize.table.remove')} ${props.title}`}
          data-testid={`${testIdOf(props.offered)}-remove`}
          disabled={disabled}
          onClick={() => {
            const next = withoutCapLink(current, props.offered)
            void confirmRemove(
              t('customize.table.capLink.removeWhat', { name: facts.source?.name ?? props.title }),
              next === null,
            ).then((ok) => (ok ? report(next) : undefined))
          }}
        />
      )}
    </span>
  )
}

export interface CapLinkDialogProps extends CapLinkCellProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onError: (reason: string | null) => void
}

/** The device step of the `SourceSelector`: one pick sets or replaces the link. */
export function CapLinkDialog(props: CapLinkDialogProps): ReactNode {
  const { t } = useTranslation()
  const facts = useCapLinkRow(props.device, props.handle, props.offered)
  return (
    <SourceSelectorDevicesDialog
      open={props.open}
      title={t('customize.table.capLink.pickTitle')}
      selection="single"
      candidates={facts.candidates}
      confirmLabel={() => t('customize.table.capLink.pick')}
      onConfirm={(picked) => {
        const first = picked[0]
        props.onClose()
        if (first === undefined) return
        void props.handle
          .save(
            withCapLink(
              currentComposition(props.handle.state),
              props.handle.target,
              props.offered,
              first.ref,
            ),
          )
          .then((outcome) => props.onError(outcome.kind === 'refused' ? outcome.reason : null))
      }}
      onClose={props.onClose}
    />
  )
}
