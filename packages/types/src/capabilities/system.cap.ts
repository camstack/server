import { z } from 'zod'
import { FailureContributionSchema } from './failure-contribution.cap.js'
import { LoadContributionSchema } from './load-contribution.cap.js'
import { LogChannelDescriptorSchema } from '../logging/log-channel.js'
import { ServerNameInfoSchema } from '../system/server-name.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * system — system-scoped singleton capability exposing hub-level
 * health, feature flags, network interface enumeration, and the
 * analytics-suite retention controls.
 *
 * Implementation lives in the server's `FeatureService` plus the
 * `analysis-data-persistence` singleton (provided by
 * `addon-analytics-suite`). The provider is registered from
 * `trpc.router.ts` against the existing services — no addon owns
 * this surface end-to-end.
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router. Cap conversion lets the canonical hooks
 * (`useSystemInfo`, `useSystemHealth`, `useSystemNetworkAddresses`,
 * `useSystemGetRetentionConfig`, `useSystemSetRetentionConfig`,
 * `useSystemForceRetentionCleanup`) flow through the same codegen
 * as every other cap.
 */

const FeatureManifestSchema = z.object({
  streaming: z.boolean(),
  notifications: z.boolean(),
  objectDetection: z.boolean(),
  remoteAccess: z.boolean(),
  agentCluster: z.boolean(),
  smartHome: z.boolean(),
  recordings: z.boolean(),
  backup: z.boolean(),
  repl: z.boolean(),
})

/**
 * `system.info`: the feature flags plus the hub's human name (D861). The name is
 * `{ name, isDefault }` — `isDefault: true` means nobody named the hub and `name`
 * is the machine hostname.
 */
const SystemInfoSchema = FeatureManifestSchema.extend({
  serverName: ServerNameInfoSchema,
})

const HealthStatusSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number(),
})

const NetworkAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
  family: z.string(),
  internal: z.boolean(),
})

/**
 * Provenance of the site coordinates, and the whole reason this is not just two
 * numbers.
 *
 *   - `operator-set` — a human typed it, or accepted a detection. Authoritative;
 *     nothing overwrites it.
 *   - `derived-from-ip` — the hub geolocated its own public IP once, because a
 *     default that is right to a few kilometres beats the coarse UTC clock split
 *     the sun-times consumers otherwise fall back to.
 *
 * The UI shows which one it is. An operator who cannot tell a guess from their
 * own input will eventually trust the guess.
 */
const SiteLocationSourceSchema = z.enum(['operator-set', 'derived-from-ip'])

/**
 * Where the installation physically is — a fact of the SITE, not of any addon.
 *
 * It used to live in `pipeline-analytics`' global settings, which made a
 * property of the building a property of one analytics addon. Anything that
 * needs sun-times (scene condition variants today; anything solar tomorrow)
 * reads it from here.
 */
const SiteLocationSchema = z.object({
  /** WGS84 decimal degrees. */
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: SiteLocationSourceSchema,
  /** Epoch ms the value was last written. */
  updatedAt: z.number(),
  /**
   * Human-readable place the geo-IP service reported ("Napoli, IT"). Display
   * only — never parsed, never matched on. Absent for an operator-typed value.
   */
  label: z.string().optional(),
})

/**
 * The read shape: the location plus the honest state of the one-shot derivation.
 *
 * `derivationAttemptedAt` is what makes the "one call, ever" contract
 * inspectable. When it is set and `location` is null, the geo-IP lookup ran and
 * failed; the hub will NOT try again on its own — the fallback is declared
 * (consumers degrade to their own last resort) and the operator either types the
 * coordinates or presses detect.
 */
const SiteLocationStatusSchema = z.object({
  location: SiteLocationSchema.nullable(),
  derivationAttemptedAt: z.number().nullable(),
  /** Why the last derivation failed, for the UI to show instead of a shrug. */
  derivationError: z.string().nullable(),
})

