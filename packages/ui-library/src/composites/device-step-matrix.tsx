/**
 * DeviceStepMatrix — the step × accelerator TABLE of a detection pipeline
 * (D757): the node's Pipeline tab and the camera's Detection pipeline → Steps
 * are this matrix, and a click on a cell (or a step's header) opens that step's
 * settings in a docked panel (`StepDetailDock`) that overlays the page instead
 * of reflowing the matrix.
 *
 *   Column 1 (STICKY): the indented step tree — slot, name, class-flow chips,
 *     and an optional badge (the camera's gate). The header is a button: it
 *     opens the step on the selected accelerator.
 *   Columns 2..N: one per accelerator, grouped under their node; the header
 *     names the accelerator, its format, the model it elects, and "off" for a
 *     switched-off one. A cell shows the model that runs there, or "⚠ skip",
 *     "→ iGPU", "root", "cluster", "ovr", "—".
 *
 * Keyboard: ONE Tab stop (a roving tabindex over the step headers and cells);
 * arrows move, Home / End go to the row's ends, Enter or Space opens.
 *
 * `reserveRightPx`: the width a docked panel covers at the right of the
 * viewport. The matrix adds a trailing spacer that wide (so any column can
 * scroll clear of it) and scrolls the selected cell into the uncovered part —
 * it never shrinks, so nothing reflows when the panel opens.
 *
 * Responsive, container-measured: narrower than the step column plus two
 * columns, the matrix shows ONE node at a time with a node selector.
 */
import { useUiText } from '../contexts/ui-text'
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { Server } from 'lucide-react'
import type { StepTreeNode } from './step-tree'
import { cn } from '../lib/cn'
import {
  type AgentColumn,
  type AgentColumnGroup,
  type CellState,
  type MatrixSelectedCell,
  AGENT_COL_PX,
  AGENT_COL_REM,
  AgentColumnLines,
  agentColumnKey,
  cellButtonClass,
  flattenTree,
  groupAgentColumns,
  GroupedAgentHeader,
  renderCellContent,
  shouldUseSingleNode,
  StepLabel,
} from './pipeline-matrix-shared'

export type { AgentColumn, CellState, MatrixSelectedCell } from './pipeline-matrix-shared'

/** The sticky step column. */
const STEP_COL_REM = 18
const STEP_COL_PX = STEP_COL_REM * 16
/**
 * Narrow (mobile) step-column width. On a phone the wide column would occlude
 * nearly the whole viewport, so the single-node layout pins a slimmer sticky
 * step column and lets the device columns scroll horizontally beside it.
 */
const STEP_COL_SINGLE_REM = 11

export interface DeviceStepMatrixProps {
  readonly tree: readonly StepTreeNode[]
  readonly agents: readonly AgentColumn[]
  readonly getCellState: (addonId: string, agent: AgentColumn) => CellState
  /** `viaKeyboard`: opened with Enter / Space (a host moves focus into its panel). */
  readonly onCellClick: (addonId: string, agent: AgentColumn, viaKeyboard?: boolean) => void
  readonly selectedCell: MatrixSelectedCell | null
  /** Single-node fallback (B): which node the one column shows. */
  readonly fallbackNodeId: string | null
  readonly onFallbackNodeChange: (nodeId: string) => void
  /** A step's header was activated — open the step on the selected accelerator. */
  readonly onStepClick?: (addonId: string, viaKeyboard?: boolean) => void
  /** A badge beside a step's name (the camera's gate). */
  readonly stepBadge?: (addonId: string) => ReactNode
  /** Width a docked panel covers at the viewport's right edge; 0 = none. */
  readonly reserveRightPx?: number
  /** Accessible name of the grid. */
  readonly label?: string
}

/** Imperative focus, so a closing panel can hand focus back to its cell. */
export interface DeviceStepMatrixHandle {
  /** `columnKey` = `agentColumnKey(column)`; `null` = the step's header. */
  readonly focusCell: (addonId: string, columnKey: string | null) => void
}

/** Where a key press moves the roving focus in a `rows × cols` grid. */
export function nextGridPosition(
  key: string,
  pos: { readonly r: number; readonly c: number },
  rows: number,
  cols: number,
): { readonly r: number; readonly c: number } | null {
  const clamp = (r: number, c: number) => ({
    r: Math.max(0, Math.min(rows - 1, r)),
    c: Math.max(0, Math.min(cols - 1, c)),
  })
  switch (key) {
    case 'ArrowRight':
      return clamp(pos.r, pos.c + 1)
    case 'ArrowLeft':
      return clamp(pos.r, pos.c - 1)
    case 'ArrowDown':
      return clamp(pos.r + 1, pos.c)
    case 'ArrowUp':
      return clamp(pos.r - 1, pos.c)
    case 'Home':
      return clamp(pos.r, 0)
    case 'End':
      return clamp(pos.r, cols - 1)
    case 'PageDown':
      return clamp(rows - 1, pos.c)
    case 'PageUp':
      return clamp(0, pos.c)
    default:
      return null
  }
}

