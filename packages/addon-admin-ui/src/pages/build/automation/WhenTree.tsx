/**
 * WHEN — the one tree an automation says when it runs.
 *
 * Blocks (ALL / ANY) hold rows and further blocks; NOT wraps one row or block.
 * Every block offers "Add row" and "Add block" from inside it, so a nested
 * condition is built where it belongs instead of by grouping afterwards.
 *
 * Every row and block moves up / down among its siblings (the same arrows as
 * the THEN steps), and every nested block or NOT collapses to one line naming
 * what it holds. Order inside a block changes nothing the engine decides.
 *
 * The editor lets the tree pass through a shape the engine refuses (two events
 * under ALL, a block nested too deep). The refusal is NOT drawn inside the
 * tree: the save path shows `validateRecipeBounds`' sentence beside the
 * disabled Save, so the screen and the save path cannot disagree.
 *
 * Firing rule, in one line for the operator: an event starts a run when it
 * happens and the whole tree is true at that moment; a tree of states alone
 * starts one when it becomes true.
 */

import type {
  AutomationLeaf,
  AutomationLeafContext,
  AutomationRecipe,
  AutomationWhen,
  DeviceIsLeaf,
  TraceNodeOutcome,
} from '@camstack/types'
import { baseUnitForQuantity, countWhenLeaves, isLeaf, MAX_WHEN_LEAVES } from '@camstack/types'
import { Badge, Button, DisclosureChevron, Select } from '@camstack/ui-library'
import { Plus, Trash2, Ungroup } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toneBorderClass, toneEdgeClass } from '../flow/RunsPanel'
import { ConditionResult } from '../flow/TraceResult'
import { type ConditionNodeView, valueInUnit, type WhenRunView } from '../flow/trace-view'
import type { AutomationDevice } from './automation-data'
import { useFieldDescriptor } from './FieldPicker'
import { childRails, railClass, ROOT_RAIL } from './group-rail'
import { type MoveControls, MoveButtons } from './MoveButtons'
import { leafKindLabel, newLeaf } from './recipe-parts'
import { LeafKindPickerModal } from './LeafKindPickerModal'
import { WhenLeafRow } from './WhenLeafRow'
import { declaredQuantity } from './ValueInput'
import {
  addNode,
  type ContainerKind,
  canNestBlockAt,
  moveNode,
  negate,
  pathKey,
  removeNode,
  seedBlock,
  setContainerKind,
  summarizeWhen,
  swapPathKeys,
  unnegate,
  updateNode,
  type WhenPath,
  whenBudget,
  whenRoot,
} from './when-ops'

export interface WhenTreeProps {
  readonly recipe: AutomationRecipe
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationRecipe) => void
  /** The selected run: what each node decided (by path key, `when.0.1`) and the trigger's values. */
  readonly run?: WhenRunView | null
  /** Hide the run-start sentence: the tree is a plain condition (a step's `if`), not what starts a run. */
  readonly hideRule?: boolean
  /** Where the tree lives: the automation's `when` (default) or a step's `if`, which takes states only. */
  readonly context?: Extract<AutomationLeafContext, 'trigger' | 'guard'>
}

interface TreeContext {
  readonly leafContext: Extract<AutomationLeafContext, 'trigger' | 'guard'>
  readonly recipe: AutomationRecipe
  readonly devices: readonly AutomationDevice[]
  readonly run: WhenRunView | null
  readonly onChange: (next: AutomationRecipe) => void
  /** An edit that shifts indices (remove, NOT): collapsed blocks reopen. */
  readonly reshape: (next: AutomationRecipe) => void
  readonly collapsed: ReadonlySet<string>
  readonly toggleCollapsed: (path: WhenPath) => void
  /** Up / down for the child at `index` of a block with `count` children. */
  readonly moveControls: (path: WhenPath, count: number) => MoveControls
}

function asContainerKind(value: string): ContainerKind {
  return value === 'any' ? 'any' : 'all'
}

function toneOf(outcome: TraceNodeOutcome): 'pass' | 'fail' | 'idle' {
  return outcome === 'pass' ? 'pass' : outcome === 'fail' ? 'fail' : 'idle'
}

/** A row is filled; a block or NOT only draws its edge, so nested tints never stack. */
function toneFor(
  outcome: TraceNodeOutcome | undefined,
  fallback: string,
  fill: boolean = true,
): string {
  if (outcome === undefined) return fallback
  return fill ? toneBorderClass(toneOf(outcome)) : toneEdgeClass(toneOf(outcome))
}

