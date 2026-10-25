/**
 * Cluster → Auto tune (D745, D755).
 *
 * Computes the recommended detector for every node — ONE family (YOLOv9) for
 * the whole cluster, from each node's hardware and the measured latency table:
 * per device, the most accurate model that still carries at least the chosen
 * number of parallel sessions (no load is measured or estimated) — and shows every write before anything happens: the
 * node models set, and the model and threshold overrides that are cleared (so
 * every model runs its own default thresholds). Apply asks for confirmation
 * with the full list, and writes exactly that list: if the configuration
 * changed meanwhile, the server refuses and the new plan is shown instead.
 *
 * It never changes which steps or devices are enabled, pins, recording,
 * notifications, zones or rules. There is no undo.
 */
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cpu, Sparkles } from 'lucide-react'
import {
  type AutoTuneApplyResult,
  type AutoTunePlan,
  DEFAULT_MIN_SESSIONS_PER_DEVICE,
} from '@camstack/types'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SECTION_CARD,
  SECTION_HEADER,
  Select,
  TEXT_SECTION_LABEL,
  useClusterNodes,
  usePipelineOrchestratorApplyAutoTune,
  usePipelineOrchestratorPlanAutoTune,
} from '@camstack/ui-library'
import { nodeNamer } from '../assignments/assignment-rows'
import {
  acceleratorLabel,
  detectorChangeFor,
  latencySourceText,
  hardwareLabel,
  planCounts,
  planIsNoop,
  reasonText,
  warningText,
} from '../auto-tune/auto-tune-view-model'
import { useTranslation } from 'react-i18next'

const HEADROOMS = [0.3, 0.4, 0.5] as const
type Headroom = (typeof HEADROOMS)[number]

function isHeadroom(value: number): value is Headroom {
  return HEADROOMS.some((h) => h === value)
}

/** The floor the operator picks from (the server accepts 1–8). */
const MIN_SESSIONS = [1, 2, 3, 4, 6, 8] as const

