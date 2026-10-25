/**
 * The camera's Detection pipeline → Steps tree (D927).
 *
 * A camera does not choose a model. Each row is one step in the catalog
 * hierarchy, with the switch the camera already owns (`stepToggles`):
 *
 *   - absent  → Auto, which follows the step's catalog default
 *   - true    → On
 *   - false   → Off
 *
 * A step whose own switch is off idles every descendant ("off because its
 * parent is off"), even when the descendant's own switch is On. The
 * root-detector pick is a separate idle: `none` idles the whole video tree,
 * `onboard` idles only the root step, and an unanswered pick idles nothing.
 * A source idle does not pretend to be a parent switch — the root can be
 * idle because the camera detects itself while the steps under it still run.
 */
import type { CameraDetectionSource, PipelineSlot } from '@camstack/types'
import type { StepTreeNode } from '@camstack/ui-library'
import { stepsSuppressedBySource } from '../../pipeline/step-inspector/detection-source-model'

/** What the camera stored for one step. Auto = no `stepToggles` entry. */
export type CameraStepChoice = 'on' | 'off' | 'auto'

/** Why a step does not run even though the operator may still see its switch. */
export type CameraStepBlock =
  | { readonly kind: 'parent'; readonly ancestorId: string }
  | { readonly kind: 'source'; readonly source: 'onboard' | 'none' }

export interface CameraStepRow {
  readonly stepId: string
  readonly name: string
  readonly kind: PipelineSlot
  readonly depth: number
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  readonly choice: CameraStepChoice
  readonly defaultOn: boolean
  /** The step's own switch, before ancestors and the root-detector pick. */
  readonly ownOn: boolean
  readonly runs: boolean
  readonly blocked: CameraStepBlock | null
  /** Package zones drive the step — a badge, not On / Off / Auto. */
  readonly zoneDriven: boolean
}

export interface CameraStepTreeInput {
  readonly tree: readonly StepTreeNode[]
  readonly toggles: Readonly<Record<string, boolean>> | undefined
  /** `enabledByDefault` per step. A step missing from the map defaults to on. */
  readonly defaults: Readonly<Record<string, boolean>>
  /** `null` = the root-detector pick has not answered yet, so nothing is idle. */
  readonly source: CameraDetectionSource | null
  readonly zoneDrivenIds?: ReadonlySet<string>
}

interface OffAncestor {
  readonly stepId: string
}

function choiceOf(
  toggles: Readonly<Record<string, boolean>> | undefined,
  stepId: string,
): CameraStepChoice {
  const explicit = toggles?.[stepId]
  if (explicit === undefined) return 'auto'
  return explicit ? 'on' : 'off'
}

function ownSwitchOn(choice: CameraStepChoice, defaultOn: boolean): boolean {
  if (choice === 'auto') return defaultOn
  return choice === 'on'
}

function sourceBlock(
  source: CameraDetectionSource | null,
  stepId: string,
  suppressed: ReadonlySet<string>,
): CameraStepBlock | null {
  if ((source !== 'onboard' && source !== 'none') || !suppressed.has(stepId)) return null
  return { kind: 'source', source }
}

function walk(
  input: CameraStepTreeInput,
  nodes: readonly StepTreeNode[],
  depth: number,
  parentOff: OffAncestor | null,
  suppressed: ReadonlySet<string>,
): readonly CameraStepRow[] {
  const zoneDrivenIds = input.zoneDrivenIds ?? new Set<string>()
  return nodes.flatMap((node) => {
    const zoneDriven = zoneDrivenIds.has(node.addonId)
    const choice = choiceOf(input.toggles, node.addonId)
    const defaultOn = input.defaults[node.addonId] ?? true
    const ownOn = zoneDriven || ownSwitchOn(choice, defaultOn)
    const blocked: CameraStepBlock | null =
      parentOff !== null
        ? { kind: 'parent', ancestorId: parentOff.stepId }
        : sourceBlock(input.source, node.addonId, suppressed)
    const row: CameraStepRow = {
      stepId: node.addonId,
      name: node.addonName,
      kind: node.slot,
      depth,
      inputs: node.inputClasses,
      outputs: node.outputClasses,
      choice,
      defaultOn,
      ownOn,
      runs: blocked === null && ownOn,
      blocked,
      zoneDriven,
    }
    const nextParent = ownOn ? parentOff : { stepId: node.addonId }
    return [row, ...walk(input, node.children, depth + 1, nextParent, suppressed)]
  })
}

export function cameraStepRows(input: CameraStepTreeInput): readonly CameraStepRow[] {
  const suppressed =
    input.source === null ? new Set<string>() : stepsSuppressedBySource(input.source, input.tree)
  return walk(input, input.tree, 0, null, suppressed)
}
