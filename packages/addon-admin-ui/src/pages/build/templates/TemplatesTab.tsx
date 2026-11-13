/**
 * Build → Templates (D964, #527): the reusable, named pieces of operator data
 * more than one device or automation points at — the button layout of a remote
 * and the automation templates. The tab is generic over the template store
 * (`template.*`): a kind contributes its summary and its editor
 * (`components/remote/template-kinds.tsx`); an automation template is edited
 * inline (it needs the room of the automation editor), a layout in its dialog.
 * A template something still uses is not deleted; the tab names what uses it.
 */
import {
  AutomationTemplatePayloadSchema,
  type TemplateDeleteResult,
  type TemplateRecord,
} from '@camstack/types'
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, LayoutTemplate, Pencil, Plus, Trash2, Workflow } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { TEMPLATE_EDIT_PARAM } from '../../../components/remote/EditTemplateButton'
import {
  TemplateEditorDialog,
  type TemplateDraft,
} from '../../../components/remote/TemplateEditorDialog'
import { templateKindView } from '../../../components/remote/template-kinds'
import { useTemplateSave } from '../../../components/remote/useTemplateSave'
import { FROM_TEMPLATE_PARAM } from './template-params'
import { AutomationTemplateEditor, type AutomationTemplateTarget } from './AutomationTemplateEditor'

export interface TemplatesTabProps {
  /** Header "New template" on Build: open the choice once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function targetOf(row: TemplateRecord): AutomationTemplateTarget | null {
  const parsed = AutomationTemplatePayloadSchema.safeParse(row.payload)
  return parsed.success
    ? { id: row.id, name: row.name, payload: parsed.data, builtIn: row.builtIn === true }
    : null
}

/** What blocks a delete, one sentence per kind of user; empty when nothing does. */
export function inUseSentences(
  result: Extract<TemplateDeleteResult, { status: 'in-use' }>,
  t: (key: string, options: Record<string, string>) => string,
): readonly string[] {
  return [
    ...(result.devices.length === 0
      ? []
      : [
          t('remote.templates.inUseMessage', {
            devices: result.devices.map((d) => d.name).join(', '),
          }),
        ]),
    ...(result.automations.length === 0
      ? []
      : [
          t('build.templates.inUseAutomations', {
            automations: result.automations.map((a) => a.name).join(', '),
          }),
        ]),
  ]
}

export function TemplatesTab({
  createRequested = false,
  onCreateConsumed,
}: TemplatesTabProps): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const list = useTemplateList({})
  const create = useTemplateCreate()
  const saver = useTemplateSave()
  const remove = useTemplateDelete()
  const confirm = useConfirm()
  const alert = useAlert()
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [automation, setAutomation] = useState<AutomationTemplateTarget | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [params, setParams] = useSearchParams()
  const editId = params.get(TEMPLATE_EDIT_PARAM)

  const open = (row: TemplateRecord): void => {
    saver.clearError()
    if (row.kind === 'automation') {
      setDraft(null)
      setAutomation(targetOf(row))
      return
    }
    setAutomation(null)
    setDraft({ id: row.id, kind: row.kind, name: row.name, payload: row.payload })
  }

  useEffect(() => {
    if (!createRequested) return
    setChoosing(true)
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed])

