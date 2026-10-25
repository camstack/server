/**
 * Cluster models — the steps whose model is ONE cluster-wide choice (D651:
 * every vector lands in one shared index). One card per step: the model in
 * force, and per node where it runs — node · runtime · devices · loaded, or
 * "no build for <format> → refused". Changing it stays an explicit action
 * with its confirm; nothing on this page rewrites the cluster row from a
 * device chip.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  BTN_COMPACT_PRIMARY,
  DataTable,
  SECTION_CARD,
  SECTION_HEADER,
  Select,
  TEXT_HINT,
  TEXT_SECTION_LABEL,
  useConfirm,
  type AddonPageProps,
  type DataColumn,
} from '@camstack/ui-library'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type ClusterModelScopedStep,
  type ClusterStepModels,
} from '@camstack/types'
import { setClusterStepModel } from '../../ui/api.js'
import { clusterModelPatch } from '../../ui/installed-activation.js'
import {
  buildClusterPlacement,
  type ClusterNodeInput,
  type ClusterPlacementEntry,
} from '../../ui/installed-inventory.js'
import { useClusterPlacementInputs } from './use-cluster-placement.js'
import { useOnlineNodeIds } from './use-online-node-ids.js'
import { useT } from '../../i18n/index.js'

type ClusterT = ReturnType<typeof useT>['t']

interface PlacementRow {
  readonly key: string
  readonly nodeId: string
  readonly entry: ClusterPlacementEntry | null
  readonly error?: string
}

function StateCell({ row }: { readonly row: PlacementRow }): ReactNode {
  const { t } = useT()
  if (row.entry === null) {
    return (
      <Badge variant="danger" className="text-[10px] px-1.5 py-0">
        {row.error ?? t('cluster.noDevice')}
      </Badge>
    )
  }
  const { state, format, onDisk } = row.entry
  if (state === 'refused') {
    return (
      <Badge variant="danger" className="text-[10px] px-1.5 py-0" title={t('cluster.refusedTitle')}>
        {t('cluster.refused', { format })}
      </Badge>
    )
  }
  const label =
    state === 'loaded'
      ? t('cluster.loaded')
      : state === 'unknown'
        ? t('cluster.loadUnknown')
        : t('cluster.notLoaded')
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge
        variant={state === 'loaded' ? 'success' : 'default'}
        className="text-[10px] px-1.5 py-0"
      >
        {label}
      </Badge>
      {onDisk !== 'current' && <span className={TEXT_HINT}>{t('cluster.fileStale')}</span>}
    </span>
  )
}

const buildColumns = (t: ClusterT): readonly DataColumn<PlacementRow>[] => [
  {
    key: 'node',
    header: t('cluster.cols.node'),
    render: (r) => <span className="text-[11px]">{r.nodeId}</span>,
  },
  {
    key: 'runtime',
    header: t('cluster.cols.runtime'),
    render: (r) => <span className="font-mono text-[11px]">{r.entry?.format ?? '—'}</span>,
  },
  {
    key: 'devices',
    header: t('cluster.cols.devices'),
    nowrap: false,
    render: (r) => (
      <span className="text-[11px]">
        {r.entry === null || r.entry.devices.length === 0
          ? '—'
          : r.entry.devices.map((d) => d.label).join(', ')}
      </span>
    ),
  },
  { key: 'state', header: t('cluster.cols.state'), render: (r) => <StateCell row={r} /> },
]

function placementRows(
  step: ClusterModelScopedStep,
  modelId: string,
  inputs: readonly ClusterNodeInput[],
): readonly PlacementRow[] {
  return buildClusterPlacement(step.stepId, modelId, inputs).nodes.flatMap((n): PlacementRow[] =>
    n.entries.length === 0
      ? [{ key: n.nodeId, nodeId: n.nodeId, entry: null, ...(n.error ? { error: n.error } : {}) }]
      : n.entries.map((entry) => ({ key: `${n.nodeId}:${entry.format}`, nodeId: n.nodeId, entry })),
  )
}

/**
 * What the cluster row can be set to: the step's declared options, plus every
 * model of that step any node's catalog lists (an operator-registered encoder
 * is the operator's own compatibility call — `cluster-model-resolution.ts`).
 */
