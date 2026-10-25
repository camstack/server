/**
 * Named multi-device templates — DataTable + ItemFormDialog (NC Rules pattern).
 * Each binding owns its own device pick (container → child → field).
 */
import { useMemo, useState, useEffect } from 'react'
import {
  Button,
  DataTable,
  ErrorBox,
  Input,
  ItemFormDialog,
  Label,
  PlaceholderChipField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useConfirm,
  useDeviceManagerListAll,
  useDeviceStateGetAllSnapshots,
  useItemFormUrl,
  useOsdManagerDeleteTemplate,
  useOsdManagerGetSourceCatalog,
  useOsdManagerListTemplates,
  useOsdManagerUpsertTemplate,
  useUrlQueryParam,
  type DataColumn,
} from '@camstack/ui-library'
import { parseTemplateContentPanel, type TemplateContentPanel } from '../ui/osd-page-model.js'
import type { OsdNamedTemplate, OsdSourceOption, OsdTemplateBinding } from '@camstack/types'
import { Copy, Layers, Trash2 } from 'lucide-react'
import { renderNamedTemplate, resolveBindingLive } from '../named-template-render.js'
import {
  deviceById,
  isContainerDeviceType,
  toOsdPickerDevices,
  type OsdPickerDevice,
} from '../osd-picker-devices.js'
import { generateTemplateId } from '../template-id.js'
import { aliasToken, bindingInsertChips, suggestAlias } from '../template-tokens.js'
import { translate, useT } from '../i18n/index.js'
import { DeviceStatePickBlock, type DeviceStatePickValue } from './DeviceStatePickBlock.js'

/** Sentinel deviceId for a binding row that has not picked a leaf yet. */
const UNPICKED_DEVICE_ID = 0

function takenAliases(bindings: readonly OsdTemplateBinding[], exceptIndex?: number): Set<string> {
  const taken = new Set<string>()
  for (let i = 0; i < bindings.length; i += 1) {
    if (i === exceptIndex) continue
    taken.add(bindings[i]!.alias)
  }
  return taken
}

function emptyBinding(): OsdTemplateBinding {
  return {
    alias: '',
    pick: { deviceId: UNPICKED_DEVICE_ID },
    capName: '',
    valuePath: '',
    maxDecimals: 1,
  }
}

function bindingIsComplete(binding: OsdTemplateBinding): boolean {
  return (
    binding.pick.deviceId > 0 &&
    binding.capName !== '' &&
    binding.valuePath !== '' &&
    binding.alias !== ''
  )
}

function newDraft(): OsdNamedTemplate {
  return {
    id: generateTemplateId(),
    name: translate('templates.newName'),
    bindings: [],
    parser: '',
  }
}