/** The run's node at `path`, when a run is selected and recorded one there. */
function nodeAt(ctx: TreeContext, path: WhenPath): ConditionNodeView | undefined {
  return ctx.run?.nodes.get(pathKey(path))
}

export function WhenTree({
  recipe,
  devices,
  onChange,
  run = null,
  hideRule = false,
  context = 'trigger',
}: WhenTreeProps) {
  const { t } = useTranslation()
  const root = whenRoot(recipe)
  const budget = whenBudget(recipe)
  // Collapse is keyed by path (rows carry no id): a move swaps the two
  // subtrees' keys, an edit that shifts indices reopens everything.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const ctx: TreeContext = {
    leafContext: context,
    recipe,
    devices,
    run,
    onChange,
    reshape: (next) => {
      setCollapsed(new Set())
      onChange(next)
    },
    collapsed,
    toggleCollapsed: (path) => {
      const key = pathKey(path)
      setCollapsed((prev) =>
        prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : new Set([...prev, key]),
      )
    },
    moveControls: (path, count) => {
      const index = path[path.length - 1] ?? 0
      const step = (delta: -1 | 1) => () => {
        const sibling = [...path.slice(0, -1), index + delta]
        setCollapsed((prev) => swapPathKeys(prev, path, sibling))
        onChange(moveNode(recipe, path, delta))
      }
      return {
        up: index > 0 ? step(-1) : null,
        down: index < count - 1 ? step(1) : null,
      }
    },
  }
  const empty = root.children.length === 0
  return (
    <div className="space-y-2" data-testid="when-tree">
      {!hideRule && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'automation.whenTree.rule',
            'An event starts a run when it happens and everything here is true at that moment. With only states, a run starts when they become true.',
          )}
        </p>
      )}
      <BlockView
        block={root}
        path={[]}
        ctx={ctx}
        underNot={false}
        rail={ROOT_RAIL}
        budgetText={t('automation.whenTree.budget', {
          depth: budget.depth,
          depthLimit: budget.depthLimit,
          leaves: budget.leaves,
          leafLimit: budget.leafLimit,
        })}
        move={null}
        emptyHint={
          empty && !hideRule
            ? t(
                'automation.whenTree.empty',
                'Add a row to say when this runs. Without one nothing can ever start this automation.',
              )
            : null
        }
      />
    </div>
  )
}

interface NodeViewProps {
  readonly node: AutomationWhen
  readonly path: WhenPath
  readonly ctx: TreeContext
  /** The parent is a NOT: a second one is never offered (it would cancel). */
  readonly underNot: boolean
  /** Up / down among its siblings; null for the child of a NOT (it has none). */
  readonly move: MoveControls | null
  /** The group rail a block (or the block inside a NOT) here draws; unused by a row. */
  readonly rail: number
}

function NodeView({ node, path, ctx, underNot, move, rail }: NodeViewProps) {
  if (isLeaf(node)) {
    return <LeafView leaf={node} path={path} ctx={ctx} underNot={underNot} move={move} />
  }
  if (node.kind === 'not') {
    return <NotView child={node.child} path={path} ctx={ctx} move={move} rail={rail} />
  }
  return (
    <BlockView
      block={node}
      path={path}
      ctx={ctx}
      underNot={underNot}
      move={move}
      rail={rail}
      budgetText={null}
      emptyHint={null}
    />
  )
}

interface LeafViewProps {
  readonly leaf: AutomationLeaf
  readonly path: WhenPath
  readonly ctx: TreeContext
  readonly underNot: boolean
  readonly move: MoveControls | null
}

function LeafView({ leaf, path, ctx, underNot, move }: LeafViewProps) {
  const node = nodeAt(ctx, path)
  const vars = ctx.run !== null && ctx.run.triggerPath === pathKey(path) ? ctx.run.vars : undefined
  return (
    <WhenLeafRow
      leaf={leaf}
      devices={ctx.devices}
      context={ctx.leafContext}
      underNot={underNot}
      toneClass={toneFor(node?.outcome, 'border-border')}
      result={node === undefined ? undefined : <LeafResult leaf={leaf} node={node} vars={vars} />}
      onNegate={underNot ? null : () => ctx.reshape(negate(ctx.recipe, path))}
      {...(move === null ? {} : { move })}
      onChange={(next) => ctx.onChange(updateNode(ctx.recipe, path, next))}
      onRemove={() => ctx.reshape(removeNode(ctx.recipe, path))}
    />
  )
}

