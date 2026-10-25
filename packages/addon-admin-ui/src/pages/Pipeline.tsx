/**
 * Pipeline page — master-detail view of the distributed detection pipeline.
 *
 * Two top-level modes, toggled via the `?view=` search param:
 *
 *   Nodes (default, `?view=nodes` or no param) — node-centric master-detail:
 *     Left rail: list of nodes (hub + online agents) plus a synthetic "Cluster"
 *     entry. Right pane: NodeDetail or ClusterDetail.
 *
 *   Cameras (`?view=cameras`) — camera-centric operational roster:
 *     One card per camera with every pipeline parameter that matters
 *     operationally (placement, detection runtime, streams, steps, broker,
 *     decoder) and loud problem surfacing. No charts — see
 *     `components/pipeline/cameras/CamerasOverview.tsx`.
 *
 * Chrome is library `PageShell` (AdminPage's wrapper) so the gutter matches
 * every other Cluster page — never a bare outer `p-4` / top-bar pad stack.
 */
import { useState, useEffect, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, GitBranch, RefreshCw } from 'lucide-react'
import { Button, PageShell } from '@camstack/ui-library'
import { NodeList } from '../components/pipeline/NodeList'
import { NodeDetail } from '../components/pipeline/NodeDetail'
import { ClusterDetail } from '../components/pipeline/ClusterDetail'
import { CamerasOverview } from '../components/pipeline/cameras/CamerasOverview'
import { useTranslation } from 'react-i18next'

/** Synthetic "all cluster settings" entry shown at the top of the node list. */
export const CLUSTER_NODE_ID = '__cluster__'

/** Top-level view mode for the Pipeline page. */
type PipelineViewMode = 'nodes' | 'cameras'

/** Parse the `?view=` param; default to `'nodes'`. */
function parseViewMode(raw: string | null): PipelineViewMode {
  return raw === 'cameras' ? 'cameras' : 'nodes'
}

function ViewModeToggle({
  viewMode,
  onNodes,
  onCameras,
}: {
  readonly viewMode: PipelineViewMode
  readonly onNodes: () => void
  readonly onCameras: () => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5"
      role="tablist"
      aria-label={t('pipeline.pipelineView', 'Pipeline view')}
    >
      <button // ui-check-ok: segmented view toggle; Button chrome fights the selected pill
        type="button"
        role="tab"
        aria-selected={viewMode === 'nodes'}
        onClick={onNodes}
        className={[
          'rounded-md px-3 py-1 text-[11px] font-medium transition-colors',
          viewMode === 'nodes'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-foreground-subtle hover:text-foreground',
        ].join(' ')}
      >
        {t('pipeline.nodes', 'Nodes')}
      </button>
      <button // ui-check-ok: segmented view toggle; Button chrome fights the selected pill
        type="button"
        role="tab"
        aria-selected={viewMode === 'cameras'}
        onClick={onCameras}
        className={[
          'rounded-md px-3 py-1 text-[11px] font-medium transition-colors',
          viewMode === 'cameras'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-foreground-subtle hover:text-foreground',
        ].join(' ')}
      >
        {t('pipeline.cameras', 'Cameras')}
      </button>
    </div>
  )
}

export function PipelinePage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const viewMode = parseViewMode(params.get('view'))
  const selected = params.get('node') ?? CLUSTER_NODE_ID

  // Force a refetch cascade across the child queries by bumping a counter
  // that's included in every queryKey downstream (Nodes mode) or wired to a
  // query invalidation (Cameras mode). Used by the top-right refresh button.
  const [refreshToken, setRefreshToken] = useState(0)

  // Mobile: the left rail (node list) is collapsible so it doesn't eat
  // ~half the viewport on a narrow screen — collapsed by default so the detail
  // pane (its own scroll container) opens full-height; selecting an item
  // auto-collapses it. Always visible on md+ (the toggle is `md:hidden`).
  // Only relevant in Nodes mode — the Cameras roster has no rail.
  const [railOpen, setRailOpen] = useState(false)

  // Nodes mode: ensure ?node= is always present so deep-link is stable.
  // Keep the other params (`?ctab=`) — replacing the whole query drops a
  // link that lands on a cluster tab.
  useEffect(() => {
    if (viewMode === 'nodes' && !params.get('node')) {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev)
          out.set('view', 'nodes')
          out.set('node', CLUSTER_NODE_ID)
          return out
        },
        { replace: true },
      )
    }
  }, [viewMode, params, setParams])

  const handleSelectNode = (nodeId: string): void => {
    setParams({ view: 'nodes', node: nodeId }, { replace: true })
    setRailOpen(false)
  }

  const handleSwitchToNodes = (): void => {
    setParams({ view: 'nodes', node: selected }, { replace: true })
  }

  const handleSwitchToCameras = (): void => {
    setParams({ view: 'cameras' }, { replace: true })
  }

  return (
    <PageShell
      icon={GitBranch}
      title={t('pipeline.pipeline', 'Pipeline')}
      subtitle={t(
        'pipeline.detectionPlacementLoadAndPer',
        'Detection placement, load and per-camera runtime across the cluster.',
      )}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRefreshToken((n) => n + 1)}
          title={t('common.refresh', 'Refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('common.refresh', 'Refresh')}
        </Button>
      }
      nav={
        <ViewModeToggle
          viewMode={viewMode}
          onNodes={handleSwitchToNodes}
          onCameras={handleSwitchToCameras}
        />
      }
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {/* Mobile-only rail toggle — collapses the node list so the detail
          pane gets the full viewport height. Hidden on md+ (rail always
          shown). Nodes mode only — the Cameras roster is a single column. */}
      {viewMode === 'nodes' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRailOpen((open) => !open)}
          aria-expanded={railOpen}
          className="flex w-full shrink-0 justify-between border-b border-border md:hidden"
        >
          <span>{railOpen ? t('pipeline.hideNodeList') : t('pipeline.showNodeList')}</span>
          <ChevronDown
            className={['h-4 w-4 transition-transform', railOpen ? 'rotate-180' : ''].join(' ')}
          />
        </Button>
      )}

      {/* Master-detail body.
          Only ONE vertical scroll container exists inside the right
          pane: the tab-content div owned by NodeDetail / ClusterDetail
          (Nodes mode) or the roster scroll container (Cameras mode).
          The AppLayout's <main> is `overflow-hidden` for this route
          (see `FULL_HEIGHT_ROUTES` in `AppLayout.tsx`) so we don't get
          nested scrollbars stacking over the same content. `min-h-0`
          on the flex row lets the flex children actually shrink below
          their intrinsic height so their own `h-full` resolves. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {viewMode === 'nodes' ? (
          <>
            <aside
              className={[
                railOpen ? 'block' : 'hidden',
                'md:block w-full md:w-72 shrink-0 border-b border-border md:border-b-0 md:border-r',
                'max-h-[60vh] overflow-y-auto md:max-h-none',
              ].join(' ')}
            >
              <NodeList
                selectedNodeId={selected}
                onSelect={handleSelectNode}
                refreshToken={refreshToken}
              />
            </aside>
            {/* plain div (not <main>) — AppLayout already owns the outer <main> */}
            <section className="min-h-0 flex-1 overflow-hidden">
              {selected === CLUSTER_NODE_ID ? (
                <ClusterDetail refreshToken={refreshToken} />
              ) : (
                <NodeDetail nodeId={selected} refreshToken={refreshToken} />
              )}
            </section>
          </>
        ) : (
          <section className="min-h-0 flex-1 overflow-hidden">
            <CamerasOverview refreshToken={refreshToken} />
          </section>
        )}
      </div>
    </PageShell>
  )
}
