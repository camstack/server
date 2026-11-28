/**
 * Re-export — colour map lives in `@dominevo/ui-library` (NodePicker, Assignments).
 * Kept for one release so relative imports in admin-ui keep resolving.
 */
export {
  buildColorByNodeId,
  colorIdForNode,
  type AgentSettingsColorRow,
} from '@dominevo/ui-library'