export interface TemplatesPanelProps {
  /** Page-header "New template" — open the create dialog once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

export function TemplatesPanel({ createRequested = false, onCreateConsumed }: TemplatesPanelProps) {
  const { t } = useT()
  const listQuery = useOsdManagerListTemplates({})
  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' })
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

  const pickerDevices: OsdPickerDevice[] = useMemo(
    () => toOsdPickerDevices(devicesQuery.data ?? []),
    [devicesQuery.data],
  )
  const listState = devicesQuery.isError
    ? 'failed'
    : devicesQuery.isSuccess
      ? 'answered'
      : 'pending'

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
        key: 'bindings',
        header: t('templates.colBindings'),
        render: (row) => String(row.bindings.length),
        sortValue: (row) => row.bindings.length,
      },
      {
        key: 'parser',
        header: t('templates.colParser'),
        render: (row) => (
          <span className="block max-w-[14rem] truncate font-mono text-[11px] text-foreground-muted">
            {row.parser || t('common.empty')}
          </span>
        ),
        sortValue: (row) => row.parser,
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
  const [panelParam, setPanelParam] = useUrlQueryParam('panel')
  const editorTab = parseTemplateContentPanel(panelParam)
  const setEditorTab = (next: TemplateContentPanel): void => {
    setPanelParam(next === 'template' ? null : next)
  }

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
        <Tabs
          appearance="pills"
          value={editorTab}
          onValueChange={(next) => {
            if (next === 'template' || next === 'bindings') setEditorTab(next)
          }}
        >
          <ItemFormDialog
            open
            onClose={() => {
              formUrl.close()
              setPanelParam(null)
              setDraft(null)
            }}
            title={isNew ? t('templates.newName') : t('templates.editTitle', { name: draft.name })}
            icon={Layers}
            width="xl"
            testId="osd-template-editor"
            beforeBody={
              <TabsList data-testid="osd-tpl-editor-tabs">
                <TabsTrigger value="template">{t('templates.tabTemplate')}</TabsTrigger>
                <TabsTrigger value="bindings">{t('templates.tabBindings')}</TabsTrigger>
              </TabsList>
            }
            footer={
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    upsert.isPending ||
                    draft.name.trim().length === 0 ||
                    !draft.bindings.every(bindingIsComplete)
                  }
                  onClick={() =>
                    void (async () => {
                      await upsert.mutateAsync({ template: draft })
                      await listQuery.refetch()
                      formUrl.close()
                      setPanelParam(null)
                      setDraft(null)
                    })()
                  }
                >
                  {t('templates.save')}
                </Button>
              </div>
            }
          >
            <TemplateEditorForm
              draft={draft}
              pickerDevices={pickerDevices}
              listState={listState}
              onChange={setDraft}
            />
          </ItemFormDialog>
        </Tabs>
      ) : null}
    </div>
  )
}

interface TemplateEditorFormProps {
  readonly draft: OsdNamedTemplate
  readonly pickerDevices: readonly OsdPickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly onChange: (next: OsdNamedTemplate) => void
}

function TemplateEditorForm({
  draft,
  pickerDevices,
  listState,
  onChange,
}: TemplateEditorFormProps) {
  const { t } = useT()
  const catalogCameraId = pickerDevices.find((d) => !isContainerDeviceType(d.type))?.id ?? 0
  const catalogQuery = useOsdManagerGetSourceCatalog(
    { deviceId: catalogCameraId },
    { enabled: catalogCameraId > 0 },
  )
  const sources = catalogQuery.data?.sources ?? []

  const chips = useMemo(
    () => draft.bindings.filter(bindingIsComplete).flatMap((b) => bindingInsertChips(b)),
    [draft.bindings],
  )

  const stateByDevice = useBindingSnapshots(draft.bindings)
  const preview = useMemo(
    () =>
      renderNamedTemplate(
        {
          ...draft,
          bindings: draft.bindings.filter(bindingIsComplete),
        },
        { stateByDevice },
      ),
    [draft, stateByDevice],
  )

  return (
    <>
      <TabsContent
        value="template"
        className="space-y-3 pt-0"
        data-testid="osd-tpl-section-template"
      >
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

        <div
          className="space-y-3 border-t border-border pt-3"
          data-testid="osd-tpl-section-preview"
        >
          <p className="text-[11px] text-foreground-subtle">{t('templates.parserHint')}</p>
          <PlaceholderChipField
            label={t('templates.parserLabel')}
            value={draft.parser}
            onChange={(parser) => onChange({ ...draft, parser })}
            chips={chips}
            multiline
            placeholder={t('templates.parserPlaceholder')}
            testId="osd-tpl-parser"
            maxLength={256}
          />
          <div
            className="rounded border border-border bg-surface-hover/40 px-3 py-2"
            data-testid="osd-tpl-preview"
          >
            <p className="text-[10px] uppercase tracking-wide text-foreground-muted">
              {t('templates.livePreview')}
            </p>
            {'text' in preview ? (
              <p className="mt-0.5 font-mono text-sm text-foreground">
                {preview.text === '' ? t('common.empty') : preview.text}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-foreground-muted">{preview.reason}</p>
            )}
          </div>
        </div>
      </TabsContent>

      <TabsContent
        value="bindings"
        className="space-y-3 pt-0"
        data-testid="osd-tpl-section-bindings"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-[11px] text-foreground-subtle">{t('templates.bindingsHint')}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="osd-tpl-add-binding"
            onClick={() => {
              onChange({
                ...draft,
                bindings: [...draft.bindings, emptyBinding()],
              })
            }}
          >
            {t('templates.addBinding')}
          </Button>
        </div>

        {draft.bindings.length === 0 && (
          <p className="text-xs text-foreground-muted">{t('templates.noBindings')}</p>
        )}

        {draft.bindings.map((binding, index) => (
          <BindingCard
            key={`binding-${index}`}
            binding={binding}
            index={index}
            draft={draft}
            pickerDevices={pickerDevices}
            listState={listState}
            sources={sources}
            stateByDevice={stateByDevice}
            onChange={onChange}
          />
        ))}
      </TabsContent>
    </>
  )
}

interface BindingCardProps {
  readonly binding: OsdTemplateBinding
  readonly index: number
  readonly draft: OsdNamedTemplate
  readonly pickerDevices: readonly OsdPickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly sources: readonly OsdSourceOption[]
  readonly stateByDevice: ReadonlyMap<number, Readonly<Record<string, unknown>>>
  readonly onChange: (next: OsdNamedTemplate) => void
}

function BindingCard({
  binding,
  index,
  draft,
  pickerDevices,
  listState,
  sources,
  stateByDevice,
  onChange,
}: BindingCardProps) {
  const { t } = useT()
  const live = bindingIsComplete(binding)
    ? resolveBindingLive(binding, { stateByDevice })
    : { reason: t('templates.pickDeviceAndField') }

  const pickValue: DeviceStatePickValue = {
    deviceId: binding.pick.deviceId,
    ...(binding.pick.containerId !== undefined ? { containerId: binding.pick.containerId } : {}),
    capName: binding.capName,
    valuePath: binding.valuePath,
    ...(binding.displayUnit !== undefined ? { displayUnit: binding.displayUnit } : {}),
    ...(binding.valueMap !== undefined ? { valueMap: binding.valueMap } : {}),
  }

  const applyPick = (next: DeviceStatePickValue) => {
    const leafChanged = next.deviceId !== binding.pick.deviceId
    const device = next.deviceId > 0 ? deviceById(pickerDevices, next.deviceId) : undefined
    const taken = takenAliases(draft.bindings, index)
    const alias =
      leafChanged && next.deviceId > 0
        ? suggestAlias(device?.name ?? (next.valuePath !== '' ? next.valuePath : 'sensor'), taken)
        : binding.alias
    const previousAlias = binding.alias
    const { displayUnit: _priorUnit, valueMap: _priorMap, ...bindingBase } = binding
    const nextBinding: OsdTemplateBinding = {
      ...bindingBase,
      alias,
      pick:
        next.containerId !== undefined
          ? { containerId: next.containerId, deviceId: next.deviceId }
          : { deviceId: next.deviceId },
      capName: next.capName,
      valuePath: next.valuePath,
      ...(next.displayUnit !== undefined ? { displayUnit: next.displayUnit } : {}),
      ...(next.valueMap !== undefined ? { valueMap: next.valueMap } : {}),
    }
    const parser =
      leafChanged && previousAlias !== '' && previousAlias !== alias
        ? draft.parser.replaceAll(`{${previousAlias}`, `{${alias}`)
        : draft.parser
    onChange({
      ...draft,
      bindings: draft.bindings.map((b, i) => (i === index ? nextBinding : b)),
      parser,
    })
  }

  return (
    <div
      className="space-y-2 rounded border border-border p-2"
      data-testid={`osd-tpl-binding-${index}`}
    >
      {binding.alias !== '' ? (
        <p className="text-right font-mono text-[10px] text-foreground-muted">
          {aliasToken(binding.alias)} · {aliasToken(binding.alias, 'value')} ·{' '}
          {aliasToken(binding.alias, 'unit')}
        </p>
      ) : null}

      <DeviceStatePickBlock
        value={pickValue}
        sources={sources}
        pickerDevices={pickerDevices}
        listState={listState}
        stateByDevice={stateByDevice}
        testIdPrefix={`osd-tpl-${index}`}
        onChange={applyPick}
      />

      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label>{t('templates.alias')}</Label>
          <Input
            data-testid={`osd-tpl-alias-${index}`}
            value={binding.alias}
            maxLength={32}
            onChange={(e) => {
              const alias = e.target.value
              const taken = takenAliases(draft.bindings, index)
              if (alias !== '' && taken.has(alias)) return
              onChange({
                ...draft,
                bindings: draft.bindings.map((b, i) => (i === index ? { ...binding, alias } : b)),
              })
            }}
          />
        </div>
        <div>
          <Label>{t('templates.decimals')}</Label>
          <Input
            type="number"
            min={0}
            max={4}
            value={binding.maxDecimals}
            onChange={(e) =>
              onChange({
                ...draft,
                bindings: draft.bindings.map((b, i) =>
                  i === index ? { ...binding, maxDecimals: Number(e.target.value) } : b,
                ),
              })
            }
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`osd-tpl-remove-${index}`}
            onClick={() =>
              onChange({
                ...draft,
                bindings: draft.bindings.filter((_, i) => i !== index),
              })
            }
          >
            {t('templates.remove')}
          </Button>
        </div>
      </div>

      <p className="font-mono text-xs text-foreground" data-testid={`osd-tpl-live-${index}`}>
        {'formatted' in live ? (
          <>
            {t('templates.live', {
              value: live.formatted === '' ? t('common.empty') : live.formatted,
            })}
          </>
        ) : (
          <span className="text-foreground-muted">{live.reason}</span>
        )}
      </p>
    </div>
  )
}

function useBindingSnapshots(
  bindings: readonly OsdTemplateBinding[],
): ReadonlyMap<number, Readonly<Record<string, unknown>>> {
  const needed = useMemo(
    () => new Set(bindings.map((b) => b.pick.deviceId).filter((id) => id > 0)),
    [bindings],
  )
  const all = useDeviceStateGetAllSnapshots(
    {},
    { enabled: needed.size > 0, refetchInterval: 5_000 },
  )

  return useMemo(() => {
    const map = new Map<number, Readonly<Record<string, unknown>>>()
    const rows = all.data
    if (rows === undefined) return map
    for (const [idText, caps] of Object.entries(rows)) {
      const id = Number(idText)
      if (!Number.isFinite(id) || !needed.has(id)) continue
      if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) continue
      map.set(id, caps as Readonly<Record<string, unknown>>)
    }
    return map
  }, [all.data, needed])
}