/** `null` clears the location and re-arms nothing — the derivation stays spent. */
const SetSiteLocationInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .nullable()

/**
 * The TRANSPORT a call arrived on.
 *
 * Every counted call carries exactly one of these, and `unknown` is a PLANE
 * rather than a gap: a plane that cannot attribute a call declares it here, so
 * the call lands in a named bucket instead of vanishing. `planes` summing to
 * `procedureCalls` is what makes "the sum of the planes explains the total"
 * checkable rather than asserted.
 *
 *  - `http`  — the Fastify tRPC plugin (`/trpc/*`), one context per request.
 *  - `ws`    — `applyWSSHandler`, counted per OPERATION rather than per
 *              connection; the viewer talks to the hub over `wsLink`
 *              exclusively, so this is the plane the HTTP census could not see.
 *  - `mesh`  — the in-process `$core-caps` bridge (`createCaller`), which
 *              never touches a socket and therefore never touched a census.
 *  - `unknown` — counted, plane undecidable. No hook produces it today, and
 *    that is exactly what its `0` asserts: every plane the hub has can name
 *    itself. It is an output bucket, never a knob — a call that arrives on a
 *    plane nobody instrumented lands here instead of vanishing from the total.
 */
const TransportPlaneSchema = z.enum(['http', 'ws', 'mesh', 'unknown'])

/**
 * Calls per plane. Every key is always present, `0` included — an absent plane
 * reads as "not instrumented", which is the one thing this census must never
 * make an operator wonder about.
 */
const TransportPlaneCountsSchema = z.object({
  http: z.number(),
  ws: z.number(),
  mesh: z.number(),
  unknown: z.number(),
})

/**
 * One `(plane, procedure, user-agent, ip, principal)` tuple of the transport
 * census. `principal` is the DERIVED identity (`apocaliss92 (admin)`,
 * `scoped:1a2b3c4d (scoped-token)`, `anonymous`) that the tRPC error log
 * already prints - never a token, never an `Authorization` header.
 *
 * `subscriptions` is counted APART from `calls`: a subscription is opened once
 * and lives for hours, so folding it into a call count makes one long-lived
 * stream look like a storm.
 */
const RequestCensusGroupSchema = z.object({
  plane: TransportPlaneSchema,
  procedure: z.string(),
  userAgent: z.string(),
  ip: z.string(),
  principal: z.string(),
  calls: z.number(),
  subscriptions: z.number(),
  perMin: z.number(),
})

/**
 * A procedure's TOTAL over the window, across every caller.
 *
 * This block, not the group list, is what answers "did these calls arrive over
 * HTTP at all". A total far BELOW what a store-side census counted over the
 * same window excludes the HTTP plane, which is a result, not a failure.
 */
const RequestCensusProcedureSchema = z.object({
  procedure: z.string(),
  calls: z.number(),
  /**
   * The same total, split by transport. THIS is the row that answers the
   * question the census exists for: one look at `deviceManager.listAll` says
   * which plane carried the 4 960, without joining two log lines by eye.
   */
  planes: TransportPlaneCountsSchema,
  /** Subscription STARTS on this procedure. Never folded into `calls`. */
  subscriptions: z.number(),
  perMin: z.number(),
})

