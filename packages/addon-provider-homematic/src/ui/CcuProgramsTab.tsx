import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  DataTableFilterBar,
  type DataTableFilterConfig,
  ErrorBox,
  KebabMenu,
  type KebabMenuItem,
  useConfirm,
  useDataTableFilter,
} from '@camstack/ui-library'
import { ListTree, Pencil, Play, Power, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  type CcuProgram,
  CcuProgramsResultSchema,
  OkResultSchema,
  type ProgramChannel,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { type CcuTrpc, callCcuAction } from './ccu-client.js'
import { type ProgramDraft, ProgramFormDialog } from './ProgramFormDialog.js'
import { type RunTimeText, relativeRun } from './relative-run.js'
import { TableBlock } from './TableBlock.js'
import { useCcuData } from './use-ccu-data.js'

type RowWrite =
  | { readonly kind: 'busy' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string }

type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'form'; readonly program: CcuProgram | null }

export interface CcuProgramsTabProps {
  readonly trpc: CcuTrpc
  readonly integrationId: string
}

function programSearchText(program: CcuProgram): readonly string[] {
  return [
    program.name,
    program.active ? 'active' : 'inactive',
    program.createdByCamstack ? 'camstack' : '',
    ...program.channels.flatMap((channel) => [
      channel.address,
      channel.channelName ?? '',
      channel.deviceName ?? '',
    ]),
  ]
}

const PROGRAM_FILTER: DataTableFilterConfig<CcuProgram> = {
  searchText: programSearchText,
}

