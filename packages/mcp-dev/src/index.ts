/** @camstack/mcp-dev — private operator MCP library surface (also used by docs generators). */

export { createServer } from './server.js'
export { scrubSecrets, scrubValue } from '@camstack/develop'
export { loadDevelopOverlay } from './config.js'
export {
  parseToolsets,
  DEV_TOOLSETS,
  OPS_TOOLSETS,
  ALL_TOOLSETS,
} from './toolsets.js'
export {
  getKnowledgeIndex,
  clearKnowledgeCache,
  getDecision,
  decisionsForPath,
  trapsFor,
  subsystemOf,
  subsystemMap,
  guardsFor,
  normalizeAdrId,
} from './knowledge/index.js'
export { nextAdrNumber, readSection, SECTION_READ_LIMIT } from './knowledge/read.js'
export { runUiCli, resolveInsideRoot } from './ui/run.js'
export { planCapability } from './caps/plan.js'
export { scaffoldCapability } from './caps/scaffold.js'
export { runCodegen, methodTiersDiff } from './caps/codegen.js'
export { capShipPlan } from './caps/ship.js'
export {
  getEnrichedCapability,
  listEnrichedCapabilities,
} from './caps/enriched.js'
export { ARCHETYPES, inferArchetype } from './caps/archetypes.js'
export { affectedChecks, runChecks, isDeniedCommand } from './ci/affected.js'
