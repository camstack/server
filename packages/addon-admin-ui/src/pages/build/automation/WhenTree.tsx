/**
 * WHEN — the one tree an automation says when it runs.
 *
 * Blocks (ALL / ANY) hold rows and further blocks; NOT wraps one row or block.
 * Every block offers "Add row" and "Add block" from inside it, so a nested
 * condition is built where it belongs instead of by grouping afterwards.
 *
 * The editor lets the tree pass through a shape the engine refuses (two events
 * under ALL, a block nested too deep) and says so ON the block at fault, with
 * `validateWhenTree`'s own sentence — never re-worded here, so the screen and
 * the save path cannot disagree. Save stays blocked until it is fixed.
 *
 * Firing rule, in one line for the operator: an event starts a run when it
 * happens and the whole tree is true at that moment; a tree of states alone
 * starts one when it becomes true.
 */

import type {
  AutomationLeaf,
  AutomationRecipe,
  AutomationWhen,
  DeviceIsLeaf,
  TraceNodeOutcome,
} from '@camstack/types'
import { baseUnitForQuantity, isLeaf } from '@camstack/types'
import { Badge, Button, Select } from '@camstack/ui-library'
import { Plus, Trash2, Ungroup } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toneBorderClass, toneEdgeClass } from '../flow/RunsPanel'
import { ConditionResult } from '../flow/TraceResult'
import { type ConditionNodeView, valueInUnit, type WhenRunView } from '../flow/trace-view'
import type { AutomationDevice } from './automation-data'
import { useFieldDescriptor } from './FieldPicker'
import { newLeaf } from './recipe-parts'
import { WhenLeafRow } from './WhenLeafRow'
import { declaredQuantity } from './ValueInput'
import {
  addNode,
  type ContainerKind,
  canNestBlockAt,
  negate,
  pathKey,
  removeNode,
  seedBlock,
  setContainerKind,
  ungroup,
  unnegate,
  updateNode,
  type WhenPath,
  whenBudget,
  whenIssues,
  whenRoot,
} from './when-ops'

export interface WhenTreeProps {
  readonly recipe: AutomationRecipe
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationRecipe) => void
  /** The selected run: what each node decided (by path key, `when.0.1`) and the trigger's values. */
  readonly run?: WhenRunView | null
}

