import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cpu, ExternalLink, MemoryStick, Trash2, Unlink } from 'lucide-react'
import {
  Button,
  useConfirm,
  usePipelineOrchestratorListAgentSettings,
  useSystem,
} from '@camstack/ui-library'
import {
  buildAgentDashboardBaseUrl,
  buildAgentDashboardTicketUrl,
  navigateDashboardTab,
  openBlankDashboardTab,
  parseMintUnlockResult,
  pickAgentDashboardHost,
} from '../../lib/agent-dashboard-unlock'
import { NodeTitle } from './NodeTitle'
import { ForksTab } from './tabs/ForksTab'
import { ProcessesTab } from './tabs/ProcessesTab'
import { LoadTab } from './load/LoadTab'
import { NodeDetailSettingsTab } from './tabs/NodeDetailSettingsTab'
import { NodeDetailCapabilitiesTab } from './tabs/NodeDetailCapabilitiesTab'
import { NodeInfoTab } from './tabs/NodeInfoTab'
import { NodeGeneralIdentitySection } from './NodeGeneralIdentitySection'
import { NodeServerManagementSection } from './tabs/NodeServerManagementSection'
import { useTranslation } from 'react-i18next'
// Models live in Model Studio (catalog + per-node download), not on
// cluster cards and not on Pipeline → Nodo.

interface NodeAddon {
  readonly id: string
  readonly capabilities: readonly string[]
  readonly status: string
}

export interface ServiceInfo {
  readonly addonId: string
  readonly capabilities: readonly string[]
  readonly status: string
}

export interface NodeProcess {
  readonly pid: number
  readonly name: string
  readonly state: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  readonly services?: readonly ServiceInfo[]
}

interface NodeCategoryAddon {
  readonly id: string
  readonly status: string
  readonly cpuPercent: number
  readonly memoryRss: number
}

interface NodeCategory {
  readonly category: string
  readonly total: number
  readonly healthy: number
  readonly addons: readonly NodeCategoryAddon[]
}

export interface NodeData {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel?: string | null
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly string[]
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly uptime?: number
  readonly lastSeen?: string | number
  readonly localIps?: readonly string[]
  readonly addons: readonly NodeAddon[]
  readonly processes: readonly NodeProcess[]
  readonly categories: readonly NodeCategory[]
  // The node's runtime-updatable ROOT package — always `@camstack/server` now
  // (hub and agent are the same root, differentiated by CAMSTACK_ROLE) from
  // `nodes.topology.rootPackage` — the SAME single source the Server-management
  // surface reads. Nullable for offline / pre-phase-2 rows.
  readonly rootPackage?: { readonly name: string; readonly version: string } | null
}

// No `addons` tab: the dedicated Addons page owns per-node addon management
// (deploy / restart / uninstall / upload). A second surface for the same thing
// on the node card only made operators wonder which one was authoritative.
// `node.addons` is still read here — the offline summary, the Settings tab's
// `addonIds` and the Capabilities tab all derive from it.
type TabId = 'info' | 'forks' | 'processes' | 'load' | 'settings' | 'capabilities'

/** What "Forget node" answered, as rendered. */
interface ForgetOutcome {
  readonly tone: 'ok' | 'warn'
  readonly text: string
}

