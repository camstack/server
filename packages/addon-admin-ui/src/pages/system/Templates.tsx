/**
 * System → Templates (D964): the reusable, named pieces of operator data more
 * than one device points at — today the button layout of a remote. The page is
 * generic over the template store (`template.*`): a kind only contributes its
 * summary and its editor (`components/remote/template-kinds.tsx`). A template a
 * device still uses is not deleted; the page names the devices instead.
 */
import { type TemplateKind, type TemplateRecord, TEMPLATE_KINDS } from '@camstack/types'
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  ErrorBox,
  KebabMenu,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  useAlert,
  useConfirm,
  useTemplateCreate,
  useTemplateDelete,
  useTemplateList,
  useTemplateUpdate,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import {
  TemplateEditorDialog,
  type TemplateDraft,
} from '../../components/remote/TemplateEditorDialog'
import { templateKindView } from '../../components/remote/template-kinds'

const FIRST_KIND: TemplateKind = TEMPLATE_KINDS[0]

export function TemplatesPage(): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const list = useTemplateList({})
  const create = useTemplateCreate()
  const update = useTemplateUpdate()
  const remove = useTemplateDelete()
  const confirm = useConfirm()
  const alert = useAlert()
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: [['template']] })

  const save = async (next: TemplateDraft): Promise<void> => {
    setError(null)
    try {
      const result =
        next.id === null
          ? await create.mutateAsync({ kind: next.kind, name: next.name, payload: next.payload })
          : await update.mutateAsync({ id: next.id, name: next.name, payload: next.payload })
      if (result.status === 'refused') {
        setError(result.detail)
        return
      }
      refresh()
      setDraft(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const duplicate = async (row: TemplateRecord): Promise<void> => {
    try {
      await create.mutateAsync({
        kind: row.kind,
        name: t('remote.templates.copyName', { name: row.name }),
        payload: row.payload,
      })
      refresh()
    } catch (err: unknown) {
      await alert({
        title: t('remote.templates.duplicateFailed'),
        message: err instanceof Error ? err.message : String(err),
        variant: 'danger',
      })
    }
  }

  const askDelete = async (row: TemplateRecord): Promise<void> => {
    const ok = await confirm({
      title: t('remote.templates.deleteTitle', { name: row.name }),
      message: t('remote.templates.deleteMessage'),
      confirmLabel: t('common.delete'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      const result = await remove.mutateAsync({ id: row.id })
      if (result.status === 'in-use') {
        await alert({
          title: t('remote.templates.inUseTitle', { name: row.name }),
          message: t('remote.templates.inUseMessage', {
            devices: result.devices.map((d) => d.name).join(', '),
          }),
          variant: 'warning',
        })
        return
      }
      refresh()
    } catch (err: unknown) {
      await alert({
        title: t('remote.templates.deleteFailed'),
        message: err instanceof Error ? err.message : String(err),
        variant: 'danger',
      })
    }
  }

  const columns = useMemo(
    (): readonly DataColumn<TemplateRecord>[] => [
      {
        key: 'name',
        header: t('remote.templates.name'),
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => <span className="font-medium text-foreground">{r.name}</span>,
      },
      {
        key: 'kind',
        header: t('remote.templates.kind.label'),
        sortValue: (r) => r.kind,
        render: (r) => <Badge variant="neutral">{templateKindView(r.kind).label(t)}</Badge>,
      },
      {
        key: 'summary',
        header: t('remote.templates.summary'),
        notSortableReason: 'A sentence built from the payload.',
        render: (r) => (
          <span className="text-foreground-muted">
            {templateKindView(r.kind).summary(r.payload, t)}
          </span>
        ),
      },
      {
        key: 'updated',
        header: t('remote.templates.updated'),
        sortValue: (r) => r.updatedAt,
        render: (r) => (
          <span className="text-foreground-muted">
            {new Date(r.updatedAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        key: 'actions',
        align: 'right',
        notSortableReason: 'Row actions.',
        render: (r) => (
          <KebabMenu
            title={t('remote.templates.actionsFor', { name: r.name })}
            items={[
              {
                id: 'edit',
                label: t('common.edit'),
                icon: Pencil,
                onClick: () => {
                  setError(null)
                  setDraft({ id: r.id, kind: r.kind, name: r.name, payload: r.payload })
                },
              },
              {
                id: 'duplicate',
                label: t('remote.templates.duplicate'),
                icon: Copy,
                onClick: () => void duplicate(r),
              },
              {
                id: 'delete',
                label: t('common.delete'),
                icon: Trash2,
                danger: true,
                onClick: () => void askDelete(r),
              },
            ]}
          />
        ),
      },
    ],
    // The handlers close over mutation objects that change identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  )

  const rows = list.data ?? []
  const newTemplate = (): void => {
    setError(null)
    setDraft({
      id: null,
      kind: FIRST_KIND,
      name: '',
      payload: templateKindView(FIRST_KIND).emptyPayload(),
    })
  }

  return (
    <AdminPage
      icon={LayoutTemplate}
      title={t('remote.templates.title')}
      subtitle={t('remote.templates.subtitle')}
      actions={
        <Button size="sm" onClick={newTemplate} data-testid="template-new">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('remote.templates.new')}
        </Button>
      }
    >
      {list.status === 'error' ? (
        <ErrorBox
          title={t('remote.templates.loadFailed')}
          message={list.error.message}
          onRetry={() => void list.refetch()}
        />
      ) : list.data === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title={t('remote.templates.emptyTitle')}
          description={t('remote.templates.emptyDescription')}
          action={
            <Button size="sm" onClick={newTemplate}>
              {t('remote.templates.new')}
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          defaultSort={{ columnKey: 'name', dir: 'asc' }}
          onRowClick={(r) => {
            setError(null)
            setDraft({ id: r.id, kind: r.kind, name: r.name, payload: r.payload })
          }}
        />
      )}
      <TemplateEditorDialog
        draft={draft}
        saving={create.isPending || update.isPending}
        error={error}
        onSave={(next) => void save(next)}
        onClose={() => setDraft(null)}
      />
    </AdminPage>
  )
}
