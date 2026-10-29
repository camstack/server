import { useState, useEffect, useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
import { formatLastSeen, useUiText } from '@camstack/ui-library'
import type { ClusterGraphNode } from './build-cluster-graph'
import { RunnerBlock } from './RunnerBlock'
import { lastSeenToMs } from '../../../lib/last-seen'
import { useTranslation } from 'react-i18next'

// I2: type alias satisfying the @xyflow/react Node<Data extends Record<string,unknown>> constraint
// via intersection — no blanket index signature on the named fields, still type-safe.
export type NodeBoxData = ClusterGraphNode & {
  /** Called when the user clicks the node header to open the table detail view. */
  readonly onOpenNodeDetail: (nodeId: string) => void
  /** I1: Expand-all signal value — true = expand, false = collapse. */
  readonly expandAllValue: boolean
  /** I1: Increments on every Expand-all / Collapse-all click to trigger the effect. */
  readonly expandAllNonce: number
} & Record<string, unknown>

/** Props shape accepted by NodeBox as a plain component (matches the RF NodeProps subset we use). */
export interface NodeBoxProps {
  readonly data: NodeBoxData
  readonly id: string
  readonly type: string
  readonly zIndex: number
  readonly isConnectable: boolean
  readonly positionAbsoluteX: number
  readonly positionAbsoluteY: number
  readonly dragging: boolean
  readonly selected: boolean
}

function onlineStatusClass(isOnline: boolean): string {
  return isOnline ? 'bg-success' : 'bg-muted-foreground'
}

export function NodeBox({ data }: NodeBoxProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  // Per-runner caps-expanded state: Set of pids that are expanded.
  const [expandedPids, setExpandedPids] = useState<ReadonlySet<number>>(new Set())

  // I3: stable callback — created once, not per-render.
  const toggleCaps = useCallback((pid: number): void => {
    setExpandedPids((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) {
        next.delete(pid)
      } else {
        next.add(pid)
      }
      return next
    })
  }, [])

  // I1: React to expand-all / collapse-all signals from ClusterGraphView.
  useEffect(() => {
    if (data.expandAllNonce === 0) return
    if (data.expandAllValue) {
      setExpandedPids(new Set(data.runners.map((r) => r.pid)))
    } else {
      setExpandedPids(new Set())
    }
  }, [data.expandAllNonce, data.expandAllValue, data.runners])

  const isOffline = !data.isOnline
  const relativeLastSeen = isOffline ? formatLastSeen(lastSeenToMs(data.lastSeen), uiText) : null
  const offlineLabel = relativeLastSeen !== null ? `offline · ${relativeLastSeen}` : 'offline'

  return (
    <div
      className={`border border-border rounded-xl bg-background shadow-md min-w-[280px] max-w-[360px] flex flex-col${isOffline ? ' opacity-50' : ''}`}
    >
      {/* C1: RF Handle components — required for edges to attach to this custom node. */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {/* Hub/Agent badge */}
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
          {data.isHub ? 'HUB' : 'AGENT'}
        </span>
        {/* Online dot */}
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${onlineStatusClass(data.isOnline)}`}
          aria-label={data.isOnline ? t('common.online') : t('common.offline')}
        />
        {/* Offline badge with relative last-seen */}
        {isOffline && (
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-destructive/10 text-destructive shrink-0"
            title={
              relativeLastSeen !== null
                ? t('graph.nodeBox.lastSeen', 'last seen {{relativeLastSeen}}', {
                    relativeLastSeen,
                  })
                : t('common.offline')
            }
          >
            {offlineLabel}
          </span>
        )}
        {/* Name + IP */}
        <span className="font-semibold text-sm truncate flex-1 min-w-0">{data.identity.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">{data.identity.ip}</span>
        {/* CPU + Mem */}
        <span className="text-xs text-muted-foreground shrink-0">{data.identity.cpu}%</span>
        <span className="text-xs text-muted-foreground shrink-0">
          {data.identity.mem === null ? t('cluster.memoryUnknown') : `${data.identity.mem}%`}
        </span>
        {/* Detail link button */}
        <button
          type="button"
          aria-label={t('graph.nodeBox.openNodeDetail', 'Open node detail')}
          onClick={() => data.onOpenNodeDetail(data.nodeId)}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline ml-1"
        >
          ↗
        </button>
      </div>

      {/* Body: runner list */}
      <div className="flex flex-col gap-1 p-2 max-h-96 overflow-auto">
        {data.runners.map((runner) => (
          <RunnerBlock
            key={runner.pid}
            runner={runner}
            nodeId={data.nodeId}
            expanded={expandedPids.has(runner.pid)}
            onToggleCaps={toggleCaps}
            pid={runner.pid}
          />
        ))}
        {data.runners.length === 0 && (
          <span className="text-xs text-muted-foreground px-1">
            {t('graph.nodeBox.noProcesses', 'No processes')}
          </span>
        )}
      </div>
    </div>
  )
}
