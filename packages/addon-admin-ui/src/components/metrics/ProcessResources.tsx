import { useClusterTopology } from '@camstack/ui-library'
import { formatBytes } from '../../lib/format-size'
import { Trans, useTranslation } from 'react-i18next'

interface ProcessEntry {
  id: string
  label: string
  state: string
  stats?: { cpu: number; memory: number; uptime: number }
  restartCount: number
}

function formatMemoryOptional(bytes?: number): string {
  if (bytes == null) return '—'
  return formatBytes(bytes)
}

function formatUptime(ms?: number): string {
  if (ms == null || ms <= 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return 'text-success'
    case 'stopped':
      return 'text-foreground-subtle'
    case 'crashed':
    case 'error':
      return 'text-danger'
    case 'starting':
      return 'text-warning'
    default:
      return 'text-foreground-subtle'
  }
}

export function ProcessResources() {
  const { t } = useTranslation()
  // This widget renders every runner subprocess on every node, so it genuinely
  // wants the diagram. It gets it through the one hook that bootstraps once and
  // then lives off the pushed snapshot, instead of re-implementing that pattern
  // here (D317) — the local `useEventStreamLatest` copy went with it.
  const { nodes: rawNodes, isLoading, isError } = useClusterTopology()

  // Flatten node processes into a flat list for this widget
  const processes: ProcessEntry[] = (rawNodes ?? []).flatMap((node) => {
    const procs = node.processes ?? []
    return procs.map((p) => ({
      id: `${node.id}/${p.name}`,
      label: p.name,
      state: p.state,
      stats: {
        cpu: p.cpuPercent,
        memory: p.memoryRss,
        uptime: p.uptimeSeconds * 1000,
      },
      restartCount: 0,
    }))
  })
  const runningCount = processes.filter((p) => p.state === 'running').length

  const totalCpu = processes.reduce((sum, p) => sum + (p.stats?.cpu ?? 0), 0)
  const totalMemory = processes.reduce((sum, p) => sum + (p.stats?.memory ?? 0), 0)

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs font-semibold text-foreground-subtle uppercase tracking-wider mb-3">
        {t('metrics.processResources.processResources', 'Process Resources')}
      </h2>

      {isLoading && (
        <div className="text-xs text-foreground-subtle animate-pulse">
          {t('metrics.processResources.loading', 'Loading...')}
        </div>
      )}

      {isError && (
        <div className="text-xs text-danger">
          {t('metrics.processResources.failedToLoadData', 'Failed to load data')}
        </div>
      )}

      {!isLoading && !isError && processes.length === 0 && (
        <div className="text-xs text-foreground-subtle">
          {t('common.noData', 'No data available')}
        </div>
      )}

      {!isLoading && !isError && processes.length > 0 && (
        <>
          {/* System totals */}
          <div className="flex items-center gap-4 mb-3 pb-3 border-b border-border">
            <span className="text-xs text-foreground-subtle">
              <Trans
                i18nKey="common.runningOfTotal"
                values={{ running: runningCount, total: processes.length }}
                components={{ b: <span className="text-foreground font-semibold" /> }}
              />
            </span>
            <span className="text-xs text-foreground-subtle">
              {t('metrics.processResources.cpu', 'CPU:')}{' '}
              <span className="text-foreground font-semibold tabular-nums">
                {totalCpu.toFixed(1)}%
              </span>
            </span>
            <span className="text-xs text-foreground-subtle">
              {t('metrics.processResources.mem', 'Mem:')}{' '}
              <span className="text-foreground font-semibold tabular-nums">
                {formatMemoryOptional(totalMemory)}
              </span>
            </span>
          </div>

          {/* Process table */}
          <div className="space-y-1.5">
            {/* Header */}
            <div className="grid grid-cols-[1fr_4rem_5rem_4rem_3rem] gap-2 text-[10px] font-medium text-foreground-subtle uppercase tracking-wider pb-1">
              <span>{t('metrics.processResources.process', 'Process')}</span>
              <span className="text-right">CPU</span>
              <span className="text-right">{t('metrics.processResources.memory', 'Memory')}</span>
              <span className="text-right">{t('metrics.processResources.uptime', 'Uptime')}</span>
              <span className="text-right">{t('metrics.processResources.rst', 'Rst')}</span>
            </div>

            {processes.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[1fr_4rem_5rem_4rem_3rem] gap-2 text-xs items-center"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[10px] font-semibold ${stateColor(p.state)}`}>●</span>
                  <span className="text-foreground truncate">{p.label ?? p.id}</span>
                </div>
                <span className="tabular-nums text-foreground-subtle text-right">
                  {p.stats?.cpu != null ? `${p.stats.cpu.toFixed(1)}%` : '—'}
                </span>
                <span className="tabular-nums text-foreground-subtle text-right">
                  {formatMemoryOptional(p.stats?.memory)}
                </span>
                <span className="tabular-nums text-foreground-subtle text-right">
                  {formatUptime(p.stats?.uptime)}
                </span>
                <span className="tabular-nums text-foreground-subtle text-right">
                  {p.restartCount ?? 0}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
