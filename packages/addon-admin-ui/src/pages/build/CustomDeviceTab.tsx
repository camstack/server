/**
 * Custom Device — compositions the hub runs, in two lists (D659, D663).
 *
 * Composed devices: DataTable + ItemFormDialog with the shared card editor.
 * Customizations stay links to the device.
 */

import type { CompositionListRead } from '@camstack/types'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataColumn,
  ErrorBox,
  ItemFormDialog,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useCoreBlocksDelete,
  useCoreBlocksListCompositions,
  useDeviceLabelById,
  useItemFormUrl,
} from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { Boxes, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { CompositionBlockEditor } from '../../components/composition-editor/CompositionBlockEditor'
import {
  type CompositionCreateMode,
  CompositionCreateForm,
} from '../../components/composition-editor/CompositionCreateForm'
import { useDeviceList } from '../../hooks/useDevice'
import { customizePath, devicePath } from '../../lib/customization-routes'
import {
  buildCompositionRows,
  type CompositionRow,
  type CompositionRowLists,
  type CompositionRowSource,
  type FleetLookup,
  fleetLookupOf,
} from './composition-rows'
import { badgeVariantForTone } from './core-block-status'
import i18n from '../../i18n/index'

const POLL_MS = 10_000

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}

function useFleetLookup(): FleetLookup {
  const devices = useDeviceList()
  if (devices.data !== undefined) return fleetLookupOf(devices.data)
  return {
    state: 'unanswered',
    reason:
      devices.error != null
        ? i18n.t('build.customDeviceTab.deviceListUnreadable', {
            error: errorMessage(devices.error),
          })
        : i18n.t('build.customDeviceTab.deviceListPending'),
  }
}

export interface CustomDeviceTabProps {
  /**
   * Legacy `?create=1` on this tab. The header writes `?new=1` directly.
   * Cleared when the dialog closes (`onCreateConsumed`), never in the same
   * turn it opens — that second router write dropped `new` and closed the chooser.
   */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function createModeOf(raw: string | null, createRequested: boolean): CompositionCreateMode | null {
  if (raw === 'blank') return 'blank'
  if (raw === 'helper' || raw === '1') return 'helper'
  if (createRequested) return 'helper'
  return null
}

export function CustomDeviceTab({
  createRequested = false,
  onCreateConsumed,
}: CustomDeviceTabProps = {}) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const compositions = useCoreBlocksListCompositions({}, { refetchInterval: POLL_MS })
  const fleet = useFleetLookup()
  const formUrl = useItemFormUrl({ editKey: 'block', newKey: 'new' })
  const editingId = formUrl.state.mode === 'edit' ? formUrl.state.id : null
  const createMode = editingId === null ? createModeOf(params.get('new'), createRequested) : null
  const isNew = createMode !== null
  const [createTitle, setCreateTitle] = useState('')
  const confirm = useConfirm()
  const remove = useCoreBlocksDelete()

  const closeDialog = (): void => {
    formUrl.close()
    setParams(
      () => {
        const copy = new URLSearchParams(window.location.search)
        copy.delete('new')
        copy.delete('block')
        return copy
      },
      { replace: true },
    )
    onCreateConsumed?.()
  }

  const read = compositions.data
  const body = compositionBody(read, compositions.error, () => void compositions.refetch(), fleet, {
    onEditComposed: (blockId) => formUrl.openEdit(blockId),
    deleting: remove.isPending,
    onDelete: (row) => {
      void confirm({
        title: t('build.customDeviceTab.deleteThisComposedDevice', 'Delete this composed device?'),
        message: t(
          'build.customDeviceTab.deleteMessage',
          '{{name}} will be deleted. This cannot be undone.',
          {
            name: row.name,
          },
        ),
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      }).then((accepted) => {
        if (!accepted) return
        remove.mutate({ blockId: row.blockId }, { onSuccess: () => void compositions.refetch() })
      })
    },
  })

  return (
    <>
      {body}
      <ItemFormDialog
        open={isNew || editingId !== null}
        onClose={closeDialog}
        title={
          isNew
            ? createTitle ||
              (createMode === 'blank' ? t('helper.newComposition') : t('helper.newHelper'))
            : t('build.customDeviceTab.editComposedDevice', 'Edit composed device')
        }
        icon={Boxes}
        width="xl"
        testId="composed-device-editor"
      >
        {isNew && createMode !== null ? (
          <CompositionCreateForm key={createMode} mode={createMode} onTitle={setCreateTitle} />
        ) : editingId !== null ? (
          <CompositionBlockEditor blockId={editingId} />
        ) : null}
      </ItemFormDialog>
      {remove.error != null && <ErrorBox message={errorMessage(remove.error)} />}
    </>
  )
}

