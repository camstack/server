import { useMemo, useState } from 'react'
import {
  Button,
  DataTable,
  ErrorBox,
  KebabMenu,
  SectionCard,
  usePrompt,
  type DataColumn,
} from '@camstack/ui-library'
import { DoorOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  CcuRoomSchema,
  CcuRoomsResultSchema,
  OkResultSchema,
  RoomChannelsResultSchema,
  type CcuRoom,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { endpointLabel } from './link-labels.js'
import { RoomChannelsDialog } from './RoomChannelsDialog.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

export interface CcuSettingsTabProps {
  readonly trpc: CcuTrpc
  readonly integrationId: string
}

/** CCU settings: the rooms (create, rename, delete, which channels each holds). Every write asks first. */
export function CcuSettingsTab(props: CcuSettingsTabProps) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const rooms = useCcuData(trpc, 'listCcuRooms', input, CcuRoomsResultSchema)
  const write = useCcuWrite(trpc)
  const prompt = usePrompt()
  const [editing, setEditing] = useState<CcuRoom | null>(null)

  const create = async (): Promise<void> => {
    const name = await prompt({ title: t('rooms.newRoom'), label: t('rooms.fieldName') })
    if (name === null || name.trim() === '') return
    const done = await write({
      action: 'createCcuRoom',
      input: { integrationId, name },
      schema: CcuRoomSchema,
      title: t('rooms.createTitle'),
      message: t('rooms.createMessage', { name: name.trim() }),
      confirmLabel: t('rooms.createConfirm'),
    })
    if (done !== null) rooms.reload()
  }

  const rename = async (room: CcuRoom): Promise<void> => {
    const name = await prompt({
      title: t('rooms.renameTitle'),
      label: t('rooms.fieldName'),
      defaultValue: room.name,
    })
    if (name === null || name.trim() === '' || name.trim() === room.name) return
    const done = await write({
      action: 'renameCcuRoom',
      input: { integrationId, id: room.id, name },
      schema: OkResultSchema,
      title: t('rooms.renameTitle'),
      message: t('rooms.renameMessage', { from: room.name, to: name.trim() }),
      confirmLabel: t('rooms.renameConfirm'),
    })
    if (done !== null) rooms.reload()
  }

  const remove = async (room: CcuRoom): Promise<void> => {
    const done = await write({
      action: 'deleteCcuRoom',
      input: { integrationId, id: room.id },
      schema: OkResultSchema,
      title: t('rooms.deleteTitle'),
      message: t('rooms.deleteMessage', { name: room.name }),
      confirmLabel: t('rooms.deleteConfirm'),
      variant: 'danger',
    })
    if (done !== null) rooms.reload()
  }

  const saveChannels = async (room: CcuRoom, channels: readonly string[]): Promise<void> => {
    const done = await write({
      action: 'setCcuRoomChannels',
      input: { integrationId, id: room.id, channels },
      schema: RoomChannelsResultSchema,
      title: t('rooms.membersTitle'),
      message: t('rooms.membersMessage', { name: room.name, count: channels.length }),
      confirmLabel: t('rooms.membersConfirm'),
    })
    if (done !== null) {
      setEditing(null)
      rooms.reload()
    }
  }

  const columns: readonly DataColumn<CcuRoom>[] = [
    {
      key: 'name',
      header: t('rooms.colRoom'),
      render: (row) => row.name,
      sortValue: (row) => row.name,
    },
    {
      key: 'channels',
      header: t('rooms.colChannels'),
      nowrap: false,
      render: (row) =>
        row.channels.length === 0 ? '—' : row.channels.map(endpointLabel).join(', '),
      sortValue: (row) => row.channels.length,
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
              id: 'channels',
              label: t('rooms.editChannels'),
              icon: DoorOpen,
              onClick: () => setEditing(row),
            },
            {
              id: 'rename',
              label: t('rooms.rename'),
              icon: Pencil,
              onClick: () => void rename(row),
            },
            {
              id: 'delete',
              label: t('rooms.delete'),
              icon: Trash2,
              danger: true,
              onClick: () => void remove(row),
            },
          ]}
        />
      ),
    },
  ]

  if (rooms.error !== null) {
    return <ErrorBox title={t('rooms.loadFailed')} message={rooms.error} onRetry={rooms.reload} />
  }
  const data = rooms.data
  return (
    <div className="flex flex-col gap-3">
      <SectionCard
        headingId="hm-rooms"
        title={t('rooms.title')}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={data === undefined}
            onClick={() => void create()}
          >
            <Plus className="h-4 w-4" />
            {t('rooms.newRoom')}
          </Button>
        }
      >
        <DataTable
          columns={columns}
          rows={data?.rooms ?? []}
          rowKey={(row) => row.id}
          minWidthPx={340}
          defaultSort={{ columnKey: 'name', dir: 'asc' }}
          emptyMessage={rooms.loading ? t('common.loading') : t('rooms.none')}
        />
      </SectionCard>
      {editing !== null && data !== undefined && (
        <RoomChannelsDialog
          room={editing}
          channels={data.channels}
          onClose={() => setEditing(null)}
          onSave={(channels) => saveChannels(editing, channels)}
        />
      )}
    </div>
  )
}
