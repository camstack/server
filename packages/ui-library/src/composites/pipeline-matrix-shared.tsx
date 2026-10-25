/**
 * pipeline-matrix-shared — the presentation primitives shared by every
 * steps×nodes matrix surface (the cluster `PipelineTreeMatrix` and the
 * per-camera `DeviceStepMatrix`). Extracted so the two matrices render an
 * IDENTICAL cell/label/track vocabulary and can never drift apart.
 *
 * Nothing here holds state or talks to a store — pure display + one pure
 * layout-decision helper (`shouldUseSingleNode`).
 */
import { useUiText, type UiTextFn } from '../contexts/ui-text'
import { type ReactNode, type JSX } from 'react'
import type { PipelineSlot } from '@camstack/types'
import type { StepTreeNode } from './step-tree'
import { cn } from '../lib/cn'

export interface AgentColumn {
  readonly agentNodeId: string
  readonly engineLabel: string
  /**
   * When set, this column is a per-device sub-column of its node — one enabled
   * inference accelerator (C7.4). MULTIPLE `AgentColumn`s with the SAME
   * `agentNodeId` and distinct `deviceKey` expand a node into device columns.
   * A column with `deviceKey` undefined is a plain per-node column (today's
   * behaviour — rendered identically).
   */
  readonly deviceKey?: string
  /** Short human label for the device sub-column header (e.g. "Intel NPU"). */
  readonly deviceLabel?: string
  /** The node's display name for the group header (defaults to `agentNodeId`). */
  readonly nodeLabel?: string
  /** A third header line — the model this accelerator elects for detection. */
  readonly detail?: string
  /** The accelerator is switched off: shown, marked, and never a dispatch target. */
  readonly disabled?: boolean
}

/**
 * Stable column identity. Plain per-node columns key by `agentNodeId` (so the
 * rendered `key` is byte-identical to the pre-C7.4 matrix); device sub-columns
 * disambiguate with their `deviceKey`. MUST be used everywhere a React `key`,
 * selection compare, or column identity is derived.
 */
export function agentColumnKey(a: AgentColumnIdentity): string {
  return a.deviceKey !== undefined ? `${a.agentNodeId}::${a.deviceKey}` : a.agentNodeId
}

/** Minimal identity shape shared by `AgentColumn` and `MatrixSelectedCell`. */
export interface AgentColumnIdentity {
  readonly agentNodeId: string
  readonly deviceKey?: string
}

/**
 * The currently-selected cell, identified by step addon + column identity.
 * A plain per-node selection carries no `deviceKey` (so existing consumers pass
 * their `{ addonId, agentNodeId }` state unchanged); a per-device selection adds
 * the `deviceKey` of the picked sub-column.
 */
export interface MatrixSelectedCell {
  readonly addonId: string
  readonly agentNodeId: string
  readonly deviceKey?: string
}

/**
 * A node's header super-cell: one node grouping ONE or MORE consecutive
 * `AgentColumn`s (device sub-columns) that share its `agentNodeId`.
 *   - `grouped: false` — a single plain column (no `deviceKey`): the header
 *     renders EXACTLY the pre-C7.4 single node header (node name + engineLabel).
 *   - `grouped: true`  — 2+ device sub-columns: a node super-label spanning the
 *     sub-columns, with a per-device sub-label row beneath.
 */
export interface AgentColumnGroup {
  readonly agentNodeId: string
  readonly engineLabel: string
  readonly columns: readonly AgentColumn[]
  readonly grouped: boolean
}

/**
 * Coalesce CONSECUTIVE columns that share an `agentNodeId` into node groups.
 * Order-preserving: the flat column order is untouched, so body cells still map
 * 1:1 to `agents`. A run of length 1 is a plain (ungrouped) node header.
 */
export function groupAgentColumns(agents: readonly AgentColumn[]): readonly AgentColumnGroup[] {
  const groups: AgentColumnGroup[] = []
  for (const col of agents) {
    const last = groups[groups.length - 1]
    if (last && last.agentNodeId === col.agentNodeId) {
      const columns = [...last.columns, col]
      groups[groups.length - 1] = { ...last, columns, grouped: columns.length > 1 }
    } else {
      groups.push({
        agentNodeId: col.agentNodeId,
        engineLabel: col.engineLabel,
        columns: [col],
        grouped: false,
      })
    }
  }
  return groups
}

/**
 * A single (step, node) cell's rendered state.
 *   - `enabled`  — the node runs a model for this step (chip + optional `ovr`).
 *   - `disabled` — cluster-default off (used by the per-node matrix only).
 *   - `skip`     — #33: gated ON for the camera but this node has no compatible
 *                  model — a visible amber status, never silent.
 *   - `na`       — not applicable on this node.
 */
