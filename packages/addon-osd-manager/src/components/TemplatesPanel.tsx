/**
 * Named device templates — DataTable + ItemFormDialog (NC Rules pattern).
 * A template is one device-template text (`{{ alias.field | unit('°C') }}`); `camera`
 * names the camera it is rendered for, so one template serves every camera.
 */
import { useMemo, useRef, useState, useEffect } from 'react'
import {
  Button,
  DataTable,
  ErrorBox,
  Input,
  ItemFormDialog,
  Label,
  DeviceTemplateField,
  Select,
  type DeviceTemplateFieldHandle,
  useDebouncedString,
  useConfirm,
  useItemFormUrl,
  useOsdManagerDeleteTemplate,
  useOsdManagerListTemplates,
  useOsdManagerPreviewTemplate,
  useOsdManagerUpsertTemplate,
  type DataColumn,
} from '@camstack/ui-library'
import type { OsdNamedTemplate } from '@camstack/types'
import { Copy, Layers, Trash2 } from 'lucide-react'
import { generateTemplateId } from '../template-id.js'
import { translate, useT } from '../i18n/index.js'

/** Pause in typing before the hub is asked for a preview. */
const PREVIEW_DEBOUNCE_MS = 500

export interface CameraChoice {
  readonly id: number
  readonly name: string
}

function newDraft(): OsdNamedTemplate {
  return {
    id: generateTemplateId(),
    name: translate('templates.newName'),
    text: '',
  }
}

