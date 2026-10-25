import { z } from 'zod'
import { lifecycleJobSchema } from '../lifecycle/job.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * addons — system-scoped singleton capability for addon package
 * management (install, update, configure, restart) and per-addon log
 * streaming.
 *
 * Implementation lives in the server's `AddonRegistryService`,
 * `AddonPackageService`, and `LoggingService`. The provider is
 * registered from `trpc.router.ts` against those services — no addon
 * owns this surface end-to-end (it manages addons themselves).
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router. Cap conversion lets `useAddonsList`, `useAddonsInstallPackage`,
 * `useAddonsOnAddonLogs`, etc. flow through the same codegen pipeline
 * as every other cap.
 */

// ── Loose-shape Zod helpers ─────────────────────────────────────────
//
// The `addons` surface ships rich runtime objects (manifests, addon
// declarations, package metadata) whose precise shapes already live in
// `@camstack/types/interfaces`. We deliberately keep the cap schemas
// loose — `z.record(z.string(), z.unknown())` plus a few well-known
// fields — so admin-ui consumers can keep using the existing
// `AddonListItem` interface via cast, and so we don't risk inflating
// the inferred AppRouter type past the TypeScript inference budget.

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
const ChannelSchema = z.enum(['off', 'latest', 'beta'])
const ChannelWithInheritSchema = z.enum(['off', 'latest', 'beta', 'inherit'])

// Mirrors `AddonListItem` from interfaces/api-responses.ts. Schema is
// intentionally loose — `z.unknown()` slots accept any runtime shape so
// admin-ui can keep using the `AddonListItem` interface via cast.
const ManifestShapeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  // Loose schema for `manifest.capabilities` — runtime entries are
  // either kebab-case strings (legacy form) or `CapabilityDeclaration`
  // objects. The cap output schema deliberately keeps it as
  // `readonly unknown[]` so admin-ui consumers cast to the canonical
  // `AddonListItem` (from `@camstack/types`) before reading fields.
  capabilities: z.array(z.unknown()).readonly().optional(),
  packageName: z.string(),
  packageVersion: z.string(),
  packageDisplayName: z.string().optional(),
  /**
   * Bundle metadata when the npm package ships multiple addon entries
   * (mirror of `AddonPackageManifest.bundle` in @camstack/types). When
   * present, the admin UI groups all entries with the same packageName
   * under a collapsible bundle card. Single-entry packages omit this.
   */
  bundle: z
    .object({
      displayName: z.string(),
      description: z.string().optional(),
      icon: z.string().optional(),
    })
    .optional(),
  protected: z.boolean().optional(),
  removable: z.boolean().optional(),
})

const AddonProcessSchema = z.object({
  pid: z.number().optional(),
  mode: z.string(),
  state: z.string(),
  /** Why the runner is `refused` (an addon's own words), when it is (D877). */
  reason: z.string().optional(),
})

/**
 * Per-addon health snapshot from the kernel's AddonHealthMonitor.
 * Surfaces the retry-loop state to the admin UI so the Addons page
 * can:
 *   - Show a red badge + error stack on `phase=failed` rows
 *   - Render a "Retry now" button (calls `addons.retryLoad`)
 *   - Display a "next retry in Ns" countdown
 *   - Suppress alarming UI during the 5-minute boot grace
 */
const AddonHealthSchema = z.object({
  phase: z.enum(['pending', 'healthy', 'failed']),
  retryCount: z.number(),
  firstFailureAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.object({ message: z.string(), stack: z.string().optional() }).nullable(),
  nextRetryAt: z.number().nullable(),
  alertEmitted: z.boolean(),
  retrying: z.boolean(),
  inGracePeriod: z.boolean(),
})

const AddonListItemSchema = z.object({
  manifest: ManifestShapeSchema,
  declaration: z.unknown().optional(),
  source: z.string(),
  installSource: z.string().optional(),
  process: AddonProcessSchema.optional(),
  /**
   * True when `applyUpdate` last ran for this package and a pre-update
   * backup is still on disk (post-update health-check hasn't cleared
   * it yet, or the user hasn't called `clearBackup`). Drives the
   * Rollback button visibility in admin-ui's AddonCard.
   */
  hasBackup: z.boolean().optional(),
  /** Kernel health snapshot — null when monitor doesn't track this package. */
  health: AddonHealthSchema.nullable().optional(),
})

const InstalledPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  dir: z.string(),
  installSource: z.string().optional(),
})

const PackageUpdateSchema = z.object({
  name: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  category: z.enum(['addon', 'core']),
  requiresRestart: z.boolean(),
  isSystem: z.boolean(),
})

const PackageVersionInfoSchema = z.object({
  version: z.string(),
  publishedAt: z.string(),
  deprecated: z.string().optional(),
  distTags: z.array(z.string()).readonly(),
})

const SearchResultSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  keywords: z.array(z.string()).readonly(),
  publishedAt: z.string(),
  author: z.string(),
  installed: z.boolean(),
  installedVersion: z.string().optional(),
  /**
   * Capability names the package's addons declare (from its published
   * manifest). `null` = the registry lookup failed — unknown, never `[]` (D393).
   */
  capabilities: z.array(z.string()).readonly().nullable(),
})

const AutoUpdateSettingsSchema = z.object({
  channel: ChannelSchema,
  intervalSeconds: z.number(),
  /**
   * Cadence of the "an update exists" POLLER, in seconds. Independent of
   * `channel`: the poller runs while auto-apply is `off`, because being told
   * about a publish and installing it are different decisions. Clamped
   * server-side to 900 s … 604800 s; defaults to 21600 s (6 h).
   */
  updateCheckIntervalSeconds: z.number(),
})

const AddonAutoUpdateSchema = ChannelWithInheritSchema

const RestartAddonResultSchema = z.unknown()

const InstallPackageResultSchema = z.unknown()
const ReloadPackagesResultSchema = z.unknown()

// ── Per-node uninstall ──────────────────────────────────────────────

/**
 * What an uninstall did on ONE node.
 *  - `uninstalled`       — removed: runner(s) stopped, caps gone, code deleted.
 *  - `not-installed`     — the node did not have it (nothing to do).
 *  - `refused`           — protected / bootstrap package; nothing touched.
 *  - `failed`            — attempted and did not complete; `error` says why.
 *  - `pending-reconnect` — the node is OFFLINE: its record was pruned so the
 *    back-fill never returns the package, and the stale-addon sweep removes the
 *    copy when the node registers again (only once the hub no longer has it).
 */
const UninstallNodeOutcomeSchema = z.enum([
  'uninstalled',
  'not-installed',
  'refused',
  'failed',
  'pending-reconnect',
])

const UninstallNodeResultSchema = z.object({
  nodeId: z.string(),
  outcome: UninstallNodeOutcomeSchema,
  error: z.string().optional(),
  addonIds: z.array(z.string()).readonly(),
  runnersStopped: z.array(z.string()).readonly(),
  warnings: z.array(z.string()).readonly(),
})

const UninstallPackageResultSchema = z.object({
  /** Every targeted node ended `uninstalled`, `not-installed` or `pending-reconnect`. */
  success: z.boolean(),
  packageName: z.string(),
  results: z.array(UninstallNodeResultSchema).readonly(),
})

/**
 * One node that has a package. `source: 'live'` = the node answered now (the
 * hub's installer, or an agent's `$agent.status`); `'recorded'` = an offline
 * node's last declared roster — the copy may or may not still be on disk.
 */
const PackageInstallationSchema = z.object({
  packageName: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
  isHub: z.boolean(),
  isOnline: z.boolean(),
  version: z.string().nullable(),
  addonIds: z.array(z.string()).readonly(),
  source: z.enum(['live', 'recorded']),
  /** The hub installs this package too. `false` on an agent row = an orphan. */
  onHub: z.boolean(),
})

/**
 * `unreachable` lists online agents whose status read FAILED — absence from
 * `installations` is only "not installed" for a node that answered (D315).
 */
const PackageInstallationsSchema = z.object({
  installations: z.array(PackageInstallationSchema).readonly(),
  unreachable: z.array(z.object({ nodeId: z.string(), error: z.string() })).readonly(),
})