function notLoadedNote(reason: string): ReactNode {
  return (
    <Card>
      <div className="space-y-1 p-4">
        <p className="text-sm text-warning">
          {i18n.t(
            'build.customDeviceTab.theCompositionStoreHasNot',
            'The composition store has not been read yet.',
          )}
        </p>
        <p className="text-xs text-foreground-subtle">
          {i18n.t(
            'build.customDeviceTab.thisIsNotTheSame',
            'This is not the same as having none — the list appears once the hub has read it (',
          )}
          {reason}).
        </p>
      </div>
    </Card>
  )
}

interface CompositionBodyHandlers {
  readonly onEditComposed: (blockId: string) => void
  readonly deleting: boolean
  readonly onDelete: (row: CompositionRow) => void
}

function compositionBody(
  read: CompositionListRead | undefined,
  error: unknown,
  refetch: () => void,
  fleet: FleetLookup,
  handlers: CompositionBodyHandlers,
): ReactNode {
  if (error != null && read === undefined) {
    return (
      <ErrorBox
        title={i18n.t(
          'build.customDeviceTab.couldNotReadTheCompositions',
          'Could not read the compositions',
        )}
        message={errorMessage(error)}
        onRetry={refetch}
      />
    )
  }
  if (read === undefined) {
    return (
      <p className="p-4 text-sm text-foreground-subtle">
        {i18n.t('build.customDeviceTab.loadingCompositions', 'Loading compositions…')}
      </p>
    )
  }
  if (read.state === 'not-loaded') return notLoadedNote(read.reason)
  const refreshError = error != null ? errorMessage(error) : null
  const lists = buildCompositionRows(read.views, fleet)
  return (
    <CompositionLists lists={lists} fleet={fleet} refreshError={refreshError} handlers={handlers} />
  )
}

interface CompositionListsProps {
  readonly lists: CompositionRowLists
  readonly fleet: FleetLookup
  readonly refreshError: string | null
  readonly handlers: CompositionBodyHandlers
}

function CompositionLists({ lists, fleet, refreshError, handlers }: CompositionListsProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      {refreshError !== null && (
        <p className="text-xs text-warning">
          {t(
            'build.customDeviceTab.showingTheLastAnswerThe',
            'Showing the last answer — the latest refresh failed:',
          )}{' '}
          {refreshError}
        </p>
      )}
      {fleet.state === 'unanswered' && (
        <p className="text-xs text-warning">
          {t(
            'build.customDeviceTab.deviceNamesAreShownAs',
            'Device names are shown as references:',
          )}{' '}
          {fleet.reason}. No source is marked missing until it has.
        </p>
      )}
      <CompositionSection
        title={t('build.customDeviceTab.composedDevices', 'Composed devices')}
        hint={t(
          'build.customDeviceTab.aNewDeviceWhoseState',
          'A new device whose state is derived from other devices.',
        )}
        rows={lists.composed}
        nameHeader="Name"
        emptyMessage={t('build.customDeviceTab.noComposedDevices', 'No composed devices.')}
        kind="composed"
        handlers={handlers}
      />
      <CompositionSection
        title={t('build.customDeviceTab.customizations', 'Customizations')}
        hint={t(
          'build.customDeviceTab.fieldsAddedToOrReplaced',
          'Fields added to or replaced on an existing device — one per device, edited from the device.',
        )}
        rows={lists.customizations}
        nameHeader="Device"
        emptyMessage={t('build.customDeviceTab.noCustomizations', 'No customizations.')}
        kind="customization"
        handlers={handlers}
      />
    </div>
  )
}

interface CompositionSectionProps {
  readonly title: string
  readonly hint: string
  readonly rows: readonly CompositionRow[]
  readonly nameHeader: string
  readonly emptyMessage: string
  readonly kind: 'composed' | 'customization'
  readonly handlers: CompositionBodyHandlers
}

function CompositionSection({
  title,
  hint,
  rows,
  nameHeader,
  emptyMessage,
  kind,
  handlers,
}: CompositionSectionProps) {
  const { t } = useTranslation()
  return (
    <section className="space-y-2" aria-label={title}>
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-foreground-subtle">{hint}</p>
      </div>
      <DataTable<CompositionRow>
        columns={columnsFor(nameHeader, kind, handlers, t)}
        rows={rows}
        rowKey={(row) => row.blockId}
        pageSize={25}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        emptyMessage={emptyMessage}
        onRowClick={kind === 'composed' ? (row) => handlers.onEditComposed(row.blockId) : undefined}
      />
    </section>
  )
}

