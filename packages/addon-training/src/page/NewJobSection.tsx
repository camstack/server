/**
 * New-job form body (ItemFormDialog filler): provider entry, collections,
 * one base model by default (exports onnx/ov/coreml), multi-arch behind
 * advanced; plan / confirm / startJob or startJobBatch.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import type {
  RetrainCollection,
  TrainingBaseModel,
  TrainingProviderDescriptor,
} from '@camstack/types'
import {
  Button,
  Checkbox,
  defaultSelectClusterRoots,
  defaultSingleClusterRoot,
  Input,
  Label,
  Select,
  TrainingBaseModelPicker,
  useClusterNodes,
  useConfirm,
  type AddonPageProps,
  type RootDetectorDeviceInput,
  type TrainingBaseModelRow,
} from '@camstack/ui-library'
import {
  buildClusterRootModelRows,
  type ClusterNodeSnapshot,
  type SchemaSlotsLike,
} from './cluster-root-model-rows.js'
import { useT } from '../i18n/index.js'
import { PlanSummary } from './PlanSummary.js'
import {
  EMPTY_FORM,
  PRESETS,
  WORK_STATES,
  type PlanForm,
  requestOf,
  withProvider,
} from './plan-form.js'
import { errorText, useAsync } from './use-async.js'

export interface NewJobSectionProps {
  readonly trpc: AddonPageProps['trpc']
  readonly providers: readonly TrainingProviderDescriptor[]
  readonly baseModels: readonly TrainingBaseModel[]
  readonly collections: readonly RetrainCollection[]
  readonly cameraName: (id: number) => string
  readonly onStarted: () => void
  /** Called when the dialog should close after a successful start. */
  readonly onClose?: () => void
}

function isSchemaSlots(value: unknown): value is SchemaSlotsLike {
  if (typeof value !== 'object' || value === null) return false
  const slots = Reflect.get(value, 'slots')
  return Array.isArray(slots)
}

function devicesOf(value: unknown): readonly RootDetectorDeviceInput[] {
  if (typeof value !== 'object' || value === null) return []
  const devices = Reflect.get(value, 'devices')
  if (!Array.isArray(devices)) return []
  return devices.flatMap((row) => {
    const device = rootDetectorDeviceOf(row)
    return device === null ? [] : [device]
  })
}

function rootDetectorDeviceOf(value: unknown): RootDetectorDeviceInput | null {
  if (typeof value !== 'object' || value === null) return null
  const key = Reflect.get(value, 'key')
  const backend = Reflect.get(value, 'backend')
  const device = Reflect.get(value, 'device')
  const enabled = Reflect.get(value, 'enabled')
  const format = Reflect.get(value, 'format')
  if (
    typeof key !== 'string' ||
    typeof backend !== 'string' ||
    typeof device !== 'string' ||
    typeof enabled !== 'boolean' ||
    typeof format !== 'string'
  ) {
    return null
  }
  const defaultModelId = Reflect.get(value, 'defaultModelId')
  const steps = stepsMapOf(Reflect.get(value, 'steps'))
  return {
    key,
    backend,
    device,
    enabled,
    format,
    ...(typeof defaultModelId === 'string' ? { defaultModelId } : {}),
    ...(steps !== undefined ? { steps } : {}),
  }
}

function stepsMapOf(value: unknown): RootDetectorDeviceInput['steps'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, { readonly modelId?: string }> = {}
  for (const [stepId, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) continue
    const modelId = Reflect.get(raw, 'modelId')
    out[stepId] = typeof modelId === 'string' ? { modelId } : {}
  }
  return out
}

