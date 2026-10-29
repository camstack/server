/// <reference types="vite/client" />
/**
 * Agent status dashboard (standalone Vite app served by every agent).
 *
 * After editing this package: `npm run build -w @camstack/addon-agent-ui`,
 * then `camstack deploy addon-agent-ui` — the runner loads from
 * `<dataDir>/addons/@camstack/addon-agent-ui/dist/`, not the workspace copy.
 */
import './index.css'
import {
  PageShell,
  SectionCard,
  SettingRow,
  SECTION_BODY,
  Badge,
  Button,
  Card,
} from '@camstack/ui-library'
import {
  Activity,
  AlertTriangle,
  Clock,
  Cog,
  Cpu,
  Download,
  Gauge,
  MemoryStick,
  Package,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type AgentStatus, resolveConnectionState, type AgentProcessInfo } from './agent-status'
import { describeRelease } from './release-identity'
import { UnauthorizedError, fetchJson, redeemUnlockTicket } from './api-client'
import { AgentUiErrorBoundary, installGlobalErrorSurface } from './error-boundary'
import { AddonsPanel } from './addons-panel'
import { HubConfigPanel } from './hub-config-panel'
import { UpdatesPanel } from './updates-panel'
import { translate, useT } from './i18n'

// ---------------------------------------------------------------------------
// Electron desktop bridge (feature-detected)
// ---------------------------------------------------------------------------

/**
 * Exposed by the Electron wrapper's UI preload (`preload-ui.ts`) via
 * `contextBridge`. Absent when the agent UI is opened in a plain browser or
 * runs headless — every consumer MUST feature-detect it.
 */
interface CamstackAgentAppBridge {
  readonly version: string
  getUpdateState(): Promise<UpdateState>
  onUpdateState(cb: (state: UpdateState) => void): () => void
  checkForUpdates(): Promise<void>
  installUpdate(): void
}

interface UpdateState {
  readonly available: boolean
  readonly downloaded: boolean
  readonly version: string | null
  readonly checking: boolean
  /** Why the last check did not produce an answer, or `null`.
   *  Mirrors `UpdateState.error` of the main process. */
  readonly error: string | null
}

declare global {
  interface Window {
    readonly camstackAgentApp?: CamstackAgentAppBridge
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

/**
 * Long update/check errors must not grow the header horizontally.
 * Truncate by default; click expands the full message (and title always has it).
 */
function ClampedError({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setExpanded((v) => !v)}
      title={text}
      className={`h-auto py-0.5 px-1.5 text-[10px] text-danger hover:text-danger text-left max-w-[10rem] sm:max-w-[14rem] ${
        expanded ? 'whitespace-normal break-words' : ''
      }`}
    >
      <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
      <span className={expanded ? 'break-words' : 'truncate'}>{text}</span>
    </Button>
  )
}

function StatusMetricCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  readonly label: string
  readonly value: string
  readonly icon: typeof Cpu
  readonly tone?: 'default' | 'danger' | 'primary'
}) {
  const iconClass =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'primary'
        ? 'text-primary'
        : 'text-foreground-subtle'
  return (
    <Card variant="bordered" className="p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`h-4 w-4 ${iconClass}`} />
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle font-medium">
          {label}
        </span>
      </div>
      <div className="text-xl font-bold text-foreground">{value}</div>
    </Card>
  )
}

/**
 * App version + auto-update control. The version comes from the agent status
 * API (`appVersion`) so it renders in any browser; the update button only
 * appears when the Electron bridge is present AND an update is downloaded.
 */
interface AppVersionBadgeProps {
  readonly productVersion?: string | null
  readonly serverVersion?: string | null
  readonly appVersion?: string | null
}

