/**
 * Node benchmark — the operator picks ONE node, the devices and candidate
 * detectors to measure and the detail steps of the pipeline measurement;
 * the orchestrator does the rest (D791): benchmark mode for that node (its
 * cameras move elsewhere, their pins come back after), the node's own runner
 * measures, and the results feed Auto tune and the automatic shares.
 *
 * Every number shown comes from the orchestrator; this component holds only
 * the operator's draft.
 */
import type {
  NodeBenchmarkCandidates,
  NodeBenchmarkPreflight,
  NodeBenchmarkResultView,
  NodeBenchmarkStatus,
} from '@camstack/types'
import {
  type AddonPageProps,
  Button,
  Checkbox,
  ConfirmActionButton,
  type DataColumn,
  DataTable,
  EmptyState,
  NodePicker,
  SECTION_BODY,
  SectionCard,
  TEXT_FIELD_LABEL,
  TEXT_HINT,
  Select,
  Input,
} from '@camstack/ui-library'
import { Activity, Cpu, Gauge, ListChecks, Play, Square, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n/index.js'
import {
  initialDraft,
  type PlanDraft,
  planOf,
  preflightLines,
  type ResultRow,
  resultRow,
  runLine,
  toggleDevice,
  toggleModel,
  togglePhase,
  toggleStep,
} from './plan-editor.js'

type Trpc = AddonPageProps['trpc']
type TFn = ReturnType<typeof useT>['t']

const ACTIVE_STATES = new Set(['draining', 'measuring', 'restoring'])

/** Poll `read` every `ms` while mounted; `null` until the first answer. */
function usePolled<T>(
  read: () => Promise<T>,
  ms: number,
  deps: readonly unknown[],
): {
  readonly data: T | null
  readonly error: string | null
  readonly refresh: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const run = (): void => {
      read()
        .then((value) => {
          if (!alive) return
          setData(value)
          setError(null)
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err))
        })
    }
    run()
    const timer = setInterval(run, ms)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [...deps, tick, ms])
  return { data, error, refresh: () => setTick((t) => t + 1) }
}

function NumberField(props: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly onChange: (v: number) => void
  readonly disabled?: boolean
}): ReactNode {
  return (
    <label className="flex items-center gap-2">
      <span className={TEXT_FIELD_LABEL}>{props.label}</span>
      <Input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) props.onChange(Math.min(props.max, Math.max(props.min, v)))
        }}
        className="h-7 w-16 rounded border border-border bg-background px-2 text-xs"
      />
    </label>
  )
}

