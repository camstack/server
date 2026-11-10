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
import { useState, useMemo, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ArrowDownToLine, Network } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, NodePicker, useClusterTopology, useSystem } from '@camstack/ui-library'
import { AdminPage } from '../../components/AdminPage'
import { ClusterUpdateDialog } from '../../components/cluster/ClusterUpdateDialog'
import { AgentsFoundSection } from '../../components/cluster/pairing/AgentsFoundSection'
import { NodeCard, type NodeData } from '../../components/cluster/NodeCard'
import { StaleNodeNotice } from '../../components/shared/StaleNodeNotice'
import { useNodeUrlSelection } from '../../hooks/useNodeUrlSelection'
import { parseMintUnlockResult } from '../../lib/agent-dashboard-unlock'

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

export function ClusterPage() {
  const { t } = useTranslation()
  const { nodes, isLoading } = useTopologyStream()
  const [searchParams, setSearchParams] = useSearchParams()

  const { selection, selectNode } = useNodeUrlSelection(nodes)
  const selectedNode = selection.node

  const onlineNodes = useMemo(() => nodes.filter((n) => n.isOnline), [nodes])
  const onlineCount = onlineNodes.length
  const offlineCount = nodes.filter((n) => !n.isOnline).length

  // "Update all" opens the hub's cluster-update job (preview, confirm, then
  // the step list). The hub runs backup, itself, each agent and the addons;
  // this page only follows `getClusterUpdateJob`. A job already running is
  // the resume strip inside `ClusterUpdateDialog`.
  const system = useSystem()
  const [clusterUpdateOpen, setClusterUpdateOpen] = useState(false)

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
          <Button
            type="button"
            size="sm"
            title={t(
              'clusterUpdate.updateAllHint',
              'Preview the hub plan, then follow the same job the CLI uses.',
            )}
            onClick={() => setClusterUpdateOpen(true)}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            {t('clusterUpdate.updateAll', 'Update all nodes')}
          </Button>
        </>
      }
    >
      <ClusterUpdateDialog open={clusterUpdateOpen} onOpenChange={setClusterUpdateOpen} />

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