/** What one armed window measured. Mirrors `TransportCensus.snapshot()`. */
const RequestCensusSnapshotSchema = z.object({
  armed: z.boolean(),
  /** How long the current - or just-closed - window collected, in ms. */
  elapsedMs: z.number(),
  /** The window actually armed, after the server clamped the request. */
  windowMs: z.number(),
  /** Epoch ms the window closes at. 0 when disarmed. */
  armedUntilMs: z.number(),
  httpRequests: z.number(),
  batchedRequests: z.number(),
  /**
   * Procedure invocations. Higher than `httpRequests` whenever tRPC batching
   * is in play (`?batch=1` carries several procedures in one request); this is
   * the number comparable with a store-side call count.
   */
  procedureCalls: z.number(),
  /**
   * `procedureCalls` split by transport. The four keys sum to
   * `procedureCalls` by construction - {@link RequestCensusSnapshotSchema}'s
   * `planesExplainTotal` is that identity, checked rather than assumed.
   */
  planes: TransportPlaneCountsSchema,
  /**
   * True iff `planes` sums to `procedureCalls`. False means a call was counted
   * on no plane at all - which is a RESULT (a plane is missing from the
   * instrument), not a failure, and it has to be visible to be read as one.
   */
  planesExplainTotal: z.boolean(),
  /**
   * tRPC WebSocket connections opened during the window. NOT calls - the WS
   * adapter resolves one context per connection - kept because a plane's call
   * count of zero against 37 open connections says something different from a
   * plane with no connections at all.
   */
  wsConnections: z.number(),
  /**
   * Client frames the WS plane looked at. `wsMessages` far above
   * `planes.ws + subscriptions` means most traffic is not operations
   * (keepalives, connection params) - which is itself an answer.
   */
  wsMessages: z.number(),
  /**
   * Subscription STARTS across every plane, excluded from `procedureCalls` on
   * purpose: one live-events stream opened at boot and held for six hours is
   * one subscription, and counting it as a call would let a quiet plane
   * masquerade as the storm.
   */
  subscriptions: z.number(),
  /** `subscription.stop` frames. Starts minus stops is what is still open. */
  subscriptionStops: z.number(),
  distinctGroups: z.number(),
  /**
   * Operations counted in the totals whose CALLER attribution was shed at the
   * cardinality bound. Unrelated to the `unknown` PLANE: these calls know
   * which transport they arrived on, they just lost their group row.
   */
  unattributedCalls: z.number(),
  procedures: z.array(RequestCensusProcedureSchema).readonly(),
  groups: z.array(RequestCensusGroupSchema).readonly(),
})

/**
 * The census as an operator sees it.
 *
 * `persisted` is the honest answer to "will this survive the restart I am
 * about to do": the arm deadline is written to `system-settings` so a window
 * armed now can measure the NEXT boot, and a write that failed must not look
 * like one that succeeded.
 */
const RequestCensusStatusSchema = RequestCensusSnapshotSchema.extend({
  persisted: z.boolean(),
})

// ── logging settings document ────────────────────────────────────────
//
// ONE document, read and written whole. Adding a logging knob means adding a
// FIELD here, never a method: eight methods configuring the same thing are
// eight places to get it wrong, which is the sprawl the audit in
// `docs/design/plans/2026-08-26-per-component-logging.md` found (five knobs
// across three settings panels plus an env var that never worked).

/** Severity vocabulary. Mirrors `LogLevel` in `interfaces/logging.ts`. */
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

/**
 * The diagnostics that can be ARMED for a window. Exactly one today.
 *
 * A diagnostic is anything whose cost is only worth paying while a question is
 * open. It never persists as a boolean: see {@link DiagnosticWindowSchema}.
 */
const DiagnosticIdSchema = z.enum(['request-census'])

/**
 * The layers of the level hierarchy, general → specific. The most specific
 * layer that carries an explicit value wins.
 *
 * `component` became RESOLVABLE on 2026-08-27: a component is a declared log
 * CHANNEL (`stream-broker.webrtc`, `provider-reolink.baichuan`), named by
 * `scopeComponent`. It was declared-but-dark in the first slice precisely so
 * that turning it on would not force every consumer of this document to widen
 * a `levelSource` enum — which is what has now not happened.
 */
const LoggingScopeKindSchema = z.enum(['cluster', 'node', 'component'])

/** Where an effective level came from. `default` = nothing is set anywhere. */
const LoggingLevelSourceSchema = z.enum(['default', 'cluster', 'node', 'component'])