function DevicesEditor(props: {
  readonly candidates: NodeBenchmarkCandidates
  readonly draft: PlanDraft
  readonly onChange: (d: PlanDraft) => void
  readonly disabled: boolean
}): ReactNode {
  const { candidates, draft, onChange, disabled } = props
  const { t } = useT()
  return (
    <div className="divide-y divide-border">
      {candidates.devices.map((device) => {
        const sel = draft.devices.find((d) => d.deviceKey === device.deviceKey)
        const included = sel?.included ?? false
        const chosen = sel?.modelIds ?? []
        const shown = [...new Set([...device.suggested, ...chosen])]
        const more = device.all.filter((m) => !shown.includes(m))
        return (
          <div key={device.deviceKey} className="flex flex-wrap items-center gap-2 py-2">
            <label className="flex w-40 shrink-0 items-center gap-2">
              <Checkbox
                checked={included}
                disabled={disabled}
                onChange={() => onChange(toggleDevice(draft, device.deviceKey))}
              />
              <span className="font-mono text-xs">{device.deviceKey}</span>
            </label>
            {!device.available && <span className={TEXT_HINT}>{t('devices.unavailable')}</span>}
            {!device.enabled && device.available && (
              <span className={TEXT_HINT}>{t('devices.notUsed')}</span>
            )}
            {shown.map((modelId, i) => (
              <label key={modelId} className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={chosen.includes(modelId)}
                  disabled={disabled || !included}
                  onChange={() => onChange(toggleModel(draft, device.deviceKey, modelId))}
                />
                <span className="font-mono">{modelId}</span>
                {i === 0 && device.suggested[0] === modelId && (
                  <span className={TEXT_HINT}>{t('devices.suggested')}</span>
                )}
                {chosen[0] === modelId && (
                  <span className={TEXT_HINT}>{t('devices.pipelineModel')}</span>
                )}
              </label>
            ))}
            {more.length > 0 && (
              <Select
                aria-label={t('devices.addModelAria', { device: device.deviceKey })}
                className="h-7 w-44 text-xs"
                disabled={disabled || !included}
                value=""
                options={[
                  { value: '', label: t('devices.addModel') },
                  ...more.map((m) => ({ value: m, label: m })),
                ]}
                onChange={(e) => {
                  if (e.target.value) onChange(toggleModel(draft, device.deviceKey, e.target.value))
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function PreflightPanel({ preflight }: { readonly preflight: NodeBenchmarkPreflight }): ReactNode {
  const { t } = useT()
  return (
    <div className="space-y-1 text-xs">
      {preflightLines(preflight).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {preflight.refusals.map((r) => (
        <p key={r.kind} className="text-danger">
          {r.detail}
          {r.overridable ? ` ${t('preflight.startAnyway')}` : ''}
        </p>
      ))}
    </div>
  )
}

const RESULT_COLUMNS = (
  onDelete: (id: string) => void,
  t: TFn,
): readonly DataColumn<ResultRow>[] => [
  {
    key: 'device',
    header: t('results.device'),
    nowrap: true,
    render: (r) => <span className="font-mono">{r.deviceKey}</span>,
  },
  {
    key: 'model',
    header: t('results.model'),
    nowrap: true,
    render: (r) => <span className="font-mono">{r.modelId}</span>,
  },
  { key: 'what', header: t('results.measurement'), render: (r) => r.what },
  { key: 'capacity', header: t('results.capacity'), nowrap: true, render: (r) => r.capacity },
  { key: 'latency', header: t('results.latency'), nowrap: true, render: (r) => r.latency },
  { key: 'limit', header: t('results.limitedBy'), render: (r) => r.limitedBy },
  { key: 'when', header: t('results.measured'), nowrap: true, render: (r) => r.measuredAt },
  {
    key: 'standing',
    header: t('results.standing'),
    render: (r) => (
      <span>
        {r.standing}
        {r.flags.length > 0 && <span className={`block ${TEXT_HINT}`}>{r.flags.join(' · ')}</span>}
      </span>
    ),
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: (r) => (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('results.delete')}
        onClick={() => onDelete(r.id)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    ),
  },
]

export function NodeBenchmarkSection({ trpc }: { readonly trpc: Trpc }): ReactNode {
  const { t, lang } = useT()
  const [nodeId, setNodeId] = useState('hub')
  const [draft, setDraft] = useState<PlanDraft | null>(null)

  const status = usePolled<NodeBenchmarkStatus>(
    () => trpc.pipelineOrchestrator.getNodeBenchmarkStatus.query(),
    3000,
    [trpc],
  )
  const run = status.data?.run ?? null
  const active = run !== null && ACTIVE_STATES.has(run.state)
  // One run cluster-wide (D791): while active, the picker follows the mode node.
  const runNodeId =
    active && status.data !== null ? (status.data.modeNodeId ?? run?.nodeId ?? null) : null

  useEffect(() => {
    if (runNodeId !== null && nodeId !== runNodeId) {
      setNodeId(runNodeId)
      setDraft(null)
    }
  }, [runNodeId, nodeId])

  const candidates = usePolled<NodeBenchmarkCandidates>(
    () => trpc.pipelineOrchestrator.getNodeBenchmarkCandidates.query({ nodeId }),
    60_000,
    [trpc, nodeId],
  )
  useEffect(() => {
    if (candidates.data !== null && candidates.data.nodeId === nodeId) {
      setDraft((prev) => (prev?.nodeId === nodeId ? prev : initialDraft(candidates.data!)))
    }
  }, [candidates.data, nodeId])

  const plan = useMemo(() => (draft === null ? null : planOf(draft)), [draft])
  const planKey = plan?.kind === 'plan' ? JSON.stringify(plan.plan) : null
  const preflight = usePolled<NodeBenchmarkPreflight | null>(
    async () =>
      plan?.kind === 'plan' && !active
        ? trpc.pipelineOrchestrator.getNodeBenchmarkPreflight.query(plan.plan)
        : null,
    15_000,
    [trpc, planKey, active],
  )

  const results = usePolled<readonly NodeBenchmarkResultView[]>(
    () => trpc.pipelineOrchestrator.listNodeBenchmarkResults.query({ nodeId }),
    active ? 10_000 : 60_000,
    [trpc, nodeId, run?.state],
  )
  const deleteResult = useCallback(
    (id: string) => {
      void trpc.pipelineOrchestrator.deleteNodeBenchmarkResult
        .mutate({ id })
        .then(() => results.refresh())
    },
    [trpc, results],
  )

  const start = async (): Promise<void> => {
    if (plan?.kind !== 'plan') throw new Error(plan?.why ?? t('plan.none'))
    const answer = await trpc.pipelineOrchestrator.startNodeBenchmark.mutate(plan.plan)
    if (answer.kind === 'refused') {
      throw new Error(answer.preflight.refusals.map((r) => r.detail).join(' '))
    }
    status.refresh()
  }

  const pf = preflight.data
  const steps = candidates.data?.steps ?? []
  const editing = draft !== null && !active

  return (
    <div className="space-y-3">
      <SectionCard
        headingId="nb-node"
        title={t('node.title')}
        icon={Cpu}
        actions={
          <NodePicker
            selectedNodeId={runNodeId ?? nodeId}
            onSelect={(id) => {
              if (active) return
              setNodeId(id)
              setDraft(null)
            }}
            alwaysShow
          />
        }
      >
        <div className={`${SECTION_BODY} space-y-1 text-xs`}>
          <p>{t('node.intro')}</p>
          {pf !== null && pf !== undefined && (
            <p className={TEXT_HINT}>
              {t('node.cluster', {
                now: pf.headroom.sessionsNow,
                capacity: pf.headroom.otherNodesCapacitySessions ?? t('node.unknownCapacity'),
              })}
            </p>
          )}
          {candidates.error !== null && <p className="text-danger">{candidates.error}</p>}
        </div>
      </SectionCard>

      {run !== null && (!active || run.nodeId === nodeId) && (
        <SectionCard
          headingId="nb-run"
          title={active ? t('run.running') : t('run.lastRun')}
          icon={Activity}
          actions={
            active ? (
              <ConfirmActionButton
                label={t('run.abort')}
                icon={Square}
                title={t('run.abortTitle')}
                description={t('run.abortDescription')}
                confirmLabel={t('run.abort')}
                action={async () =>
                  trpc.pipelineOrchestrator.abortNodeBenchmark.mutate({ runId: run.runId })
                }
                onSuccess={() => status.refresh()}
              />
            ) : null
          }
        >
          <div className={`${SECTION_BODY} space-y-1 text-xs`}>
            <p>{runLine(run)}</p>
            {run.staying.length > 0 && (
              <p className={TEXT_HINT}>
                {t('run.stayed', { list: run.staying.map((d) => `#${d}`).join(', ') })}
              </p>
            )}
            {run.error !== null && !active && <p className="text-danger">{run.error}</p>}
          </div>
        </SectionCard>
      )}

      <SectionCard headingId="nb-devices" title={t('devices.title')} icon={Gauge}>
        <div className={SECTION_BODY}>
          {candidates.data === null || draft === null ? (
            <p className={TEXT_HINT}>{t('devices.reading', { node: nodeId })}</p>
          ) : (
            <>
              <DevicesEditor
                candidates={candidates.data}
                draft={draft}
                onChange={setDraft}
                disabled={!editing}
              />
              <p className={`${TEXT_HINT} pt-2`}>
                {draft.keepDownloadedModels ? t('devices.noteKept') : t('devices.note')}
              </p>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard headingId="nb-steps" title={t('measure.title')} icon={ListChecks}>
        <div className={`${SECTION_BODY} space-y-3`}>
          {draft !== null && (
            <>
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.phases.includes('device')}
                    disabled={!editing}
                    onChange={() => setDraft(togglePhase(draft, 'device'))}
                  />
                  {t('measure.deviceCapacity')}
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.phases.includes('pipeline')}
                    disabled={!editing}
                    onChange={() => setDraft(togglePhase(draft, 'pipeline'))}
                  />
                  {t('measure.pipelineLoad')}
                </label>
              </div>
              {draft.phases.includes('pipeline') && (
                <div className="flex flex-wrap gap-3 text-xs">
                  {steps.length === 0 && <span className={TEXT_HINT}>{t('measure.noSteps')}</span>}
                  {steps.map((s) => (
                    <label key={s.id} className="flex items-center gap-1">
                      <Checkbox
                        checked={draft.steps.includes(s.id)}
                        disabled={!editing}
                        onChange={() => setDraft(toggleStep(draft, s.id))}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <NumberField
                  label={t('measure.fps')}
                  value={draft.fpsPerStream}
                  min={1}
                  max={30}
                  disabled={!editing}
                  onChange={(v) => setDraft({ ...draft, fpsPerStream: v })}
                />
                <NumberField
                  label={t('measure.budget')}
                  value={draft.budgetMinutes}
                  min={10}
                  max={120}
                  disabled={!editing}
                  onChange={(v) => setDraft({ ...draft, budgetMinutes: v })}
                />
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.keepDownloadedModels}
                    disabled={!editing}
                    onChange={() =>
                      setDraft({ ...draft, keepDownloadedModels: !draft.keepDownloadedModels })
                    }
                  />
                  {t('measure.keepModels')}
                </label>
                {pf?.refusals.some((r) => r.overridable) === true && (
                  <label className="flex items-center gap-2 text-warning">
                    <Checkbox
                      checked={draft.acceptInsufficientHeadroom}
                      disabled={!editing}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          acceptInsufficientHeadroom: !draft.acceptInsufficientHeadroom,
                        })
                      }
                    />
                    {t('measure.acceptHeadroom')}
                  </label>
                )}
              </div>
            </>
          )}
          {pf !== null && pf !== undefined && !active && <PreflightPanel preflight={pf} />}
          {plan?.kind === 'incomplete' && <p className={TEXT_HINT}>{plan.why}</p>}
          <div className="flex justify-end">
            <ConfirmActionButton
              label={t('start.label')}
              icon={Play}
              title={t('start.title', { node: nodeId })}
              description={pf ? <PreflightPanel preflight={pf} /> : t('start.reading')}
              confirmLabel={t('start.confirm')}
              confirmVariant="primary"
              triggerVariant="primary"
              disabled={active || pf === null || pf === undefined || !pf.canStart}
              action={start}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard headingId="nb-results" title={t('results.title', { node: nodeId })} icon={Gauge}>
        {results.data === null || results.data.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title={t('results.empty')}
            description={t('results.emptyHint')}
          />
        ) : (
          <DataTable
            columns={RESULT_COLUMNS(deleteResult, t)}
            rows={results.data.map((r) => resultRow(r, lang))}
            rowKey={(r) => r.id}
            minWidthPx={900}
          />
        )}
      </SectionCard>
    </div>
  )
}
