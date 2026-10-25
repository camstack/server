/**
 * NodePicker — shared cluster-node pill bar.
 *
 * Uses `useClusterNodes` hook so every consumer hits the same React-Query
 * cache. Renders a `Server` icon + label + segmented pill bar with one
 * button per node (hub first), tinted from agent-settings palette colours.
 * Offline nodes stay listed; they are disabled unless `allowOffline`.
 *
 * Used by admin-ui Addons page, benchmark addon page, pipeline page, etc.
 */
import { useUiText } from '../contexts/ui-text'
import { Server } from 'lucide-react'
import { useMemo, type JSX } from 'react'
import { usePipelineOrchestratorListAgentSettings } from '../generated/system-hooks'
import { useClusterNodes } from '../hooks/use-cluster-nodes'
import { cn } from '../lib/cn'
import { nodeSoftBgClass, nodeTextColorClass } from './node-color'
import { buildColorByNodeId, colorIdForNode } from './node-color-map'

export interface NodePickerProps {
  readonly selectedNodeId: string
  readonly onSelect: (nodeId: string) => void
  /** Caption shown before the pill bar. Defaults to `Node`. */
  readonly label?: string
  /** Hide the leading `Server` icon (compact toolbars). */
  readonly hideIcon?: boolean
  /**
   * When true, render even when only the hub is online. Useful when
   * the surrounding UI relies on the picker as a layout anchor; the
   * default hides the picker since there's nothing to choose.
   */
  readonly alwaysShow?: boolean
  /** When true, offline nodes stay enabled and selectable. Default false. */
  readonly allowOffline?: boolean
}

export function NodePicker({
  selectedNodeId,
  onSelect,
  label = 'Node',
  hideIcon = false,
  alwaysShow = false,
  allowOffline = false,
}: NodePickerProps): JSX.Element | null {
  const t = useUiText()
  const { nodes } = useClusterNodes()
  const settingsQuery = usePipelineOrchestratorListAgentSettings(undefined)
  const colorByNodeId = useMemo(() => buildColorByNodeId(settingsQuery.data), [settingsQuery.data])

  if (!alwaysShow && nodes.length <= 1) return null

  return (
    <div className="flex h-7 items-center gap-1.5">
      {!hideIcon && <Server className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />}
      {label ? (
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</span>
      ) : null}
      {/* h-7 matches Select — a shorter bar looked mid-height next to filters. */}
      <div className="flex h-7 overflow-hidden rounded-md border border-border text-xs font-medium">
        {nodes.map((node, idx) => {
          const isSelected = selectedNodeId === node.id
          const colorId = colorIdForNode(colorByNodeId, node.id)
          const disabled = !allowOffline && !node.isOnline
          return (
            // ui-check-ok: segmented NodePicker pills share one border chrome; Button sizes fight the bar
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              disabled={disabled}
              title={
                node.isOnline
                  ? node.name
                  : t('uiLibrary.nodePicker.offline', '{{name}} (offline)', { name: node.name })
              }
              className={cn(
                'inline-flex h-7 items-center px-2.5 transition-colors',
                isSelected
                  ? cn(nodeSoftBgClass(colorId), nodeTextColorClass(colorId))
                  : cn(
                      'bg-transparent hover:bg-surface-hover',
                      nodeTextColorClass(colorId),
                      !disabled && 'opacity-70 hover:opacity-100',
                    ),
                idx > 0 && 'border-l border-border',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {node.shortName}
            </button>
          )
        })}
      </div>
    </div>
  )
}
