/**
 * Why a system-scoped cap is never part of a device's vocabulary (D920): the
 * reasons several caps share, named once. A cap's `vocabulary` block cites
 * one (`vocabulary: { notOperatorFacing: NOT_A_DEVICE.STORAGE }`) or states
 * its own.
 */
export const NOT_A_DEVICE = {
  UI_PLUMBING: 'admin UI plumbing — pages, widgets and routes, not something a device does',
  ADDON_ADMIN: 'addon administration — installed and configured from the Addons page',
  PIPELINE: 'detection pipeline machinery — tuned on the pipeline pages, never actuated per device',
  STORAGE: 'storage administration — locations, retention and migrations, not a device action',
  IDENTITY: 'identity and access administration — users, sign-in and secrets',
  NETWORK: 'network administration of the cluster — addresses, mesh, tunnels',
  CLUSTER: 'cluster administration — nodes, server package, metrics',
  ML: 'model and training machinery — no device action',
  INTERNAL: 'internal plumbing between addons — never operator-facing',
} as const
