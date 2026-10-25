/**
 * Cluster page — one node at a time.
 *
 * The former Graph view was removed on 2026-08-28, and the stack that replaced
 * it went the same day: it rendered every node's `NodeCard` at once, six tabs
 * and two chart grids apiece, so reading one node meant scrolling past the
 * others. The shared `NodePicker` shows one node's detail and keeps the fleet
 * answer on the pills — offline agents stay selectable (`allowOffline`).
 *
 * ## The selection is in the URL
 *
 * `?node=<nodeId>`, the same idiom `AdminTabs` uses for `?tab=`. It is written
 * with `replace: true`, so switching node does not stack history entries the
 * back button has to walk out of.
 *
 * The URL is the store on purpose. A selector that reset on every navigation
 * would be worse than the stack it replaced — the operator reloads this page
 * constantly while a node is restarting, and landing back on the hub each time
 * is exactly the friction the split was meant to remove. It also makes the
 * view linkable, which component state never is.
 *
 * The contract itself (param name, ordering, what a forgotten id does) is
 * `lib/node-url-selection.ts`, shared with the Addons page since 2026-08-30 —
 * a `server-update-available` notification taps into `?node=` here.
 *
 * Event-driven: reads topology directly from the `cluster.topology-snapshot`
 * event payload. The initial query is only a bootstrap — once the first event
 * arrives, the query is never refetched. Zero polling.
 *
 * Offline nodes are selectable like any other (topology carries
 * `isOnline: false` rows for disconnected nodes) — there is no separate
 * "Offline agents" tab/panel.
 */
import { useState, useMemo, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ArrowDownToLine, Loader2, Network } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  NodePicker,
  useConfirm,
  useClusterTopology,
  useServerManagementApplyServerUpdate,
  useSystem,
} from '@camstack/ui-library'
import { AdminPage } from '../../components/AdminPage'
import { AgentsFoundSection } from '../../components/cluster/pairing/AgentsFoundSection'
import { NodeCard, type NodeData } from '../../components/cluster/NodeCard'
import { StaleNodeNotice } from '../../components/shared/StaleNodeNotice'
import { useNodeUrlSelection } from '../../hooks/useNodeUrlSelection'
import { parseMintUnlockResult } from '../../lib/agent-dashboard-unlock'
import {
  updateAllNodes,
  type NodeUpdateReport,
  type UpdateAllTarget,
} from '../../lib/cluster-update-all'

/**
 * Hook: topology from event stream with query bootstrap.
 * Returns the latest topology snapshot — either from the live event
 * stream or from the initial query (whichever is newer).
 */
function useTopologyStream(): {
  nodes: readonly NodeData[]
  isLoading: boolean
} {
  // This page IS the cluster diagram — per-node CPU, memory, addon status and
  // process detail — so it is a sanctioned reader of `nodes.topology`. It used
  // to hand-roll the bootstrap-then-push pattern here; that pattern now lives
  // once, in `useClusterTopology`, so every diagram reader shares one query key
  // and one subscription (D317).
  const { nodes: topology, isLoading } = useClusterTopology()
  const nodes = useMemo(() => (topology ?? []) as readonly NodeData[], [topology])
  return { nodes, isLoading: isLoading && nodes.length === 0 }
}

/**
 * One tone per outcome. `unconfirmed` is deliberately NOT green: a node that
 * could not be read back has not been shown to have updated, and the whole
 * defect this page shipped was treating "we don't know" as "it worked".
 */
const OUTCOME_STYLE: Record<NodeUpdateReport['outcome'], string> = {
  applied: 'border-success/40 bg-success/10 text-success',
  refused: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-danger/40 bg-danger/10 text-danger',
  unconfirmed: 'border-warning/40 bg-warning/10 text-warning',
}