function AppVersionBadge({ productVersion, serverVersion, appVersion }: AppVersionBadgeProps) {
  const { t } = useT()
  const bridge = typeof window !== 'undefined' ? window.camstackAgentApp : undefined
  const [update, setUpdate] = useState<UpdateState | null>(null)

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.getUpdateState().then((s) => {
      if (active) setUpdate(s)
    })
    const off = bridge.onUpdateState((s) => setUpdate(s))
    return () => {
      active = false
      off()
    }
  }, [bridge])

  const described = describeRelease({
    productVersion: productVersion ?? appVersion ?? bridge?.version ?? null,
    serverVersion: serverVersion ?? null,
    fallbackVersion: appVersion ?? bridge?.version ?? null,
  })
  const versionText =
    described.kind === 'both'
      ? t('dashboard.version.both', {
          product: described.productLabel,
          server: described.serverVersion,
        })
      : described.kind === 'product'
        ? described.productLabel
        : described.kind === 'server'
          ? t('dashboard.version.serverOnly', { version: described.serverVersion })
          : described.kind === 'fallback'
            ? `v${described.version}`
            : null
  if (versionText === null && !bridge) return null

  return (
    <div className="flex items-center gap-2 min-w-0 max-w-full flex-wrap justify-end">
      {versionText !== null && (
        <span
          data-testid="release-identity"
          className="text-[10px] font-mono text-foreground-subtle"
        >
          {versionText}
        </span>
      )}
      {bridge && update?.downloaded && (
        <Button type="button" variant="primary" size="sm" onClick={() => bridge.installUpdate()}>
          <Download className="h-3 w-3" />
          {update.version
            ? t('dashboard.version.restartToUpdateTo', { version: update.version })
            : t('dashboard.version.restartToUpdate')}
        </Button>
      )}
      {bridge && update && !update.downloaded && update.available && (
        <span className="inline-flex items-center gap-1 text-[10px] text-warning">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {t('dashboard.version.downloading')}
        </span>
      )}
      {bridge && update && !update.available && !update.downloaded && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void bridge.checkForUpdates()}
          disabled={update.checking}
        >
          {update.checking ? t('dashboard.version.checking') : t('dashboard.version.check')}
        </Button>
      )}
      {bridge && update?.error != null && !update.checking && (
        <ClampedError text={t('dashboard.version.checkFailed', { error: update.error })} />
      )}
    </div>
  )
}

/** The agent process itself (uptime + memory), distinct from host metrics. */
function AgentProcessPanel({ info }: { readonly info?: AgentProcessInfo }) {
  const { t } = useT()
  return (
    <SectionCard headingId="agent-process" title={t('dashboard.process.title')} icon={Cog}>
      <div className={`${SECTION_BODY} space-y-0`}>
        <SettingRow label={t('dashboard.process.pid')} valueClassName="font-mono">
          {info?.pid ?? '—'}
        </SettingRow>
        <SettingRow label={t('dashboard.process.uptime')} valueClassName="font-mono">
          {info ? formatUptime(info.uptimeSeconds) : '—'}
        </SettingRow>
        <SettingRow label={t('dashboard.process.memory')} valueClassName="font-mono">
          {info ? `${info.rssMB} MB` : '—'}
        </SettingRow>
        <SettingRow label={t('dashboard.process.heap')} valueClassName="font-mono">
          {info ? `${info.heapUsedMB} / ${info.heapTotalMB} MB` : '—'}
        </SettingRow>
      </div>
    </SectionCard>
  )
}