/**
 * One layer of the hierarchy as it actually STANDS.
 *
 * `level: null` is the whole reason this array is returned: it is the
 * difference between "this node is at `info` because I decided it" and
 * "...because it inherits". An operator who clears an override believing they
 * are clearing an inherited value has been handed the same defect as the two
 * contradicting knobs this document exists to remove, moved one floor up.
 */
const LoggingLevelLayerSchema = z.object({
  scope: LoggingScopeKindSchema,
  /** The node this layer speaks for; `null` on the cluster layer. */
  nodeId: z.string().nullable(),
  /**
   * The declared channel this layer speaks for; `null` on every layer but
   * `component`. Never folded into `nodeId`: a component level is CLUSTER-WIDE
   * by design — the convention this repo settled on is one orchestrator-wide
   * setting, never per node (D52) — so a component layer that carried a node
   * would invite a per-node copy of a value that has no per-node meaning.
   */
  component: z.string().nullable(),
  /** Explicitly set here, or `null` when this layer inherits. */
  level: LogLevelSchema.nullable(),
})

/** What a line is judged against, and WHICH layer decided it. */
const LoggingEffectiveSchema = z.object({
  level: LogLevelSchema,
  levelSource: LoggingLevelSourceSchema,
})

/** Every layer, general → specific. Never collapsed into the effective value. */
const LoggingExplicitSchema = z.object({
  layers: z.array(LoggingLevelLayerSchema).readonly(),
})

/**
 * An armed diagnostic, with its DEADLINE.
 *
 * The shape of ADR-0244: what is stored is a deadline and never a flag, so a
 * diagnostic somebody forgot expires by itself, and a boot-window measurement
 * survives the restart it exists to measure. `remainingMs` is 0 whenever
 * `armed` is false — a window is never reported as slightly expired.
 */
const DiagnosticWindowSchema = z.object({
  id: DiagnosticIdSchema,
  armed: z.boolean(),
  /** Epoch ms the window closes at. 0 when disarmed. */
  armedUntilMs: z.number(),
  /** Ms left before it expires on its own. 0 when disarmed. */
  remainingMs: z.number(),
  /** Whether the stored deadline is the one the live diagnostic is running —
   *  i.e. whether this window would survive a restart. */
  persisted: z.boolean(),
})

/**
 * `armMs: 0` DISARMS. Any positive value arms for that long, clamped by the
 * server — there is no maximum here on purpose: a bound repeated in a schema
 * is a second knob that disagrees with the first the day one of them moves.
 */
const DiagnosticWindowPatchSchema = z.object({
  id: DiagnosticIdSchema,
  armMs: z.number().int().min(0),
  /** Cadence of the diagnostic's aggregated report line. Clamped by the server. */
  reportEveryMs: z.number().int().positive().optional(),
})

// ── per-component channels ───────────────────────────────────────────
//
// A channel is DECLARED by the addon that owns it, through the `log-channels`
// capability, and never listed here — a hand-wired central list rots at the
// first addition and rots invisibly. What lives in this document is only the
// VALUE: which channel is armed, for which cameras, until when.

/**
 * A channel ARMED, as the document reports it.
 *
 * `armMs` is not echoed back: what an operator needs to see is the deadline
 * and the time left, because a diagnostic left running is itself an incident
 * and "armed for 10 minutes" said an hour ago is not an answer.
 */
const LogChannelWindowStateSchema = z.object({
  channel: z.string(),
  armed: z.boolean(),
  /** Epoch ms the window closes at. 0 when disarmed. */
  armedUntilMs: z.number(),
  /** Ms left before it expires on its own. 0 when disarmed. */
  remainingMs: z.number(),
  /**
   * The cameras it is narrowed to, or `null` for every camera.
   *
   * A channel declared `perDevice: false` can only ever report `null` here:
   * its lines do not carry `tags: { deviceId }`, so narrowing them would
   * produce a filter that silently matches nothing. The server REFUSES such a
   * patch rather than quietly widening it — ignoring the request would teach
   * the operator that per-camera filtering works on that channel when it does
   * not.
   */
  deviceIds: z.array(z.number().int()).readonly().nullable(),
})

