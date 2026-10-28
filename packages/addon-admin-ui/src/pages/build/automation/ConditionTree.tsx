/**
 * AND ONLY IF — the condition tree, and the one interaction that keeps it
 * honest.
 *
 * **There is no button that makes an empty group.** A container is created by
 * SELECTING rows that already exist and saying what they mean together; that is
 * why the toolbar's verbs are "Group as ALL" / "Group as ANY" and why they are
 * disabled with a reason rather than absent. An empty container is a tree the
 * schema rejects and a box the operator has to remember to fill.
 *
 * The budget is shown before it is hit, and a refusal is
 * `validateRecipeBounds`' own sentence — it is the one that points out that
 * `not (any of …)` is `all of (not …)`, one level shallower. Re-wording it here
 * would let the editor and the save path disagree about the same tree.
 *
 * Only three chips exist: ALL, ANY, NOT. Anything an operator could want past
 * those is the expression leaf, which is bounded and is not a fourth container.
 */

import type { AutomationCondition, AutomationRecipe } from '@camstack/types'
import { Badge, Button, Checkbox, Select } from '@camstack/ui-library'
import { Braces, Car, Plus, Trash2, Ungroup } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AutomationDevice } from './automation-data'
import { ConditionLeafRow } from './ConditionRow'
import { ExpressionLeafRow } from './ExpressionLeafRow'
import {
  addCondition,
  type ConditionContainer,
  type ConditionPath,
  type ContainerKind,
  conditionBudget,
  conditionRoot,
  groupSelection,
  isContainer,
  type RecipeEdit,
  removeCondition,
  setContainerKind,
  toggleNot,
  ungroup,
  updateCondition,
} from './recipe-ops'
import { newConditionLeaf, newExpressionLeaf, newStationaryLeaf } from './recipe-parts'
import { StationaryPresentFields } from './SceneFields'
import { useTranslation } from 'react-i18next'

export interface ConditionTreeProps {
  readonly recipe: AutomationRecipe
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationRecipe) => void
}

const CONTAINER_OPTIONS = [
  { value: 'all', labelKey: 'automation.conditionTree.allOf' },
  { value: 'any', labelKey: 'automation.conditionTree.anyOf' },
]

function pathKey(path: ConditionPath): string {
  return path.join('/')
}

function keyToPath(key: string): ConditionPath {
  return key === '' ? [] : key.split('/').map((p) => Number(p))
}