function StepCell({
  node,
  depth,
  r,
  tabbable,
  selected,
  badge,
  onClick,
  sticky,
}: {
  readonly node: StepTreeNode
  readonly depth: number
  readonly r: number
  readonly tabbable: boolean
  readonly selected: boolean
  readonly badge: ReactNode
  readonly onClick: ((viaKeyboard: boolean) => void) | undefined
  readonly sticky: boolean
}) {
  return (
    <div
      role="rowheader"
      className={cn('min-w-0 border-b border-border bg-surface', sticky && 'sticky left-0 z-10')}
    >
      <button
        type="button"
        data-r={r}
        data-c={0}
        data-step={node.addonId}
        data-col=""
        tabIndex={tabbable ? 0 : -1}
        aria-current={selected ? 'true' : undefined}
        onClick={onClick ? (e) => onClick(e.detail === 0) : undefined}
        className={cn(
          'flex h-full w-full min-w-0 items-start gap-2 px-3 py-2 text-left text-xs outline-none',
          'hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          selected && 'bg-primary/10 shadow-[inset_3px_0_0_var(--color-primary)]',
        )}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        <StepLabel node={node} />
        {badge}
      </button>
    </div>
  )
}

// ── Node selector (single-node fallback) ─────────────────────────────────────

/**
 * Agents-scoped node selector for the B fallback. Styled like the shared
 * `NodePicker` but driven by THIS matrix's NODE set — the cluster-wide
 * NodePicker can list nodes (e.g. the hub) that own no pipeline column here,
 * which would let the operator select a node the matrix can't show. Selects a
 * NODE (grouping its device sub-columns), never a raw device column.
 */
