/**
 * Thin wrapper around `NodePicker` from `@camstack/ui-library` — same pattern
 * the benchmark addon uses, so the visual language (topology query, sorting,
 * styling) is identical to admin-ui's Addons page.
 */
import { NodePicker } from '@camstack/ui-library'

interface NodeSelectorProps {
  readonly selectedNodeId: string
  readonly onSelect: (nodeId: string) => void
}

export function NodeSelector({ selectedNodeId, onSelect }: NodeSelectorProps) {
  // Toolbar compact: no caption/icon — bar height matches Select (h-7).
  return <NodePicker selectedNodeId={selectedNodeId} onSelect={onSelect} hideIcon label="" />
}