function columnsFor(
  nameHeader: string,
  kind: 'composed' | 'customization',
  handlers: CompositionBodyHandlers,
  t: TFunction,
): DataColumn<CompositionRow>[] {
  const cols: DataColumn<CompositionRow>[] = [
    {
      key: 'name',
      header: nameHeader,
      sortValue: (row) => row.name.toLowerCase(),
      render: (row) => <RowName row={row} />,
    },
    {
      key: 'type',
      header: i18n.t('build.customDeviceTab.type', 'Type'),
      sortValue: (row) => row.type,
      render: (row) => (
        <span className="text-xs text-foreground-subtle">
          {row.type ?? i18n.t('common.unknownWord')}
        </span>
      ),
    },
    {
      key: 'state',
      header: i18n.t('build.customDeviceTab.state', 'State'),
      nowrap: false,
      notSortableReason: 'A state and its reason are read together, not ordered.',
      render: (row) => (
        <div className="space-y-0.5">
          <Badge variant={badgeVariantForTone(row.state.tone)}>{row.state.label}</Badge>
          {row.state.reason !== null && (
            <p className="max-w-md whitespace-normal text-xs text-foreground-subtle">
              {row.state.reason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'sources',
      header: i18n.t('build.customDeviceTab.sources', 'Sources'),
      nowrap: false,
      notSortableReason: 'A list of devices has no single order.',
      render: (row) => <SourceList sources={row.sources} />,
    },
  ]
  if (kind === 'composed') {
    cols.push({
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Row actions',
      nowrap: true,
      render: (row) => {
        return (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              title={t('common.edit', 'Edit')}
              onClick={(e) => {
                e.stopPropagation()
                handlers.onEditComposed(row.blockId)
              }}
            >
              {t('common.edit', 'Edit')}
            </Button>
            <Button
              variant="ghost"
              title={t('common.delete', 'Delete')}
              disabled={handlers.deleting}
              aria-label={t('common.delete', 'Delete')}
              onClick={(e) => {
                e.stopPropagation()
                handlers.onDelete(row)
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      },
    })
  }
  return cols
}

interface RowNameProps {
  readonly row: CompositionRow
}

function RowName({ row }: RowNameProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-0.5">
      <RowNameLink row={row} />
      {row.namePresence === 'missing' && (
        <span className="ml-1.5 text-[10px] text-danger">
          {t('build.customDeviceTab.deviceMissing', 'device missing')}
        </span>
      )}
      <p className="text-[11px] text-foreground-subtle">{row.features.join(', ')}</p>
    </div>
  )
}

/** Composed names open the device. Customizations open its Customize tab. */
function RowNameLink({ row }: RowNameProps) {
  const { t } = useTranslation()
  const label = useDeviceLabelById(row.reportedDeviceId ?? 0, 'compact', row.name)
  const shown = row.reportedDeviceId === null ? row.name : label
  if (row.reportedDeviceId === null) {
    if (row.kind === 'composed') {
      return <span className="text-xs font-medium text-foreground">{row.name}</span>
    }
    return (
      <span className="text-xs text-foreground-subtle">
        {t('build.customDeviceTab.notReported', { name: shown })}
      </span>
    )
  }
  const to =
    row.kind === 'composed' ? devicePath(row.reportedDeviceId) : customizePath(row.reportedDeviceId)
  return (
    <Link
      to={to}
      className="text-xs font-medium text-foreground hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {shown}
    </Link>
  )
}

interface SourceListProps {
  readonly sources: readonly CompositionRowSource[]
}

function SourceList({ sources }: SourceListProps) {
  const { t } = useTranslation()
  if (sources.length === 0) return <span className="text-xs text-foreground-subtle">—</span>
  return (
    <ul className="space-y-0.5">
      {sources.map((source) => (
        <li key={source.key} className="text-xs">
          {source.deviceId === null ? (
            <span className={source.presence === 'missing' ? 'text-danger' : 'text-foreground'}>
              {source.label}
            </span>
          ) : (
            <Link to={`/devices/${String(source.deviceId)}`} className="hover:underline">
              {source.label}
            </Link>
          )}
          {source.presence === 'missing' && (
            <span className="ml-1.5 text-[10px] text-danger">{t('common.missing')}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
