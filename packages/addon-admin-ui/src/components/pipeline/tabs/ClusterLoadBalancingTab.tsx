/**
 * Cluster → Load balancing (D748) — HOW MUCH detection each node and each of
 * its accelerators carries, in one place:
 *
 *  - Placement policy: the `load` section of the orchestrator settings — the
 *    `sessionPlacement` toggle (least-loaded | honour shares) and the reactive
 *    policies (node stress, low-fps relocate). Rendered here and nowhere else.
 *  - Live load and the per-node reading: target share vs the share placement
 *    actually held over the last hour, peak, yields.
 *  - Node shares, from one of three sources (`setShareSource`, D755):
 *    Hardware (default) — computed by the system from each node's static
 *    capacity and shown read-only; Benchmark — the same from node benchmark
 *    results, each node without results falling back to Hardware and saying
 *    so; or Manual — one slider stack written in ONE `setLoadBalancingShares`
 *    call. Then the effective shares after a node or device that cannot take
 *    sessions gave its share away, and the per-node "max concurrent
 *    sessions" cap (advanced). No load is measured or estimated anywhere.
 *  - Suggest: the capacity behind the automatic shares, with advisory
 *    per-device caps; in manual it can be applied to the sliders on a click.
 *  - Accelerators: each node's devices — enablement, share, cap.
 *  - Stale device pins, each with a one-click clear (never cleared for you).
 *
 * Which camera runs where stays on Assignments; who holds a cluster role on
 * Roles & nodes.
 */
import type {
  CapacitySource,
  EffectiveShares,
  PlacementStats,
  SuggestSharesResult,
} from '@camstack/types'
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  LIST_ROW,
  SECTION_BODY,
  SectionCard,
  TEXT_HINT,
  useClusterNodes,
  useDeviceManagerListAll,
  usePipelineOrchestratorGetEffectiveShares,
  usePipelineOrchestratorGetPlacementStats,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorRebalance,
  usePipelineOrchestratorSetAgentMaxCameras,
  usePipelineOrchestratorSetLoadBalancingShares,
  usePipelineOrchestratorSetPipelineDevicePin,
  usePipelineOrchestratorSetShareSource,
  usePipelineOrchestratorSuggestShares,
} from '@camstack/ui-library'
import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Cpu, Lightbulb, PinOff, Scale, Sparkles, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cameraNamer } from '../assignments/assignment-rows'
import { LiveLoadPanel } from '../LiveLoadPanel'
import { NodeLoadOverview } from '../NodeLoadOverview'
import { effectiveCapabilitySettings } from '../lib/node-enablement'
import {
  benchmarkFallbackNote,
  capacityFallbackText,
  effectiveShareNote,
  SHARE_SOURCE_OPTIONS,
  shareSliderView,
  sharesWriteFromCommit,
  sharesWriteFromSuggestion,
  stalePinText,
  suggestedCapsByNode,
} from '../load-balancing/load-balancing-view-model'
import { invalidatePlacementQueries, readNumberObjectField } from '../placement-board/board-model'
import { NodeInferenceDevices } from '../placement-board/NodeInferenceDevices'
import { WeightSliderStack, type WeightSliderNode } from '../placement-board/WeightSliderStack'
import { useTranslation } from 'react-i18next'

/** The "actual" window of the share readout. */
const STATS_WINDOW_MS = 60 * 60 * 1000
const STATS_REFRESH_MS = 20_000
const DEFAULT_HEADROOM = 0.4

interface ShareNode extends WeightSliderNode {
  readonly isOnline: boolean
  readonly maxCameras: number | null
}

interface ClusterLoadBalancingTabProps {
  readonly refreshToken: number
  readonly onOpenAutoTune: () => void
}

