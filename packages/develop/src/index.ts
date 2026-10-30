/** @camstack/develop — shared developer tooling for CLI + MCP. */

export type {
  AddonCapabilityRef,
  AddonManifestEntry,
  AddonPackageSummary,
  CapabilitySummary,
  ExampleEntry,
  ExampleHit,
  ExtendAddonOptions,
  ExtendAddonResult,
  ScaffoldAddonOptions,
  ScaffoldAddonResult,
  ScaffoldCapOptions,
  ScaffoldCapResult,
  SkillInfo,
  ValidationFinding,
  ValidationResult,
  WorkspacePaths,
} from './types.js'

export {
  findWorkspaceRoot,
  requireWorkspaceRoot,
  resolveWorkspacePaths,
} from './workspace.js'

export {
  toCamelName,
  toCapExportName,
  toClassName,
  toFileName,
} from './naming.js'

export {
  findAddonPackage,
  listAddonPackages,
  whoProvides,
} from './catalogue/addons.js'
export { getCapability, listCapabilities } from './catalogue/capabilities.js'

export { CORE_EXAMPLES } from './examples/catalogue.js'
export { findExample, listExamples } from './examples/find.js'

export { checkAddonEntries } from './validate/entries.js'
export { validateAddon } from './validate/addon.js'

export { scaffoldAddon } from './scaffold/addon.js'
export { scaffoldCapStub } from './scaffold/cap-stub.js'
export { extendAddon } from './scaffold/extend.js'

export { listSkills, readSkill, resolveSkillsDir } from './skills.js'

// Hub access — the one credential chain, session cache, address and TLS trust
// shared by the CLI, scripts/hub/hub.mjs and the operator MCP (D835).
export {
  authRejectedHint,
  credentialTier,
  jwtClaims,
  jwtExpiryMs,
  jwtPayloadIsAdmin,
  MissingCredentialsError,
  readTokenFile,
  resolveCredentials,
  withAuthHint,
} from './hub/credentials.js'
export type {
  CachedSessionLike,
  CredentialInputs,
  CredentialSource,
  CredentialTier,
  ResolvedCredentials,
  TokenFileContents,
} from './hub/credentials.js'
export {
  clearSession,
  defaultSession,
  defaultSessionDir,
  isSessionFile,
  listSessions,
  loadSession,
  saveSession,
  sessionFileForServer,
  sessionRecency,
  slugForServer,
  touchSession,
} from './hub/session-store.js'
export type { SessionFile } from './hub/session-store.js'
export {
  adminCredentialHint,
  adminRejectedHint,
  REPO_LOCAL_LOGIN,
  sessionLoginCommand,
} from './hub/login-hints.js'
export {
  forceRefreshSession,
  refreshOnUnauthorized,
  resolveFreshCredentials,
} from './hub/session-refresh.js'
export type {
  FreshCredentialInputs,
  RefreshOptions,
} from './hub/session-refresh.js'
export {
  DEFAULT_HUB_PORT,
  HubAddressError,
  normalizeHubAddress,
  validateHubAddress,
} from './hub/hub-address.js'
export { resolveHubUrl } from './hub/hub-url.js'
export type {
  HubUrlInputs,
  HubUrlSource,
  ResolvedHubUrl,
} from './hub/hub-url.js'
export {
  createHubAgent,
  explainTlsFailure,
  hubCaFileForServer,
  resolveHubTls,
} from './hub/hub-tls.js'
export type { HubTlsConfig } from './hub/hub-tls.js'
export {
  createHubClient,
  encodeTrpcInput,
  HubHttpError,
  HubRpcError,
  nodeHubTransport,
} from './hub/hub-client.js'
export type {
  HubClient,
  HubClientOptions,
  HubHttpMethod,
  HubTransport,
  HubTransportRequest,
  HubTransportResponse,
} from './hub/hub-client.js'

// MCP shared helpers: the query gate, the mutation gate (D836), the secret
// scrubbers and the output redaction, shared by `camstack mcp` and the private
// operator MCP.
export { scrubSecrets, scrubValue } from './mcp/scrub.js'
export { text, textError } from './mcp/text.js'
export {
  REDACTED,
  redactDeclaredSecrets,
  redactToolArgs,
  toToolOutput,
  truncateOutput,
} from './mcp/redact.js'
export {
  CORE_QUERY_METHODS,
  loadApiIndex,
  parseApiIndex,
  type ApiIndex,
  type ApiMethod,
  type MethodAuth,
  type MethodKind,
} from './mcp/api-index.js'
export {
  connectHub,
  tryConnectHub,
  type ConnectOutcome,
  type HubConnectOptions,
  type HubConnection,
  type NoSessionOutcome,
} from './mcp/hub-connection.js'
export {
  gateQuery,
  isSecretBearing,
  type GateDecision,
} from './mcp/query-gate.js'
export {
  CONFIRM_TTL_MS,
  MAX_OUTSTANDING_TOKENS,
  MUTATIONS_DISABLED_REASON,
  MutationGate,
  canonicalJson,
  digestArgs,
  runGated,
  stderrAudit,
  type AuditPhase,
  type AuditRecord,
  type AuditSink,
  type ConfirmDecision,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type IssuedToken,
  type MutationGateOptions,
} from './mcp/mutation-gate.js'
// Hub payload slices and the per-track audit rules, shared by `camstack mcp`
// (ops toolset) and the private operator MCP.
export * from './mcp/ops/wire.js'
export * from './mcp/ops/track-findings.js'