/**
 * `armMs: 0` DISARMS. Same grammar as {@link DiagnosticWindowPatchSchema}, and
 * for the same reason: a channel is a window with a deadline, never a switch.
 */
const LogChannelWindowPatchSchema = z.object({
  channel: z.string().min(1),
  armMs: z.number().int().min(0),
  /**
   * Narrow to these numeric device ids. Absent or `null` = every camera.
   *
   * Numeric because the repo's own rule makes it possible: every log line
   * about a device carries `tags: { deviceId }` with the numeric id. That rule
   * was paid for with a 22% thumbnail gap and a 3-hour media blackout both
   * diagnosed by hand, and this is the first thing that collects on it.
   */
  deviceIds: z.array(z.number().int()).readonly().nullable().optional(),
})

/**
 * A PATCH, and patches MERGE.
 *
 * A field absent from the patch is left exactly as it was — arming a
 * diagnostic never resets a level, and setting a level never disarms a window.
 * The provider must not reconstruct the document as `{ ...snapshot, ...patch }`:
 * `setAll` already merges, and rebuilding the object is how an absent field
 * turns into an erased one.
 */
const LoggingSettingsPatchSchema = z.object({
  /**
   * Absent leaves the level untouched. `null` CLEARS the explicit value at the
   * addressed scope so it inherits again. A value sets it.
   */
  level: LogLevelSchema.nullable().optional(),
  /**
   * Only the diagnostics NAMED here change. An armed window that is not listed
   * keeps running — a patch is never a full replacement.
   */
  diagnostics: z.array(DiagnosticWindowPatchSchema).readonly().optional(),
  /**
   * Only the channels NAMED here change. An armed channel that is not listed
   * keeps running — same rule as `diagnostics`, because a patch that silently
   * disarmed the channels it did not mention would make the Levels page and
   * the Diagnostics page fight over the same value.
   */
  channels: z.array(LogChannelWindowPatchSchema).readonly().optional(),
  /**
   * How many days the analytics OPS LOG is kept — the audit trail of what
   * retention actually deleted.
   *
   * It lives HERE, on the logging document, and not on the analytics addon's
   * settings form, on the operator's instruction: every other log-ish window in
   * this system is configured through this one document, and a retention audit
   * configured somewhere else is a second place to look when the question is
   * "what happened to my data".
   *
   * That placement has a cost worth stating: this document ships in the
   * framework closure, so this knob needs a published `@camstack/server` while
   * the four windows beside it (D485) reach a node on `camstack deploy`.
   *
   * `retention-model.ts` argued this one must NOT follow a device window,
   * because the audit trail is the history of the SWEEP and not of the camera.
   * That argument stands and is untouched — what changes is that 30 days stops
   * being a constant nobody can reach. `0` keeps it forever. The floor is 1 day
   * rather than 0-as-delete: an audit log truncated to nothing is precisely the
   * state in which the next 9.5 GiB leak cannot be explained.
   */
  opsLogRetentionDays: z.number().int().min(0).max(3650).optional(),
})

/**
 * Which LAYER of the hierarchy is addressed. Absent = the cluster layer.
 *
 * Deliberately NOT called `nodeId`: that key is reserved on every cap method
 * input — the generated router strips it and uses it to resolve the PROVIDER
 * on that node (`resolveProvider(cap, nodeId, …)`). A document about
 * `agent-1` addressed as `nodeId` would be forwarded to agent-1 and answered
 * by an agent that holds no cluster document at all. The hub is the single
 * authority over the whole hierarchy and answers for every layer, so the
 * layer selector needs a name the transport does not already own.
 */
/**
 * One contribution, plus WHO reported it.
 *
 * The addon and node are added by the hub as it enumerates providers, never by
 * the contributor: an addon reporting its own identity could report somebody
 * else's, and the whole point of this surface is that no claim is made by
 * anyone but its owner.
 */
