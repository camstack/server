/**
 * The classification table for every hand-written CORE (non-cap) tRPC router.
 *
 * Moved from `scripts/core-router-classification.ts` on 2026-09-20 together with
 * the guard that enforces it (D548): both read only this package.
 */
export type CoreRouterClassification = 'admin-only' | 'device-filtered' | 'mixed' | 'session-self'

export interface CoreRouterExpectation {
  /** The key this router is mounted under in `buildCapabilityRouters`. */
  readonly key: string
  /** Source file, relative to repo root. */
  readonly file: string
  readonly classification: CoreRouterClassification
  /** Why this classification is safe. Read by a human during review. */
  readonly rationale: string
}

export const CORE_ROUTER_EXPECTATIONS: readonly CoreRouterExpectation[] = [
  {
    key: 'notifications',
    file: 'server/backend/src/api/core/notifications.router.ts',
    classification: 'mixed',
    rationale:
      'Admin procedures manage delivery config; the non-admin ones read/ack the caller-facing notification surface and carry no per-device payload.',
  },
  {
    key: 'addonSettingsRaw',
    file: 'server/backend/src/api/core/addon-settings.router.ts',
    classification: 'admin-only',
    rationale:
      'Raw addon settings store proxy for forked workers — a plaintext config surface. Admin-gated end to end.',
  },
  {
    key: 'eventBusProxy',
    file: 'server/backend/src/api/core/event-bus-proxy.router.ts',
    classification: 'mixed',
    rationale:
      'Admin publishes onto the bus; the non-admin legs are the in-process addon bridge, not a device read surface.',
  },
  {
    key: 'repl',
    file: 'server/backend/src/api/core/repl.router.ts',
    classification: 'admin-only',
    rationale: 'Arbitrary code execution against the hub. Admin only, always.',
  },
  {
    key: 'systemEvents',
    file: 'server/backend/src/api/core/system-events.router.ts',
    classification: 'device-filtered',
    rationale:
      'Streams the event firehose to non-admins; filtered per caller via `scopedEventVisibility` (F0.5) so a device-scoped token only sees its own cameras.',
  },
  {
    key: 'capabilities',
    file: 'server/backend/src/api/core/capabilities.router.ts',
    classification: 'admin-only',
    rationale:
      'Enumerates and swaps capability providers — deployment topology and control. Admin only.',
  },
  {
    key: 'logs',
    file: 'server/backend/src/api/core/logs.router.ts',
    classification: 'admin-only',
    rationale:
      'Hub logs quote device names, hosts and failure detail across the whole fleet. Admin only.',
  },
  {
    key: 'live',
    file: 'server/backend/src/api/core/live-events.router.ts',
    classification: 'device-filtered',
    rationale:
      'The live motion/detection stream and its recent-events replay, both cut to the caller with `scopedEventVisibility` (F0.5).',
  },
  {
    key: 'streamProbe',
    file: 'server/backend/src/api/core/stream-probe.router.ts',
    classification: 'admin-only',
    rationale:
      'ffprobe against an arbitrary operator-supplied URL — an SSRF-shaped surface. Admin only.',
  },
  {
    key: 'hwaccel',
    file: 'server/backend/src/api/core/hwaccel.router.ts',
    classification: 'admin-only',
    rationale: 'Per-node hardware inventory for the pipeline pages. Admin only.',
  },
  {
    key: 'clusterNodes',
    file: 'server/backend/src/api/core/cluster-nodes.router.ts',
    classification: 'admin-only',
    rationale: 'Cluster membership and the destructive "forget node" purge. Admin only.',
  },
  {
    key: 'certificates',
    file: 'server/backend/src/api/core/certificates.router.ts',
    classification: 'admin-only',
    rationale:
      'The HTTPS certificate per node, its renewal and the mesh CA inventory (D855). Every procedure is `adminProcedure`.',
  },
  {
    key: 'agentPairing',
    file: 'server/backend/src/api/core/agent-pairing.router.ts',
    classification: 'admin-only',
    rationale:
      'Agent discovery, hub-initiated pairing and unpairing (D857). Every procedure is `adminProcedure`: it signs certificates for the mesh.',
  },
  {
    key: 'preferences',
    file: 'server/backend/src/api/core/preferences.router.ts',
    classification: 'session-self',
    rationale:
      'Account preferences (D894). No procedure takes a user id: every one acts on `ctx.user.id`, admin included, and only a principal holding `preferences-self` gets in (share links, view-only and legacy tokens, the mesh are refused). No device payload.',
  },
  {
    key: 'auth',
    file: 'server/backend/src/api/core/auth.router.ts',
    classification: 'session-self',
    rationale:
      'Login legs are public + rate-limited; every non-admin procedure binds to `ctx.user.id` (own password, own TOTP, own passkeys, own share tokens). Share minting is additionally intersected with the caller device scope (F0.4). The one procedure that reads OTHER than the caller — `previewScope`, which resolves a proposed grant set for the Users page — is `adminProcedure`, and it reads nothing off `ctx.user`, so it is not a self-scope oracle (F3).',
  },
] as const
