import { useClusterNodes } from '@camstack/ui-library'
import { CapabilityBadges } from '../shared/CapabilityBadges'
import { Trans, useTranslation } from 'react-i18next'

interface AgentView {
  id: string
  name: string
  state: 'online' | 'offline' | 'degraded'
  capabilities: string[]
  activeTaskCount: number
}

function stateStyle(state: string): { dot: string; label: string } {
  switch (state) {
    case 'online':
      return { dot: 'bg-success', label: 'text-success' }
    case 'degraded':
      return { dot: 'bg-warning', label: 'text-warning' }
    case 'offline':
    default:
      return { dot: 'bg-foreground-subtle/40', label: 'text-foreground-subtle' }
  }
}

export function AgentLoad() {
  const { t } = useTranslation()
  // This widget needs the node ROSTER — id, name, up/down, capabilities — not
  // the cluster diagram, so it reads the roster hook (D317): bootstrap once,
  // then live off `cluster.topology-snapshot`.
  const { nodes: rawNodes, isLoading, isError } = useClusterNodes()

  const agents: readonly AgentView[] = rawNodes.map((n) => ({
    id: n.id,
    name: n.name,
    state: (n.isOnline ? 'online' : 'offline') as AgentView['state'],
    capabilities: n.addons.flatMap((a) => a.capabilities),
    activeTaskCount: 0,
  }))
  const onlineCount = agents.filter((a) => a.state === 'online').length
  const totalActive = agents.reduce((sum, a) => sum + (a.activeTaskCount ?? 0), 0)

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs font-semibold text-foreground-subtle uppercase tracking-wider mb-3">
        {t('metrics.agentLoad.agentLoad', 'Agent Load')}
      </h2>

      {isLoading && (
        <div className="text-xs text-foreground-subtle animate-pulse">
          {t('metrics.agentLoad.loading', 'Loading...')}
        </div>
      )}

      {isError && (
        <div className="text-xs text-danger">
          {t('metrics.agentLoad.failedToLoadData', 'Failed to load data')}
        </div>
      )}

      {!isLoading && !isError && agents.length === 0 && (
        <div className="text-xs text-foreground-subtle">
          {t('common.noData', 'No data available')}
        </div>
      )}

      {!isLoading && !isError && agents.length > 0 && (
        <>
          {/* Aggregate */}
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-border">
            <span className="text-xs text-foreground-subtle">
              <Trans
                i18nKey="common.onlineOfTotal"
                values={{ online: onlineCount, total: agents.length }}
                components={{ b: <span className="text-foreground font-semibold" /> }}
              />
            </span>
            <span className="text-xs text-foreground-subtle">
              <Trans
                i18nKey="metrics.agentLoad.activeTasks"
                count={totalActive}
                components={{ b: <span className="text-foreground font-semibold" /> }}
              />
            </span>
          </div>

          {/* Agent list */}
          <div className="space-y-3">
            {agents.map((a) => {
              const { dot, label: labelClass } = stateStyle(a.state)
              const isIdle = (a.activeTaskCount ?? 0) === 0
              return (
                <div key={a.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dot}`} />
                      <span className="text-xs text-foreground font-medium truncate">
                        {a.name ?? a.id}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[10px] font-medium ${labelClass}`}>{a.state}</span>
                      <span className="text-[10px] text-foreground-subtle tabular-nums bg-surface-hover rounded px-1.5 py-0.5">
                        {isIdle
                          ? t('metrics.agentLoad.idle')
                          : t('metrics.agentLoad.taskCount', { count: a.activeTaskCount })}
                      </span>
                    </div>
                  </div>
                  {a.capabilities && a.capabilities.length > 0 && (
                    <div className="pl-4">
                      <CapabilityBadges capabilities={a.capabilities} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