export function NewJobSection({
  trpc,
  providers,
  baseModels,
  collections,
  cameraName,
  onStarted,
  onClose,
}: NewJobSectionProps): JSX.Element {
  const { t } = useT()
  const confirm = useConfirm()
  const { nodes } = useClusterNodes()
  const onlineNodeIds = useMemo(() => nodes.filter((n) => n.isOnline).map((n) => n.id), [nodes])
  const onlineKey = onlineNodeIds.join('\0')

  const [form, setForm] = useState<PlanForm>(EMPTY_FORM)
  const [name, setName] = useState('')
  const [costCap, setCostCap] = useState('')
  const [runtimeHours, setRuntimeHours] = useState('')
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [rootsSeeded, setRootsSeeded] = useState(false)
  const [advancedMulti, setAdvancedMulti] = useState(false)

  const placements = useAsync(async (): Promise<ClusterRootModelRowsSafe> => {
    if (baseModels.length === 0) {
      return { models: [], clusterRootModelIds: [] }
    }
    const snapshots: ClusterNodeSnapshot[] = []
    await Promise.all(
      onlineNodeIds.map(async (nodeId) => {
        try {
          const [devicesRaw, schemaRaw] = await Promise.all([
            trpc.pipelineOrchestrator.getNodeInferenceDevices.query({ nodeId }),
            trpc.pipelineExecutor.getSchema.query({ nodeId }),
          ])
          if (!isSchemaSlots(schemaRaw)) return
          snapshots.push({ nodeId, devices: devicesOf(devicesRaw), schema: schemaRaw })
        } catch {
          // A node that did not answer contributes no placements.
        }
      }),
    )
    return buildClusterRootModelRows(baseModels, snapshots)
  }, [onlineKey, baseModels.map((m) => m.modelId).join('\0')])

  const pickerModels: readonly TrainingBaseModelRow[] =
    placements.state.status === 'ok'
      ? placements.state.data.models
      : baseModels.map((m) => ({
          modelId: m.modelId,
          label: m.label,
          ...(m.recommended ? { recommended: true as const } : {}),
          placements: [],
        }))
  const clusterRootIds =
    placements.state.status === 'ok' ? placements.state.data.clusterRootModelIds : []

  useEffect(() => {
    setForm((f) => {
      let next: PlanForm = { ...f, holdoutCameras: [] }
      const first = providers.find((p) => p.configured) ?? providers[0]
      if (next.entryId === '' && first !== undefined) next = withProvider(next, first)
      return next
    })
  }, [providers])

  useEffect(() => {
    if (rootsSeeded) return
    if (placements.state.status !== 'ok') return
    const trainableIds = pickerModels.map((m) => m.modelId)
    if (advancedMulti) {
      const roots = defaultSelectClusterRoots(
        trainableIds,
        placements.state.data.clusterRootModelIds,
      )
      if (roots.length === 0) return
      setForm((f) => (f.baseModelIds.length === 0 ? { ...f, baseModelIds: roots } : f))
    } else {
      const one = defaultSingleClusterRoot(
        trainableIds,
        placements.state.data.clusterRootModelIds,
        pickerModels,
      )
      if (one === undefined) return
      setForm((f) => (f.baseModelIds.length === 0 ? { ...f, baseModelIds: [one] } : f))
    }
    setRootsSeeded(true)
  }, [placements.state, pickerModels, rootsSeeded, advancedMulti])

  const request = requestOf(form)
  const plan = useAsync(
    async () => (request === null ? null : trpc.training.planJob.query(request)),
    [JSON.stringify(request)],
  )
  const planned = plan.state.status === 'ok' ? plan.state.data : null
  useEffect(() => {
    if (planned?.defaults == null) return
    setCostCap(planned.defaults.maxCostUsd.toFixed(2))
    setRuntimeHours((planned.defaults.maxRuntimeSec / 3600).toFixed(1))
  }, [planned?.defaults?.maxCostUsd, planned?.defaults?.maxRuntimeSec])

  const provider = providers.find((p) => p.entryId === form.entryId)
  const cap = Number(costCap)
  const hours = Number(runtimeHours)
  const canStart =
    request !== null &&
    form.baseModelIds.length > 0 &&
    planned !== null &&
    planned.refusal === null &&
    cap > 0 &&
    hours > 0 &&
    name.trim() !== '' &&
    !starting

  const start = async (): Promise<void> => {
    if (request === null || planned === null || form.baseModelIds.length === 0) return
    const modelCount = form.baseModelIds.length
    const ok = await confirm({
      title: modelCount > 1 ? t('newJob.confirm.batchTitle') : t('newJob.confirm.title'),
      message:
        modelCount > 1
          ? `${planned.dataNotice}\n\n${t('newJob.confirm.batchMessage', { jobs: modelCount, cap: cap.toFixed(2), hours })}`
          : `${planned.dataNotice}\n\n${t('newJob.confirm.message', { cap: cap.toFixed(2), hours })}`,
      confirmLabel: t('newJob.confirm.confirm'),
      variant: 'warning',
    })
    if (!ok) return
    setStarting(true)
    setStartError(null)
    try {
      if (modelCount === 1) {
        const baseModelId = form.baseModelIds[0]
        if (baseModelId === undefined) return
        const res = await trpc.training.startJob.mutate({
          ...request,
          baseModelId,
          name: name.trim(),
          maxCostUsd: cap,
          maxRuntimeSec: Math.round(hours * 3600),
          idempotencyKey: crypto.randomUUID(),
        })
        if (res.kind === 'refused')
          setStartError(t('newJob.refused', { reason: res.reason, detail: res.detail }))
        else {
          onStarted()
          onClose?.()
        }
      } else {
        const res = await trpc.training.startJobBatch.mutate({
          selection: request.selection,
          entryId: request.entryId,
          gpuType: request.gpuType,
          region: request.region,
          preset: request.preset,
          freeze: request.freeze,
          holdoutCameras: request.holdoutCameras,
          baseModelIds: [...form.baseModelIds],
          name: name.trim(),
          maxCostUsd: cap,
          maxRuntimeSec: Math.round(hours * 3600),
          idempotencyKey: crypto.randomUUID(),
        })
        if (res.kind === 'refused') setStartError(`Refused (${res.reason}): ${res.detail}`)
        else {
          onStarted()
          onClose?.()
        }
      }
    } catch (err: unknown) {
      setStartError(errorText(err))
    } finally {
      setStarting(false)
    }
  }

  const set = (patch: Partial<PlanForm>): void => setForm((f) => ({ ...f, ...patch }))
  const holdoutCameras = planned?.split?.holdoutCameras ?? []

  const onAdvancedChange = (checked: boolean): void => {
    setAdvancedMulti(checked)
    if (!checked) {
      setForm((f) => ({
        ...f,
        baseModelIds: f.baseModelIds[0] !== undefined ? [f.baseModelIds[0]] : [],
      }))
    }
  }

  if (collections.length === 0) {
    return <p className="text-sm text-foreground-muted">{t('newJob.noCollections')}</p>
  }
  if (providers.length === 0) {
    return <p className="text-sm text-foreground-muted">{t('newJob.noProviders')}</p>
  }

  return (
    <>
      <Label className="space-y-1">
        <span>{t('newJob.providerEntry')}</span>
        <Select
          value={form.entryId}
          onChange={(e) => {
            const p = providers.find((x) => x.entryId === e.target.value)
            if (p !== undefined) setForm((f) => withProvider(f, p))
          }}
          options={providers.map((p) => ({
            value: p.entryId,
            label: p.configured
              ? `${p.name} · ${p.label}`
              : t('newJob.providerNotConfigured', { name: p.name, type: p.label }),
          }))}
        />
      </Label>
      <fieldset className="space-y-1" data-testid="new-job-collections">
        <legend className="text-sm text-foreground">{t('newJob.collections')}</legend>
        <div className="flex flex-wrap gap-3">
          {collections.map((c) => (
            <label key={c.id} className="flex items-center gap-1 text-sm text-foreground-muted">
              <Checkbox
                checked={form.collectionIds.includes(c.id)}
                onChange={(e) =>
                  set({
                    collectionIds: e.target.checked
                      ? [...form.collectionIds, c.id]
                      : form.collectionIds.filter((id) => id !== c.id),
                  })
                }
              />
              {c.name}
              <span className="text-foreground-subtle">({String(c.frameCount)})</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Label className="space-y-1">
        <span>{t('newJob.workState')}</span>
        <Select
          value={form.workState}
          onChange={(e) => {
            const value = e.target.value
            if (
              value === 'complete' ||
              value === 'annotated_or_complete' ||
              value === 'any_annotated'
            ) {
              set({ workState: value })
            }
          }}
          options={WORK_STATES.map((value) => ({
            value,
            label: t(`newJob.workStates.${value}`),
          }))}
        />
      </Label>
      <div className="space-y-1" data-testid="new-job-base-models">
        <span className="text-sm text-foreground">
          {advancedMulti ? t('newJob.baseModels') : t('newJob.baseModel')}
        </span>
        <p className="text-xs text-foreground-muted">{t('newJob.baseModelHint')}</p>
        <TrainingBaseModelPicker
          models={pickerModels}
          clusterRootModelIds={clusterRootIds}
          value={form.baseModelIds}
          onChange={(modelIds) => set({ baseModelIds: modelIds })}
          multiple={advancedMulti}
        />
        <label className="flex items-center gap-1.5 text-sm text-foreground-muted">
          <Checkbox
            checked={advancedMulti}
            onChange={(e) => onAdvancedChange(e.target.checked)}
            data-testid="new-job-advanced-multi"
          />
          {t('newJob.advancedMulti')}
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Label className="space-y-1">
          <span>{t('newJob.preset.label')}</span>
          <Select
            value={form.preset}
            onChange={(e) =>
              set({
                preset:
                  e.target.value === 'quick'
                    ? 'quick'
                    : e.target.value === 'thorough'
                      ? 'thorough'
                      : 'standard',
              })
            }
            options={PRESETS.map((value) => ({ value, label: t(`newJob.preset.${value}`) }))}
          />
        </Label>
        <Label className="space-y-1">
          <span>{t('newJob.freeze')}</span>
          <Input
            inputMode="numeric"
            value={form.freeze}
            onChange={(e) => set({ freeze: e.target.value })}
            placeholder={t('newJob.freezePlaceholder')}
          />
        </Label>
        <Label className="space-y-1">
          <span>GPU</span>
          <Select
            value={form.gpuType}
            onChange={(e) => set({ gpuType: e.target.value })}
            options={(provider?.gpuTypes ?? []).map((g) => ({
              value: g.id,
              label: `${g.label} — $${g.usdPerHour.toFixed(2)}/h`,
            }))}
          />
        </Label>
        <Label className="space-y-1">
          <span>{t('newJob.region')}</span>
          <Select
            value={form.region}
            onChange={(e) => set({ region: e.target.value })}
            options={(provider?.regions ?? []).map((r) => ({
              value: r.id,
              label:
                r.priceMultiplier === 1 ? r.label : `${r.label} (×${String(r.priceMultiplier)})`,
            }))}
          />
        </Label>
      </div>
      {holdoutCameras.length > 0 ? (
        <p className="text-sm text-foreground-muted">
          {t('newJob.holdoutCameras', {
            cameras: holdoutCameras.map((id) => cameraName(id)).join(', '),
          })}
        </p>
      ) : null}
      {plan.state.status === 'pending' && request !== null && (
        <p className="text-sm text-foreground-subtle">{t('newJob.planning')}</p>
      )}
      {plan.state.status === 'error' && (
        <p className="text-sm text-danger">
          {t('newJob.couldNotPlan')} {plan.state.error}
        </p>
      )}
      {planned !== null && <PlanSummary plan={planned} cameraName={cameraName} />}
      <div className="grid gap-3 md:grid-cols-3">
        <Label className="space-y-1">
          <span>{t('newJob.jobName')}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('newJob.jobNamePlaceholder')}
          />
        </Label>
        <Label className="space-y-1">
          <span>{t('newJob.costCap')}</span>
          <Input inputMode="decimal" value={costCap} onChange={(e) => setCostCap(e.target.value)} />
        </Label>
        <Label className="space-y-1">
          <span>{t('newJob.maxRuntime')}</span>
          <Input
            inputMode="decimal"
            value={runtimeHours}
            onChange={(e) => setRuntimeHours(e.target.value)}
          />
        </Label>
      </div>
      {startError !== null && (
        <p className="text-sm text-danger" role="alert">
          {startError}
        </p>
      )}
      <div className="flex justify-end pt-1">
        <Button size="md" disabled={!canStart} onClick={() => void start()}>
          {starting ? t('newJob.starting') : t('newJob.reviewAndStart')}
        </Button>
      </div>
    </>
  )
}

interface ClusterRootModelRowsSafe {
  readonly models: readonly TrainingBaseModelRow[]
  readonly clusterRootModelIds: readonly string[]
}