function channelLabel(channel: ProgramChannel): string {
  const device = channel.deviceName ?? channel.address
  return channel.channelName === null ? device : `${device} · ${channel.channelName}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The CCU's programs. Run, enable and delete ask first and report on the row.
 * Create and edit only the key-event program CamStack uses for an HmIP button.
 */
export function CcuProgramsTab(props: CcuProgramsTabProps) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const confirm = useConfirm()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const result = useCcuData(trpc, 'listCcuPrograms', input, CcuProgramsResultSchema)
  const [writes, setWrites] = useState<Readonly<Record<string, RowWrite>>>({})
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const programs = result.data?.programs ?? []
  const filter = useDataTableFilter(programs, PROGRAM_FILTER)
  const timeText: RunTimeText = {
    justNow: t('programs.justNow'),
    minutesAgo: (count) => t('programs.minutesAgo', { count }),
    hoursAgo: (count) => t('programs.hoursAgo', { count }),
    daysAgo: (count) => t('programs.daysAgo', { count }),
  }
  const now = Date.now()

  const mark = (id: string, write: RowWrite): void => {
    setWrites((prev) => ({ ...prev, [id]: write }))
  }

  const runWrite = async (
    program: CcuProgram,
    action: string,
    body: Record<string, unknown>,
    copy: {
      readonly title: string
      readonly message: string
      readonly confirmLabel: string
      readonly variant?: 'danger'
    },
  ): Promise<void> => {
    const agreed = await confirm({
      title: copy.title,
      message: copy.message,
      confirmLabel: copy.confirmLabel,
      variant: copy.variant ?? 'default',
    })
    if (!agreed) return
    mark(program.id, { kind: 'busy' })
    try {
      await callCcuAction(trpc, action, { integrationId, ...body, confirmed: true }, OkResultSchema)
      mark(program.id, { kind: 'saved' })
      result.reload()
    } catch (err: unknown) {
      mark(program.id, { kind: 'error', message: errorText(err) })
    }
  }

  const save = async (program: CcuProgram | null, draft: ProgramDraft): Promise<void> => {
    const name =
      program?.name ??
      result.data?.keys.find((key) => key.deviceAddress === draft.deviceAddress)?.deviceName ??
      draft.deviceAddress
    const agreed = await confirm({
      title: t(program === null ? 'programs.createTitle' : 'programs.updateTitle'),
      message: t(program === null ? 'programs.createMessage' : 'programs.updateMessage', { name }),
      confirmLabel: t(program === null ? 'programs.createConfirm' : 'programs.updateConfirm'),
    })
    if (!agreed) return
    setFormBusy(true)
    setFormError(null)
    try {
      await callCcuAction(
        trpc,
        'ensureCcuKeyEventProgram',
        { integrationId, ...draft, confirmed: true },
        OkResultSchema,
      )
      setDialog({ kind: 'closed' })
      result.reload()
    } catch (err: unknown) {
      setFormError(errorText(err))
    } finally {
      setFormBusy(false)
    }
  }

  const menu = (program: CcuProgram): KebabMenuItem[] => {
    const busy = writes[program.id]?.kind === 'busy'
    const name = program.name
    return [
      {
        id: 'run',
        label: t('programs.run'),
        icon: Play,
        disabled: busy,
        onClick: () =>
          void runWrite(
            program,
            'runCcuProgram',
            { programId: program.id },
            {
              title: t('programs.runTitle'),
              message: t('programs.runMessage', { name }),
              confirmLabel: t('programs.runConfirm'),
            },
          ),
      },
      {
        id: 'active',
        label: t(program.active ? 'programs.disable' : 'programs.enable'),
        icon: Power,
        disabled: busy,
        onClick: () =>
          void runWrite(
            program,
            'setCcuProgramActive',
            { programId: program.id, active: !program.active },
            program.active
              ? {
                  title: t('programs.disableTitle'),
                  message: t('programs.disableMessage', { name }),
                  confirmLabel: t('programs.disableConfirm'),
                }
              : {
                  title: t('programs.enableTitle'),
                  message: t('programs.enableMessage', { name }),
                  confirmLabel: t('programs.enableConfirm'),
                },
          ),
      },
      {
        id: 'edit',
        label: t('programs.edit'),
        icon: Pencil,
        hidden: !program.createdByCamstack,
        disabled: busy,
        onClick: () => {
          setFormError(null)
          setDialog({ kind: 'form', program })
        },
      },
      {
        id: 'delete',
        label: t('programs.delete'),
        icon: Trash2,
        danger: true,
        hidden: program.internal,
        disabled: busy,
        onClick: () =>
          void runWrite(
            program,
            'deleteCcuProgram',
            { programId: program.id },
            {
              title: t('programs.deleteTitle'),
              message: t('programs.deleteMessage', { name }),
              confirmLabel: t('programs.deleteConfirm'),
              variant: 'danger',
            },
          ),
      },
    ]
  }

  const columns: readonly DataColumn<CcuProgram>[] = [
    {
      key: 'name',
      header: t('programs.colName'),
      nowrap: false,
      render: (row) => (
        <div className="flex min-w-0 flex-col" aria-busy={writes[row.id]?.kind === 'busy'}>
          <span className="text-sm text-foreground">{row.name}</span>
          <RowWriteLabel write={writes[row.id]} />
        </div>
      ),
      sortValue: (row) => row.name,
    },
    {
      key: 'active',
      header: t('programs.colActive'),
      render: (row) => (
        <Badge variant={row.active ? 'success' : 'warning'}>
          {t(row.active ? 'programs.active' : 'programs.inactive')}
        </Badge>
      ),
      sortValue: (row) => (row.active ? 1 : 0),
    },
    {
      key: 'lastRun',
      header: t('programs.colLastRun'),
      render: (row) => relativeRun(row.lastRunMs, now, timeText) ?? '—',
      sortValue: (row) => row.lastRunMs,
    },
    {
      key: 'conditions',
      header: t('programs.colConditions'),
      nowrap: false,
      render: (row) =>
        row.channels.length === 0 ? (
          <span className="text-foreground-subtle">—</span>
        ) : (
          <span className="text-sm text-foreground">
            {row.channels.map(channelLabel).join(', ')}
          </span>
        ),
      sortValue: (row) => row.channels.map(channelLabel).join(', '),
    },
    {
      key: 'origin',
      header: t('programs.colOrigin'),
      render: (row) =>
        row.createdByCamstack ? <Badge>{t('programs.camstack')}</Badge> : t('programs.other'),
      sortValue: (row) => (row.createdByCamstack ? 0 : 1),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Action column',
      render: (row) => <KebabMenu items={menu(row)} />,
    },
  ]

  if (result.error !== null) {
    return (
      <ErrorBox title={t('programs.loadFailed')} message={result.error} onRetry={result.reload} />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <TableBlock
        headingId="hm-programs"
        title={t('programs.title')}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={result.data === undefined}
            onClick={() => {
              setFormError(null)
              setDialog({ kind: 'form', program: null })
            }}
          >
            <ListTree className="h-4 w-4" />
            {t('programs.newProgram')}
          </Button>
        }
      >
        <p className="text-xs text-foreground-muted">{t('programs.hint')}</p>
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: t('programs.searchPlaceholder'),
            searchLabel: t('programs.searchLabel'),
            facetsLabel: t('programs.facetsLabel'),
            clearLabel: t('programs.clearFilters'),
          }}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
        <DataTable
          columns={columns}
          rows={filter.rows}
          rowKey={(row) => row.id}
          minWidthPx={720}
          defaultSort={{ columnKey: 'name', dir: 'asc' }}
          emptyMessage={
            result.loading
              ? t('common.loading')
              : filter.active
                ? t('programs.noMatch')
                : t('programs.none')
          }
        />
      </TableBlock>
      {dialog.kind === 'form' && result.data !== undefined && (
        <ProgramFormDialog
          program={dialog.program}
          keys={result.data.keys}
          busy={formBusy}
          error={formError}
          onClose={() => setDialog({ kind: 'closed' })}
          onSave={(draft) => void save(dialog.program, draft)}
        />
      )}
    </div>
  )
}

function RowWriteLabel(props: { readonly write: RowWrite | undefined }): ReactNode {
  const { write } = props
  const { t } = useT()
  if (write === undefined) return null
  if (write.kind === 'busy') {
    return <span className="text-xs text-foreground-subtle">{t('programs.saving')}</span>
  }
  if (write.kind === 'saved') {
    return <span className="text-xs text-success">{t('programs.saved')}</span>
  }
  return <span className="text-xs text-danger">{write.message}</span>
}