interface TreeContext {
  readonly recipe: AutomationRecipe
  readonly devices: readonly AutomationDevice[]
  readonly issues: ReadonlyMap<string, string>
  readonly run: WhenRunView | null
  readonly onChange: (next: AutomationRecipe) => void
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

export function WhenTree({ recipe, devices, onChange, run = null }: WhenTreeProps) {
  const { t } = useTranslation()
  const root = whenRoot(recipe)
  const budget = whenBudget(recipe)
  const issues = useMemo(() => whenIssues(root), [root])
  const ctx: TreeContext = { recipe, devices, issues, run, onChange }
  const empty = root.children.length === 0
  return (
    <div className="space-y-2" data-testid="when-tree">
      <p className="text-xs text-foreground-subtle">
        {t(
          'automation.whenTree.rule',
          'An event starts a run when it happens and everything here is true at that moment. With only states, a run starts when they become true.',
        )}
      </p>
      <BlockView
        block={root}
        path={[]}
        ctx={ctx}
        underNot={false}
        budgetText={t('automation.whenTree.budget', {
          depth: budget.depth,
          depthLimit: budget.depthLimit,
          leaves: budget.leaves,
          leafLimit: budget.leafLimit,
        })}
        emptyHint={
          empty
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
}

function NodeView({ node, path, ctx, underNot }: NodeViewProps) {
  if (isLeaf(node)) return <LeafView leaf={node} path={path} ctx={ctx} underNot={underNot} />
  if (node.kind === 'not') return <NotView child={node.child} path={path} ctx={ctx} />
  return (
    <BlockView
      block={node}
      path={path}
      ctx={ctx}
      underNot={underNot}
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
}

function LeafView({ leaf, path, ctx, underNot }: LeafViewProps) {
  const node = nodeAt(ctx, path)
  const vars = ctx.run !== null && ctx.run.triggerPath === pathKey(path) ? ctx.run.vars : undefined
  return (
    <WhenLeafRow
      leaf={leaf}
      devices={ctx.devices}
      toneClass={toneFor(node?.outcome, 'border-border')}
      result={node === undefined ? undefined : <LeafResult leaf={leaf} node={node} vars={vars} />}
      onNegate={underNot ? null : () => ctx.onChange(negate(ctx.recipe, path))}
      onChange={(next) => ctx.onChange(updateNode(ctx.recipe, path, next))}
      onRemove={() => ctx.onChange(removeNode(ctx.recipe, path))}
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

function IssueLine({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null
  return (
    <p
      role="alert"
      data-testid="when-issue"
      className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning"
    >
      {message}
    </p>
  )
}

interface NotViewProps {
  readonly child: AutomationWhen
  readonly path: WhenPath
  readonly ctx: TreeContext
}

function NotView({ child, path, ctx }: NotViewProps) {
  const { t } = useTranslation()
  return (
    <div
      className={`space-y-1.5 rounded border p-2 ${toneFor(nodeAt(ctx, path)?.outcome, 'border-warning/40', false)}`}
      data-testid="when-not"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">{'NOT'}</Badge>
        <span className="text-xs text-foreground-subtle">
          {t('automation.whenTree.notHint', 'True when what is below is not')}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => ctx.onChange(unnegate(ctx.recipe, path))}
          title={t('automation.whenTree.removeNot', 'Remove the NOT, keeping what is inside')}
        >
          <Ungroup className="h-3.5 w-3.5" />{' '}
          {t('automation.whenTree.removeNotLabel', 'Remove NOT')}
        </Button>
      </div>
      <IssueLine message={ctx.issues.get(pathKey(path))} />
      <BlockResult node={nodeAt(ctx, path)} />
      <div className="pl-3">
        <NodeView node={child} path={[...path, 0]} ctx={ctx} underNot />
      </div>
    </div>
  )
}

interface BlockViewProps {
  readonly block: Extract<AutomationWhen, { kind: 'all' | 'any' }>
  readonly path: WhenPath
  readonly ctx: TreeContext
  readonly underNot: boolean
  /** Shown on the root only. */
  readonly budgetText: string | null
  readonly emptyHint: string | null
}

function BlockView({ block, path, ctx, underNot, budgetText, emptyHint }: BlockViewProps) {
  const { t } = useTranslation()
  const isRoot = path.length === 0
  const nestable = canNestBlockAt(ctx.recipe, path)
  const kinds = [
    { value: 'all', label: t('automation.whenTree.allOf', 'All of (AND)') },
    { value: 'any', label: t('automation.whenTree.anyOf', 'Any of (OR)') },
  ]
  // An empty root is the fresh-automation state: the hint says what to do, the
  // engine's "a group is empty" would only repeat it as a complaint.
  const issue = emptyHint === null ? ctx.issues.get(pathKey(path)) : undefined
  return (
    <div
      className={`space-y-2 rounded border p-2 ${toneFor(nodeAt(ctx, path)?.outcome, 'border-border', false)} bg-surface-subtle/40`}
      data-testid="when-block"
      data-kind={block.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
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
        {!isRoot && !underNot && (
          <Button
            variant="ghost"
            onClick={() => ctx.onChange(negate(ctx.recipe, path))}
            title={t('automation.whenTree.negateBlock', 'Invert this block (NOT)')}
          >
            {'NOT'}
          </Button>
        )}
        {!isRoot && (
          <Button
            variant="ghost"
            onClick={() => ctx.onChange(ungroup(ctx.recipe, path))}
            title={t('automation.whenTree.ungroup', 'Dissolve this block, keeping its rows')}
          >
            <Ungroup className="h-3.5 w-3.5" />
          </Button>
        )}
        {!isRoot && (
          <Button
            variant="ghost"
            onClick={() => ctx.onChange(removeNode(ctx.recipe, path))}
            title={t('automation.whenTree.removeBlock', 'Delete this block and everything in it')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <IssueLine message={issue} />
      <BlockResult node={nodeAt(ctx, path)} />
      {emptyHint !== null && <p className="text-xs text-warning">{emptyHint}</p>}

      {block.children.length > 0 && (
        <div className="space-y-1.5 border-l border-border pl-3">
          {block.children.map((child, index) => (
            <NodeView
              // Path is the identity: rows carry no id.
              key={pathKey([...path, index])}
              node={child}
              path={[...path, index]}
              ctx={ctx}
              underNot={false}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => ctx.onChange(addNode(ctx.recipe, path, newLeaf('device-is')))}
          title={t('automation.whenTree.addRowTitle', 'Add one row: an event or a state')}
        >
          <Plus className="h-4 w-4" /> {t('automation.whenTree.addRow', 'Add row')}
        </Button>
        <Button
          variant="outline"
          disabled={!nestable}
          onClick={() =>
            ctx.onChange(addNode(ctx.recipe, path, seedBlock(block.kind === 'all' ? 'any' : 'all')))
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
    </div>
  )
}