const ReportedLoadContributionSchema = LoadContributionSchema.extend({
  addonId: z.string(),
})

export type ReportedLoadContribution = z.infer<typeof ReportedLoadContributionSchema>

/**
 * One per-camera failure counter, plus WHO reported it.
 *
 * Same rule as {@link ReportedLoadContributionSchema}: `addonId` is stamped by
 * the hub as it enumerates providers, never by the contributor.
 */
const ReportedFailureContributionSchema = FailureContributionSchema.extend({
  addonId: z.string(),
})

export type ReportedFailureContribution = z.infer<typeof ReportedFailureContributionSchema>

const GetLoggingSettingsInputSchema = z.object({
  scopeNodeId: z.string().optional(),
  /**
   * The declared CHANNEL this document is addressed at, when the caller wants
   * the `component` layer. Absent = the node/cluster hierarchy only.
   *
   * Naming it separately rather than overloading `scopeNodeId` keeps the two
   * axes from collapsing: a component level is cluster-wide, a node level is
   * not, and one selector for both would make "which of these two did I just
   * set" unanswerable — the exact ambiguity `explicit` exists to remove.
   */
  scopeComponent: z.string().optional(),
})

const SetLoggingSettingsInputSchema = z.object({
  scopeNodeId: z.string().optional(),
  scopeComponent: z.string().optional(),
  patch: LoggingSettingsPatchSchema,
})

/**
 * The whole document, as read and as returned after every write.
 *
 * `persisted: false` means the settings store could not be read or written.
 * The in-memory mirror still governs behaviour and is unchanged by the
 * failure — a read that fails neither switches a level nor disarms a window
 * (D49) — but the operator is told that what they are looking at would not
 * survive a restart.
 */
const LoggingSettingsStateSchema = z.object({
  /** The layer this document was read at. `null` = the cluster layer. */
  scopeNodeId: z.string().nullable(),
  /** The channel this document was read at. `null` = no component layer. */
  scopeComponent: z.string().nullable(),
  effective: LoggingEffectiveSchema,
  explicit: LoggingExplicitSchema,
  activeWindows: z.array(DiagnosticWindowSchema).readonly(),
  /**
   * Every channel the cluster's addons DECLARE, gathered from the
   * `log-channels` providers. Not stored anywhere: assembled per read, so a
   * channel added by a redeployed addon appears without anybody editing a
   * list, and a channel whose addon is gone stops being offered.
   */
  channels: z.array(LogChannelDescriptorSchema).readonly(),
  /** The channels ARMED right now, each with its deadline. */
  activeChannels: z.array(LogChannelWindowStateSchema).readonly(),
  /**
   * The ops-log window in days, as it is in force. `0` = kept forever.
   *
   * Reported rather than left to the caller's memory of what it wrote: this is
   * the value the analytics sweep will actually use, and an operator asking how
   * long their audit trail lives should not have to infer it from a default.
   */
  opsLogRetentionDays: z.number().int().min(0),
  persisted: z.boolean(),
})