export function ClusterLoadBalancingTab({
  refreshToken,
  onOpenAutoTune,
}: ClusterLoadBalancingTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { nodes } = useClusterNodes()
  const settingsQuery = usePipelineOrchestratorListAgentSettings(undefined)
  const camerasQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const statsQuery = usePipelineOrchestratorGetPlacementStats(
    { windowMs: STATS_WINDOW_MS },
    { refetchInterval: STATS_REFRESH_MS, placeholderData: keepPreviousData },
  )
  const stats: PlacementStats | undefined = statsQuery.data
  const effectiveQuery = usePipelineOrchestratorGetEffectiveShares(undefined, {
    refetchInterval: STATS_REFRESH_MS,
    placeholderData: keepPreviousData,
  })
  const effective: EffectiveShares | undefined = effectiveQuery.data

  const invalidate = (): void => {
    invalidatePlacementQueries(queryClient)
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getNodeInferenceDevices']],
    })
  }
  const setShares = usePipelineOrchestratorSetLoadBalancingShares({ onSuccess: invalidate })
  const setSource = usePipelineOrchestratorSetShareSource({
    onSuccess: () => {
      invalidate()
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getEffectiveShares']],
      })
    },
  })
  const setMaxCameras = usePipelineOrchestratorSetAgentMaxCameras({ onSuccess: invalidate })
  const rebalance = usePipelineOrchestratorRebalance()

  const [suggestRequested, setSuggestRequested] = useState(false)
  const source = effective?.source
  const suggestSource: CapacitySource = source === 'benchmark' ? 'benchmark' : 'hardware'
  const suggestQuery = usePipelineOrchestratorSuggestShares(
    { headroom: DEFAULT_HEADROOM, source: suggestSource },
    { enabled: suggestRequested, staleTime: Number.POSITIVE_INFINITY },
  )
  const suggestion: SuggestSharesResult | undefined = suggestQuery.data

  const shareNodes = useMemo<readonly ShareNode[]>(() => {
    const byNode = new Map((settingsQuery.data ?? []).map((row) => [row.nodeId, row.settings]))
    return nodes
      .filter((node) => effectiveCapabilitySettings(byNode.get(node.id)).pipeline)
      .map((node) => {
        const settings = byNode.get(node.id)
        return {
          id: node.id,
          name: node.name,
          isOnline: node.isOnline,
          weight: readNumberObjectField(settings, 'detectWeight') ?? 1,
          maxCameras: readNumberObjectField(settings, 'maxCameras'),
        }
      })
  }, [nodes, settingsQuery.data])

  const nameOf = (nodeId: string): string => nodes.find((n) => n.id === nodeId)?.name ?? nodeId
  const cameraName = cameraNamer((camerasQuery.data ?? []).map((c) => ({ id: c.id, name: c.name })))
  const caps = suggestion ? suggestedCapsByNode(suggestion) : undefined
  const sliders = shareSliderView(shareNodes, effective)
  const isAuto = source !== 'manual'
  const sharesAutomatic =
    effective !== undefined && effective.source !== 'manual' && !effective.autoPending
  const nodeShare = (nodeId: string) => effective?.nodes.find((n) => n.nodeId === nodeId)
  const nodePlaced = (nodeId: string) => stats?.nodes.find((n) => n.nodeId === nodeId)
  const redistribution = effective ? effectiveShareNote(effective, nameOf) : null
  const fallbackNote = effective ? benchmarkFallbackNote(effective, nameOf) : null
  const sourceHint = SHARE_SOURCE_OPTIONS.find((o) => o.value === source)?.hint

  return (
    <div className="space-y-3 sm:space-y-4">
      <LiveLoadPanel refreshToken={refreshToken} />
      <NodeLoadOverview
        stats={stats}
        showAccelerators={false}
        {...(effective !== undefined && effective.source !== 'manual' && !effective.autoPending
          ? {
              targetWeights: Object.fromEntries(
                effective.nodes.map((n) => [n.nodeId, n.configuredPct]),
              ),
            }
          : {})}
      />

      <SectionCard
        headingId="load-balancing-node-shares"
        title={t('pipeline.clusterLoadBalancingTab.nodeShares', 'Node shares')}
        icon={Scale}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="radiogroup"
              aria-label={t('pipeline.clusterLoadBalancingTab.shareSource', 'Share source')}
              className="flex items-center gap-1"
            >
              {SHARE_SOURCE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  role="radio"
                  aria-checked={source === option.value}
                  variant={source === option.value ? 'primary' : 'outline'}
                  size="sm"
                  title={option.hint}
                  disabled={setSource.isPending || effective === undefined}
                  onClick={() => {
                    if (source !== option.value) setSource.mutate({ source: option.value })
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSuggestRequested(true)
                if (suggestRequested) void suggestQuery.refetch()
              }}
              disabled={suggestQuery.isFetching}
            >
              <Lightbulb className="h-3.5 w-3.5" />
              {suggestQuery.isFetching
                ? t('pipeline.clusterLoadBalancingTab.suggesting', 'Suggesting…')
                : suggestSource === 'benchmark'
                  ? t(
                      'pipeline.clusterLoadBalancingTab.suggestFromBenchmark',
                      'Suggest from benchmark',
                    )
                  : t(
                      'pipeline.clusterLoadBalancingTab.suggestFromHardware',
                      'Suggest from hardware',
                    )}
            </Button>
            <Button variant="ghost" size="sm" onClick={onOpenAutoTune}>
              <Sparkles className="h-3.5 w-3.5" />
              {t('pipeline.clusterLoadBalancingTab.autoTune', 'Auto tune')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => rebalance.mutate(undefined)}
              disabled={rebalance.isPending}
              title={t(
                'pipeline.clusterLoadBalancingTab.moveStandingAlwaysOnCameras',
                'Move standing (always-on) cameras that are no longer on their best node. Pinned cameras never move; on-motion sessions are placed per session anyway.',
              )}
            >
              <Zap className="h-3.5 w-3.5" />
              {rebalance.isPending
                ? t('pipeline.clusterLoadBalancingTab.rebalancing', 'Rebalancing…')
                : t('pipeline.clusterLoadBalancingTab.rebalance', 'Rebalance')}
            </Button>
          </div>
        }
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          {sourceHint !== undefined && <p className={TEXT_HINT}>{sourceHint}</p>}
          {stats && (
            <p className={TEXT_HINT}>
              {t('pipeline.clusterLoadBalancingTab.policy', 'Policy:')}{' '}
              <Badge variant={stats.policy === 'share' ? 'info' : 'default'}>
                {stats.policy === 'share'
                  ? t('pipeline.clusterLoadBalancingTab.honourShares', 'honour shares')
                  : 'least-loaded'}
              </Badge>{' '}
              {` · ${t('pipeline.clusterLoadBalancingTab.clusterPeak', { count: stats.clusterPeakSessions })}`}
              {stats.policy === 'least-loaded' &&
                ` · ${t('pipeline.clusterLoadBalancingTab.leastLoadedNote')}`}
            </p>
          )}
          <WeightSliderStack
            nodes={sliders.nodes}
            pending={setShares.isPending}
            readOnly={sliders.readOnly}
            onCommitWeights={(entries) => setShares.mutate(sharesWriteFromCommit(entries))}
            weightLabel="Node share"
            {...(sliders.readOnly
              ? {
                  footnote: effective?.autoPending ? (
                    <>
                      {t(
                        'pipeline.clusterLoadBalancingTab.automaticSharesAreBeingComputed',
                        "Automatic shares are being computed from the cluster's measured capacity; the stored values are used meanwhile.",
                      )}
                    </>
                  ) : (
                    <>
                      {source === 'benchmark'
                        ? t(
                            'pipeline.clusterLoadBalancingTab.benchmarkEachNodeSShare',
                            "Benchmark: each node's share follows its measured capacity from node benchmark results (hardware capacity where it has none)",
                          )
                        : t(
                            'pipeline.clusterLoadBalancingTab.hardwareEachNodeSShare',
                            "Hardware: each node's share follows its capacity at its Auto tune model, from the measured speed of its hardware",
                          )}
                      {t(
                        'pipeline.clusterLoadBalancingTab.recomputedWheneverANodeOr',
                        ', recomputed whenever a node or accelerator is added, removed, switched on or off, or changes model',
                      )}
                      {effective?.computedAt != null && (
                        <span className="ml-1">
                          {t(
                            effective.trigger !== null
                              ? 'pipeline.clusterLoadBalancingTab.lastAtTrigger'
                              : 'pipeline.clusterLoadBalancingTab.lastAt',
                            {
                              time: new Date(effective.computedAt).toLocaleTimeString(),
                              trigger: effective.trigger ?? '',
                            },
                          )}
                        </span>
                      )}
                      .
                    </>
                  ),
                }
              : {})}
          />
          {redistribution !== null && <p className={TEXT_HINT}>{redistribution}</p>}
          {fallbackNote !== null && (
            <p className={TEXT_HINT} data-testid="benchmark-fallback-note">
              {fallbackNote}
            </p>
          )}
          {setSource.isError && (
            <ErrorBox
              message={t('pipeline.clusterLoadBalancingTab.switchFailed', {
                message:
                  setSource.error instanceof Error
                    ? setSource.error.message
                    : t('common.unknownError'),
              })}
            />
          )}
          {setShares.isError && (
            <ErrorBox
              message={t('pipeline.clusterLoadBalancingTab.saveFailed', {
                message:
                  setShares.error instanceof Error
                    ? setShares.error.message
                    : t('common.unknownError'),
              })}
            />
          )}
          <details className="rounded-md border border-border">
            <summary className={`${LIST_ROW} cursor-pointer text-xs text-foreground`}>
              {t(
                'pipeline.clusterLoadBalancingTab.maxConcurrentSessionsAdvanced',
                'Max concurrent sessions (advanced)',
              )}
            </summary>
            <ul className="divide-y divide-border border-t border-border">
              {shareNodes.map((node) => (
                <li key={node.id} className={`${LIST_ROW} flex items-center gap-2`}>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {node.name}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    placeholder="∞"
                    defaultValue={node.maxCameras ?? ''}
                    aria-label={t(
                      'pipeline.clusterLoadBalancingTab.maxConcurrentSessionsFor',
                      'Max concurrent sessions for {{name}}',
                      { name: node.name },
                    )}
                    className="w-20 text-right"
                    disabled={setMaxCameras.isPending}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const parsed = raw === '' ? null : Number.parseInt(raw, 10)
                      const next = parsed !== null && parsed > 0 ? parsed : null
                      if (next !== node.maxCameras) {
                        setMaxCameras.mutate({ agentNodeId: node.id, maxCameras: next })
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
            <p className={`${LIST_ROW} ${TEXT_HINT} border-t border-border`}>
              {t(
                'pipeline.clusterLoadBalancingTab.aHardCapOnThe',
                'A hard cap on the sessions a node runs at once (always-on cameras count too). A node at its cap is never chosen; under shares its turn goes to a free node. Empty = unlimited.',
              )}
            </p>
          </details>
        </div>
      </SectionCard>

      {suggestQuery.isError && (
        <ErrorBox
          message={t('pipeline.clusterLoadBalancingTab.suggestionFailed', {
            message:
              suggestQuery.error instanceof Error
                ? suggestQuery.error.message
                : t('common.unknownError'),
          })}
        />
      )}
      {suggestion && (
        <SuggestionCard
          suggestion={suggestion}
          nameOf={nameOf}
          pending={setShares.isPending}
          {...(isAuto
            ? {}
            : { onApply: () => setShares.mutate(sharesWriteFromSuggestion(suggestion)) })}
        />
      )}

      <SectionCard
        headingId="load-balancing-accelerators"
        title={t('pipeline.clusterLoadBalancingTab.accelerators', 'Accelerators')}
        icon={Cpu}
      >
        <div className={`${SECTION_BODY} space-y-2`}>
          {shareNodes.length === 0 ? (
            <EmptyState
              title={t(
                'pipeline.clusterLoadBalancingTab.noDetectCapableNodes',
                'No detect-capable nodes',
              )}
              description={t(
                'pipeline.clusterLoadBalancingTab.enableDetectionOnANode',
                'Enable detection on a node in Roles & nodes to configure its accelerators.',
              )}
            />
          ) : (
            shareNodes.map((node) => (
              <NodeInferenceDevices
                key={node.id}
                nodeId={node.id}
                nodeName={node.name}
                isOnline={node.isOnline}
                {...(caps?.[node.id] !== undefined ? { suggestedMaxSessions: caps[node.id] } : {})}
                sharesAutomatic={sharesAutomatic}
                {...(effective !== undefined ? { shareSource: effective.source } : {})}
                {...(nodeShare(node.id) !== undefined ? { share: nodeShare(node.id) } : {})}
                {...(nodePlaced(node.id) !== undefined ? { placed: nodePlaced(node.id) } : {})}
              />
            ))
          )}
        </div>
      </SectionCard>

      {stats !== undefined && stats.stalePins.length > 0 && (
        <StalePinsCard stats={stats} cameraName={cameraName} />
      )}
    </div>
  )
}

interface SuggestionCardProps {
  readonly suggestion: SuggestSharesResult
  readonly nameOf: (nodeId: string) => string
  readonly pending: boolean
  /** Absent under automatic shares — the system already applies them. */
  readonly onApply?: () => void
}

function SuggestionCard({ suggestion, nameOf, pending, onApply }: SuggestionCardProps) {
  const { t } = useTranslation()
  return (
    <SectionCard
      headingId="load-balancing-suggestion"
      title={
        suggestion.source === 'benchmark'
          ? t('pipeline.clusterLoadBalancingTab.suggestedFromBenchmark', 'Suggested from benchmark')
          : t('pipeline.clusterLoadBalancingTab.suggestedFromHardware', 'Suggested from hardware')
      }
      icon={Lightbulb}
      {...(onApply !== undefined
        ? {
            actions: (
              <Button size="sm" onClick={onApply} disabled={pending}>
                {t(
                  'pipeline.clusterLoadBalancingTab.applySuggestedShares',
                  'Apply suggested shares',
                )}
              </Button>
            ),
          }
        : {})}
    >
      <ul className="divide-y divide-border">
        {suggestion.nodes.map((node) => (
          <li key={node.nodeId} className={`${LIST_ROW} space-y-0.5`}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {nameOf(node.nodeId)}
              </span>
              <span className="tabular-nums text-foreground">
                {node.share === null ? t('common.skipped') : `${node.share}%`}
              </span>
            </div>
            <p className={TEXT_HINT}>
              {capacityFallbackText(node.capacityFallback) !== null
                ? `${capacityFallbackText(node.capacityFallback)} · `
                : ''}
              {node.skippedReason !== null
                ? t(
                    'pipeline.clusterLoadBalancingTab.notPartOfTheSuggestion',
                    'not part of the suggestion — {{skippedReason}}',
                    { skippedReason: node.skippedReason },
                  )
                : t(
                    'pipeline.clusterLoadBalancingTab.parallelSessions',
                    '≈ {{capacitySessions}} parallel sessions · {{value2}}',
                    {
                      capacitySessions: node.capacitySessions,
                      value2: node.devices
                        .map(
                          (d) =>
                            `${d.deviceKey} ${d.share}% (${d.modelId ?? '—'}${d.measured ? '' : ', estimated'}, cap ${d.suggestedMaxSessions ?? '—'})`,
                        )
                        .join(' · '),
                    },
                  )}
            </p>
          </li>
        ))}
      </ul>
      <p className={`${LIST_ROW} ${TEXT_HINT} border-t border-border`}>
        {t('pipeline.clusterLoadBalancingTab.sharesIntro', {
          fps: suggestion.cameraFps,
          headroom: Math.round(suggestion.headroom * 100),
          basis:
            suggestion.source === 'benchmark'
              ? t(
                  'pipeline.clusterLoadBalancingTab.measuredByNodeBenchmarksOr',
                  'measured by node benchmarks, or from the hardware table where a node has no results',
                )
              : t(
                  'pipeline.clusterLoadBalancingTab.atTheModelsAutoTune',
                  "at the models Auto tune picks (at least {{minSessionsPerDevice}} per accelerator), from the measured speed of each node's hardware",
                  { minSessionsPerDevice: suggestion.minSessionsPerDevice },
                ),
        })}{' '}
        {onApply !== undefined
          ? t(
              'pipeline.clusterLoadBalancingTab.applyingWritesTheNodeAnd',
              'Applying writes the node and accelerator shares; the caps are advisory — apply each from its accelerator row.',
            )
          : t(
              'pipeline.clusterLoadBalancingTab.automaticSharesAlreadyFollowThis',
              'Automatic shares already follow this; the caps are advisory — apply each from its accelerator row.',
            )}
      </p>
    </SectionCard>
  )
}

export function StalePinsCard({
  stats,
  cameraName,
}: {
  readonly stats: PlacementStats
  readonly cameraName: (deviceId: number) => string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const clearPin = usePipelineOrchestratorSetPipelineDevicePin({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getPlacementStats']],
      })
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getPipelineDevicePin']],
      })
    },
  })
  return (
    <SectionCard
      headingId="load-balancing-stale-pins"
      title={t('pipeline.clusterLoadBalancingTab.staleDevicePins', 'Stale device pins')}
      icon={PinOff}
    >
      <ul className="divide-y divide-border">
        {stats.stalePins.map((pin) => (
          <li key={pin.deviceId} className={`${LIST_ROW} flex items-center gap-2`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-foreground" title={cameraName(pin.deviceId)}>
                {cameraName(pin.deviceId)}
              </p>
              <p className={TEXT_HINT}>{stalePinText(pin)}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={clearPin.isPending}
              onClick={() => clearPin.mutate({ deviceId: pin.deviceId, deviceKey: 'auto' })}
            >
              {t('pipeline.clusterLoadBalancingTab.clearPin', 'Clear pin')}
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