export interface TemplatesPanelProps {
  /** Cameras the preview can be rendered for. */
  readonly cameras: readonly CameraChoice[]
  /** Page-header "New template" — open the create dialog once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

export function TemplatesPanel({
  cameras,
  createRequested = false,
  onCreateConsumed,
}: TemplatesPanelProps) {
  const { t } = useT()
  const listQuery = useOsdManagerListTemplates({})
  const upsert = useOsdManagerUpsertTemplate()
  const remove = useOsdManagerDeleteTemplate()
  const formUrl = useItemFormUrl()
  const confirm = useConfirm()

  const [draft, setDraft] = useState<OsdNamedTemplate | null>(null)

  const templates = listQuery.data?.templates ?? []

  useEffect(() => {
    if (!createRequested) return
    setDraft(newDraft())
    formUrl.openNew()
    onCreateConsumed?.()
    // Intentionally only react to the page-header request pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested])

  useEffect(() => {
    const state = formUrl.state
    if (state.mode === 'closed') {
      setDraft(null)
      return
    }
    if (state.mode === 'new') {
      setDraft((prev) =>
        prev !== null && !templates.some((tpl) => tpl.id === prev.id) ? prev : newDraft(),
      )
      return
    }
    const found = templates.find((tpl) => tpl.id === state.id)
    if (found !== undefined) setDraft(found)
  }, [formUrl.state, templates])

  const error = listQuery.error ?? upsert.error ?? remove.error

  const columns: DataColumn<OsdNamedTemplate>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('templates.colName'),
        render: (row) => <span className="font-medium text-foreground">{row.name}</span>,
        sortValue: (row) => row.name,
      },
      {
        key: 'text',
        header: t('templates.colText'),
        render: (row) => (
          <span className="block max-w-[24rem] truncate font-mono text-[11px] text-foreground-muted">
            {row.text || t('common.empty')}
          </span>
        ),
        sortValue: (row) => row.text,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: t('templates.rowActions'),
        render: (row) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                formUrl.openEdit(row.id)
              }}
            >
              {t('common.edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('templates.duplicateAria', { name: row.name })}
              title={t('templates.duplicate')}
              onClick={(e) => {
                e.stopPropagation()
                setDraft({
                  ...row,
                  id: generateTemplateId(),
                  name: t('templates.copyName', { name: row.name }),
                })
                formUrl.openNew()
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('templates.deleteAria', { name: row.name })}
              title={t('common.delete')}
              disabled={remove.isPending}
              onClick={(e) => {
                e.stopPropagation()
                void (async () => {
                  const ok = await confirm({
                    title: t('templates.deleteTitle'),
                    message: t('templates.deleteMessage', { name: row.name }),
                    confirmLabel: t('common.delete'),
                    cancelLabel: t('common.cancel'),
                    variant: 'danger',
                  })
                  if (!ok) return
                  await remove.mutateAsync({ templateId: row.id })
                  await listQuery.refetch()
                  if (formUrl.state.mode === 'edit' && formUrl.state.id === row.id) formUrl.close()
                })()
              }}
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </div>
        ),
      },
    ],
    [confirm, formUrl, listQuery, remove, t],
  )

  const dialogOpen = formUrl.state.mode !== 'closed' && draft !== null
  const isNew = formUrl.state.mode === 'new'
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="osd-templates-panel">
      {error && <ErrorBox message={error.message} title={t('templates.title')} />}

      <DataTable
        columns={columns}
        rows={templates}
        rowKey={(r) => r.id}
        pageSize={25}
        fill
        emptyMessage={listQuery.isLoading ? t('templates.loading') : t('templates.none')}
        onRowClick={(row) => formUrl.openEdit(row.id)}
      />

      {dialogOpen && draft !== null ? (
        <ItemFormDialog
          open
          onClose={() => {
            formUrl.close()
            setDraft(null)
          }}
          title={isNew ? t('templates.newName') : t('templates.editTitle', { name: draft.name })}
          icon={Layers}
          width="xl"
          testId="osd-template-editor"
          footer={
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={
                  upsert.isPending ||
                  draft.name.trim().length === 0 ||
                  draft.text.trim().length === 0
                }
                onClick={() =>
                  void (async () => {
                    await upsert.mutateAsync({ template: draft })
                    await listQuery.refetch()
                    formUrl.close()
                    setDraft(null)
                  })()
                }
              >
                {t('templates.save')}
              </Button>
            </div>
          }
        >
          <TemplateEditorForm draft={draft} cameras={cameras} onChange={setDraft} />
        </ItemFormDialog>
      ) : null}
    </div>
  )
}

interface TemplateEditorFormProps {
  readonly draft: OsdNamedTemplate
  readonly cameras: readonly CameraChoice[]
  readonly onChange: (next: OsdNamedTemplate) => void
}

/** The template variables the manager supplies besides device values. */
const INSERT_SNIPPETS = [
  { id: 'clock', labelKey: 'templates.insertClock', text: "{{ now | time('HH:mm') }}", offset: 7 },
  { id: 'person', labelKey: 'templates.insertPerson', text: '{{ camera.lastPerson }}' },
  { id: 'plate', labelKey: 'templates.insertPlate', text: '{{ camera.lastPlate }}' },
] as const

function TemplateEditorForm({ draft, cameras, onChange }: TemplateEditorFormProps) {
  const { t } = useT()
  const handle = useRef<DeviceTemplateFieldHandle | null>(null)
  const [previewCameraId, setPreviewCameraId] = useState<number | null>(null)
  const cameraId = previewCameraId ?? cameras[0]?.id ?? null
  const settledText = useDebouncedString(draft.text, PREVIEW_DEBOUNCE_MS)
  const previewMutation = useOsdManagerPreviewTemplate()
  const { mutate: runPreview } = previewMutation
  useEffect(() => {
    if (cameraId === null || settledText.trim() === '') return
    runPreview({ deviceId: cameraId, text: settledText })
  }, [cameraId, settledText, runPreview])
  const preview = previewMutation.data
  const cameraOptions = useMemo(
    () => cameras.map((c) => ({ value: String(c.id), label: c.name })),
    [cameras],
  )

  return (
    <div className="space-y-3 pt-0" data-testid="osd-tpl-section-template">
      <div>
        <Label htmlFor="osd-tpl-name">{t('common.name')}</Label>
        <Input
          id="osd-tpl-name"
          data-testid="osd-tpl-name"
          value={draft.name}
          maxLength={64}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-3" data-testid="osd-tpl-section-text">
        <p className="text-[11px] text-foreground-subtle">{t('templates.textHint')}</p>
        <DeviceTemplateField
          handle={handle}
          label={t('templates.textLabel')}
          value={draft.text}
          onChange={(text) => onChange({ ...draft, text })}
          accepts="any"
          multiline
          placeholder={t('templates.textPlaceholder')}
          testId="osd-tpl-text"
          thisDevice={cameraId === null ? undefined : { deviceId: cameraId }}
        />
        <div className="flex flex-wrap gap-1.5" data-testid="osd-tpl-snippets">
          {INSERT_SNIPPETS.map((snippet) => (
            <Button
              key={snippet.id}
              type="button"
              size="sm"
              variant="outline"
              data-testid={`osd-tpl-insert-${snippet.id}`}
              onClick={() =>
                handle.current?.insertText(
                  snippet.text,
                  'offset' in snippet ? snippet.offset : undefined,
                )
              }
            >
              {t(snippet.labelKey)}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-foreground-subtle">{t('templates.cameraHint')}</p>
      </div>

      <div
        className="space-y-2 rounded border border-border bg-surface-hover/40 px-3 py-2"
        data-testid="osd-tpl-preview"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wide text-foreground-muted">
            {t('templates.livePreview')}
          </p>
          {cameraOptions.length > 0 && cameraId !== null ? (
            <Select
              aria-label={t('templates.previewCamera')}
              value={String(cameraId)}
              options={cameraOptions}
              onChange={(e) => setPreviewCameraId(Number(e.target.value))}
            />
          ) : null}
        </div>
        {preview === undefined ? (
          <p className="text-xs text-foreground-muted">{t('templates.previewIdle')}</p>
        ) : preview.ok ? (
          <p className="font-mono text-sm text-foreground" data-testid="osd-tpl-preview-text">
            {preview.text === '' ? t('common.empty') : preview.text}
          </p>
        ) : (
          <p className="text-xs text-danger" role="alert" data-testid="osd-tpl-preview-refused">
            {preview.notes.join(' ')}
          </p>
        )}
        {preview?.ok === true && preview.notes.length > 0 ? (
          <p className="text-[11px] text-foreground-muted">{preview.notes.join(' ')}</p>
        ) : null}
      </div>
    </div>
  )
}