  // `?edit=<id>` opens the editor on that template once the list answered; the
  // param is replaced away so closing the editor does not reopen it. Only `edit`
  // goes: the tab (`?tab=templates`) stays.
  useEffect(() => {
    if (editId === null || list.data === undefined) return
    const row = list.data.find((r) => r.id === editId)
    if (row !== undefined) open(row)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete(TEMPLATE_EDIT_PARAM)
        return next
      },
      { replace: true },
    )
    // `open` closes over mutation objects that change identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, list.data, setParams])

  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: [['template']] })

  const save = async (next: TemplateDraft): Promise<void> => {
    if (await saver.save(next)) {
      setDraft(null)
      setAutomation(null)
    }
  }

  /** The id of the copy, or null when it was not made. */
  const duplicate = async (row: TemplateRecord): Promise<string | null> => {
    try {
      const result = await create.mutateAsync({
        kind: row.kind,
        name: t('remote.templates.copyName', { name: row.name }),
        payload: row.payload,
      })
      refresh()
      return result.status === 'saved' ? result.template.id : null
    } catch (err: unknown) {
      await alert({
        title: t('remote.templates.duplicateFailed'),
        message: err instanceof Error ? err.message : String(err),
        variant: 'danger',
      })
      return null
    }
  }

  /** A built-in opened in the editor: its copy is made and the list shows it. */
  const duplicateBuiltIn = async (from: TemplateDraft): Promise<void> => {
    const row = list.data?.find((r) => r.id === from.id)
    if (row === undefined) return
    if ((await duplicate(row)) !== null) setAutomation(null)
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
          message: inUseSentences(result, t).join(' '),
          variant: 'warning',
        })
        return
      }
      if (result.status === 'read-only') {
        await alert({
          title: t('build.templates.readOnlyTitle', { name: row.name }),
          message: t('build.templates.readOnlyMessage'),
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
        render: (r) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{r.name}</span>
            {r.builtIn === true && (
              <Badge variant="neutral">{t('build.templates.builtIn', 'Built-in')}</Badge>
            )}
          </span>
        ),
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
            {r.builtIn === true ? '' : new Date(r.updatedAt).toLocaleDateString()}
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
              ...(r.kind === 'automation'
                ? [
                    {
                      id: 'create-automation',
                      label: t('build.templates.createAutomation', 'Create automation'),
                      icon: Workflow,
                      onClick: () =>
                        void navigate(
                          `/build?tab=automations&${FROM_TEMPLATE_PARAM}=${encodeURIComponent(r.id)}`,
                        ),
                    },
                  ]
                : []),
              {
                id: 'edit',
                label: r.builtIn === true ? t('build.templates.view', 'View') : t('common.edit'),
                icon: Pencil,
                onClick: () => open(r),
              },
              {
                id: 'duplicate',
                label: t('remote.templates.duplicate'),
                icon: Copy,
                onClick: () => void duplicate(r),
              },
              ...(r.builtIn === true
                ? []
                : [
                    {
                      id: 'delete',
                      label: t('common.delete'),
                      icon: Trash2,
                      danger: true,
                      onClick: () => void askDelete(r),
                    },
                  ]),
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

  if (automation !== null) {
    return (
      <AutomationTemplateEditor
        key={automation.id ?? 'new'}
        template={automation}
        saving={saver.saving}
        error={saver.error}
        onSave={(next) => void save(next)}
        onDuplicate={(next) => void duplicateBuiltIn(next)}
        onClose={() => setAutomation(null)}
      />
    )
  }

  const newRemote = (): void => {
    saver.clearError()
    setChoosing(false)
    setDraft({
      id: null,
      kind: 'remote',
      name: '',
      payload: templateKindView('remote').emptyPayload(),
    })
  }
  const newAutomation = (): void => {
    saver.clearError()
    setChoosing(false)
    setAutomation({
      id: null,
      name: '',
      payload: AutomationTemplatePayloadSchema.parse(templateKindView('automation').emptyPayload()),
      builtIn: false,
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">{t('remote.templates.subtitle')}</p>
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
            <Button size="sm" onClick={() => setChoosing(true)}>
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
          onRowClick={open}
        />
      )}
      <TemplateEditorDialog
        draft={draft}
        saving={saver.saving}
        error={saver.error}
        onSave={(next) => void save(next)}
        onClose={() => setDraft(null)}
      />
      <Dialog open={choosing} onOpenChange={(next) => !next && setChoosing(false)}>
        <DialogContent width="md" placement="sheet-on-mobile">
          <DialogHeader>
            <DialogTitle>{t('remote.templates.new')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-2" data-testid="new-template-chooser">
            <Button
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal py-2 text-left"
              onClick={newRemote}
              data-testid="new-template-remote"
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden />
              <span className="block">
                <span className="block font-medium">{templateKindView('remote').label(t)}</span>
                <span className="block text-xs text-foreground-muted">
                  {t('build.templates.newRemoteHint', 'The button layout of a remote.')}
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal py-2 text-left"
              onClick={newAutomation}
              data-testid="new-template-automation"
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden />
              <span className="block">
                <span className="block font-medium">{templateKindView('automation').label(t)}</span>
                <span className="block text-xs text-foreground-muted">
                  {t(
                    'build.templates.newAutomationHint',
                    'An automation with inputs, so each copy only asks for its devices.',
                  )}
                </span>
              </span>
            </Button>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