function readReachableHost(settings: unknown): string | null {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  const value = Reflect.get(settings, 'reachableHost')
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function NodeCard({ node }: { readonly node: NodeData }) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [unpairing, setUnpairing] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('info')
  const [forgetting, setForgetting] = useState(false)
  const [forgetOutcome, setForgetOutcome] = useState<ForgetOutcome | null>(null)
  const processes = node.processes ?? []
  const addonIds = node.addons.map((a) => a.id)
  const agentSettingsQuery = usePipelineOrchestratorListAgentSettings(undefined)
  const reachableHost = useMemo(() => {
    const row = agentSettingsQuery.data?.find((r) => r.nodeId === node.id)
    return readReachableHost(row?.settings)
  }, [agentSettingsQuery.data, node.id])

  // Inline "Forget node": fully forget an offline node — its durable history
  // row, its Moleculer node-catalog entry, and its per-node pipeline
  // assignments.
  //
  // This used to `await Promise.allSettled([...])` and DISCARD the array, so
  // two rejections and two successes looked identical, and the operator's only
  // feedback was whether the row eventually vanished. On 2026-09-01 it did not
  // vanish, over and over, and nothing on the page said why. The result is now
  // read and shown — including `stillListed`, the case where the call
  // succeeded and the node is nevertheless still there.
  const [openingDashboard, setOpeningDashboard] = useState(false)
  const [openDashboardError, setOpenDashboardError] = useState<string | null>(null)
  /** When the browser blocks the tab, keep a one-click link (user gesture). */
  const [openDashboardUrl, setOpenDashboardUrl] = useState<string | null>(null)

  /** D821 — mint unlock ticket and open the agent's :4444 dashboard. */
  const handleOpenDashboard = useCallback(async (): Promise<void> => {
    if (openingDashboard || node.isHub) return
    const host = pickAgentDashboardHost(node.localIps ?? [], reachableHost)
    if (host === null) {
      setOpenDashboardError('No LAN IPv4 on this node — open its :4444 URL by hand.')
      setOpenDashboardUrl(null)
      return
    }
    // Open in the click turn — a post-await `window.open` is popup-blocked.
    const tab = openBlankDashboardTab()
    setOpeningDashboard(true)
    setOpenDashboardError(null)
    setOpenDashboardUrl(null)
    try {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: 'system-config',
        action: 'mintAgentUiUnlockTicket',
        input: {
          nodeId: node.id,
          dashboardBaseUrl: buildAgentDashboardBaseUrl(host),
        },
      })
      const minted = parseMintUnlockResult(raw)
      const url =
        minted === null
          ? null
          : (minted.dashboardUrl ?? buildAgentDashboardTicketUrl(host, minted.ticket))
      if (url === null) {
        tab?.close()
        setOpenDashboardError('Hub did not return an unlock ticket.')
        return
      }
      if (!navigateDashboardTab(tab, url)) {
        setOpenDashboardUrl(url)
        setOpenDashboardError(
          'Browser blocked the new tab — click the link below (or allow popups for this site).',
        )
      }
    } catch (err) {
      tab?.close()
      setOpenDashboardError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningDashboard(false)
    }
  }, [node.id, node.isHub, node.localIps, openingDashboard, reachableHost, system.trpcClient])

  const handleForget = async (): Promise<void> => {
    if (forgetting) return
    setForgetting(true)
    setForgetOutcome(null)
    try {
      // Pipeline assignments are a genuinely best-effort side cleanup; the
      // forget itself is the answer, so its rejection is not swallowed.
      await system.trpcClient.pipelineOrchestrator.removeAgentSettings
        .mutate({ agentNodeId: node.id })
        .catch(() => undefined)
      const result = await system.trpcClient.clusterNodes.forgetNode.mutate({ nodeId: node.id })
      setForgetOutcome({ tone: result.stillListed ? 'warn' : 'ok', text: result.message })
      // Drop the bootstrap query so a late event / remount cannot resurrect
      // the forgotten id from the pre-forget topology answer. The live push
      // is driven server-side by `AgentUnregistered` (forget emits it).
      if (!result.stillListed) {
        void queryClient.invalidateQueries({ queryKey: [['nodes', 'topology']] })
      }
    } catch (err) {
      setForgetOutcome({
        tone: 'warn',
        text: t('cluster.nodeCard.forgetFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setForgetting(false)
    }
  }

  /** D857: the hub revokes the agent's certificates and tells it to forget the hub (works offline too). */
  const handleUnpair = async (): Promise<void> => {
    if (unpairing) return
    const ok = await confirm({
      title: t('cluster.nodeCard.unpair', 'Unpair {{name}}', { name: node.name }),
      message: t(
        'cluster.nodeCard.unpairItDisconnectsAndMust',
        'Unpair {{name}}? It disconnects and must be paired again.',
        { name: node.name },
      ),
      confirmLabel: t('cluster.nodeCard.unpair2', 'Unpair'),
      variant: 'danger',
    })
    if (!ok) return
    setUnpairing(true)
    setForgetOutcome(null)
    try {
      const result = await system.trpcClient.agentPairing.unpairAgent.mutate({ nodeId: node.id })
      setForgetOutcome({
        tone: result.agentNotified ? 'ok' : 'warn',
        text: `${result.nodeId}: ${result.next}${
          result.agentNotified
            ? ''
            : ' The agent could not be told; forget the hub on its own page.'
        }`,
      })
      void queryClient.invalidateQueries({ queryKey: [['nodes', 'topology']] })
    } catch (err) {
      setForgetOutcome({
        tone: 'warn',
        text: t('cluster.nodeCard.unpairFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setUnpairing(false)
    }
  }

  const unpairButton = node.isHub ? null : (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void handleUnpair()}
      disabled={unpairing}
      title={t(
        'cluster.nodeCard.unpairThisNodeRevokesIts',
        'Unpair this node — revokes its certificates; it must be paired again to rejoin',
      )}
    >
      <Unlink className="h-3 w-3" aria-hidden />
      {unpairing
        ? t('cluster.nodeCard.unpairing', 'Unpairing…')
        : t('cluster.nodeCard.unpair2', 'Unpair')}
    </Button>
  )

  if (!node.isOnline) {
    return (
      <div className="border border-border rounded-xl overflow-hidden opacity-60">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-muted/30">
          <div className="w-2.5 h-2.5 rounded-full bg-destructive shrink-0" />
          <NodeTitle node={node} />
          <span className="text-xs text-muted-foreground min-w-0 truncate">
            {node.cpuModel ?? node.platform} ·{' '}
            {node.memoryMB > 0
              ? t('cluster.nodeCard.gb', '{{value1}}GB', {
                  value1: Math.round(node.memoryMB / 1024),
                })
              : ''}{' '}
            · {node.arch}
          </span>
          {node.engines.map((e) => (
            <span
              key={e}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
              title={t(
                'cluster.nodeInfoTab.installedRuntimesHint',
                'Inference runtimes installed on this node. Its live inference devices are on Pipeline → Load balancing.',
              )}
            >
              {e}
            </span>
          ))}
          {node.rootPackage && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {node.rootPackage.name}@{node.rootPackage.version}
            </span>
          )}
          <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
            {t('common.offline')}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {node.lastSeen ? (
              <span className="mr-1">
                {t('cluster.nodeCard.lastSeen', { when: new Date(node.lastSeen).toLocaleString() })}
              </span>
            ) : null}
            {t('cluster.nodeCard.addonsAssigned', { count: node.addons.length })}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {unpairButton}
            <button
              type="button"
              onClick={() => void handleForget()}
              disabled={forgetting}
              title={t(
                'cluster.nodeCard.forgetThisNodeRemovesIts',
                'Forget this node — removes its saved history and pipeline assignments',
              )}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              {forgetting
                ? t('cluster.nodeCard.forgetting', 'Forgetting…')
                : t('cluster.nodeCard.forgetNode', 'Forget node')}
            </button>
          </div>
        </div>
        {forgetOutcome != null && (
          <p
            role="status"
            className={`px-4 pb-3 text-xs leading-relaxed ${
              forgetOutcome.tone === 'ok' ? 'text-success' : 'text-warning'
            }`}
          >
            {forgetOutcome.text}
          </p>
        )}
      </div>
    )
  }

  return (
    // NO `overflow-hidden` here. It was only clipping children to the card's
    // radius, but `overflow: hidden` makes this div the nearest scroll
    // container for every descendant — which silently disables `position:
    // sticky` inside the card (sticky resolves against the nearest scrolling
    // ancestor, and a non-scrollable one never moves). That is why the tab bar
    // below could not be made to stick. The rounding is preserved by giving the
    // header row its own `rounded-t-xl` instead.
    <div className="border border-border rounded-xl">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-muted/30 border-b border-border rounded-t-xl">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-x-2 gap-y-1 sm:basis-auto sm:flex-initial">
          <div className="w-2.5 h-2.5 rounded-full bg-success shrink-0" />
          <NodeTitle node={node} />
          <span className="text-xs text-muted-foreground min-w-0 truncate">
            {node.cpuModel ?? node.platform} ·{' '}
            {node.memoryMB > 0
              ? t('cluster.nodeCard.gb', '{{value1}}GB', {
                  value1: Math.round(node.memoryMB / 1024),
                })
              : ''}{' '}
            · {node.arch}
          </span>
        </div>
        {node.engines.map((e) => (
          <span
            key={e}
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0"
            title={t(
              'cluster.nodeInfoTab.installedRuntimesHint',
              'Inference runtimes installed on this node. Its live inference devices are on Pipeline → Load balancing.',
            )}
          >
            {e}
          </span>
        ))}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground w-full sm:ml-auto sm:w-auto">
          {!node.isHub && (
            <button
              type="button"
              onClick={() => void handleOpenDashboard()}
              disabled={openingDashboard}
              title={t(
                'cluster.nodeCard.openThisAgentSStatus',
                "Open this agent's status dashboard (unlocks with a short-lived hub ticket)",
              )}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              <ExternalLink className="h-3 w-3" />
              {openingDashboard
                ? t('cluster.nodeCard.opening', 'Opening…')
                : t('cluster.nodeCard.openDashboard', 'Open dashboard')}
            </button>
          )}
          {unpairButton}
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" /> {node.cpuPercent}%
          </span>
          <span className="flex items-center gap-1">
            <MemoryStick className="h-3 w-3" /> {node.memoryPercent}%
          </span>
        </div>
      </div>
      {forgetOutcome != null && (
        <p
          role="status"
          className={`px-4 pt-2 text-xs ${forgetOutcome.tone === 'ok' ? 'text-success' : 'text-warning'}`}
        >
          {forgetOutcome.text}
        </p>
      )}
      {(openDashboardError !== null || openDashboardUrl !== null) && (
        <p role="status" className="px-4 pt-2 text-xs text-warning">
          {openDashboardError}
          {openDashboardUrl !== null && (
            <>
              {' '}
              <a
                href={openDashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="underline text-foreground"
              >
                {t('cluster.nodeCard.openDashboard', 'Open dashboard')}
              </a>
            </>
          )}
        </p>
      )}

      {/* Sticky within `<main>` (AppLayout scroll container): a node's
          Processes / Capabilities lists are long, and losing the tab bar
          means scrolling back up just to switch tab. `overflow-x-auto` keeps
          all six tabs reachable on a narrow viewport instead of clipping the
          last ones. The opaque background is required — content scrolls UNDER
          this bar. */}
      <div className="sticky top-0 z-20 flex border-b border-border px-4 bg-background overflow-x-auto">
        {(['info', 'forks', 'processes', 'load', 'settings', 'capabilities'] as const).map(
          (tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              // `shrink-0 whitespace-nowrap`: inside the horizontally
              // scrollable bar the labels must keep their width instead of
              // squeezing (`Forks (12)` wrapping to two lines).
              className={`shrink-0 whitespace-nowrap px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'info'
                ? t('cluster.nodeCard.general', 'General')
                : tab === 'forks'
                  ? t('cluster.nodeCard.forks', 'Forks ({{length}})', { length: processes.length })
                  : tab === 'processes'
                    ? t('cluster.nodeCard.processes', 'Processes')
                    : tab === 'load'
                      ? t('cluster.nodeCard.load', 'Load')
                      : tab === 'settings'
                        ? t('cluster.nodeCard.settings', 'Settings')
                        : t('cluster.nodeCard.capabilities', 'Capabilities')}
            </button>
          ),
        )}
      </div>

      <div className="px-4 py-2">
        {activeTab === 'info' && (
          <div className="space-y-3">
            <NodeInfoTab
              nodeId={node.id}
              name={node.name}
              hostname={node.hostname}
              platform={node.platform}
              arch={node.arch}
              cpuModel={node.cpuModel}
              cpuCores={node.cpuCores}
              memoryMB={node.memoryMB}
              engines={node.engines}
              isHub={node.isHub}
              uptime={node.uptime}
              localIps={node.localIps}
              rootPackage={node.rootPackage}
            />
            <NodeGeneralIdentitySection nodeId={node.id} detectedHosts={node.localIps ?? []} />
            {/* Server-management surface (runtime-updatable root package +
                lifecycle actions) — merged in from the former standalone
                "Server" page as the node's General overview. */}
            <div className="border-t border-border pt-1">
              <NodeServerManagementSection
                node={{
                  id: node.id,
                  name: node.name,
                  isHub: node.isHub,
                  isOnline: node.isOnline,
                  rootPackage: node.rootPackage ?? null,
                }}
              />
            </div>
          </div>
        )}
        {activeTab === 'forks' && <ForksTab nodeId={node.id} processes={processes} />}
        {activeTab === 'processes' && <ProcessesTab nodeId={node.id} />}
        {activeTab === 'load' && <LoadTab nodeId={node.id} isHub={node.isHub} />}
        {activeTab === 'settings' && <NodeDetailSettingsTab nodeId={node.id} addonIds={addonIds} />}
        {activeTab === 'capabilities' && (
          <NodeDetailCapabilitiesTab nodeId={node.id} addons={node.addons} />
        )}
      </div>
    </div>
  )
}