export function ClusterPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { nodes, isLoading } = useTopologyStream()
  const [searchParams, setSearchParams] = useSearchParams()

  const { selection, selectNode } = useNodeUrlSelection(nodes)
  const selectedNode = selection.node

  const onlineNodes = useMemo(() => nodes.filter((n) => n.isOnline), [nodes])
  const onlineCount = onlineNodes.length
  const offlineCount = nodes.filter((n) => !n.isOnline).length

  // Cluster-wide "Update all nodes" convenience — sequences nodes AGENTS-FIRST,
  // HUB-LAST so the hub (which hosts the cap routing to every agent) is never
  // restarted before the agents have been kicked. It is sequential, never
  // parallel: each call awaits the previous. This is a GLOBAL action (moved
  // here from the former Server page); per-node update/restart live in each
  // node card's General tab.
  //
  // The sequencing, the outcome classification and the read-back that resolves
  // a dropped connection all live in `lib/cluster-update-all.ts` — including
  // the account of the 2026-09-01 failure this shape exists to prevent. What
  // stays here is the confirm, the seams, and RENDERING the reports: a node
  // whose update was refused or could not be confirmed must say so on screen,
  // because the previous version of this loop said nothing at all.
  //
  // NOTE: there is no probation boot / auto-rollback safety net any more — the
  // single-framework-copy collapse (2026-07-18) removed it. The confirm copy
  // below used to promise one.
  const applyAllMutation = useServerManagementApplyServerUpdate()
  const system = useSystem()
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updateReports, setUpdateReports] = useState<readonly NodeUpdateReport[]>([])

  // D821 Continue-with-hub: agent unlock screen redirects here with
  // `unlockNode` + `returnTo`; mint a ticket and send the browser back.
  const unlockNode = searchParams.get('unlockNode')
  const unlockReturnTo = searchParams.get('returnTo')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  useEffect(() => {
    if (unlockNode === null || unlockReturnTo === null) return
    let cancelled = false
    void (async () => {
      try {
        const raw = await system.trpcClient.addons.custom.mutate({
          addonId: 'system-config',
          action: 'mintAgentUiUnlockTicket',
          input: { nodeId: unlockNode, dashboardBaseUrl: unlockReturnTo },
        })
        if (cancelled) return
        const minted = parseMintUnlockResult(raw)
        const url =
          minted === null
            ? null
            : (minted.dashboardUrl ??
              (() => {
                const u = new URL(unlockReturnTo)
                u.searchParams.set('ticket', minted.ticket)
                return u.toString()
              })())
        if (url === null) {
          setUnlockError('Could not mint an unlock ticket.')
          return
        }
        const next = new URLSearchParams(searchParams)
        next.delete('unlockNode')
        next.delete('returnTo')
        setSearchParams(next, { replace: true })
        window.location.assign(url)
      } catch (err) {
        if (!cancelled) {
          setUnlockError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlockNode, unlockReturnTo, searchParams, setSearchParams, system.trpcClient])

  const handleUpdateAll = useCallback(async (): Promise<void> => {
    const targets: readonly UpdateAllTarget[] = onlineNodes.map((n) => ({
      id: n.id,
      name: n.name,
      isHub: n.isHub,
    }))
    const ok = await confirm({
      title: t('serverManagement.confirmUpdateAllTitle', 'Update all nodes'),
      message: t(
        'serverManagement.confirmUpdateAllBody',
        'Update and restart every online node, agents first, hub last. Up-to-date nodes are skipped; this page reconnects when the hub comes back.',
      ),
      confirmLabel: t('serverManagement.confirmUpdateAllAction', 'Update all & restart'),
      variant: 'warning',
    })
    if (!ok) return
    setUpdatingAll(true)
    setUpdateReports([])
    try {
      const reports = await updateAllNodes(targets, {
        apply: (routing) => applyAllMutation.mutateAsync(routing),
        readStatus: (routing) =>
          system.trpcClient.serverManagement.getServerPackageStatus.query(routing),
        wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      })
      setUpdateReports(reports)
    } finally {
      setUpdatingAll(false)
    }
  }, [applyAllMutation, confirm, onlineNodes, system, t])

  // Natural page flow — `<main>` in AppLayout is the scroll container
  // (`overflow-auto`). `h-full` + an inner `flex-1 overflow-auto` nested a
  // second scroller that only had the leftover viewport after the secret
  // card, so the selected node's detail showed a few centimetres and
  // scrolled internally while the page itself never moved. Sticky tabs on
  // NodeCard resolve against `<main>` once this page stops owning scroll.
  // Gutter comes from AdminPage / PageShell — never a bare outer `p-4`.
  return (
    <AdminPage
      icon={Network}
      title={t('nav.nodes', 'Nodes')}
      subtitle={t(
        'cluster.subtitle',
        'One node at a time — topology and packages. Agents join by pairing (certificate, no shared secret).',
      )}
      actions={
        <>
          {onlineCount > 0 && (
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
              {t('common.onlineCount', { count: onlineCount })}
            </span>
          )}
          {offlineCount > 0 && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
              {t('common.offlineCount', { count: offlineCount })}
            </span>
          )}
          {onlineCount > 1 && (
            <Button
              type="button"
              size="sm"
              disabled={updatingAll}
              title={t(
                'serverManagement.updateAllHint',
                'Sequenced agents-first, hub-last — up-to-date nodes are skipped.',
              )}
              onClick={() => void handleUpdateAll()}
            >
              {updatingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowDownToLine className="h-3.5 w-3.5" />
              )}
              {t('serverManagement.updateAll', 'Update all nodes')}
            </Button>
          )}
        </>
      }
    >
      {updateReports.length > 0 && (
        <ul aria-label="update-all-report" className="flex flex-col gap-1 text-xs">
          {updateReports.map((report) => (
            <li
              key={report.nodeId}
              // The outcome as DATA, not only as rendered prose: the detail
              // string for a refusal starts with "Refused:", so a test reading
              // text alone would pass on a page that mislabels it "applied".
              data-outcome={report.outcome}
              className={`rounded border px-2 py-1 ${OUTCOME_STYLE[report.outcome]}`}
            >
              <span className="font-medium">{report.nodeName}</span>
              <span className="mx-1 uppercase tracking-wide">{report.outcome}</span>
              <span className="opacity-80">{report.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {unlockError !== null && (
        <p
          role="alert"
          className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {t('system.cluster.unlockFromAgentFailed', 'Unlock from agent failed:')} {unlockError}
        </p>
      )}

      <AgentsFoundSection onOpenNode={selectNode} />

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          {t('system.cluster.loadingClusterTopology', 'Loading cluster topology...')}
        </div>
      ) : selectedNode === null ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-foreground-subtle">
          {t('cluster.noNodes', 'No nodes in this cluster yet.')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <StaleNodeNotice staleNodeId={selection.staleNodeId} shownNodeName={selectedNode.name} />
          <NodePicker
            selectedNodeId={selectedNode.id}
            onSelect={selectNode}
            allowOffline
            alwaysShow
          />
          <NodeCard node={selectedNode} />
        </div>
      )}
    </AdminPage>
  )
}