export type UninstallNodeOutcome = z.infer<typeof UninstallNodeOutcomeSchema>
export type UninstallNodeResult = z.infer<typeof UninstallNodeResultSchema>
export type UninstallPackageResult = z.infer<typeof UninstallPackageResultSchema>
export type AddonSearchResult = z.infer<typeof SearchResultSchema>
export type PackageInstallation = z.infer<typeof PackageInstallationSchema>
export type PackageInstallations = z.infer<typeof PackageInstallationsSchema>

// ── Bulk update progress ────────────────────────────────────────────

const BulkUpdateItemStatusSchema = z.enum([
  'queued',
  'updating',
  'done',
  'done-pending-restart',
  'failed',
])

const BulkUpdateItemSchema = z.object({
  name: z.string(),
  isSystem: z.boolean(),
  fromVersion: z.string(),
  toVersion: z.string(),
  status: BulkUpdateItemStatusSchema,
  error: z.string().optional(),
  startedAtMs: z.number().optional(),
  completedAtMs: z.number().optional(),
})

const BulkUpdatePhaseSchema = z.enum(['regular', 'system', 'restarting', 'finalizing'])

const BulkUpdateStateSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  startedAtMs: z.number(),
  completedAtMs: z.number().optional(),
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  current: z.string().nullable(),
  phase: BulkUpdatePhaseSchema,
  cancelled: z.boolean(),
  items: z.array(BulkUpdateItemSchema).readonly(),
})

export type BulkUpdateItemStatus = z.infer<typeof BulkUpdateItemStatusSchema>
export type BulkUpdateItem = z.infer<typeof BulkUpdateItemSchema>
export type BulkUpdatePhase = z.infer<typeof BulkUpdatePhaseSchema>
export type BulkUpdateState = z.infer<typeof BulkUpdateStateSchema>

/**
 * One framework package row for the admin-UI "System packages" panel.
 * `latestVersion` is null when the npm lookup failed (offline / registry
 * unreachable) — the UI hides the Update button in that case.
 */
const FrameworkPackageStatusSchema = z.object({
  packageName: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  hasUpdate: z.boolean(),
  /** Optional manifest description for the row tooltip. */
  description: z.string().optional(),
  /**
   * Content build-id (md5 of the resolved `dist/` tree) of the code the hub
   * ACTUALLY loaded. Framework packages ship code changes without always
   * bumping `currentVersion`, so semver alone hides "same version, new code".
   * `null` when the dist can't be hashed (not installed / empty). The admin-UI
   * surfaces this so a stale-code hub is visible even at an unchanged version.
   */
  buildId: z.string().nullable(),
})

// LogStream entry — mirrors LoggingService output.
const LogStreamEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  scope: z.string().optional(),
})

// Generic log query result — admin-ui treats it as the same schema.
const LogQueryEntrySchema = z.unknown()

// Custom action dispatcher — pass-through. Used by `bindAddonActions`
// helper which downcasts to `(input: unknown) => Promise<unknown>` and
// stamps the per-action types on its own.
const CustomActionInputSchema = z.object({
  addonId: z.string().min(1),
  action: z.string().min(1),
  input: z.unknown(),
})

/**
 * `addons` is a **hub-centric** cap: the hub hosts the single provider
 * and orchestrates per-node operations itself. The optional `nodeId`
 * on `list` / `listUpdates` / `updatePackage` / `forceRefresh` is DATA
 * for the hub provider's internal dispatcher (it reads/pushes to the
 * target agent via `$agent.*` Moleculer actions), NOT a routing hint
 * for the cap-router — agents host no `addons` provider of their own.
 *
 * `nodeIdMode: 'data'` therefore forwards `nodeId` to the local hub
 * provider intact instead of stripping it for generic node routing.
 * See `CapabilityDefinition.nodeIdMode` and `addon-settings.cap.ts`
 * for the same pattern.
 */