export type CellState =
  | {
      readonly kind: 'enabled'
      readonly modelId: string
      readonly overridden?: boolean
      /**
       * Step-tree device jump (phase 1): a short label of the OTHER same-node
       * device this step runs on (operator manual override). Renders a subtle
       * "→ label" badge on the cell.
       */
      readonly jumpTo?: string
      /**
       * This model is a CLUSTER-wide choice, not a per-(node,device) one — the
       * step writes into a shared vector index, where two encoders make
       * similarity scores meaningless.
       *
       * The cell must SAY so. Rendering a cluster value in a per-node matrix
       * with no marking invites the operator to change it expecting a per-node
       * effect, and to read a neighbouring node's identical value as a
       * coincidence rather than as the same single row.
       */
      readonly clusterWide?: boolean
      /**
       * The root model whose output IS this step's result here (D730) — the
       * step's "Use the root model" flag is on and the root supplies it, so the
       * step's own model does not run. Renders a "root" chip: an enabled cell
       * whose model is not the one answering must say so.
       */
      readonly suppliedByRoot?: string
    }
  | { readonly kind: 'disabled'; readonly overridden?: boolean }
  | { readonly kind: 'na' }
  | {
      readonly kind: 'skip'
      /**
       * Step-tree device jump (phase 1): this device's format can't run the
       * step, but it AUTO-jumps to this labelled same-node device — renders a
       * subtle "→ label" badge in place of the "⚠ skip" degrade marker.
       */
      readonly jumpTo?: string
    }

/**
 * Fixed column geometry (rem). Both matrices use CSS-grid STATIC track widths
 * so a cell's content (a status chip, a long model id) can never resize a
 * column or shift its neighbours — content truncates WITHIN the fixed track.
 * This kills the "table dances when the last column's status changes" jitter.
 */
export const AGENT_COL_REM = 13
export const REM_PX = 16
export const AGENT_COL_PX: number = AGENT_COL_REM * REM_PX

export interface FlatRow {
  readonly node: StepTreeNode
  readonly depth: number
}

