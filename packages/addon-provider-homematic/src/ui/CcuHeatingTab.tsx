import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  DataTable,
  ErrorBox,
  KebabMenu,
  SectionCard,
  type DataColumn,
} from '@camstack/ui-library'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  HeatingGroupSchema,
  HeatingOverviewSchema,
  OkResultSchema,
  type HeatingGroup,
  type Thermostat,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { GroupFormDialog, type GroupDraft } from './GroupFormDialog.js'
import { textOrDash } from './format.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'form'; readonly group: HeatingGroup | null }

function temperature(value: number | null): string {
  return value === null ? '—' : `${value} °C`
}

/** Thermostats and heating groups. Group writes (create, change members, rename, delete) ask the operator first. */
export function CcuHeatingTab(props: { readonly trpc: CcuTrpc; readonly integrationId: string }) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const overview = useCcuData(trpc, 'listHeatingGroups', input, HeatingOverviewSchema)
  const write = useCcuWrite(trpc)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })

  const save = async (group: HeatingGroup | null, draft: GroupDraft): Promise<void> => {
    const done =
      group === null
        ? await write({
            action: 'createHeatingGroup',
            input: { integrationId, name: draft.name, type: draft.type, members: draft.members },
            schema: HeatingGroupSchema,
            title: t('heating.createTitle'),
            message: t('heating.createMessage', {
              name: draft.name.trim(),
              count: draft.members.length,
            }),
            confirmLabel: t('heating.createConfirm'),
          })
        : await write({
            action: 'updateHeatingGroup',
            input: { integrationId, id: group.id, name: draft.name, members: draft.members },
            schema: HeatingGroupSchema,
            title: t('heating.updateTitle'),
            message: t('heating.updateMessage', {
              name: group.name,
              count: draft.members.length,
            }),
            confirmLabel: t('heating.updateConfirm'),
          })
    if (done !== null) {
      setDialog({ kind: 'closed' })
      overview.reload()
    }
  }

  const remove = async (group: HeatingGroup): Promise<void> => {
    const done = await write({
      action: 'deleteHeatingGroup',
      input: { integrationId, id: group.id },
      schema: OkResultSchema,
      title: t('heating.deleteTitle'),
      message: t('heating.deleteMessage', { name: group.name }),
      confirmLabel: t('heating.deleteConfirm'),
      variant: 'danger',
    })
    if (done !== null) overview.reload()
  }

  const groupColumns: readonly DataColumn<HeatingGroup>[] = [
    {
      key: 'name',
      header: t('heating.colGroup'),
      render: (row) => row.name,
      sortValue: (row) => row.name,
    },
    {
      key: 'type',
      header: t('heating.colType'),
      render: (row) => textOrDash(row.typeLabel ?? row.type),
      sortValue: (row) => row.typeLabel ?? row.type,
    },
    {
      key: 'members',
      header: t('heating.colMembers'),
      nowrap: false,
      render: (row) => row.members.map((m) => m.deviceName ?? m.address).join(', '),
      sortValue: (row) => row.members.length,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Action column',
      render: (row) => (
        <KebabMenu
          items={[
            {
              id: 'edit',
              label: t('heating.edit'),
              icon: Pencil,
              onClick: () => setDialog({ kind: 'form', group: row }),
            },
            {
              id: 'delete',
              label: t('heating.delete'),
              icon: Trash2,
              onClick: () => void remove(row),
            },
          ]}
        />
      ),
    },
  ]

  const thermostatColumns: readonly DataColumn<Thermostat>[] = [
    {
      key: 'name',
      header: t('heating.colThermostat'),
      render: (row) => row.name ?? row.device,
      sortValue: (row) => row.name ?? row.device,
    },
    {
      key: 'current',
      header: t('heating.colCurrent'),
      align: 'right',
      render: (row) => temperature(row.currentTemperature),
      sortValue: (row) => row.currentTemperature,
    },
    {
      key: 'target',
      header: t('heating.colTarget'),
      align: 'right',
      render: (row) => temperature(row.targetTemperature),
      sortValue: (row) => row.targetTemperature,
    },
    {
      key: 'mode',
      header: t('heating.colMode'),
      render: (row) => t(`heating.mode_${row.mode}`),
      sortValue: (row) => row.mode,
    },
    {
      key: 'activity',
      header: t('heating.colActivity'),
      render: (row) => (
        <Badge variant={row.activity === 'heating' ? 'warning' : 'default'}>
          {t(`heating.activity_${row.activity}`)}
        </Badge>
      ),
      sortValue: (row) => row.activity,
    },
  ]

  if (overview.error !== null) {
    return (
      <ErrorBox
        title={t('heating.loadFailed')}
        message={overview.error}
        onRetry={overview.reload}
      />
    )
  }
  const data = overview.data
  return (
    <div className="flex flex-col gap-3">
      <SectionCard
        headingId="hm-heating-groups"
        title={t('heating.groupsTitle')}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={data === undefined || data.groupsError !== null}
            onClick={() => setDialog({ kind: 'form', group: null })}
          >
            <Plus className="h-4 w-4" />
            {t('heating.newGroup')}
          </Button>
        }
      >
        {data?.groupsError ? (
          <ErrorBox
            variant="warning"
            title={t('heating.groupsUnavailable')}
            message={data.groupsError}
          />
        ) : (
          <DataTable
            columns={groupColumns}
            rows={data?.groups ?? []}
            rowKey={(row) => row.id}
            minWidthPx={520}
            emptyMessage={overview.loading ? t('common.loading') : t('heating.noGroups')}
          />
        )}
      </SectionCard>
      <SectionCard headingId="hm-heating-thermostats" title={t('heating.thermostatsTitle')}>
        <DataTable
          columns={thermostatColumns}
          rows={data?.thermostats ?? []}
          rowKey={(row) => row.channel}
          minWidthPx={520}
          emptyMessage={overview.loading ? t('common.loading') : t('heating.noThermostats')}
        />
      </SectionCard>
      {dialog.kind === 'form' && data !== undefined && (
        <GroupFormDialog
          group={dialog.group}
          candidates={data.candidates}
          onClose={() => setDialog({ kind: 'closed' })}
          onSave={(draft) => save(dialog.group, draft)}
        />
      )}
    </div>
  )
}
