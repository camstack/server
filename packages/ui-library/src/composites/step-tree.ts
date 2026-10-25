/**
 * The detection step TREE of a pipeline catalog — which step feeds which —
 * built once from the executor's schema and shared by the step inspector's
 * list and its Compare matrix.
 */
import type { PipelineSchema, PipelineSlot } from '@camstack/types'

export interface StepTreeNode {
  readonly addonId: string
  readonly addonName: string
  readonly slot: PipelineSlot
  readonly inputClasses: readonly string[]
  readonly outputClasses: readonly string[]
  readonly children: readonly StepTreeNode[]
}

/**
 * Helper: build a StepTreeNode[] from a `PipelineSchema` by chaining on
 * `inputClasses` ⇔ `outputClasses` compatibility. Mirrors the orchestrator
 * resolver's `buildTreeFromAddons` logic but yields names only (display
 * layer). Addons in the audio-classifier slot become separate roots.
 */
export function buildStepTreeFromSchema(schema: PipelineSchema): readonly StepTreeNode[] {
  // Mutable scaffold so we can attach children during the single-pass
  // compat walk; returned as readonly StepTreeNode[] at the end.
  interface MutableNode {
    readonly addonId: string
    readonly addonName: string
    readonly slot: PipelineSlot
    readonly inputClasses: readonly string[]
    readonly outputClasses: readonly string[]
    readonly children: MutableNode[]
  }

  const audioRoots: MutableNode[] = []
  const videoNodes: MutableNode[] = []
  const byId = new Map<string, MutableNode>()

  for (const slot of schema.slots) {
    for (const a of slot.addons) {
      const node: MutableNode = {
        addonId: a.id,
        addonName: a.name,
        slot: a.slot,
        inputClasses: a.inputClasses,
        outputClasses: a.outputClasses,
        children: [],
      }
      if (a.slot === 'audio-classifier') {
        audioRoots.push(node)
      } else {
        videoNodes.push(node)
        byId.set(a.id, node)
      }
    }
  }

  const roots: MutableNode[] = []
  for (const node of videoNodes) {
    if (node.inputClasses.length === 0) {
      roots.push(node)
      continue
    }
    const parent = videoNodes.find(
      (p) =>
        p.addonId !== node.addonId && p.outputClasses.some((c) => node.inputClasses.includes(c)),
    )
    if (parent) {
      parent.children.push(node)
    }
  }

  return [...roots, ...audioRoots]
}