export function flattenTree(nodes: readonly StepTreeNode[]): readonly FlatRow[] {
  const out: FlatRow[] = []
  const walk = (list: readonly StepTreeNode[], depth: number): void => {
    for (const n of list) {
      out.push({ node: n, depth })
      walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

/**
 * Layout decision for the responsive A↔B switch. Pure so it can be unit-tested
 * in isolation from the DOM. An unmeasured container (`width <= 0`) always
 * defaults to the wide matrix so there is no first-paint flash into the
 * fallback.
 *
 * Two regimes, because the sticky step column occludes the scroll area on a
 * narrow viewport:
 *   - MULTI-node (`nodeCount >= 2`): fall back when the container can't show the
 *     step column plus at least TWO node columns side by side — the fallback
 *     picks ONE node.
 *   - SINGLE node expanded into `columnCount` device sub-columns (the per-node
 *     BASE matrix): the wide grid pins a `sticky left-0` step column (`stepColPx`
 *     wide); on a phone that column covers nearly the whole viewport, so the
 *     horizontal-scroll area behind it shows only slivers of each device column
 *     and no column can be brought fully into view. Fall back to the FLUID
 *     single-node layout whenever all `columnCount` device columns can't sit
 *     beside the step column without scrolling. `columnCount` defaults to
 *     `nodeCount` (one column per node) for the multi-node consumers.
 */
export function shouldUseSingleNode(
  width: number,
  nodeCount: number,
  stepColPx: number,
  agentColPx: number = AGENT_COL_PX,
  columnCount: number = nodeCount,
): boolean {
  if (width <= 0) return false
  if (nodeCount <= 1) {
    return width < stepColPx + agentColPx * columnCount
  }
  return width < stepColPx + agentColPx * 2
}

interface SlotLabelDef {
  readonly labelKey: string
  readonly labelFallback: string
  readonly className: string
}

const SLOT_LABEL: Record<PipelineSlot, SlotLabelDef> = {
  detector: {
    labelKey: 'uiLibrary.pipelineMatrix.slotDetector',
    labelFallback: 'detector',
    className: 'text-emerald-500',
  },
  cropper: {
    labelKey: 'uiLibrary.pipelineMatrix.slotCropper',
    labelFallback: 'cropper',
    className: 'text-blue-500',
  },
  classifier: {
    labelKey: 'uiLibrary.pipelineMatrix.slotClassifier',
    labelFallback: 'classifier',
    className: 'text-violet-500',
  },
  refiner: {
    labelKey: 'uiLibrary.pipelineMatrix.slotRefiner',
    labelFallback: 'refiner',
    className: 'text-amber-500',
  },
  'audio-classifier': {
    labelKey: 'uiLibrary.pipelineMatrix.slotAudioClassifier',
    labelFallback: 'audio classifier',
    className: 'text-pink-500',
  },
}

export function SlotHeading({ slot }: { readonly slot: PipelineSlot }): JSX.Element | null {
  const t = useUiText()
  const cfg = SLOT_LABEL[slot] ?? SLOT_LABEL.classifier
  return (
    <span
      className={cn(
        'text-[9px] font-semibold uppercase tracking-widest leading-none',
        cfg.className,
      )}
    >
      {t(cfg.labelKey, cfg.labelFallback)}
    </span>
  )
}

const CLASS_PILL =
  'inline-flex items-center rounded bg-muted px-1.5 py-px text-[9px] font-medium text-foreground-subtle'

export function ClassChips({
  inputs,
  outputs,
}: {
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
}): JSX.Element | null {
  if (inputs.length === 0 && outputs.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {inputs.map((c) => (
        <span key={`in-${c}`} className={cn(CLASS_PILL, 'bg-blue-500/10 text-blue-500')}>
          {c}
        </span>
      ))}
      {inputs.length > 0 && outputs.length > 0 && (
        <span className="text-foreground-subtle/60 text-[9px]">→</span>
      )}
      {outputs.map((c) => (
        <span key={`out-${c}`} className={cn(CLASS_PILL, 'bg-emerald-500/10 text-emerald-500')}>
          {c}
        </span>
      ))}
    </span>
  )
}

/**
 * Grouped node header (C7.4): a node super-label spanning its device
 * sub-columns, with a per-device sub-label row beneath. Rendered ONLY for a
 * node expanded into 2+ device sub-columns; a single plain column keeps each
 * matrix's own byte-identical single-header markup. The spanning cell uses
 * `gridColumn: span N` so it aligns to its N body columns; the inner flex row
 * gives each device its own equal-width, padded sub-label slot.
 *
 * The node super-label carries ONLY the node id — NOT a single engine/format
 * subtitle. When device sub-columns have differing formats (e.g. Coral `tflite`
 * beside two OpenVINO devices), one node-level format label is a lie taken from
 * the first column; each device's real format is shown per sub-column instead
 * ("Coral Edge TPU · tflite").
 */
/** The per-accelerator lines of a column header: name, format, model, off. */
export function AgentColumnLines({ column }: { readonly column: AgentColumn }): JSX.Element | null {
  const t = useUiText()
  const name = column.deviceLabel ?? column.deviceKey
  return (
    <>
      {(name !== undefined || column.disabled === true) && (
        <div className="flex min-w-0 items-center gap-1">
          {name !== undefined && (
            <span className="truncate text-[10px] font-medium text-foreground/90">{name}</span>
          )}
          {column.disabled === true && (
            <span className="shrink-0 rounded bg-muted px-1 text-[8px] font-semibold uppercase text-foreground-subtle">
              {t('uiLibrary.pipelineMatrixShared.offWord', 'off')}
            </span>
          )}
        </div>
      )}
      <div className="truncate text-[9px] text-foreground-subtle">{column.engineLabel}</div>
      {column.detail !== undefined && (
        <div className="truncate font-mono text-[9px] text-foreground-subtle" title={column.detail}>
          {column.detail}
        </div>
      )}
    </>
  )
}

export function GroupedAgentHeader({
  group,
}: {
  readonly group: AgentColumnGroup
}): JSX.Element | null {
  const nodeLabel = group.columns[0]?.nodeLabel ?? group.agentNodeId
  return (
    <div
      role="columnheader"
      className="sticky top-0 z-10 min-w-0 border-b border-l border-border bg-muted/60"
      style={{ gridColumn: `span ${group.columns.length}` }}
    >
      <div className="truncate px-3 pt-2 pb-1 text-xs font-semibold text-foreground">
        {nodeLabel}
      </div>
      <div className="mt-1 flex border-t border-border/50">
        {group.columns.map((c, i) => (
          <div
            key={agentColumnKey(c)}
            className={cn(
              'min-w-0 flex-1 px-3 py-1',
              i > 0 && 'border-l border-border/50',
              c.disabled === true && 'opacity-70',
            )}
            title={`${c.deviceLabel ?? c.deviceKey} · ${c.engineLabel}${c.detail ? ` · ${c.detail}` : ''}`}
          >
            <AgentColumnLines column={c} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Step label (slot heading + addon name + class chips), shared by both views. */
export function StepLabel({ node }: { readonly node: StepTreeNode }): JSX.Element | null {
  return (
    <div className="flex flex-col gap-1 min-w-0 flex-1">
      <SlotHeading slot={node.slot} />
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold truncate">{node.addonName}</span>
        <ClassChips inputs={node.inputClasses} outputs={node.outputClasses} />
      </div>
    </div>
  )
}

/**
 * Cell content. Width-stable: the status dot is `shrink-0` (reserved space) and
 * the model id truncates inside a `min-w-0` flex row, so a longer model id never
 * widens the cell — it ellipsises instead.
 */
export function renderCellContent(t: UiTextFn, state: CellState): ReactNode {
  if (state.kind === 'enabled') {
    return (
      <span
        className="flex min-w-0 items-center gap-1"
        title={state.overridden ? t('uiLibrary.pipelineMatrix.override', 'override') : undefined}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            state.overridden ? 'bg-amber-500' : 'bg-emerald-500',
          )}
        />
        <span className="font-mono text-foreground truncate">{state.modelId}</span>
        {state.suppliedByRoot !== undefined && (
          <span
            className="ml-auto shrink-0 truncate rounded bg-primary/10 px-1 text-[8px] font-semibold uppercase text-primary"
            title={t(
              'uiLibrary.pipelineMatrix.rootModelTitle',
              "Uses the root model {{model}} — this step's own model does not run here",
              { model: state.suppliedByRoot },
            )}
          >
            {t('uiLibrary.pipelineMatrix.root', 'root')}
          </span>
        )}
        {state.clusterWide === true && (
          <span
            className="ml-auto shrink-0 text-[8px] font-semibold uppercase text-primary"
            title={t(
              'uiLibrary.pipelineMatrix.clusterTitle',
              'One value for the whole cluster — this step writes into a shared vector index',
            )}
          >
            {t('uiLibrary.pipelineMatrix.cluster', 'cluster')}
          </span>
        )}
        {state.jumpTo !== undefined && (
          <span
            className="ml-auto shrink-0 text-[8px] font-semibold text-sky-500"
            title={t('uiLibrary.pipelineMatrix.runsOn', 'runs on {{target}}', {
              target: state.jumpTo,
            })}
          >
            → {state.jumpTo}
          </span>
        )}
        {state.overridden && state.jumpTo === undefined && (
          <span className="ml-auto shrink-0 text-[8px] font-semibold uppercase text-amber-500">
            {t('uiLibrary.pipelineMatrix.ovr', 'ovr')}
          </span>
        )}
      </span>
    )
  }
  if (state.kind === 'disabled') {
    return (
      <span
        className="flex min-w-0 items-center gap-1 text-foreground-subtle"
        title={state.overridden ? t('uiLibrary.pipelineMatrix.override', 'override') : undefined}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            state.overridden ? 'bg-amber-500' : 'border border-foreground-subtle/60',
          )}
        />
        <span className="truncate">{t('uiLibrary.pipelineMatrix.off', 'off')}</span>
        {state.overridden && (
          <span className="ml-auto shrink-0 text-[8px] font-semibold uppercase text-amber-500">
            {t('uiLibrary.pipelineMatrix.ovr', 'ovr')}
          </span>
        )}
      </span>
    )
  }
  if (state.kind === 'skip') {
    // Step-tree device jump (phase 1): this device can't run the step, but
    // another same-node device can — show the auto-resolved target instead of
    // the "⚠ skip" silent-degrade marker.
    if (state.jumpTo !== undefined) {
      return (
        <span
          className="flex min-w-0 items-center gap-1 text-sky-500"
          title={t(
            'uiLibrary.pipelineMatrix.autoJump',
            'no build for this device — auto-jumps to {{target}}',
            { target: state.jumpTo },
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500 shrink-0" />
          <span className="truncate font-medium">→ {state.jumpTo}</span>
        </span>
      )
    }
    return (
      <span
        className="flex min-w-0 items-center gap-1 text-amber-500"
        title={t(
          'uiLibrary.pipelineMatrix.skipTitle',
          'Gated on for this camera, but no compatible model on this node — click to provision',
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
        <span className="truncate font-medium">{t('uiLibrary.pipelineMatrix.skip', '⚠ skip')}</span>
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-1 text-foreground-subtle/70">
      <span className="h-1.5 w-1.5 rounded-full bg-muted shrink-0" />
      <span className="truncate">—</span>
    </span>
  )
}

export function cellButtonClass(state: CellState, isSelected: boolean, extra?: string): string {
  return cn(
    'text-left text-xs hover:bg-muted/40',
    state.kind === 'enabled' && 'bg-emerald-500/5',
    state.kind === 'skip' && 'bg-amber-500/5',
    state.kind === 'na' && 'bg-muted/30',
    isSelected && 'ring-2 ring-primary ring-inset',
    extra,
  )
}
