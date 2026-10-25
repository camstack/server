/**
 * Re-export — colour map lives in `@camstack/ui-library` (NodePicker, Assignments).
 * Kept for one release so relative imports in admin-ui keep resolving.
 */
export {
  buildColorByNodeId,
  colorIdForNode,
  type AgentSettingsColorRow,
} from '@camstack/ui-library'