function ProgressBar({
  value,
  max,
  tone,
}: {
  readonly value: number
  readonly max: number
  readonly tone: 'primary' | 'danger'
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${tone === 'danger' ? 'bg-danger' : 'bg-primary'}`}
        style={{ width: `${pct}%` }} // ui-check-ok: computed progress width %
      />
    </div>
  )
}

function DecodeDetectionPanel({ status }: { readonly status: AgentStatus | null }) {
  const { t } = useT()
  const hwaccel = status?.decode?.hwaccel ?? '—'
  const dri = status?.decode?.driDevice ?? null
  const devices = status?.detectionDevices ?? []
  return (
    <SectionCard headingId="agent-decode-detection" title={t('dashboard.decode.title')} icon={Cpu}>
      <div className={`${SECTION_BODY} space-y-0`}>
        <SettingRow label={t('dashboard.decode.hwaccel')} valueClassName="font-mono">
          {hwaccel}
        </SettingRow>
        <SettingRow label={t('dashboard.decode.driDevice')} valueClassName="font-mono">
          {dri ?? '—'}
        </SettingRow>
        <SettingRow label={t('dashboard.decode.detectionDevices')}>
          {devices.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {devices.map((d) => (
                <Badge key={d} variant="info" className="text-[10px] font-mono">
                  {d}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-foreground-subtle">{t('dashboard.decode.software')}</span>
          )}
        </SettingRow>
      </div>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

/**
 * Full-page unlock when the API answers 401 (D821). The one way in from another
 * machine is Continue with hub: an admin session on the hub mints a ticket.
 */
function UnlockScreen({
  hubHttpsOrigin,
  nodeId,
}: {
  readonly hubHttpsOrigin: string | null
  readonly nodeId: string | null
}) {
  const [probeOrigin, setProbeOrigin] = useState<string | null>(hubHttpsOrigin)
  const [probeNodeId, setProbeNodeId] = useState<string | null>(nodeId)
  const [unpaired, setUnpaired] = useState(false)
  const { t } = useT()

  useEffect(() => {
    let cancelled = false
    void fetch('/api/agent/unlock-info')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (data: { hubHttpsOrigin?: string | null; nodeId?: string; paired?: boolean } | null) => {
          if (cancelled || data === null) return
          // An unpaired agent has no hub to unlock it: the network may only run the pairing
          // protocol, so this screen shows exactly that (D857).
          if (data.paired === false) setUnpaired(true)
          if (typeof data.hubHttpsOrigin === 'string') setProbeOrigin(data.hubHttpsOrigin)
          if (typeof data.nodeId === 'string') setProbeNodeId(data.nodeId)
        },
      )
      .catch(() => {
        /* keep nulls */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const effectiveOrigin = hubHttpsOrigin ?? probeOrigin
  const effectiveNodeId = nodeId ?? probeNodeId

  const continueWithHub = useCallback(() => {
    if (effectiveOrigin === null || effectiveNodeId === null) return
    const returnTo = `${window.location.origin}/`
    const target = new URL('/system/nodes', effectiveOrigin)
    target.searchParams.set('unlockNode', effectiveNodeId)
    target.searchParams.set('returnTo', returnTo)
    window.location.assign(target.toString())
  }, [effectiveOrigin, effectiveNodeId])

  if (unpaired) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-4xl mx-auto">
          <PageShell
            icon={Server}
            title={t('dashboard.defaultName')}
            subtitle={<span className="font-mono">{effectiveNodeId ?? '...'}</span>}
          >
            <HubConfigPanel status={null} onStatusRefresh={async () => window.location.reload()} />
          </PageShell>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-2 sm:p-4">
      <Card variant="bordered" className="w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-semibold">{t('dashboard.locked.title')}</h1>
        </div>
        <p className="text-xs text-foreground-subtle">{t('dashboard.locked.body')}</p>
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={effectiveOrigin === null || effectiveNodeId === null}
          onClick={continueWithHub}
        >
          {t('dashboard.locked.continue')}
        </Button>
        {effectiveOrigin === null && (
          <p className="text-[11px] text-foreground-subtle">{t('dashboard.locked.hubUnknown')}</p>
        )}
      </Card>
    </div>
  )
}

function AgentDashboard() {
  const { t } = useT()
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [httpReachable, setHttpReachable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  const [ticketBoot, setTicketBoot] = useState<'idle' | 'redeeming' | 'failed'>('idle')

  const pollStatus = useCallback(async (): Promise<void> => {
    setStatus(await fetchJson<AgentStatus>('/api/agent/status'))
    setHttpReachable(true)
    setError(null)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ticket = params.get('ticket')
    if (ticket === null || ticket.length === 0) return
    let cancelled = false
    setTicketBoot('redeeming')
    void redeemUnlockTicket(ticket)
      .then(() => {
        if (cancelled) return
        params.delete('ticket')
        const next = params.toString()
        window.history.replaceState(
          null,
          '',
          next.length > 0 ? `${window.location.pathname}?${next}` : window.location.pathname,
        )
        setTicketBoot('idle')
        setLocked(false)
      })
      .catch(() => {
        if (cancelled) return
        setTicketBoot('failed')
        setLocked(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (locked || ticketBoot === 'redeeming') return
    let active = true
    const poll = async () => {
      try {
        const s = await fetchJson<AgentStatus>('/api/agent/status')
        if (active) {
          setStatus(s)
          setHttpReachable(true)
          setError(null)
        }
      } catch (err) {
        if (active) {
          if (err instanceof UnauthorizedError) {
            setLocked(true)
            return
          }
          setHttpReachable(false)
          setError(err instanceof Error ? err.message : translate('common.unknownError'))
        }
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [locked, ticketBoot])

  // A failed memory read is unknown, never 0 or 100 (D393).
  const memUsedMB =
    status && status.freeMemoryMB !== null && status.freeMemoryMB !== undefined
      ? status.totalMemoryMB - status.freeMemoryMB
      : null
  const memPct = typeof status?.memoryPercent === 'number' ? Math.round(status.memoryPercent) : null
  const memPctLabel = memPct === null ? t('dashboard.resources.unknown') : `${memPct}%`
  const cpuPct = status?.cpuPercent ?? 0

  if (ticketBoot === 'redeeming') {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4 text-sm text-foreground-subtle">
        {t('dashboard.unlocking')}
      </div>
    )
  }

  if (locked) {
    return (
      <UnlockScreen
        hubHttpsOrigin={status?.hubHttpsOrigin ?? null}
        nodeId={status?.nodeId ?? null}
      />
    )
  }

  const connState = resolveConnectionState(status)
  const isUnreachable = !httpReachable
  const HubIcon =
    isUnreachable || connState === 'disconnected' || connState === 'certificate-rejected'
      ? WifiOff
      : Wifi
  const hubLabel = isUnreachable
    ? (error ?? t('dashboard.unreachable'))
    : connState === 'connected'
      ? t('dashboard.hub.connected')
      : connState === 'unconfigured'
        ? t('dashboard.hub.unconfigured')
        : connState === 'unpaired'
          ? t('dashboard.hub.unpaired')
          : connState === 'certificate-rejected'
            ? t('dashboard.hub.certificateRejected')
            : t('dashboard.hub.disconnected')
  const hubBadgeVariant = isUnreachable
    ? ('danger' as const)
    : connState === 'connected'
      ? ('success' as const)
      : connState === 'unconfigured' || connState === 'unpaired'
        ? ('warning' as const)
        : ('danger' as const)

  const ipv4 = (status?.localIps ?? []).filter((ip) => !ip.includes(':')).join(', ') || '—'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto">
        <PageShell
          icon={Server}
          title={status?.name ?? t('dashboard.defaultName')}
          subtitle={
            <>
              <span className="font-mono">{status?.nodeId ?? '...'}</span>
              {status?.hostname && <span className="ml-2">· {status.hostname}</span>}
              {ipv4 !== '—' && <span className="ml-2">· {ipv4}</span>}
            </>
          }
          actions={
            <>
              <AppVersionBadge
                productVersion={status?.productVersion}
                serverVersion={status?.serverVersion}
                appVersion={status?.appVersion}
              />
              <Badge
                variant={hubBadgeVariant}
                className="inline-flex items-center gap-1.5 shrink-0"
              >
                <HubIcon className="h-3 w-3" />
                <span className="max-w-[8rem] sm:max-w-none truncate">{hubLabel}</span>
              </Badge>
            </>
          }
        >
          <SectionCard
            headingId="agent-overview"
            title={t('dashboard.overview.title')}
            icon={Activity}
          >
            <div className={`${SECTION_BODY} grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4`}>
              <StatusMetricCard
                icon={Cpu}
                label={t('dashboard.overview.cpu')}
                value={`${cpuPct}%`}
                tone={cpuPct > 80 ? 'danger' : 'primary'}
              />
              <StatusMetricCard
                icon={MemoryStick}
                label={t('dashboard.overview.memory')}
                value={memPctLabel}
                tone={memPct !== null && memPct > 90 ? 'danger' : 'primary'}
              />
              <StatusMetricCard
                icon={Package}
                label={t('dashboard.overview.addons')}
                value={String(status?.addons.length ?? 0)}
              />
              <StatusMetricCard
                icon={Clock}
                label={t('dashboard.overview.uptime')}
                value={status ? formatUptime(status.uptime) : '—'}
              />
            </div>
          </SectionCard>

          <HubConfigPanel status={status} onStatusRefresh={pollStatus} />

          <AddonsPanel locked={locked} onUnauthorized={() => setLocked(true)} />

          <UpdatesPanel locked={locked} onUnauthorized={() => setLocked(true)} />

          <DecodeDetectionPanel status={status} />

          <SectionCard
            headingId="agent-resources"
            title={t('dashboard.resources.title')}
            icon={Gauge}
          >
            <div className={`${SECTION_BODY} space-y-4`}>
              <div>
                <div className="flex justify-between text-xs text-foreground-subtle mb-1">
                  <span>
                    {status?.cpuModel
                      ? t('dashboard.resources.cpuCoresModel', {
                          cores: status.cpuCores ?? 0,
                          model: status.cpuModel,
                        })
                      : t('dashboard.resources.cpuCores', { cores: status?.cpuCores ?? 0 })}
                  </span>
                  <span>{cpuPct}%</span>
                </div>
                <ProgressBar value={cpuPct} max={100} tone={cpuPct > 80 ? 'danger' : 'primary'} />
              </div>
              <div>
                <div className="flex justify-between text-xs text-foreground-subtle mb-1">
                  <span>
                    {memUsedMB === null
                      ? t('dashboard.resources.memoryUnknown')
                      : t('dashboard.resources.memory', {
                          used: memUsedMB,
                          total: status?.totalMemoryMB ?? 0,
                        })}
                  </span>
                  <span>{memPctLabel}</span>
                </div>
                <ProgressBar
                  value={memPct ?? 0}
                  max={100}
                  tone={memPct !== null && memPct > 90 ? 'danger' : 'primary'}
                />
              </div>
            </div>
          </SectionCard>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
            <SectionCard
              headingId="agent-system-host"
              title={t('dashboard.host.title')}
              icon={Server}
            >
              <div className={`${SECTION_BODY} space-y-0`}>
                <SettingRow label={t('dashboard.host.platform')} valueClassName="font-mono">
                  {status?.platform} / {status?.arch}
                </SettingRow>
                <SettingRow label={t('dashboard.host.hostname')} valueClassName="font-mono">
                  {status?.hostname ?? '—'}
                </SettingRow>
                <SettingRow label={t('dashboard.host.uptime')} valueClassName="font-mono">
                  {status ? formatUptime(status.uptime) : '—'}
                </SettingRow>
                <SettingRow label={t('dashboard.host.memory')} valueClassName="font-mono">
                  {status && memUsedMB !== null ? `${memUsedMB} / ${status.totalMemoryMB} MB` : '—'}
                </SettingRow>
                <SettingRow label={t('dashboard.host.ipv4')} valueClassName="font-mono">
                  {ipv4}
                </SettingRow>
              </div>
            </SectionCard>
            <AgentProcessPanel info={status?.agentProcess} />
          </div>
        </PageShell>
      </div>
    </div>
  )
}

installGlobalErrorSurface()
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <AgentUiErrorBoundary>
      <AgentDashboard />
    </AgentUiErrorBoundary>,
  )
}