export function ConditionTree({ recipe, devices, onChange }: ConditionTreeProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<readonly string[]>([])
  /** The last refusal, shown until the next successful edit. Kept rather than
   *  flashed: an operator who clicks a disabled button reads the title, but one
   *  whose bounds-legal-looking edit was refused needs the sentence to stay. */
  const [refusal, setRefusal] = useState<string | null>(null)

  const root = conditionRoot(recipe)
  const budget = conditionBudget(recipe)
  const selectedPaths = useMemo(() => selected.map(keyToPath), [selected])

  const apply = (edit: RecipeEdit): void => {
    if (!edit.ok) {
      setRefusal(edit.reason)
      return
    }
    setRefusal(null)
    setSelected([])
    onChange(edit.recipe)
  }

  const groupAll = groupSelection(recipe, selectedPaths, 'all')
  const groupAny = groupSelection(recipe, selectedPaths, 'any')
  const negate: RecipeEdit =
    selectedPaths.length === 1
      ? toggleNot(recipe, selectedPaths[0] ?? [])
      : { ok: false, reason: t('automation.conditionTree.selectOneNegate') }

  const handlers: NodeHandlers = {
    devices,
    selected: new Set(selected),
    onToggleSelect: (key) =>
      setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
    onUpdate: (path, next) => onChange(updateCondition(recipe, path, next)),
    onRemove: (path) => {
      setSelected([])
      onChange(removeCondition(recipe, path))
    },
    onSetKind: (path, kind) => onChange(setContainerKind(recipe, path, kind)),
    onUngroup: (path) => apply(ungroup(recipe, path)),
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">{t('automation.conditionTree.andOnlyIf', 'And only if')}</Badge>
        <div className="w-32">
          <Select
            value={root.kind}
            onChange={(e) =>
              onChange(setContainerKind(recipe, [], asContainerKind(e.target.value)))
            }
            options={CONTAINER_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        </div>
        <span className="text-xs text-foreground-subtle">
          {t('automation.conditionTree.budget', {
            depth: budget.depth,
            depthLimit: budget.depthLimit,
            leaves: budget.leaves,
            leafLimit: budget.leafLimit,
          })}
        </span>
      </div>

      {root.children.length === 0 ? (
        <p className="text-xs text-foreground-subtle">
          {t(
            'automation.conditionTree.noConditionsTheActionsRun',
            'No conditions. The actions run every time a trigger fires.',
          )}
        </p>
      ) : (
        <NodeList container={root} path={[]} handlers={handlers} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => apply(addCondition(recipe, newConditionLeaf()))}
          title={t(
            'automation.conditionTree.compareOneDeviceFieldTo',
            'Compare one device field to a value',
          )}
        >
          <Plus className="h-4 w-4" /> {t('automation.conditionTree.addCondition')}
        </Button>
        <Button
          variant="outline"
          onClick={() => apply(addCondition(recipe, newExpressionLeaf()))}
          title={t(
            'automation.conditionTree.arithmeticAcrossDeviceFieldsThe',
            'Arithmetic across device fields — the bounded expression engine',
          )}
        >
          <Braces className="h-4 w-4" /> {t('automation.conditionTree.addExpression')}
        </Button>

        <Button
          variant="outline"
          onClick={() => apply(addCondition(recipe, newStationaryLeaf()))}
          title={t(
            'flow.scene.addParkedTitle',
            'True while an object is parked on a camera, in a zone',
          )}
        >
          <Car className="h-4 w-4" /> {t('flow.scene.addParked', 'Parked object')}
        </Button>

        <span className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          disabled={!groupAll.ok}
          onClick={() => apply(groupAll)}
          title={
            groupAll.ok
              ? t(
                  'automation.conditionTree.allSelectedRowsMustBe',
                  'All selected rows must be true',
                )
              : groupAll.reason
          }
        >
          {t('automation.conditionTree.groupAsAll', 'Group as ALL')}
        </Button>
        <Button
          variant="ghost"
          disabled={!groupAny.ok}
          onClick={() => apply(groupAny)}
          title={
            groupAny.ok
              ? t(
                  'automation.conditionTree.anyOneOfTheSelected',
                  'Any one of the selected rows is enough',
                )
              : groupAny.reason
          }
        >
          {t('automation.conditionTree.groupAsAny', 'Group as ANY')}
        </Button>
        <Button
          variant="ghost"
          disabled={!negate.ok}
          onClick={() => apply(negate)}
          title={
            negate.ok
              ? t('automation.conditionTree.invertTheSelectedRow', 'Invert the selected row')
              : negate.reason
          }
        >
          NOT
        </Button>
        {selected.length > 0 && (
          <span className="text-xs text-foreground-subtle">
            {t('common.selectedCount', { count: selected.length })}
          </span>
        )}
      </div>

      {refusal !== null && (
        <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          {refusal}
        </p>
      )}
    </div>
  )
}

function asContainerKind(value: string): ContainerKind {
  return value === 'any' ? 'any' : 'all'
}

interface NodeHandlers {
  readonly devices: readonly AutomationDevice[]
  readonly selected: ReadonlySet<string>
  readonly onToggleSelect: (key: string) => void
  readonly onUpdate: (path: ConditionPath, next: AutomationCondition) => void
  readonly onRemove: (path: ConditionPath) => void
  readonly onSetKind: (path: ConditionPath, kind: ContainerKind) => void
  readonly onUngroup: (path: ConditionPath) => void
}

interface NodeListProps {
  readonly container: ConditionContainer
  readonly path: ConditionPath
  readonly handlers: NodeHandlers
}

function NodeList({ container, path, handlers }: NodeListProps) {
  return (
    <div className="space-y-1.5">
      {container.children.map((child, index) => (
        <NodeRow
          // Path is the identity — it is also what the selection is keyed by, so
          // a row cannot be selected under one identity and edited under another.
          key={pathKey([...path, index])}
          node={child}
          path={[...path, index]}
          handlers={handlers}
        />
      ))}
    </div>
  )
}

interface NodeRowProps {
  readonly node: AutomationCondition
  readonly path: ConditionPath
  readonly handlers: NodeHandlers
}

function NodeRow({ node, path, handlers }: NodeRowProps) {
  const { t } = useTranslation()
  const key = pathKey(path)
  const checkbox = (
    <Checkbox
      checked={handlers.selected.has(key)}
      onChange={() => handlers.onToggleSelect(key)}
      aria-label={t(
        'automation.conditionTree.selectThisRowForGrouping',
        'Select this row for grouping',
      )}
    />
  )

  if (isContainer(node)) {
    return (
      <div className="rounded border border-border bg-surface-subtle/40 p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {checkbox}
          <div className="w-32">
            <Select
              value={node.kind}
              onChange={(e) => handlers.onSetKind(path, asContainerKind(e.target.value))}
              options={CONTAINER_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </div>
          <Button
            variant="ghost"
            onClick={() => handlers.onUngroup(path)}
            title={t(
              'automation.conditionTree.dissolveThisGroupKeepingIts',
              'Dissolve this group, keeping its rows',
            )}
          >
            <Ungroup className="h-3.5 w-3.5" /> {t('automation.conditionTree.ungroup')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => handlers.onRemove(path)}
            title={t(
              'automation.conditionTree.deleteThisGroupAndEverything',
              'Delete this group and everything in it',
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="pl-4">
          <NodeList container={node} path={path} handlers={handlers} />
        </div>
      </div>
    )
  }

  if (node.kind === 'not') {
    return (
      <div className="rounded border border-border p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {checkbox}
          <Badge variant="warning">NOT</Badge>
          <Button
            variant="ghost"
            onClick={() => handlers.onUngroup(path)}
            title={t(
              'automation.conditionTree.removeTheNotKeepingThe',
              'Remove the NOT, keeping the row',
            )}
          >
            <Ungroup className="h-3.5 w-3.5" /> {t('automation.conditionTree.removeNot')}
          </Button>
        </div>
        <div className="pl-4">
          <NodeRow node={node.child} path={[...path, 0]} handlers={handlers} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 rounded border border-border p-2">
      <div className="pt-6">{checkbox}</div>
      <div className="min-w-0 flex-1">
        {node.kind === 'condition' ? (
          <ConditionLeafRow
            leaf={node}
            devices={handlers.devices}
            onChange={(next) => handlers.onUpdate(path, next)}
          />
        ) : node.kind === 'expression' ? (
          <ExpressionLeafRow
            leaf={node}
            devices={handlers.devices}
            onChange={(next) => handlers.onUpdate(path, next)}
          />
        ) : (
          <StationaryPresentFields
            leaf={node}
            devices={handlers.devices}
            onChange={(next) => handlers.onUpdate(path, next)}
          />
        )}
      </div>
      <Button
        variant="ghost"
        onClick={() => handlers.onRemove(path)}
        title={t('automation.conditionTree.removeThisCondition', 'Remove this condition')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
