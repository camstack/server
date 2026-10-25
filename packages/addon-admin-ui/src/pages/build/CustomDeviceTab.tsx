/**
 * Custom Device — compositions the hub runs, in two lists (D659, D663).
 *
 * Composed devices: DataTable + ItemFormDialog with the shared card editor.
 * Customizations stay links to the device.
 */

import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataColumn,
  ErrorBox,
  ItemFormDialog,
  TABLE_SCROLL_MAX_H,
  useCoreBlocksListCompositions,
  useItemFormUrl,
} from '@camstack/ui-library'
import { Boxes } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CompositionBlockEditor } from '../../components/composition-editor/CompositionBlockEditor'
import { CompositionCreateForm } from '../../components/composition-editor/CompositionCreateForm'
import { useDeviceList } from '../../hooks/useDevice'
import { customizePath } from '../../lib/customization-routes'
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
  /** Header "New composition" from Build — open create once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

export function CustomDeviceTab({
  createRequested = false,
  onCreateConsumed,
}: CustomDeviceTabProps = {}) {
  const { t } = useTranslation()
  const compositions = useCoreBlocksListCompositions({}, { refetchInterval: POLL_MS })
  const fleet = useFleetLookup()
  const formUrl = useItemFormUrl({ editKey: 'block', newKey: 'new' })

  useEffect(() => {
    if (!createRequested) return
    formUrl.openNew()
    onCreateConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested])

  const read = compositions.data
  if (compositions.error != null && read === undefined) {
    return (
      <ErrorBox
        title={t(
          'build.customDeviceTab.couldNotReadTheCompositions',
          'Could not read the compositions',
        )}
        message={errorMessage(compositions.error)}
        onRetry={() => void compositions.refetch()}
      />
    )
  }
  if (read === undefined) {
    return (
      <p className="p-4 text-sm text-foreground-subtle">
        {t('build.customDeviceTab.loadingCompositions', 'Loading compositions…')}
      </p>
    )
  }
  if (read.state === 'not-loaded') {
    return (
      <Card>
        <div className="space-y-1 p-4">
          <p className="text-sm text-warning">
            {t(
              'build.customDeviceTab.theCompositionStoreHasNot',
              'The composition store has not been read yet.',
            )}
          </p>
          <p className="text-xs text-foreground-subtle">
            {t(
              'build.customDeviceTab.thisIsNotTheSame',
              'This is not the same as having none — the list appears once the hub has read it (',
            )}
            {read.reason}).
          </p>
        </div>
      </Card>
    )
  }
  const refreshError = compositions.error != null ? errorMessage(compositions.error) : null
  const lists = buildCompositionRows(read.views, fleet)
  const editingId = formUrl.state.mode === 'edit' ? formUrl.state.id : null
  const isNew = formUrl.state.mode === 'new'

  return (
    <>
      <CompositionLists
        lists={lists}
        fleet={fleet}
        refreshError={refreshError}
        onEditComposed={(blockId) => formUrl.openEdit(blockId)}
      />
      <ItemFormDialog
        open={isNew || editingId !== null}
        onClose={() => formUrl.close()}
        title={
          isNew
            ? t('build.customDeviceTab.newComposedDevice', 'New composed device')
            : t('build.customDeviceTab.editComposedDevice', 'Edit composed device')
        }
        icon={Boxes}
        width="xl"
        testId="composed-device-editor"
      >
        {isNew ? (
          <CompositionCreateForm />
        ) : editingId !== null ? (
          <CompositionBlockEditor blockId={editingId} />
        ) : null}
      </ItemFormDialog>
    </>
  )
}

interface CompositionListsProps {
  readonly lists: CompositionRowLists
  readonly fleet: FleetLookup
  readonly refreshError: string | null
  readonly onEditComposed: (blockId: string) => void
}

function CompositionLists({ lists, fleet, refreshError, onEditComposed }: CompositionListsProps) {
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
        onEditComposed={onEditComposed}
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
        onEditComposed={onEditComposed}
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
  readonly onEditComposed: (blockId: string) => void
}

function CompositionSection({
  title,
  hint,
  rows,
  nameHeader,
  emptyMessage,
  kind,
  onEditComposed,
}: CompositionSectionProps) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-foreground-subtle">{hint}</p>
      </div>
      <Card variant="flat" className="p-0">
        <DataTable<CompositionRow>
          columns={columnsFor(nameHeader, kind, onEditComposed)}
          rows={rows}
          rowKey={(row) => row.blockId}
          minWidthPx={760}
          bordered={false}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={emptyMessage}
          onRowClick={kind === 'composed' ? (row) => onEditComposed(row.blockId) : undefined}
        />
      </Card>
    </section>
  )
}

function columnsFor(
  nameHeader: string,
  kind: 'composed' | 'customization',
  onEditComposed: (blockId: string) => void,
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
      render: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation()
              onEditComposed(row.blockId)
            }}
          >
            {i18n.t('common.edit', 'Edit')}
          </Button>
        </div>
      ),
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

/** Composed: plain name (row click / Edit opens dialog). Customization: device link. */
function RowNameLink({ row }: RowNameProps) {
  const { t } = useTranslation()
  if (row.kind === 'composed') {
    return <span className="text-xs font-medium text-foreground">{row.name}</span>
  }
  if (row.reportedDeviceId === null) {
    return (
      <span className="text-xs text-foreground-subtle">
        {t('build.customDeviceTab.notReported', { name: row.name })}
      </span>
    )
  }
  return (
    <Link
      to={customizePath(row.reportedDeviceId)}
      className="text-xs text-foreground hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {row.name}
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
