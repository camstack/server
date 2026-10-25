import { NODE_COLOR_IDS, assignNodeColorId, type NodeColorId } from '@camstack/types'

export { NODE_COLOR_IDS, assignNodeColorId, type NodeColorId }

/** Full class strings so Tailwind v4 JIT retains every node palette utility. */
const NODE_BG_CLASS = {
  'node-a': 'bg-node-a',
  'node-b': 'bg-node-b',
  'node-c': 'bg-node-c',
  'node-d': 'bg-node-d',
  'node-e': 'bg-node-e',
  'node-f': 'bg-node-f',
  'node-g': 'bg-node-g',
  'node-h': 'bg-node-h',
} satisfies Record<NodeColorId, string>

const NODE_TEXT_CLASS = {
  'node-a': 'text-node-a',
  'node-b': 'text-node-b',
  'node-c': 'text-node-c',
  'node-d': 'text-node-d',
  'node-e': 'text-node-e',
  'node-f': 'text-node-f',
  'node-g': 'text-node-g',
  'node-h': 'text-node-h',
} satisfies Record<NodeColorId, string>

/** Soft fill for selected pills / chrome (Tailwind v4 needs full class strings). */
const NODE_BG_SOFT_CLASS = {
  'node-a': 'bg-node-a/15',
  'node-b': 'bg-node-b/15',
  'node-c': 'bg-node-c/15',
  'node-d': 'bg-node-d/15',
  'node-e': 'bg-node-e/15',
  'node-f': 'bg-node-f/15',
  'node-g': 'bg-node-g/15',
  'node-h': 'bg-node-h/15',
} satisfies Record<NodeColorId, string>

export function nodeColorClass(id: NodeColorId): string {
  return NODE_BG_CLASS[id]
}

export function nodeTextColorClass(id: NodeColorId): string {
  return NODE_TEXT_CLASS[id]
}

export function nodeSoftBgClass(id: NodeColorId): string {
  return NODE_BG_SOFT_CLASS[id]
}
