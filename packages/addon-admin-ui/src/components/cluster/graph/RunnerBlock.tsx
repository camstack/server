import { useState } from 'react'
import { RotateCw, ScrollText, ChevronDown, ChevronRight } from 'lucide-react'
import { FloatingLogStream, useNodesRestartAddon, Button } from '@camstack/ui-library'
import { formatBytes } from '../../../lib/format-size'
import type { RunnerBlock as RunnerBlockData } from './build-cluster-graph'
import { useTranslation } from 'react-i18next'

export interface RunnerBlockProps {
  readonly runner: RunnerBlockData
  readonly nodeId: string
  readonly expanded: boolean
  /** I3: caller passes the pid; RunnerBlock calls onToggleCaps(pid) to avoid per-render lambdas. */
  readonly pid: number
  readonly onToggleCaps: (pid: number) => void
}

function statusDotClass(state: string): string {
  if (state === 'running' || state === 'online') {
    return 'bg-success'
  }
  if (state === 'crashed' || state === 'failed') {
    return 'bg-destructive'
  }
  return 'bg-muted-foreground'
}

export function RunnerBlock({ runner, nodeId, expanded, pid, onToggleCaps }: RunnerBlockProps) {
  const { t } = useTranslation()
  const [showLog, setShowLog] = useState(false)
  const restart = useNodesRestartAddon()

  function handleRestart(): void {
    void restart.mutateAsync({ nodeId, addonId: runner.addonId })
  }

  function handleLogsClick(): void {
    setShowLog((prev) => !prev)
  }

  return (
    <div className="border border-border rounded-md px-2 py-1.5 text-xs space-y-1">
      {/* Top row: status dot + name + cpu + mem + actions */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`shrink-0 h-1.5 w-1.5 rounded-full ${statusDotClass(runner.state)}`}
          aria-label={`status: ${runner.state}`}
        />
        <span className="font-medium truncate flex-1 min-w-0">{runner.name}</span>
        <span className="shrink-0 text-muted-foreground">{runner.cpu.toFixed(1)}%</span>
        <span className="shrink-0 text-muted-foreground">{formatBytes(runner.mem)}</span>
        <Button
          variant="unstyled"
          type="button"
          aria-label={`caps: ${runner.caps.length}`}
          onClick={() => onToggleCaps(pid)}
          className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground hover:bg-muted/80"
        >
          {expanded ? (
            <ChevronDown className="h-2.5 w-2.5" aria-hidden />
          ) : (
            <ChevronRight className="h-2.5 w-2.5" aria-hidden />
          )}
          <span>caps: {runner.caps.length}</span>
        </Button>
        <Button
          variant="unstyled"
          type="button"
          aria-label={t('graph.runnerBlock.restartAddon', 'Restart addon')}
          onClick={handleRestart}
          className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <RotateCw className="h-3 w-3" />
        </Button>
        <Button
          variant="unstyled"
          type="button"
          aria-label={t('graph.runnerBlock.logs', 'Logs')}
          onClick={handleLogsClick}
          className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <ScrollText className="h-3 w-3" />
        </Button>
      </div>

      {/* Caps list (inline progressive disclosure) */}
      {expanded && runner.caps.length > 0 && (
        <ul className="pl-3 space-y-0.5">
          {runner.caps.map((cap) => (
            <li key={`${cap.name}\0${cap.addonId}`} className="text-muted-foreground">
              <span className="text-foreground">{cap.name}</span>
              {' · '}
              <span>{cap.addonId}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Floating log stream (local show/hide state) */}
      {showLog && (
        <FloatingLogStream
          addonId={runner.addonId}
          agentId={nodeId}
          showScope
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  )
}
