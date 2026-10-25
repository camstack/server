export { MatterBrokerAddon } from './addon.js'
export {
  matterAddonConfigSchema,
  matterConnectionSchema,
  buildConnectionFormSchema,
  settingsToMatterConnection,
} from './config.js'
export type { MatterAddonConfig, MatterConnection, MatterBrokerEntry } from './config.js'
export {
  MatterClusterId,
  mapMatterEndpointToCamStack,
  endpointLabel,
} from './matter-cluster-mapping.js'
export type { MatterEndpointCap, MatterEndpointMapping } from './matter-cluster-mapping.js'
export {
  parsePairingCode,
  isValidPairingCode,
  InvalidPairingCodeError,
} from './matter-commissioning.js'
export type { ParsedPairingCode, PairingCodeKind } from './matter-commissioning.js'
export { buildMatterNodeCandidate, endpointNativeId } from './matter-discovery.js'
export {
  createMatterController,
  StubMatterController,
  MatterControllerNotWiredError,
} from './matter-controller.js'
export type {
  MatterController,
  MatterNodeSnapshot,
  MatterEndpointSnapshot,
  MatterAttributeReport,
  MatterCommandInvocation,
  CommissionResult,
} from './matter-controller.js'