function NodeSelectorBar({
  nodes,
  selected,
  onSelect,
}: {
  readonly nodes: readonly AgentColumnGroup[]
  readonly selected: string
  readonly onSelect: (nodeId: string) => void
}) {
  const t = useUiText()
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="tablist"
      aria-label={t('uiLibrary.deviceStepMatrix.node', 'Node')}
    >
      <Server className="h-3.5 w-3.5 text-foreground-subtle" />
      <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
        {t('uiLibrary.deviceStepMatrix.node', 'Node')}
      </span>
      <div className="flex overflow-hidden rounded-md border border-border text-[11px] font-medium">
        {nodes.map((a, idx) => {
          const isSelected = a.agentNodeId === selected
          return (
            <button
              key={a.agentNodeId}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => onSelect(a.agentNodeId)}
              title={`${a.columns[0]?.nodeLabel ?? a.agentNodeId} · ${a.engineLabel}`}
              className={cn(
                'px-2.5 py-1 transition-colors',
                isSelected
                  ? 'bg-primary/15 text-primary'
                  : 'bg-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
                idx > 0 && 'border-l border-border',
              )}
            >
              {a.columns[0]?.nodeLabel ?? a.agentNodeId}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Matrix grid ──────────────────────────────────────────────────────────────

interface GridProps {
  readonly tree: readonly StepTreeNode[]
  readonly agents: readonly AgentColumn[]
  readonly getCellState: (addonId: string, agent: AgentColumn) => CellState
  readonly onCellClick: (addonId: string, agent: AgentColumn, viaKeyboard?: boolean) => void
  readonly onStepClick: ((addonId: string, viaKeyboard?: boolean) => void) | undefined
  readonly stepBadge: ((addonId: string) => ReactNode) | undefined
  readonly selectedCell: MatrixSelectedCell | null
  /** Single-node (B): a slimmer sticky step column; the columns still scroll inside the box. */
  readonly single: boolean
  readonly reserveRightPx: number
  readonly label: string
}

const MatrixGrid = forwardRef<DeviceStepMatrixHandle, GridProps>(function MatrixGrid(
  {
    tree,
    agents,
    getCellState,
    onCellClick,
    onStepClick,
    stepBadge,
    selectedCell,
    single,
    reserveRightPx,
    label,
  },
  ref,
) {
  const t = useUiText()
  const rows = useMemo(() => flattenTree(tree), [tree])
  const groups = useMemo(() => groupAgentColumns(agents), [agents])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stepColRem = single ? STEP_COL_SINGLE_REM : STEP_COL_REM
  const gridTemplate = `${stepColRem}rem repeat(${agents.length}, ${AGENT_COL_REM}rem)`
  const cols = agents.length + 1

  // With a panel docked over the right of a NARROW area (the camera page beside
  // its live view), a sticky step column plus the dock can leave less than one
  // column of room — the selected cell would be squeezed out of sight. The step
  // column then scrolls with the cells (still the same width: nothing reflows)
  // so the selected column can sit fully in the free room.
  const [stickySteps, setStickySteps] = useState(true)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || reserveRightPx <= 0) {
      setStickySteps(true)
      return
    }
    const measure = (): void => {
      const left = box.getBoundingClientRect().left
      const room = window.innerWidth - reserveRightPx - left
      setStickySteps(room >= stepColRem * 16 + AGENT_COL_PX + 24)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [reserveRightPx, stepColRem])

  const selectedPos = useMemo(() => {
    if (selectedCell === null) return null
    const r = rows.findIndex((row) => row.node.addonId === selectedCell.addonId)
    if (r < 0) return null
    const c = agents.findIndex((a) => agentColumnKey(a) === agentColumnKey(selectedCell))
    return { r, c: c < 0 ? 0 : c + 1 }
  }, [selectedCell, rows, agents])
  const [focusPos, setFocusPos] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  useEffect(() => {
    if (selectedPos !== null) setFocusPos(selectedPos)
  }, [selectedPos])
  const tab = focusPos.r < rows.length && focusPos.c < cols ? focusPos : { r: 0, c: 0 }

  const focusAt = (r: number, c: number): void => {
    boxRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus()
  }

  useImperativeHandle(
    ref,
    () => ({
      focusCell: (addonId, columnKey) => {
        const r = rows.findIndex((row) => row.node.addonId === addonId)
        if (r < 0) return
        const index =
          columnKey === null ? -1 : agents.findIndex((a) => agentColumnKey(a) === columnKey)
        const c = index < 0 ? 0 : index + 1
        setFocusPos({ r, c })
        focusAt(r, c)
      },
    }),
    [rows, agents],
  )

  // Keep the selected cell visible: scrolled into view, and clear of a docked
  // panel at the right edge (the trailing spacer below guarantees the room).
  useLayoutEffect(() => {
    if (selectedPos === null) return
    const box = boxRef.current
    const el = box?.querySelector<HTMLElement>(
      `[data-r="${selectedPos.r}"][data-c="${selectedPos.c}"]`,
    )
    if (!box || !el) return
    if (typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (reserveRightPx <= 0) return
    const limit = window.innerWidth - reserveRightPx - 12
    const right = el.getBoundingClientRect().right
    if (right > limit) box.scrollLeft += right - limit
  }, [selectedPos, reserveRightPx, stickySteps])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.target instanceof HTMLElement) || e.target.dataset.r === undefined) return
    const pos = { r: Number(e.target.dataset.r), c: Number(e.target.dataset.c) }
    const next = nextGridPosition(e.key, pos, rows.length, cols)
    if (next === null) return
    e.preventDefault()
    setFocusPos(next)
    focusAt(next.r, next.c)
  }

  return (
    <div ref={boxRef} className="overflow-auto rounded border border-border">
      <div className="flex w-max">
        <div
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          className="grid w-max"
          style={{ gridTemplateColumns: gridTemplate }}
          onKeyDown={onKeyDown}
        >
          <div role="row" className="contents">
            <div
              role="columnheader"
              className={cn(
                'top-0 z-20 border-b border-border bg-muted/60 px-3 py-2 text-[10px] uppercase tracking-widest text-foreground-subtle',
                stickySteps ? 'sticky left-0' : 'sticky',
              )}
            >
              {t('uiLibrary.deviceStepMatrix.step', 'Step')}
            </div>
            {groups.map((group) =>
              group.grouped ? (
                <GroupedAgentHeader key={group.agentNodeId} group={group} />
              ) : (
                group.columns.map((col) => (
                  <div
                    key={agentColumnKey(col)}
                    role="columnheader"
                    className={cn(
                      'sticky top-0 z-10 min-w-0 border-b border-l border-border bg-muted/60 px-3 py-2',
                      col.disabled === true && 'opacity-70',
                    )}
                  >
                    <div className="truncate text-xs font-semibold text-foreground">
                      {col.nodeLabel ?? col.agentNodeId}
                    </div>
                    <AgentColumnLines column={col} />
                  </div>
                ))
              ),
            )}
          </div>

          {rows.map(({ node, depth }, r) => (
            <div key={node.addonId} role="row" className="contents">
              <StepCell
                node={node}
                depth={depth}
                r={r}
                tabbable={tab.r === r && tab.c === 0}
                selected={selectedCell?.addonId === node.addonId}
                badge={stepBadge?.(node.addonId)}
                onClick={onStepClick ? (kb) => onStepClick(node.addonId, kb) : undefined}
                sticky={stickySteps}
              />
              {agents.map((a, i) => {
                const state = getCellState(node.addonId, a)
                const isSelected =
                  selectedCell !== null &&
                  selectedCell.addonId === node.addonId &&
                  agentColumnKey(selectedCell) === agentColumnKey(a)
                const actionable = state.kind === 'enabled' || state.kind === 'skip'
                return (
                  <div
                    key={agentColumnKey(a)}
                    role="gridcell"
                    className="min-w-0 border-b border-l border-border"
                  >
                    <button
                      type="button"
                      data-r={r}
                      data-c={i + 1}
                      data-step={node.addonId}
                      data-col={agentColumnKey(a)}
                      tabIndex={tab.r === r && tab.c === i + 1 ? 0 : -1}
                      aria-disabled={!actionable}
                      aria-selected={isSelected}
                      onClick={(e) => {
                        // `detail === 0`: activated from the keyboard, not a pointer.
                        if (actionable) onCellClick(node.addonId, a, e.detail === 0)
                      }}
                      className={cellButtonClass(
                        state,
                        isSelected,
                        cn(
                          'h-full w-full min-w-0 overflow-hidden px-3 py-2 outline-none',
                          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                          !actionable && 'cursor-default hover:bg-transparent',
                          a.disabled === true && 'opacity-70',
                        ),
                      )}
                    >
                      {renderCellContent(t, state)}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        {reserveRightPx > 0 && (
          <div aria-hidden style={{ width: reserveRightPx }} className="shrink-0" />
        )}
      </div>
    </div>
  )
})

// ── Public component ─────────────────────────────────────────────────────────

export const DeviceStepMatrix: ForwardRefExoticComponent<
  DeviceStepMatrixProps & RefAttributes<DeviceStepMatrixHandle>
> = forwardRef<DeviceStepMatrixHandle, DeviceStepMatrixProps>(function DeviceStepMatrix(
  {
    tree,
    agents,
    getCellState,
    onCellClick,
    selectedCell,
    fallbackNodeId,
    onFallbackNodeChange,
    onStepClick,
    stepBadge,
    reserveRightPx = 0,
    label = 'Detection steps',
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (): void => setWidth(el.getBoundingClientRect().width)
    measure()
    const RO = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    RO?.observe(el)
    return () => RO?.disconnect()
  }, [])

  // Group device sub-columns into their nodes. The responsive A↔B decision and
  // the fallback selector operate on NODES (a node may span 2+ device columns).
  const nodes = useMemo(() => groupAgentColumns(agents), [agents])
  // `agents.length` (the total device-column count) drives the SINGLE-node
  // regime: the per-node BASE matrix has ONE node expanded into K accelerator
  // columns, so the fallback must key on those K columns, not the node count.
  const single = shouldUseSingleNode(width, nodes.length, STEP_COL_PX, AGENT_COL_PX, agents.length)

  const selectedNode = useMemo(() => {
    if (nodes.length === 0) return null
    const match = nodes.find((n) => n.agentNodeId === fallbackNodeId)
    return match ?? nodes[0] ?? null
  }, [nodes, fallbackNodeId])

  // A selected cell on another node brings its node into the single-node view —
  // the clicked column is never the one left hidden.
  const selectedNodeId = selectedCell?.agentNodeId
  useEffect(() => {
    if (single && selectedNodeId !== undefined && selectedNodeId !== fallbackNodeId) {
      onFallbackNodeChange(selectedNodeId)
    }
  }, [single, selectedNodeId, fallbackNodeId, onFallbackNodeChange])

  // Single-node (B): show the selected NODE's full set of device sub-columns.
  const shownAgents = single && selectedNode ? selectedNode.columns : agents

  return (
    <div ref={containerRef} className="w-full space-y-2">
      {/* The node selector only makes sense when 2+ nodes compete for the one
          fallback column. The per-node BASE matrix has a single node expanded
          into device columns — the fluid layout already shows them all, so a
          one-tab selector would be dead chrome. */}
      {single && selectedNode && nodes.length > 1 && (
        <NodeSelectorBar
          nodes={nodes}
          selected={selectedNode.agentNodeId}
          onSelect={onFallbackNodeChange}
        />
      )}
      <MatrixGrid
        ref={ref}
        tree={tree}
        agents={shownAgents}
        getCellState={getCellState}
        onCellClick={onCellClick}
        onStepClick={onStepClick}
        stepBadge={stepBadge}
        selectedCell={selectedCell}
        single={single && selectedNode !== null}
        reserveRightPx={reserveRightPx}
        label={label}
      />
    </div>
  )
})
