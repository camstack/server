/**
 * Per-node Warm instances tab — lists every inference engine (runtime/
 * backend/device combo) currently resident in the node's RAM. Two
 * categories surface here:
 *
 *  - `runtime`     — the main camera-serving engine. Stays loaded as
 *                    long as cameras dispatch through it. No idle TTL.
 *  - `device-pool` — a concurrent per-accelerator pool (NPU / iGPU /
 *                    Coral) running beside the runtime engine.
 *
 * There is no third, benchmark-owned kind any more: the benchmark's engine
 * override and its warm cache were removed (D646) — a benchmark names a
 * device pool by `deviceKey` instead.
 *
 * Each row exposes the underlying Python pool pid (when applicable) and
 * a kill action that disposes the factory immediately. `runtime` engines
 * re-spin on the next frame.
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { PipelineEngineChoice } from '@dominevo/types'

import { useEventInvalidation } from '../../../hooks/useEventInvalidation'
import {
  Button,
  DataTable,
  ErrorBox,
  useEventStreamLatest,
  useEventStreamMap,
  usePipelineExecutorKillEngine,
  usePipelineExecutorListLoadedEngines,
  usePipelineRunnerGetLocalCameras,
  useConfirm,
} from '@dominevo/ui-library'
import { Zap, Trash2, Cpu, Layers } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

function formatIdle(idleMs: number, ttlMs: number): string {
  const remaining = Math.max(0, ttlMs - idleMs)
  const idle = Math.floor(idleMs / 1000)
  const left = Math.floor(remaining / 1000)
  return i18n.t('pipeline.nodeEnginesTab.idleLeft', { idle, left })
}

interface NodeEnginesTabProps {
  readonly nodeId: string
  readonly refreshToken: number
}

export function NodeEnginesTab({ nodeId, refreshToken: _refreshToken }: NodeEnginesTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const killEngineMutation = usePipelineExecutorKillEngine({
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelineExecutor', 'listLoadedEngines'] })
    },
  })

  // Engine inventory: bootstrap from a one-shot tRPC query so the table
  // renders immediately on tab mount, then live-update from the
  // `pipeline.engine-metrics-snapshot` event stream. The snapshot
  // emitter dedups identical payloads (only changes + a 60s heartbeat),
  // so a subscriber that mounts mid-cycle would otherwise wait up to a
  // full minute for the first payload — visible to the operator as a
  // permanent "Loading…" row even though the executor really is empty.
  const { data: bootstrapEngines } = usePipelineExecutorListLoadedEngines({ nodeId })
  const engineSnapshot = useEventStreamLatest<{
    nodeId: string
    engines: ReadonlyArray<{
      engineKey: string
      engine: PipelineEngineChoice
      modelsLoaded: readonly string[]
      inUseByCameras: readonly number[]
      kind: 'runtime' | 'device-pool'
      poolPid: number | null
      idleMs: number | null
      idleTtlMs: number | null
    }>
    timestamp: number
  }>('pipeline.engine-metrics-snapshot', (data) => data.nodeId === nodeId)
  // Live-stream wins once it lands; before that, fall back to the
  // bootstrap query. `engines === null` means we genuinely have no
  // data yet (query pending AND no event); `[]` means executor empty.
  const engines: ReadonlyArray<{
    engineKey: string
    engine: PipelineEngineChoice
    modelsLoaded: readonly string[]
    inUseByCameras: readonly number[]
    kind: 'runtime' | 'device-pool'
    poolPid: number | null
    idleMs: number | null
    idleTtlMs: number | null
  }> | null =
    engineSnapshot?.engines ??
    ((bootstrapEngines ?? null) as ReadonlyArray<{
      engineKey: string
      engine: PipelineEngineChoice
      modelsLoaded: readonly string[]
      inUseByCameras: readonly number[]
      kind: 'runtime' | 'device-pool'
      poolPid: number | null
      idleMs: number | null
      idleTtlMs: number | null
    }> | null)
  const isLoading = engines === null

  // Local-cameras still polled (slow) — attach/detach events trigger
  // invalidation. There's no per-node "attached cameras" snapshot today
  // so this stays a query-driven cache.
  useEventInvalidation(
    ['pipelineRunner', 'getLocalCameras'],
    ['pipeline.camera-assigned', 'pipeline.camera-unassigned'],
  )

  const { data: attachedCameras } = usePipelineRunnerGetLocalCameras({ nodeId })

  // Aggregate active-camera count from the per-camera metrics
  // snapshot stream. `useEventStreamMap` keeps the latest payload per
  // deviceId so we can count cameras whose phase is currently
  // `active` without querying the runner.
  const { values: perCameraSnapshots } = useEventStreamMap<
    { deviceId: number; nodeId: string; metrics: { phase: string } },
    number
  >(
    'pipeline.camera-metrics-snapshot',
    (data) => data.deviceId,
    (data) => data.nodeId === nodeId,
  )
  const activeCount = useMemo(
    () => perCameraSnapshots.filter((s) => s.metrics.phase === 'active').length,
    [perCameraSnapshots],
  )

  const handleKill = (engine: PipelineEngineChoice): void => {
    const camsOnNode = attachedCameras ?? []
    if (camsOnNode.length === 0) {
      killEngineMutation.mutate({ nodeId, engine, force: false })
      return
    }
    void (async () => {
      const ok = await confirm({
        title: t('pipeline.nodeEnginesTab.killEngine', 'Kill engine'),
        message:
          `${String(camsOnNode.length)} camera(s) are dispatching through this engine. ` +
          'Killing it drops their in-flight work and forces a respawn on the next frame.',
        confirmLabel: t('pipeline.nodeEnginesTab.killEngine', 'Kill engine'),
        variant: 'danger',
      })
      if (!ok) return
      killEngineMutation.mutate({ nodeId, engine, force: true })
    })()
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t(
            'pipeline.nodeEnginesTab.inferenceEnginesOnThisNode',
            'Inference engines on this node',
          )}
        </h3>
        <p className="text-[11px] text-foreground-subtle">
          {t('pipeline.nodeEnginesTab.summary', {
            engines: (engines ?? []).length,
            cameras: (attachedCameras ?? []).length,
            active: activeCount,
          })}
        </p>
      </div>

      <DataTable
        minWidthPx={640}
        rows={isLoading ? [] : (engines ?? [])}
        rowKey={(e) => e.engineKey}
        rowClassName={(e) => (e.kind === 'device-pool' ? 'bg-primary/[0.05]' : undefined)}
        emptyMessage={
          isLoading
            ? t('common.loading', 'Loading…')
            : t(
                'pipeline.nodeEnginesTab.noEnginesResidentTheFactory',
                'No engines resident — the factory spins up on the first pipeline run.',
              )
        }
        columns={[
          {
            mobile: 'keep',
            key: 'kind',
            header: t('pipeline.nodeEnginesTab.kind', 'Kind'),
            render: (e) => {
              const isPool = e.kind === 'device-pool'
              return (
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                    isPool ? 'bg-primary/15 text-primary' : 'bg-success/15 text-success'
                  }`}
                >
                  {isPool ? <Layers className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
                  {isPool
                    ? t('pipeline.nodeEnginesTab.pool')
                    : t('pipeline.nodeEnginesTab.runtime')}
                </span>
              )
            },
          },
          {
            mobile: 'primary',
            key: 'engine',
            header: t('pipeline.nodeEnginesTab.runtimeBackendDevice', 'Runtime / Backend / Device'),
            render: (e) => (
              <span className="inline-flex items-center gap-1 text-[11px] text-info">
                <Zap className="h-3 w-3 shrink-0" />
                {e.engine.runtime}/{e.engine.backend}
                {e.engine.device ? `/${e.engine.device}` : ''}
                {e.engine.format ? ` · ${e.engine.format}` : ''}
              </span>
            ),
          },
          {
            mobile: 'detail',
            key: 'models',
            header: t('pipeline.nodeEnginesTab.models', 'Models'),
            nowrap: false,
            render: (e) =>
              e.modelsLoaded.length === 0 ? (
                <span className="text-foreground-subtle text-[11px]">—</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {e.modelsLoaded.map((m) => (
                    <span
                      key={m}
                      className="inline-block rounded bg-surface px-1.5 py-0.5 text-[10px] font-mono text-foreground-subtle"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              ),
          },
          {
            mobile: 'detail',
            key: 'poolPid',
            header: t('pipeline.nodeEnginesTab.poolPid', 'Pool PID'),
            align: 'right',
            render: (e) => <span className="font-mono text-foreground">{e.poolPid ?? '—'}</span>,
          },
          {
            mobile: 'hidden',
            key: 'autoKill',
            header: t('pipeline.nodeEnginesTab.autoKill', 'Auto-kill'),
            align: 'right',
            render: (e) =>
              e.idleMs !== null && e.idleTtlMs !== null ? (
                <span className="text-[11px] text-foreground-subtle">
                  {formatIdle(e.idleMs, e.idleTtlMs)}
                </span>
              ) : (
                <span className="text-[11px] text-foreground-subtle/50">{t('common.never')}</span>
              ),
          },
          {
            mobile: 'hidden',
            key: 'inUse',
            header: t('pipeline.nodeEnginesTab.inUse', 'In use'),
            align: 'right',
            render: () => <span className="text-foreground">{(attachedCameras ?? []).length}</span>,
          },
          {
            mobile: 'keep',
            key: 'actions',
            header: '',
            align: 'right',
            width: 'w-20',
            render: (e) =>
              e.kind === 'device-pool' ? (
                // Device pools are reaper-managed (idle TTL) — not manually
                // killable via the default-engine kill path.
                <span className="text-[11px] text-foreground-subtle">{t('common.auto')}</span>
              ) : (
                // The app's destructive row action: a ghost Button in the
                // danger colour; the confirm (when cameras use it) is red.
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={killEngineMutation.isPending}
                  onClick={() => handleKill(e.engine)}
                  className="text-danger hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('pipeline.nodeEnginesTab.kill', 'Kill')}
                </Button>
              ),
          },
        ]}
      />

      <div className="text-[10px] text-foreground-subtle leading-relaxed">
        <Trans
          i18nKey="pipeline.nodeEnginesTab.legend"
          components={{ strong: <strong className="text-foreground" /> }}
        />
      </div>

      {killEngineMutation.isError && (
        <ErrorBox
          message={t('pipeline.nodeEnginesTab.killFailed', {
            message:
              killEngineMutation.error instanceof Error
                ? killEngineMutation.error.message
                : t('common.unknownError'),
          })}
        />
      )}
    </div>
  )
}