interface LeafResultProps {
  readonly leaf: AutomationLeaf
  readonly node: ConditionNodeView
  readonly vars: WhenRunView['vars'] | undefined
}

/** A state row compares in the unit its row picked; every other row shows the trace as stored. */
function LeafResult({ leaf, node, vars }: LeafResultProps) {
  if (leaf.kind === 'device-is' && leaf.unit !== undefined) {
    return <DeviceIsResult leaf={leaf} node={node} vars={vars} />
  }
  return (
    <ConditionResult node={node} vars={vars} expected={node.expected} observed={node.observed} />
  )
}

function DeviceIsResult({ leaf, node, vars }: LeafResultProps & { readonly leaf: DeviceIsLeaf }) {
  const descriptor = useFieldDescriptor({
    deviceId: leaf.deviceId,
    cap: leaf.cap,
    fieldPath: leaf.fieldPath,
  })
  const quantity = declaredQuantity(descriptor)
  const base = quantity === undefined ? undefined : baseUnitForQuantity(quantity)
  const inRowUnit = (raw: ConditionNodeView['rawExpected']) =>
    raw === undefined ? null : valueInUnit(raw, base, leaf.unit)
  return (
    <ConditionResult
      node={node}
      vars={vars}
      expected={inRowUnit(node.rawExpected)}
      observed={inRowUnit(node.rawObserved)}
    />
  )
}

/** A sub-block's own verdict: outcome and the engine's reason, no values. */
function BlockResult({ node }: { readonly node: ConditionNodeView | undefined }) {
  if (node === undefined) return null
  return <ConditionResult node={node} expected={null} observed={null} />
}

interface CollapseToggleProps {
  readonly expanded: boolean
  readonly onToggle: () => void
}

/** The disclosure marker of a nested block or NOT header. */
function CollapseToggle({ expanded, onToggle }: CollapseToggleProps) {
  const { t } = useTranslation()
  const label = expanded
    ? t('automation.whenTree.collapse', 'Collapse this block')
    : t('automation.whenTree.expand', 'Expand this block')
  return (
    <Button
      variant="ghost"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <DisclosureChevron expanded={expanded} />
    </Button>
  )
}

/** A collapsed block's one line: how many rows, and each by its type. */
function BlockSummary({ node }: { readonly node: AutomationWhen }) {
  const { t } = useTranslation()
  const text = `${t('automation.whenTree.rowCount', { count: countWhenLeaves(node) })} · ${summarizeWhen(node, leafKindLabel)}`
  return (
    <p
      data-testid="when-block-summary"
      title={text}
      className="break-words text-xs text-foreground-muted sm:truncate"
    >
      {text}
    </p>
  )
}

interface NotViewProps {
  readonly child: AutomationWhen
  readonly path: WhenPath
  readonly ctx: TreeContext
  readonly move: MoveControls | null
  readonly rail: number
}

function NotView({ child, path, ctx, move, rail }: NotViewProps) {
  const { t } = useTranslation()
  const expanded = !ctx.collapsed.has(pathKey(path))
  return (
    <div
      className={`space-y-1.5 rounded border p-2 ${toneFor(nodeAt(ctx, path)?.outcome, 'border-warning/40', false)}`}
      data-testid="when-not"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CollapseToggle expanded={expanded} onToggle={() => ctx.toggleCollapsed(path)} />
        <Badge variant="warning">{'NOT'}</Badge>
        <span className="text-xs text-foreground-subtle">
          {t('automation.whenTree.notHint', 'True when what is below is not')}
        </span>
        <span className="flex-1" />
        {move !== null && <MoveButtons move={move} />}
        <Button
          variant="ghost"
          onClick={() => ctx.reshape(unnegate(ctx.recipe, path))}
          title={t('automation.whenTree.removeNot', 'Remove the NOT, keeping what is inside')}
        >
          <Ungroup className="h-3.5 w-3.5" />{' '}
          {t('automation.whenTree.removeNotLabel', 'Remove NOT')}
        </Button>
      </div>
      <BlockResult node={nodeAt(ctx, path)} />
      {expanded ? (
        <div className="pl-3">
          <NodeView node={child} path={[...path, 0]} ctx={ctx} underNot move={null} rail={rail} />
        </div>
      ) : (
        <BlockSummary node={child} />
      )}
    </div>
  )
}

interface BlockViewProps {
  readonly block: Extract<AutomationWhen, { kind: 'all' | 'any' }>
  readonly path: WhenPath
  readonly ctx: TreeContext
  readonly underNot: boolean
  /** Up / down among its siblings; null for the root and the child of a NOT. */
  readonly move: MoveControls | null
  /** This block's group colour, drawn as the rail down its rows (`group-rail.ts`). */
  readonly rail: number
  /** Shown on the root only. */
  readonly budgetText: string | null
  readonly emptyHint: string | null
}