function clusterModelChoices(
  step: ClusterModelScopedStep,
  inputs: readonly ClusterNodeInput[] | null,
): readonly { readonly id: string; readonly label: string }[] {
  const out = new Map<string, string>(step.options.map((o) => [o.id, o.label]))
  for (const node of inputs ?? []) {
    if (node.error !== undefined) continue
    for (const seed of node.seeds) {
      if (seed.stepId === step.stepId && !out.has(seed.modelId)) out.set(seed.modelId, seed.name)
    }
  }
  return [...out].map(([id, label]) => ({ id, label }))
}

function ClusterStepCard({
  step,
  current,
  inputs,
  onChange,
}: {
  readonly step: ClusterModelScopedStep
  readonly current: string
  readonly inputs: readonly ClusterNodeInput[] | null
  readonly onChange: (stepId: string, modelId: string, label: string) => Promise<void>
}): ReactNode {
  const { t } = useT()
  const columns = useMemo(() => buildColumns(t), [t])
  const [draft, setDraft] = useState(current)
  useEffect(() => setDraft(current), [current])
  const rows = useMemo(
    () => (inputs === null ? [] : placementRows(step, current, inputs)),
    [step, current, inputs],
  )
  const choices = useMemo(() => clusterModelChoices(step, inputs), [step, inputs])
  const labelOf = (id: string) => choices.find((o) => o.id === id)?.label ?? id
  return (
    <section
      aria-labelledby={`cluster-${step.stepId}`}
      className={SECTION_CARD}
      data-testid="cluster-model-card"
      data-step={step.stepId}
    >
      <header className={`${SECTION_HEADER} flex min-h-9 flex-wrap items-center gap-2`}>
        <h3 id={`cluster-${step.stepId}`} className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>
          {step.label} · <span className="normal-case">{labelOf(current)}</span>
        </h3>
        {choices.length > 1 && (
          <span className="flex w-full items-center gap-1.5 sm:w-auto">
            <span className="min-w-0 flex-1 sm:w-48">
              <Select
                aria-label={t('cluster.selectAria', { step: step.label })}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                options={choices.map((o) => ({ value: o.id, label: o.label }))}
              />
            </span>
            <button
              type="button"
              className={BTN_COMPACT_PRIMARY}
              disabled={draft === current}
              onClick={() => void onChange(step.stepId, draft, labelOf(draft))}
            >
              {t('cluster.change')}
            </button>
          </span>
        )}
      </header>
      <p className={`${TEXT_HINT} px-3 pt-2 sm:px-4`}>
        {t('cluster.oneModel', { index: step.indexName })}
      </p>
      <div className="p-2 sm:p-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          minWidthPx={420}
          bordered={false}
          emptyMessage={inputs === null ? t('cluster.reading') : t('cluster.noOnlineNode')}
        />
      </div>
    </section>
  )
}

export interface ClusterModelsSectionProps {
  readonly trpc: AddonPageProps['trpc']
  readonly refreshKey: number
  readonly clusterModels: ClusterStepModels | null
  readonly onChanged: () => void
  readonly onError: (message: string) => void
}

export function ClusterModelsSection({
  trpc,
  refreshKey,
  clusterModels,
  onChanged,
  onError,
}: ClusterModelsSectionProps): ReactNode {
  const { t } = useT()
  const confirm = useConfirm()
  const nodeIds = useOnlineNodeIds()
  const inputs = useClusterPlacementInputs(trpc, nodeIds, refreshKey)

  const change = async (stepId: string, modelId: string, label: string): Promise<void> => {
    const ok = await confirm({
      title: t('cluster.confirmTitle'),
      message: t('cluster.confirmMessage', { label, stepId }),
      confirmLabel: t('common.activate'),
      cancelLabel: t('common.cancel'),
      variant: 'default',
    })
    if (!ok) return
    try {
      await setClusterStepModel(trpc, clusterModelPatch(stepId, modelId))
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('cluster.activateFailed'))
    }
  }

  return (
    <section className="space-y-2" aria-labelledby="installed-cluster-models">
      <h2 id="installed-cluster-models" className={TEXT_SECTION_LABEL}>
        {t('cluster.title')}
      </h2>
      {CLUSTER_MODEL_SCOPED_STEPS.map((step) => (
        <ClusterStepCard
          key={step.stepId}
          step={step}
          current={clusterModels?.[step.stepId] ?? step.defaultModelId}
          inputs={inputs}
          onChange={change}
        />
      ))}
    </section>
  )
}
