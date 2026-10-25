import type { RecordView, StorageKind } from '@camstack/types'
import { Loader2 } from 'lucide-react'
import { useMemo, useState, type JSX } from 'react'
import { trpc } from '../../trpc-react'
import { Badge } from '../../primitives/badge'
import { Button } from '../../primitives/button'
import { CodeBlock } from '../code-block'
import { DataTable, TABLE_SCROLL_MAX_H, type DataColumn } from '../data-table'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { EmptyState } from '../empty-state'
import { ErrorBox } from '../error-box'
import { useUiText } from '../../contexts/ui-text'

export interface StorageRecordsPanelProps {
  readonly kind: StorageKind
}

export function StorageRecordsPanel({ kind }: StorageRecordsPanelProps): JSX.Element {
  const t = useUiText()
  const [inspect, setInspect] = useState<RecordView | null>(null)

  const recordsQuery = trpc.storageAdmin.readRecords.useQuery(
    { owner: kind.owner, kind: kind.kind, limit: 100, desc: true },
    { staleTime: 15_000 },
  )

  const records = recordsQuery.data?.records ?? []

  const columns = useMemo((): readonly DataColumn<RecordView>[] => {
    return [
      {
        key: 'id',
        header: t('uiLibrary.storageRecords.colId', 'Id'),
        render: (row) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto max-w-full justify-start px-0 py-0 font-mono text-xs hover:underline"
            onClick={() => setInspect(row)}
          >
            <span className="truncate">{row.id}</span>
          </Button>
        ),
      },
      {
        key: 'deviceId',
        header: t('uiLibrary.storageRecords.colDevice', 'Device'),
        nowrap: true,
        render: (row) =>
          row.deviceId === null ? (
            <span className="text-foreground-subtle">—</span>
          ) : (
            <span className="font-mono text-xs">{row.deviceId}</span>
          ),
      },
      {
        key: 'at',
        header: t('uiLibrary.storageRecords.colAt', 'At'),
        nowrap: true,
        render: (row) => (
          <span className="text-[11px] text-foreground-subtle">
            {row.at === null ? '—' : new Date(row.at).toLocaleString()}
          </span>
        ),
      },
      {
        key: 'updatedAt',
        header: t('uiLibrary.storageRecords.colUpdated', 'Updated'),
        nowrap: true,
        render: (row) => (
          <span className="text-[11px] text-foreground-subtle">
            {new Date(row.updatedAt).toLocaleString()}
          </span>
        ),
      },
    ]
  }, [t])

  const title = `${kind.owner}/${kind.kind}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Badge variant="neutral" style="outline">
          {kind.database}
        </Badge>
        <Badge variant="neutral" style="outline">
          {kind.class}
        </Badge>
        <Badge variant={kind.state === 'declared' ? 'default' : 'neutral'}>{kind.state}</Badge>
        {kind.entry ? (
          <Badge variant="info">{t('uiLibrary.storageRecords.entryKind', 'Entry')}</Badge>
        ) : null}
      </div>

      {recordsQuery.isError ? (
        <ErrorBox
          message={
            recordsQuery.error instanceof Error
              ? recordsQuery.error.message
              : t('uiLibrary.storageRecords.loadFailed', 'Could not load records')
          }
        />
      ) : recordsQuery.isPending ? (
        <div className="flex justify-center py-8 text-foreground-subtle">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          title={t('uiLibrary.storageRecords.emptyTitle', 'No rows')}
          description={t(
            'uiLibrary.storageRecords.emptyDescription',
            'This kind has no stored records yet.',
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={records}
          rowKey={(r) => r.id}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t('uiLibrary.storageRecords.emptyTitle', 'No rows')}
        />
      )}

      <Dialog open={inspect !== null} onOpenChange={(open) => !open && setInspect(null)}>
        <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
          <DialogHeader>
            <DialogTitle>{t('uiLibrary.storageRecords.inspectTitle', 'Record')}</DialogTitle>
            {inspect !== null ? (
              <DialogDescription className="font-mono">{inspect.id}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogBody>
            {inspect !== null ? (
              <CodeBlock maxHeight={480}>{JSON.stringify(inspect, null, 2)}</CodeBlock>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
