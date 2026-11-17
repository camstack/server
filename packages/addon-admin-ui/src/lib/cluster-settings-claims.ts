/**
 * Which admin surface draws each part of every capability's CLUSTER settings (#578).
 *
 * An addon declares its cluster-wide settings per capability
 * (`clusterSettingsSchema(cap)`, D986). Every SECTION of every such form has
 * exactly ONE surface here — the page an operator would look on for that
 * subject — and `scripts/check-cluster-settings-claimed.ts` fails when a
 * capability, a section or a field has no surface, or more than one, or when a
 * claim names something the schema no longer declares.
 *
 * A claim without `sectionIds` / `fieldKeys` is a WHOLE claim: the surface
 * draws every section of the cap, minus the fields another claim of the same
 * cap names (those surfaces omit nothing; the whole-cap surface omits them).
 * A claim with `sectionIds` / `fieldKeys` draws exactly those — a cap split
 * that way has no whole claim, so a section added to it has no surface until
 * someone gives it one.
 *
 * `addon-card` is the fallback: the addon's settings dialog on the Addons page.
 * `provider-page` is a connection page (an `InstancesTable`) that draws the
 * function cap's settings next to its instances.
 *
 * Pure data, no imports: the guard script reads it from outside the package.
 */

/** A page that draws cluster settings. */
export type ClusterSettingsSurface =
  | 'pipeline'
  | 'pipeline-roles'
  | 'history'
  | 'notifications'
  | 'nodes'
  | 'provider-page'
  | 'addon-card'

export interface ClusterSettingsClaim {
  /** The capability whose `cluster` scope is drawn. */
  readonly cap: string
  /** The addon serving it (the settings read is addressed by addon id). */
  readonly addonId: string
  readonly surface: ClusterSettingsSurface
  /** The sections this surface draws. With `fieldKeys` also absent: the whole cap. */
  readonly sectionIds?: readonly string[]
  /** Single fields this surface draws, apart from the rest of their section. */
  readonly fieldKeys?: readonly string[]
  /** Why this part is drawn apart from the rest of the cap. */
  readonly reason?: string
}

/** Pipeline → Cluster → Roles & nodes: one picker per singleton role, each its owner's field. */
const ROLES_REASON = 'a singleton role: Roles & nodes is the one picker for it'

export const CLUSTER_SETTINGS_CLAIMS: readonly ClusterSettingsClaim[] = [
  // ── Pipeline → Cluster → Settings ──────────────────────────────────
  // The orchestrator form is split: its role pickers are on Roles & nodes, every other section
  // is a Settings card (the enrichment models are drawn field by field on Faces and Semantic
  // search — the two cluster-scoped steps).
  {
    cap: 'pipeline-orchestrator',
    addonId: 'pipeline-orchestrator',
    surface: 'pipeline',
    sectionIds: [
      'cluster-step-models',
      'face-rescore',
      'detail-crop',
      'native-lease',
      'load',
      'failover',
    ],
  },
  {
    cap: 'pipeline-orchestrator',
    addonId: 'pipeline-orchestrator',
    surface: 'pipeline-roles',
    fieldKeys: ['ingestNode', 'audioNode', 'motionNode'],
    reason: ROLES_REASON,
  },
  { cap: 'face-gallery', addonId: 'pipeline-analytics', surface: 'pipeline' },
  { cap: 'stream-broker', addonId: 'stream-broker', surface: 'pipeline' },
  { cap: 'snapshot', addonId: 'snapshot', surface: 'pipeline' },
  { cap: 'recording', addonId: 'recorder', surface: 'pipeline' },
  {
    cap: 'recording',
    addonId: 'recorder',
    surface: 'pipeline-roles',
    fieldKeys: ['recordingNodeId'],
    reason: ROLES_REASON,
  },
  { cap: 'embedding-encoder', addonId: 'embedding-encoder', surface: 'pipeline' },
  // ── History → Retention ────────────────────────────────────────────
  { cap: 'device-history', addonId: 'device-history', surface: 'history' },
  // ── Notifications → Settings ───────────────────────────────────────
  { cap: 'alerts', addonId: 'alert-center', surface: 'notifications' },
  // ── Nodes → Metrics collection ─────────────────────────────────────
  { cap: 'metrics-provider', addonId: 'metrics-native', surface: 'nodes' },
  // ── Connection pages (InstancesTable) ──────────────────────────────
  { cap: 'login-method', addonId: 'auth-webauthn', surface: 'provider-page' },
  { cap: 'llm', addonId: 'ai', surface: 'provider-page' },
  { cap: 'log-destination', addonId: 'console-logging', surface: 'provider-page' },
  { cap: 'core-blocks', addonId: 'core-blocks', surface: 'provider-page' },
  // ── The addon's own settings dialog ────────────────────────────────
  { cap: 'custom-model-registry', addonId: 'model-studio', surface: 'addon-card' },
  { cap: 'osd-manager', addonId: 'osd-manager', surface: 'addon-card' },
  { cap: 'pipeline-analytics', addonId: 'pipeline-analytics', surface: 'addon-card' },
  {
    cap: 'pipeline-analytics',
    addonId: 'pipeline-analytics',
    surface: 'pipeline-roles',
    fieldKeys: ['postProcessingNodeId'],
    reason: ROLES_REASON,
  },
  { cap: 'detection-pipeline', addonId: 'detection-pipeline', surface: 'addon-card' },
]

/** The admin route of each feature surface, for the links an addon dialog shows. */
export const CLUSTER_SETTINGS_SURFACE_ROUTES: Readonly<
  Partial<Record<ClusterSettingsSurface, string>>
> = {
  pipeline: '/system/pipeline?view=nodes&node=__cluster__&ctab=settings',
  'pipeline-roles': '/system/pipeline?view=nodes&node=__cluster__&ctab=roles-nodes',
  history: '/system/history',
  notifications: '/system/notifications?tab=settings',
  nodes: '/system/nodes',
}

/** True when the claim draws the whole cap (no section or field list). */
export function isWholeClaim(claim: ClusterSettingsClaim): boolean {
  return claim.sectionIds === undefined && claim.fieldKeys === undefined
}

/** The claims of one addon that a feature surface (one with a route) draws. */
export function featureClaimsOf(addonId: string): readonly ClusterSettingsClaim[] {
  return CLUSTER_SETTINGS_CLAIMS.filter(
    (c) => c.addonId === addonId && CLUSTER_SETTINGS_SURFACE_ROUTES[c.surface] !== undefined,
  )
}

/** What an addon's settings dialog leaves out: whole caps and single fields drawn on a feature page. */
export interface AddonDialogOmissions {
  readonly capabilities: readonly string[]
  readonly fieldKeys: readonly string[]
}

/**
 * The dialog draws the caps whose whole claim is `addon-card` (or unclaimed), minus the fields a
 * feature page claims. A cap with no whole `addon-card` claim is left out entirely.
 */
export function addonDialogOmissions(addonId: string): AddonDialogOmissions {
  const own = CLUSTER_SETTINGS_CLAIMS.filter((c) => c.addonId === addonId)
  const dialogCaps = new Set(
    own.filter((c) => c.surface === 'addon-card' && isWholeClaim(c)).map((c) => c.cap),
  )
  const capabilities = [...new Set(own.map((c) => c.cap))].filter((cap) => !dialogCaps.has(cap))
  const fieldKeys = own
    .filter((c) => dialogCaps.has(c.cap) && c.surface !== 'addon-card')
    .flatMap((c) => c.fieldKeys ?? [])
  return { capabilities, fieldKeys }
}