export const systemCapability = {
  name: 'system',
  scope: 'system',
  mode: 'singleton',
  methods: {
    info: method(z.void(), SystemInfoSchema),
    health: method(z.void(), HealthStatusSchema),
    featureFlags: method(z.void(), FeatureManifestSchema),
    networkAddresses: method(z.void(), z.array(NetworkAddressSchema).readonly()),
    // Retention config is opaque on the wire — the analytics-suite owns the
    // schema. `getRetentionConfig` returns null when the analytics addon
    // is not loaded; `setRetentionConfig` accepts a partial patch.
    getRetentionConfig: method(z.void(), z.unknown().nullable(), { auth: 'admin' }),
    setRetentionConfig: method(z.record(z.string(), z.unknown()), z.null(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    forceRetentionCleanup: method(z.void(), z.void(), { kind: 'mutation', auth: 'admin' }),

    /**
     * The site coordinates, deriving a default from the hub's public IP on the
     * FIRST read that finds nothing stored.
     *
     * The derivation is one-shot and bounded: one outbound request, a few
     * seconds, its outcome persisted either way. A hub with no internet pays it
     * once and never again, and neither boot nor any consumer is blocked on it —
     * the caller gets `location: null` and degrades exactly as it did before this
     * method existed.
     */
    getSiteLocation: method(z.void(), SiteLocationStatusSchema),

    /** Operator input. Always lands as `source: 'operator-set'`. */
    setSiteLocation: method(SetSiteLocationInputSchema, SiteLocationStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Re-run the geo-IP derivation now. The ONLY way a spent or failed
     * derivation is retried — there is no timer, and no read path retries.
     * Overwrites an existing `derived-from-ip` value; refuses to clobber an
     * `operator-set` one.
     */
    detectSiteLocation: method(z.void(), SiteLocationStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Read the HTTP request census - which caller, from which address, with
     * which user-agent, invoked which tRPC procedure, and how often.
     *
     * Reading NEVER re-arms: re-arming clears the counts, which would throw
     * away exactly the numbers being asked for. A closed window may be read as
     * many times as the operator likes and always describes the same window.
     *
     * Admin-only: the rows carry source addresses and principal names.
     */
    getRequestCensus: method(z.void(), RequestCensusStatusSchema, { auth: 'admin' }),

    /**
     * Every `load-contribution` an addon on this cluster reports — each
     * addon's OWN cost, already attributed by the addon that owns it.
     *
     * There is no central list of what costs what: an addon that spawns a
     * per-camera child declares it, and one that cannot attribute its cost
     * (the shared inference pool) declares THAT. So a new cost family appears
     * here the moment its addon is redeployed, with nobody editing anything.
     *
     * What this does NOT do is measure the node. `metrics.node-processes-
     * snapshot` still does that, and the difference between the two is the
     * finding: a process no contribution claims is either a leak or a family
     * nobody has taught to report. Both belong in the unattributed bucket, and
     * neither may be folded into a camera.
     */
    getLoadContributions: method(z.void(), z.array(ReportedLoadContributionSchema).readonly(), {
      auth: 'admin',
    }),

    /**
     * Every `failure-contribution` an addon on this cluster reports — per
     * camera, per reason, **with the denominator attached**.
     *
     * This is the surface the operator asked for on 2026-08-28 (*"possiamo
     * armare questi errori intanto? Così al prossimo giro ricontrolliamo tutti
     * questi punti"* [can we instrument these errors in the meantime? That way next round we recheck all these points]). Before it, four live failure modes could only be counted
     * by grepping Loki and hand-correlating timestamps, which is exactly how a
     * 22% thumbnail gap and a 3-hour media blackout were diagnosed — twice.
     *
     * Read it as a RATIO, never as a count. `attempts` is on every entry
     * because the count on its own lies: `enrichment crop native miss` read as
     * "35x worse than yesterday" and was flat across twelve hours once divided
     * by the successes on the same path.
     *
     * The counters are CUMULATIVE since each entry's `sinceMs`. Reading does
     * not reset them, and `sinceMs` changing means the reporting runner
     * respawned — a consumer differencing two reads drops that interval.
     *
     * Admin-only: the rows name cameras and the paths that fail on them.
     */
    getFailureContributions: method(
      z.void(),
      z.array(ReportedFailureContributionSchema).readonly(),
      { auth: 'admin' },
    ),

    /**
     * The logging settings document — levels and armed diagnostics — resolved
     * for `nodeId`, or for the cluster when `nodeId` is absent.
     *
     * Returns BOTH `effective` and `explicit`. See
     * {@link LoggingLevelLayerSchema} for why collapsing them is the defect.
     */
    getLoggingSettings: method(GetLoggingSettingsInputSchema, LoggingSettingsStateSchema, {
      auth: 'admin',
    }),

    /**
     * Write the logging settings document. The ONLY write authority over log
     * levels and diagnostic windows — arming the request census went through
     * `system.setRequestCensus` until 2026-08-27 and no longer does, because
     * two writes that disagree about the same window is exactly the defect
     * this document exists to remove (D245).
     *
     * The patch MERGES: see {@link LoggingSettingsPatchSchema}.
     */
    setLoggingSettings: method(SetLoggingSettingsInputSchema, LoggingSettingsStateSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type ISystemProvider = InferProvider<typeof systemCapability>

export type RequestCensusGroup = z.infer<typeof RequestCensusGroupSchema>
export type RequestCensusProcedure = z.infer<typeof RequestCensusProcedureSchema>
export type RequestCensusSnapshot = z.infer<typeof RequestCensusSnapshotSchema>
export type RequestCensusStatus = z.infer<typeof RequestCensusStatusSchema>
export type TransportPlane = z.infer<typeof TransportPlaneSchema>
export type TransportPlaneCounts = z.infer<typeof TransportPlaneCountsSchema>

export type DiagnosticId = z.infer<typeof DiagnosticIdSchema>
export type DiagnosticWindow = z.infer<typeof DiagnosticWindowSchema>
export type DiagnosticWindowPatch = z.infer<typeof DiagnosticWindowPatchSchema>
export type GetLoggingSettingsInput = z.infer<typeof GetLoggingSettingsInputSchema>
export type LoggingEffective = z.infer<typeof LoggingEffectiveSchema>
export type LoggingExplicit = z.infer<typeof LoggingExplicitSchema>
export type LoggingLevelLayer = z.infer<typeof LoggingLevelLayerSchema>
export type LoggingLevelSource = z.infer<typeof LoggingLevelSourceSchema>
export type LoggingScopeKind = z.infer<typeof LoggingScopeKindSchema>
export type LogChannelWindowPatch = z.infer<typeof LogChannelWindowPatchSchema>
export type LogChannelWindowState = z.infer<typeof LogChannelWindowStateSchema>
export type LoggingSettingsPatch = z.infer<typeof LoggingSettingsPatchSchema>
export type LoggingSettingsState = z.infer<typeof LoggingSettingsStateSchema>
export type SetLoggingSettingsInput = z.infer<typeof SetLoggingSettingsInputSchema>

export type SiteLocation = z.infer<typeof SiteLocationSchema>
export type SiteLocationSource = z.infer<typeof SiteLocationSourceSchema>
export type SiteLocationStatus = z.infer<typeof SiteLocationStatusSchema>
export type SetSiteLocationInput = z.infer<typeof SetSiteLocationInputSchema>

export {
  DiagnosticIdSchema,
  DiagnosticWindowPatchSchema,
  DiagnosticWindowSchema,
  FeatureManifestSchema,
  GetLoggingSettingsInputSchema,
  HealthStatusSchema,
  LoggingEffectiveSchema,
  LoggingExplicitSchema,
  LoggingLevelLayerSchema,
  LoggingLevelSourceSchema,
  LoggingScopeKindSchema,
  LoggingSettingsPatchSchema,
  LoggingSettingsStateSchema,
  LogChannelWindowPatchSchema,
  LogChannelWindowStateSchema,
  LogLevelSchema,
  NetworkAddressSchema,
  ReportedFailureContributionSchema,
  ReportedLoadContributionSchema,
  RequestCensusGroupSchema,
  RequestCensusProcedureSchema,
  RequestCensusSnapshotSchema,
  RequestCensusStatusSchema,
  SetLoggingSettingsInputSchema,
  SetSiteLocationInputSchema,
  SiteLocationSchema,
  SiteLocationSourceSchema,
  SiteLocationStatusSchema,
  TransportPlaneCountsSchema,
  TransportPlaneSchema,
}
