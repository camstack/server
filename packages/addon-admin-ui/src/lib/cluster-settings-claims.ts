/**
 * Which admin surface draws each capability's CLUSTER settings (#578).
 *
 * An addon declares its cluster-wide settings per capability
 * (`clusterSettingsSchema(cap)`, D986). Every such capability is claimed here
 * by exactly ONE surface — the page an operator would look on for that
 * subject — and `scripts/check-cluster-settings-claimed.ts` fails when a
 * capability declares a cluster schema and nobody claims it, or a claim names
 * a capability that no longer declares one.
 *
 * `addon-card` is the fallback: the addon's settings dialog on the Addons
 * page. That dialog draws every cluster schema of its addon EXCEPT the ones a
 * feature surface claims, and links to those instead — one control per value.
 * `provider-page` is a connection page (an `InstancesTable`) that draws the
 * function cap's settings next to its instances.
 *
 * Pure data, no imports: the guard script reads it from outside the package.
 */

/** A page that draws cluster settings. */
export type ClusterSettingsSurface =
  | 'pipeline'
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
}

export const CLUSTER_SETTINGS_CLAIMS: readonly ClusterSettingsClaim[] = [
  // Pipeline → Cluster → Settings (and Roles & nodes for the role pickers).
  { cap: 'pipeline-orchestrator', addonId: 'pipeline-orchestrator', surface: 'pipeline' },
  { cap: 'face-gallery', addonId: 'pipeline-analytics', surface: 'pipeline' },
  { cap: 'stream-broker', addonId: 'stream-broker', surface: 'pipeline' },
  { cap: 'snapshot', addonId: 'snapshot', surface: 'pipeline' },
  { cap: 'recording', addonId: 'recorder', surface: 'pipeline' },
  { cap: 'embedding-encoder', addonId: 'embedding-encoder', surface: 'pipeline' },
  // History → Retention.
  { cap: 'device-history', addonId: 'device-history', surface: 'history' },
  // Notifications → Settings.
  { cap: 'alerts', addonId: 'alert-center', surface: 'notifications' },
  // Nodes → Metrics collection.
  { cap: 'metrics-provider', addonId: 'metrics-native', surface: 'nodes' },
  // Connection pages (InstancesTable).
  { cap: 'login-method', addonId: 'auth-webauthn', surface: 'provider-page' },
  { cap: 'llm', addonId: 'ai', surface: 'provider-page' },
  { cap: 'log-destination', addonId: 'console-logging', surface: 'provider-page' },
  { cap: 'core-blocks', addonId: 'core-blocks', surface: 'provider-page' },
  // The addon's own settings dialog.
  { cap: 'custom-model-registry', addonId: 'model-studio', surface: 'addon-card' },
  { cap: 'osd-manager', addonId: 'osd-manager', surface: 'addon-card' },
  { cap: 'pipeline-analytics', addonId: 'pipeline-analytics', surface: 'addon-card' },
  { cap: 'detection-pipeline', addonId: 'detection-pipeline', surface: 'addon-card' },
]

/** The admin route of each feature surface, for the links an addon dialog shows. */
export const CLUSTER_SETTINGS_SURFACE_ROUTES: Readonly<
  Partial<Record<ClusterSettingsSurface, string>>
> = {
  pipeline: '/system/pipeline?view=nodes&node=__cluster__&ctab=settings',
  history: '/system/history',
  notifications: '/system/notifications?tab=settings',
  nodes: '/system/nodes',
}

/** The claims of one addon that a feature surface (one with a route) draws. */
export function featureClaimsOf(addonId: string): readonly ClusterSettingsClaim[] {
  return CLUSTER_SETTINGS_CLAIMS.filter(
    (c) => c.addonId === addonId && CLUSTER_SETTINGS_SURFACE_ROUTES[c.surface] !== undefined,
  )
}