export const addonsCapability = {
  name: 'addons',
  scope: 'system',
  mode: 'singleton',
  nodeIdMode: 'data',
  methods: {
    // ── Listing ──────────────────────────────────────────────────────
    /**
     * Installed addon roster for a node. `nodeId` omitted (or `'hub'`)
     * is the hub's own registry; an agent `nodeId` overlays that agent's
     * installed package versions (via `$agent.status`) onto hub manifests
     * and drops packages the agent does not have.
     */
    list: method(
      z.object({ nodeId: z.string().optional() }).optional(),
      z.array(AddonListItemSchema).readonly(),
    ),

    // ── Logs (query) ────────────────────────────────────────────────
    // Default auth (`protected`): authenticated users — including scoped
    // tokens with the right route-prefix scope. Reading logs isn't an
    // administrative action; install/restart/uninstall stay admin-only.
    getLogs: method(
      z.object({
        addonId: z.string(),
        limit: z.number().min(1).max(500).default(100),
        level: LogLevelSchema.optional(),
      }),
      z.array(LogQueryEntrySchema),
    ),

    // ── Packages ────────────────────────────────────────────────────
    listPackages: method(z.void(), z.array(InstalledPackageSchema).readonly()),
    installPackage: method(
      z.object({ packageName: z.string(), version: z.string().optional() }),
      InstallPackageResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    installFromWorkspace: method(
      z.object({ packageName: z.string() }),
      InstallPackageResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    isWorkspaceAvailable: method(z.void(), z.boolean()),
    listWorkspacePackages: method(z.void(), z.array(z.unknown()).readonly()),
    /**
     * Uninstall a package. `nodeId` omitted (or `'hub'`) uninstalls on the hub
     * — the original behaviour, which still THROWS on failure. An agent
     * `nodeId` removes it from that agent through `$agent.undeploy`
     * (runners stopped, caps deregistered, code deleted) and prunes the node's
     * declared roster so the back-fill never returns it. `everywhere: true`
     * does both for every node that has it (agents first, hub last); offline
     * nodes answer `pending-reconnect`. Node-level failures in those two modes
     * are REPORTED per node, never thrown. Protected packages are refused.
     */
    uninstallPackage: method(
      z.object({
        packageName: z.string().min(1),
        nodeId: z.string().optional(),
        everywhere: z.boolean().optional(),
      }),
      UninstallPackageResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Which nodes have a package (or, with no `packageName`, every package on
     * every node). Hub from its installer, online agents from `$agent.status`
     * (in parallel, bounded), offline agents from their declared roster.
     * Drives the uninstall confirm and the Addons page's "not on the hub" list.
     */
    listInstallations: method(
      z.object({ packageName: z.string().optional() }),
      PackageInstallationsSchema,
      { auth: 'admin' },
    ),
    reloadPackages: method(z.void(), ReloadPackagesResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    // Note: original router declared `searchAvailable` input as optional
    // outer object. The cap codegen requires a stable input shape — we
    // make `query` optional inside a required object to preserve client
    // call shape (`{ query?: string }`).
    searchAvailable: method(
      z.object({
        query: z.string().optional(),
        /** Only packages whose addons declare this capability (unknown ones excluded). */
        capability: z.string().optional(),
      }),
      z.array(SearchResultSchema),
    ),
    /**
     * Available package updates for a node. `nodeId` omitted (or
     * `'hub'`) checks the hub's own installed packages; an agent
     * `nodeId` checks that agent's installed roster against npm
     * (the hub does the npm lookups + diff — agents stay npm-free).
     */
    listUpdates: method(
      z.object({ nodeId: z.string().optional() }),
      z.array(PackageUpdateSchema).readonly(),
      { auth: 'admin' },
    ),
    /**
     * Update one package on a node. `nodeId` omitted (or `'hub'`)
     * installs on the hub via npm; an agent `nodeId` makes the hub
     * pack the resolved version and push the tarball to that agent
     * (`$agent.deploy` + `$agent.reload`) — agents need no npm runtime.
     */
    updatePackage: method(
      z.object({
        name: z.string().min(1),
        version: z.string().optional(),
        nodeId: z.string().optional(),
      }),
      z.unknown(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Roll back an addon to the version it had before the most recent
     * `updatePackage` call. The backup directory pointer is kept in the
     * central addon manifest until the post-update health-check
     * confirms the new install works (then it's cleared automatically),
     * so this only succeeds when the most recent update either failed
     * its restart or the user explicitly wants to revert.
     *
     * Returns `{ rolledBackTo: <version> }` on success, or
     * `{ rolledBackTo: null }` when there's no backup to roll back to
     * (caller can show a "no backup available" UI).
     */
    rollbackPackage: method(
      z.object({ name: z.string().min(1) }),
      z.object({ rolledBackTo: z.string().nullable() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Re-check updates for a node, bypassing any cache. `nodeId`
     *  omitted (or `'hub'`) refreshes the hub; an agent `nodeId`
     *  re-checks that agent's roster. */
    forceRefresh: method(z.object({ nodeId: z.string().optional() }), z.unknown(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    restartServer: method(z.object({ confirm: z.literal(true) }), z.unknown(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Most-recent restart marker (kind / packageName / from→to versions
     * / requestedBy / requestedAt). Returns `null` when this process
     * didn't boot from a tracked restart, or when the
     * post-boot retention window (5 min) has elapsed.
     *
     * Drives the admin-UI reconnect overlay's success toast — the
     * `system.restart-completed` event itself is fired before the
     * client has time to re-subscribe, so the client queries this on
     * first reconnect instead.
     */
    getLastRestart: method(
      z.void(),
      z
        .object({
          kind: z.enum(['framework-update', 'manual', 'system', 'framework-bulk-update']),
          packageName: z.string().optional(),
          fromVersion: z.string().optional(),
          toVersion: z.string().optional(),
          requestedBy: z.string().optional(),
          requestedAt: z.number(),
        })
        .nullable(),
      { auth: 'admin' },
    ),
    /**
     * Snapshot of the framework packages installed under the hub's
     * `<appRoot>/node_modules/`. Each row carries the currently
     * installed version and (best-effort) the latest version
     * available on npm. Drives the admin-UI "System packages" panel.
     *
     * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
     */
    listFrameworkPackages: method(z.void(), z.array(FrameworkPackageStatusSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * Cluster-wide capability-provider discovery. Returns the list of
     * `{ addonId, mode, isActive }` tuples for whatever addon(s)
     * currently provide the requested capability across the cluster.
     *
     * Why this lives on `addons` (and not on a `capabilities` cap of
     * its own): the hub's main-process `CapabilityRegistry` already
     * aggregates registrations from every forked group-runner and
     * remote agent via Moleculer event propagation — there's no
     * cross-process registry mirror to build, just an introspection
     * shim.
     *
     * Use this from addon code when you need to know whether another
     * addon has registered a specific cap (e.g. `tailscale-ingress`
     * checking `tailscale-client` is up before calling `tailscale
     * serve`). Don't reach for `ctx.capabilities.getCollectionEntries`
     * — that reads the LOCAL registry of the calling addon's group
     * runner and never sees providers in other processes. See
     * `CLAUDE.md` → Critical rules → ctx.api vs ctx.capabilities.
     */
    listCapabilityProviders: method(
      z.object({ capName: z.string().min(1) }),
      z
        .array(
          z.object({
            addonId: z.string(),
            mode: z.enum(['singleton', 'collection']),
            isActive: z.boolean(),
          }),
        )
        .readonly(),
    ),
    /**
     * Toggle a single collection-cap provider on/off. Generic write-side
     * counterpart of `listCapabilityProviders` — drives the per-provider
     * Enable/Disable affordance in admin pages (TURN servers, etc.)
     * without needing a bespoke orchestrator cap.
     *
     * Reaches the hub's `CapabilityRegistry` directly:
     * `enableCollectionProvider` / `disableCollectionProvider` flip the
     * registry-level `disabledProviders` set. `getCollectionEntries`
     * already filters disabled providers out, so a disabled provider
     * drops out of every collection aggregate immediately. Only valid
     * for `mode: 'collection'` caps — the registry no-ops + warns for
     * singletons.
     */
    setCapabilityProviderEnabled: method(
      z.object({
        capName: z.string().min(1),
        addonId: z.string().min(1),
        enabled: z.boolean(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    getVersions: method(
      z.object({ name: z.string() }),
      z.array(PackageVersionInfoSchema).readonly(),
    ),
    restartAddon: method(z.object({ addonId: z.string() }), RestartAddonResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Force-retry a failed addon NOW. Resets the retry counter so the
     * next failure starts from the 60s interval again. Used by the
     * "Retry now" button in the Addons admin page row + AlertCenter
     * alert action. Idempotent on healthy addons (no-op).
     */
    retryLoad: method(
      z.object({ packageName: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Auto-update ─────────────────────────────────────────────────
    getAutoUpdateSettings: method(z.void(), AutoUpdateSettingsSchema, { auth: 'admin' }),
    setAutoUpdateSettings: method(
      z.object({
        channel: ChannelSchema,
        intervalSeconds: z.number().min(300).max(86400).optional(),
        /** Availability-poll cadence; see AutoUpdateSettingsSchema. */
        updateCheckIntervalSeconds: z.number().min(900).max(604800).optional(),
      }),
      z.unknown(),
      { kind: 'mutation', auth: 'admin' },
    ),
    getAddonAutoUpdate: method(z.object({ addonId: z.string() }), AddonAutoUpdateSchema, {
      auth: 'admin',
    }),
    setAddonAutoUpdate: method(
      z.object({ addonId: z.string(), channel: ChannelWithInheritSchema }),
      z.unknown(),
      { kind: 'mutation', auth: 'admin' },
    ),
    applyAutoUpdateToAll: method(
      z.object({ channel: ChannelSchema }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Custom action dispatcher ────────────────────────────────────
    // Generic dispatcher used by `bindAddonActions`. Per-action auth
    // is enforced inside the provider; the outer cap auth is
    // `protected` (any authenticated user) so individual addons can
    // gate their own actions to public/protected/admin/superAdmin.
    // Viewer baseline (D921): the viewer app's own notification rules and
    // snoozes ride this dispatcher; each action's own auth still applies.
    custom: method(CustomActionInputSchema, z.unknown(), { role: 'viewer', kind: 'mutation' }),

    // ── Lifecycle job engine ─────────────────────────────────────────
    /**
     * Start a lifecycle job (install / update / uninstall / restart) for one
     * or more addon packages. Returns the `jobId` immediately — the job runs
     * asynchronously. Observe progress via `EventCategory.AddonsJobProgress` /
     * `AddonsJobLog` events or poll `getJob`.
     *
     * For a single-addon update on the hub the provider also routes
     * `updatePackage` through this path so the fast swap + atomic-restart
     * path (`applyStagedAddonUpdate`) is always used.
     */
    startJob: method(
      z.object({
        kind: z.enum(['install', 'update', 'uninstall', 'restart']),
        targets: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })).min(1),
        nodeIds: z.array(z.string()).optional(),
      }),
      z.object({ jobId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Retrieve a lifecycle job by id. Returns `null` when the id is unknown
     * (e.g. evicted after the retention window).
     */
    getJob: method(z.object({ jobId: z.string() }), lifecycleJobSchema.nullable(), {
      auth: 'admin',
    }),
    /**
     * List lifecycle jobs. When `activeOnly` is true, only jobs still in
     * `running` state are returned.
     */
    listJobs: method(
      z.object({ activeOnly: z.boolean().optional() }),
      z.array(lifecycleJobSchema),
      { auth: 'admin' },
    ),
    /**
     * Cancel a lifecycle job that is queued but not yet actively running.
     * Returns `{ cancelled: false }` if the job is unknown, already in a
     * terminal state, or actively executing (cannot abort mid-flight).
     */
    cancelJob: method(z.object({ jobId: z.string() }), z.object({ cancelled: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Log streaming ───────────────────────────────────────────────
    onAddonLogs: method(
      z.object({
        addonId: z.string(),
        level: LogLevelSchema.optional(),
      }),
      LogStreamEntrySchema,
      { kind: 'subscription' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type IAddonsProvider = InferProvider<typeof addonsCapability>

export {
  AddonAutoUpdateSchema,
  AddonListItemSchema,
  AutoUpdateSettingsSchema,
  BulkUpdateItemSchema,
  BulkUpdateItemStatusSchema,
  BulkUpdatePhaseSchema,
  BulkUpdateStateSchema,
  ChannelSchema,
  ChannelWithInheritSchema,
  CustomActionInputSchema,
  FrameworkPackageStatusSchema,
  InstalledPackageSchema,
  LogLevelSchema,
  LogStreamEntrySchema,
  PackageInstallationSchema,
  PackageInstallationsSchema,
  PackageUpdateSchema,
  PackageVersionInfoSchema,
  SearchResultSchema,
  UninstallNodeOutcomeSchema,
  UninstallNodeResultSchema,
  UninstallPackageResultSchema,
}