function NodeCard({
  plan,
  node,
  nodeName,
}: {
  readonly plan: AutoTunePlan
  readonly node: AutoTunePlan['nodes'][number]
  readonly nodeName: (nodeId: string) => string
}) {
  const { t } = useTranslation()
  return (
    <section className={SECTION_CARD} data-testid={`auto-tune-node-${node.nodeId}`}>
      <header className={`${SECTION_HEADER} flex flex-wrap items-center gap-2`}>
        <Cpu className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden />
        <h3 className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>{nodeName(node.nodeId)}</h3>
        <span className="text-[11px] text-foreground-subtle">
          {hardwareLabel(node.hardwareClass)}
          {node.cpuModel !== null ? ` · ${node.cpuModel}` : ''}
        </span>
        {node.skipped ? (
          <Badge variant="warning">
            {t('pipeline.clusterAutoTuneTab.notChanged', 'Not changed')}
          </Badge>
        ) : (
          node.acceleratorModelId !== null && (
            <Badge variant="info">{node.acceleratorModelId}</Badge>
          )
        )}
      </header>
      {node.reasons.length > 0 && (
        <ul className="px-3 pt-2 text-[11px] text-foreground-muted">
          {node.reasons.map((r, i) => (
            <li key={i}>{reasonText(r)}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] text-foreground-subtle">
              <th className="px-3 py-1.5 font-medium">
                {t('pipeline.clusterAutoTuneTab.device', 'Device')}
              </th>
              <th className="px-3 py-1.5 font-medium">
                {t('pipeline.clusterAutoTuneTab.capacity', 'Capacity')}
              </th>
              <th className="px-3 py-1.5 font-medium">
                {t('pipeline.clusterAutoTuneTab.detector', 'Detector')}
              </th>
              <th className="px-3 py-1.5 font-medium">
                {t('pipeline.clusterAutoTuneTab.why', 'Why')}
              </th>
            </tr>
          </thead>
          <tbody>
            {node.devices.map((d) => {
              const change = detectorChangeFor(plan, node.nodeId, d.deviceKey)
              return (
                <tr key={d.deviceKey} className="border-t border-border align-top">
                  <td className="px-3 py-1.5">
                    <div className="font-mono text-foreground">{d.deviceKey}</div>
                    <div className="text-[11px] text-foreground-subtle">
                      {acceleratorLabel(d.accelerator)}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-foreground-muted">
                    {d.chosen === null
                      ? '—'
                      : t('pipeline.clusterAutoTuneTab.sessionsAtFps', {
                          count: d.chosen.capacitySessions,
                          fps: plan.cameraFps,
                        })}
                    {d.chosen !== null && (
                      <div className="text-[11px] text-foreground-subtle">
                        {t('pipeline.clusterAutoTuneTab.fpsKeptFree', {
                          fps: d.chosen.fps,
                          percent: Math.round(plan.headroom * 100),
                        })}
                        <div>{latencySourceText(d.chosen.source)}</div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {d.chosen === null ? (
                      <span className="text-foreground-subtle">{t('common.unchanged')}</span>
                    ) : change !== null && change.before !== change.after ? (
                      <span>
                        <span className="text-foreground-subtle">
                          {change.before ?? t('common.defaultWord')}
                        </span>
                        {' → '}
                        <span className="font-medium text-foreground">{change.after}</span>
                      </span>
                    ) : (
                      <span className="text-foreground">{d.chosen.modelId}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-foreground-muted">
                    {d.reasons.map((r, i) => (
                      <div key={i}>{reasonText(r)}</div>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The full list of writes, shown in the confirmation. */
function ChangeList({
  plan,
  nodeName,
}: {
  readonly plan: AutoTunePlan
  readonly nodeName: (nodeId: string) => string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="auto-tune-change-list">
      <div>
        <div className={TEXT_SECTION_LABEL}>
          {t('pipeline.clusterAutoTuneTab.nodeSettings', 'Node settings')}
        </div>
        {plan.nodeChanges.length === 0 ? (
          <div className="text-foreground-subtle">
            {t('pipeline.clusterAutoTuneTab.noChange', 'No change.')}
          </div>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {plan.nodeChanges.flatMap((c) => [
              ...c.modelPins.map((p) => (
                <li key={`${c.nodeId}/${c.deviceKey}/${p.stepId}/pin`}>
                  <span className="font-mono">
                    {nodeName(c.nodeId)} · {c.deviceKey}
                  </span>{' '}
                  — {p.stepId}: {p.before ?? t('pipeline.clusterAutoTuneTab.defaultModel')} →{' '}
                  {p.after ?? t('pipeline.clusterAutoTuneTab.stepDefault', 'step default')}
                </li>
              )),
              ...c.thresholds.map((th) => (
                <li key={`${c.nodeId}/${c.deviceKey}/${th.stepId}/thr`}>
                  <span className="font-mono">
                    {nodeName(c.nodeId)} · {c.deviceKey}
                  </span>{' '}
                  —{' '}
                  {t('pipeline.clusterAutoTuneTab.thresholdReset', {
                    step: th.stepId,
                    keys: th.keys.join(', '),
                  })}
                </li>
              )),
            ])}
          </ul>
        )}
      </div>
    </div>
  )
}

function ApplyResult({ result }: { readonly result: AutoTuneApplyResult }) {
  const { t } = useTranslation()
  if (result.kind === 'refused') {
    return (
      <div className="text-xs text-warning">
        {t(
          'pipeline.clusterAutoTuneTab.anotherApplyIsAlreadyRunning',
          'Another apply is already running.',
        )}
      </div>
    )
  }
  if (result.kind === 'stale') {
    return (
      <div className="text-xs text-warning">
        {t(
          'pipeline.clusterAutoTuneTab.theConfigurationChangedSinceThe',
          'The configuration changed since the plan was shown. Review the updated plan below and apply again.',
        )}
      </div>
    )
  }
  return (
    <ul className="text-xs" data-testid="auto-tune-result">
      {result.kind === 'aborted' && (
        <li className="text-danger">
          {t(
            'pipeline.clusterAutoTuneTab.aModelCouldNotBe',
            'A model could not be downloaded: nothing was changed.',
          )}
        </li>
      )}
      {result.phases.map((p) => (
        <li key={p.phase} className={p.ok ? 'text-foreground-muted' : 'text-danger'}>
          {p.ok ? '✓' : '✗'} {p.phase}: {p.detail}
        </li>
      ))}
    </ul>
  )
}

export function ClusterAutoTuneTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [headroom, setHeadroom] = useState<Headroom>(0.4)
  const [minSessionsPerDevice, setMinSessions] = useState<number>(DEFAULT_MIN_SESSIONS_PER_DEVICE)
  const [requested, setRequested] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState<AutoTuneApplyResult | null>(null)
  const { nodes } = useClusterNodes()
  const nodeName = useMemo(() => nodeNamer(nodes), [nodes])

  const planQuery = usePipelineOrchestratorPlanAutoTune(
    { headroom, minSessionsPerDevice },
    { enabled: requested, refetchOnWindowFocus: false },
  )
  const apply = usePipelineOrchestratorApplyAutoTune({
    onSuccess: (res) => {
      setResult(res)
      setConfirmOpen(false)
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getNodeInferenceDevices']],
      })
      if (res.kind === 'applied') void planQuery.refetch()
    },
  })
  const plan = result?.kind === 'stale' ? result.plan : planQuery.data
  const counts = plan !== undefined ? planCounts(plan) : null

  return (
    <div className="flex flex-col gap-3" data-testid="cluster-auto-tune">
      <section className={SECTION_CARD}>
        <header className={`${SECTION_HEADER} flex flex-wrap items-center gap-2`}>
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden />
          <h3 className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>
            {t('pipeline.clusterAutoTuneTab.autoTune', 'Auto tune')}
          </h3>
        </header>
        <div className="flex flex-col gap-2 px-3 py-2 text-xs text-foreground-muted">
          <p>
            {t(
              'pipeline.clusterAutoTuneTab.picksForEveryAcceleratorThe',
              "Picks, for every accelerator, the most accurate YOLOv9 detector that still carries at least the chosen number of cameras at once, from the node's hardware and measured speeds. Nothing is measured or estimated about your cameras' activity. Applying it sets those models on the accelerators and clears their threshold overrides, so each model runs its own default thresholds. Cameras carry no model or threshold of their own. Enabled steps, devices, pins, recording, notifications, zones and rules are not touched. There is no undo.",
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="whitespace-nowrap">
                {t('pipeline.clusterAutoTuneTab.keepFree', 'Keep free')}
              </span>
              <Select
                aria-label={t(
                  'pipeline.clusterAutoTuneTab.shareOfEachAcceleratorKept',
                  'Share of each accelerator kept free',
                )}
                value={String(headroom)}
                options={HEADROOMS.map((h) => ({
                  value: String(h),
                  label: t(
                    'pipeline.clusterAutoTuneTab.ofEachAccelerator',
                    '{{value1}}% of each accelerator',
                    { value1: Math.round(h * 100) },
                  ),
                }))}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (isHeadroom(v)) setHeadroom(v)
                }}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="whitespace-nowrap">
                {t('pipeline.clusterAutoTuneTab.atLeast', 'At least')}
              </span>
              <Select
                aria-label={t(
                  'pipeline.clusterAutoTuneTab.minimumParallelSessionsPerDevice',
                  'Minimum parallel sessions per device',
                )}
                value={String(minSessionsPerDevice)}
                options={MIN_SESSIONS.map((n) => ({
                  value: String(n),
                  label: t('pipeline.clusterAutoTuneTab.camerasAtOnce', { count: n }),
                }))}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (MIN_SESSIONS.some((n) => n === v)) setMinSessions(v)
                }}
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setResult(null)
                setRequested(true)
                if (requested) void planQuery.refetch()
              }}
            >
              {planQuery.isFetching
                ? t('pipeline.clusterAutoTuneTab.computing', 'Computing…')
                : plan === undefined
                  ? t('pipeline.clusterAutoTuneTab.computePlan', 'Compute plan')
                  : t('pipeline.clusterAutoTuneTab.recompute', 'Recompute')}
            </Button>
            {plan !== undefined && (
              <Button size="sm" disabled={planIsNoop(plan)} onClick={() => setConfirmOpen(true)}>
                {t('pipeline.clusterAutoTuneTab.apply', 'Apply…')}
              </Button>
            )}
          </div>
          {planQuery.error !== null && <div className="text-danger">{planQuery.error.message}</div>}
          {result !== null && <ApplyResult result={result} />}
          {counts !== null && (
            <div className="text-[11px] text-foreground-subtle">
              {t('pipeline.clusterAutoTuneTab.planSummary', {
                modelChanges: counts.modelChanges,
                thresholdClears: counts.thresholdClears,
              })}
            </div>
          )}
        </div>
      </section>

      {plan?.warnings.map((w, i) => (
        <div
          key={i}
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {warningText(w, nodeName)}
        </div>
      ))}

      {plan?.nodes.map((node) => (
        <NodeCard key={node.nodeId} plan={plan} node={node} nodeName={nodeName} />
      ))}

      {plan !== undefined && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent width="lg" scroll="body">
            <DialogHeader>
              <DialogTitle>
                {t('pipeline.clusterAutoTuneTab.applyAutoTune', 'Apply auto tune?')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'pipeline.clusterAutoTuneTab.theseAreAllTheChanges',
                  'These are all the changes. Every override listed is removed and cannot be restored.',
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ChangeList plan={plan} nodeName={nodeName} />
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={apply.isPending}
                onClick={() =>
                  apply.mutate({ planHash: plan.planHash, headroom, minSessionsPerDevice })
                }
              >
                {apply.isPending
                  ? t('pipeline.clusterAutoTuneTab.applying', 'Applying…')
                  : t('common.apply', 'Apply')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