function BlockView({
  block,
  path,
  ctx,
  underNot,
  move,
  rail,
  budgetText,
  emptyHint,
}: BlockViewProps) {
  const { t } = useTranslation()
  const isRoot = path.length === 0
  // The root is the section itself: only nested blocks collapse.
  const expanded = isRoot || !ctx.collapsed.has(pathKey(path))
  const nestable = canNestBlockAt(ctx.recipe, path)
  const [picking, setPicking] = useState(false)
  const rails = childRails(block.children, rail)
  const kinds = [
    { value: 'all', label: t('automation.whenTree.allOf', 'All of (AND)') },
    { value: 'any', label: t('automation.whenTree.anyOf', 'Any of (OR)') },
  ]
  return (
    <div
      className={`space-y-2 rounded border p-2 ${toneFor(nodeAt(ctx, path)?.outcome, 'border-border', false)}`}
      data-testid="when-block"
      data-kind={block.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!isRoot && (
          <CollapseToggle expanded={expanded} onToggle={() => ctx.toggleCollapsed(path)} />
        )}
        <div className="w-40">
          <Select
            aria-label={t('automation.whenTree.blockKind', 'How the rows below combine')}
            data-testid="when-block-kind"
            value={block.kind}
            options={kinds}
            onChange={(e) =>
              ctx.onChange(setContainerKind(ctx.recipe, path, asContainerKind(e.target.value)))
            }
          />
        </div>
        {budgetText !== null && (
          <span className="text-xs text-foreground-subtle">{budgetText}</span>
        )}
        <span className="flex-1" />
        {move !== null && <MoveButtons move={move} />}
        {!isRoot && !underNot && (
          <Button
            variant="ghost"
            onClick={() => ctx.reshape(negate(ctx.recipe, path))}
            title={t('automation.whenTree.negateBlock', 'Invert this block (NOT)')}
          >
            {'NOT'}
          </Button>
        )}
        {!isRoot && (
          <Button
            variant="ghost"
            onClick={() => ctx.reshape(removeNode(ctx.recipe, path))}
            title={t('automation.whenTree.removeBlock', 'Delete this block and everything in it')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <BlockResult node={nodeAt(ctx, path)} />
      {emptyHint !== null && <p className="text-xs text-foreground-subtle">{emptyHint}</p>}
      {!expanded && <BlockSummary node={block} />}

      {expanded && block.children.length > 0 && (
        <div
          className={`space-y-1.5 border-l-2 pl-3 ${railClass(rail)}`}
          data-testid="when-block-rail"
          data-rail={rail}
        >
          {block.children.map((child, index) => (
            <NodeView
              // Path is the identity: rows carry no id.
              key={pathKey([...path, index])}
              node={child}
              path={[...path, index]}
              ctx={ctx}
              underNot={false}
              move={ctx.moveControls([...path, index], block.children.length)}
              rail={rails[index] ?? rail}
            />
          ))}
        </div>
      )}

      {expanded && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setPicking(true)}
            title={t('automation.whenTree.addRowTitle', 'Add one row: an event or a state')}
          >
            <Plus className="h-4 w-4" /> {t('automation.whenTree.addRow', 'Add row')}
          </Button>
          <LeafKindPickerModal
            open={picking}
            onOpenChange={setPicking}
            mode="add"
            context={ctx.leafContext}
            underNot={underNot}
            treeFull={countWhenLeaves(whenRoot(ctx.recipe)) >= MAX_WHEN_LEAVES}
            onPick={(kind) => ctx.onChange(addNode(ctx.recipe, path, newLeaf(kind)))}
          />
          <Button
            variant="outline"
            disabled={!nestable}
            onClick={() =>
              ctx.onChange(
                addNode(ctx.recipe, path, seedBlock(block.kind === 'all' ? 'any' : 'all')),
              )
            }
            title={
              nestable
                ? t('automation.whenTree.addBlockTitle', 'Add a nested block of rows')
                : t('automation.whenTree.tooDeep', 'The rules nest at most {{max}} levels deep', {
                    max: whenBudget(ctx.recipe).depthLimit,
                  })
            }
          >
            <Plus className="h-4 w-4" /> {t('automation.whenTree.addBlock', 'Add block')}
          </Button>
        </div>
      )}
    </div>
  )
}
