import { useState } from 'react'
import { Box, Server, RotateCw, ScrollText, Radio, ChevronDown, ChevronRight } from 'lucide-react'

import {
  LogStream,
  StatusBadge,
  type StatusBadgeStatus,
  useNodesRestartAddon,
  useNodesRestartProcess,
  useNodesSetProcessLogLevel,
} from '@camstack/ui-library'
import { EventStream } from '@camstack/ui-library'
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem } from '@camstack/ui-library'
import { formatBytes } from '../../../lib/format-size'
import { useTranslation } from 'react-i18next'

interface ServiceInfo {
  readonly addonId: string
  readonly capabilities: readonly string[]
  readonly status: string
}

interface ProcessData {
  readonly pid: number
  readonly name: string
  readonly state: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  readonly services?: readonly ServiceInfo[]
}

interface ForksTabProps {
  readonly nodeId: string
  readonly processes: readonly ProcessData[]
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function processStatus(state: string): StatusBadgeStatus {
  if (state === 'running') return 'running'
  if (state === 'crashed' || state === 'failed') return 'error'
  return 'stopped'
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

function ProcessBlock({
  proc,
  nodeId,
  defaultExpanded,
  activePanel,
  onTogglePanel,
}: {
  readonly proc: ProcessData
  readonly nodeId: string
  readonly defaultExpanded: boolean
  readonly activePanel: { addonId: string; type: 'logs' | 'events' } | null
  readonly onTogglePanel: (addonId: string, type: 'logs' | 'events') => void
}) {
  const { t } = useTranslation()
  const services = proc.services ?? []
  const isSingleAddon = services.length === 1
  const [expanded, setExpanded] = useState(isSingleAddon || defaultExpanded)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [logLevel, setLogLevel] = useState<string>('info')
  const isMain = proc.name.includes('(core)')

  const restartAddonMutation = useNodesRestartAddon()
  const restartProcessMutation = useNodesRestartProcess()
  const setLogLevelMutation = useNodesSetProcessLogLevel()

  const handleRestartAddon = async (addonId: string) => {
    setRestarting(addonId)
    try {
      await restartAddonMutation.mutateAsync({ nodeId, addonId })
    } catch (err) {
      console.error('Failed to restart addon:', err)
    } finally {
      setRestarting(null)
    }
  }

  const handleRestartProcess = async () => {
    setRestarting(proc.name)
    try {
      await restartProcessMutation.mutateAsync({ nodeId, processName: proc.name })
    } catch (err) {
      console.error('Failed to restart process:', err)
    } finally {
      setRestarting(null)
    }
  }

  const handleSetLogLevel = async (level: string) => {
    const processNodeId = `${nodeId}/${proc.name}`
    try {
      await setLogLevelMutation.mutateAsync({ nodeId: processNodeId, level })
      setLogLevel(level)
    } catch (err) {
      console.error('Failed to set log level:', err)
    }
  }

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      {/* Process header */}
      <div
        role={isSingleAddon ? undefined : 'button'}
        tabIndex={isSingleAddon ? undefined : 0}
        onClick={isSingleAddon ? undefined : () => setExpanded(!expanded)}
        onKeyDown={
          isSingleAddon
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded)
              }
        }
        className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 w-full px-3 py-2 bg-muted/20 transition-colors text-left select-none ${isSingleAddon ? '' : 'hover:bg-muted/40 cursor-pointer'}`}
      >
        {isSingleAddon ? (
          <span className="h-3 w-3 shrink-0" />
        ) : expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        {isMain ? (
          <Server className="h-3.5 w-3.5 text-primary shrink-0" />
        ) : (
          <Box className="h-3.5 w-3.5 text-warning shrink-0" />
        )}
        <span className="text-xs font-semibold min-w-0 flex-1 basis-full truncate sm:basis-auto">
          {proc.name}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          PID {proc.pid}
        </span>
        <StatusBadge status={processStatus(proc.state)} label={proc.state} />
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {t('cluster.forksTab.cpu', { percent: proc.cpuPercent })}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {formatBytes(proc.memoryRss)}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {formatUptime(proc.uptimeSeconds)}
        </span>
        {!isMain && (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Dropdown>
              <DropdownTrigger
                className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors font-mono"
                title={t('cluster.forksTab.setLogLevel', 'Set log level')}
              >
                {logLevel}
              </DropdownTrigger>
              <DropdownContent align="end" className="min-w-[70px] py-0.5">
                {LOG_LEVELS.map((lvl) => (
                  <DropdownItem
                    key={lvl}
                    onClick={() => handleSetLogLevel(lvl)}
                    className={`h-auto px-2 py-1 text-[10px] font-mono ${
                      lvl === logLevel ? 'text-primary font-semibold' : ''
                    }`}
                  >
                    {lvl}
                  </DropdownItem>
                ))}
              </DropdownContent>
            </Dropdown>
            <button
              onClick={handleRestartProcess}
              disabled={restarting === proc.name}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              title={t('cluster.forksTab.restartProcess', 'Restart process')}
            >
              <RotateCw className={`h-3 w-3 ${restarting === proc.name ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Services list with inline log viewer */}
      {expanded && services.length > 0 && (
        <div className="divide-y divide-border/30">
          {services.map((svc) => (
            <div key={svc.addonId}>
              <div className="flex items-center gap-2 px-3 py-1.5 pl-9 hover:bg-muted/10 transition-colors">
                <div
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${svc.status === 'running' ? 'bg-success' : 'bg-muted-foreground/30'}`}
                />
                <span className="text-xs font-medium flex-1 min-w-0 truncate">{svc.addonId}</span>

                {svc.capabilities.length > 0 && (
                  <div className="flex gap-1 flex-shrink-0">
                    {svc.capabilities.slice(0, 3).map((cap) => (
                      <span
                        key={cap}
                        className="text-[9px] px-1 py-0.5 rounded bg-info/10 text-info truncate max-w-[80px]"
                      >
                        {cap}
                      </span>
                    ))}
                    {svc.capabilities.length > 3 && (
                      <span className="text-[9px] text-muted-foreground">
                        +{svc.capabilities.length - 3}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onTogglePanel(svc.addonId, 'logs')}
                    className={`p-0.5 rounded transition-colors ${
                      activePanel?.addonId === svc.addonId && activePanel.type === 'logs'
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                    title={t('cluster.forksTab.showLogsFor', 'Show logs for {{addonId}}', {
                      addonId: svc.addonId,
                    })}
                  >
                    <ScrollText className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => onTogglePanel(svc.addonId, 'events')}
                    className={`p-0.5 rounded transition-colors ${
                      activePanel?.addonId === svc.addonId && activePanel.type === 'events'
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                    title={t('cluster.forksTab.showEventsFor', 'Show events for {{addonId}}', {
                      addonId: svc.addonId,
                    })}
                  >
                    <Radio className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => handleRestartAddon(svc.addonId)}
                    disabled={restarting === svc.addonId}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    title={t('cluster.forksTab.restart', 'Restart {{addonId}}', {
                      addonId: svc.addonId,
                    })}
                  >
                    <RotateCw
                      className={`h-3 w-3 ${restarting === svc.addonId ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
              </div>

              {/* Inline panel — log or event viewer below this addon */}
              {activePanel?.addonId === svc.addonId && activePanel.type === 'logs' && (
                <div className="border-t border-border/40 bg-muted/5">
                  <LogStream
                    addonId={svc.addonId}
                    agentId={nodeId}
                    maxHeight="max-h-48"
                    showFilters={false}
                    onClose={() => onTogglePanel(svc.addonId, 'logs')}
                  />
                </div>
              )}
              {activePanel?.addonId === svc.addonId && activePanel.type === 'events' && (
                <div className="border-t border-border/40 bg-muted/5">
                  <EventStream
                    addonId={svc.addonId}
                    category="addon.*"
                    maxHeight="max-h-48"
                    onClose={() => onTogglePanel(svc.addonId, 'events')}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && services.length === 0 && (
        <div className="px-3 py-2 pl-9 text-[10px] text-muted-foreground">
          {t('cluster.forksTab.noServices', 'No services')}
        </div>
      )}
    </div>
  )
}

export function ForksTab({ nodeId, processes }: ForksTabProps) {
  const { t } = useTranslation()
  // Only one panel open at a time across all processes
  const [activePanel, setActivePanel] = useState<{
    addonId: string
    type: 'logs' | 'events'
  } | null>(null)

  const togglePanel = (addonId: string, type: 'logs' | 'events') => {
    setActivePanel((prev) =>
      prev?.addonId === addonId && prev.type === type ? null : { addonId, type },
    )
  }

  if (processes.length === 0) {
    return (
      <div className="py-4 text-xs text-muted-foreground text-center">
        {t('cluster.forksTab.noProcessesOnThisNode', 'No processes on this node')}
      </div>
    )
  }

  return (
    <div className="space-y-2 py-1">
      {processes.map((proc, i) => (
        <ProcessBlock
          key={proc.name}
          proc={proc}
          nodeId={nodeId}
          defaultExpanded={i === 0}
          activePanel={activePanel}
          onTogglePanel={togglePanel}
        />
      ))}
    </div>
  )
}
