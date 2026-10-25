import * as path from 'node:path'
// All capability tRPC routers are built at runtime by `buildRuntimeCapRouters`
// (from `ALL_CAPABILITY_DEFINITIONS`). This file wires only the `server-provided`
// factory map (`buildServerProviders`) and the CORE (non-cap) routers. Tracking
// comment for the historical migration index (every `create<X>Router` that used
// to live here has been replaced by its codegen'd cap-router counterpart):
//   auth → auth (kept manual for AuthService DI), users/system →
//   `userMgmt`/`system` caps, settings → `system-config` builtin,
//   devices → `deviceManager` cap, integrations → `integrations` cap,
//   streaming → `streamingManagement` cap, events → `eventQuery` cap,
//   logs → kept manual, live → kept manual, processes → `processMgmt`
//   cap, agents → `nodes` cap, sessions → `session` cap, trackMedia /
//   trackTrail → caps, network →
//   `networkQuality` cap, addons → `addons` cap, bridgePipeline removed
//   (legacy), detection → `detectionConfig` cap, capabilities → kept
//   manual, update → addons cap, addonPages → cap, notification →
//   `notifications` (kept manual for NotificationService DI),
//   scopedToken → `userManagement`, toast → `toast` cap, inference →
//   `pipelineExecutor` cap, pipeline → `pipelineConfig` cap,
//   systemEvents → kept manual.
import type { CapabilityRegistry, NotificationService, ToastService } from '@camstack/system'
import type {
  BrokerConsumerAttribution,
  InferProvider,
  WebrtcClientHints,
  WebrtcStreamTarget,
} from '@camstack/types'
import { webrtcSessionCapability } from '@camstack/types'
import type { AddonPackageService } from '../../core/addon/addon-package.service'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service'
import type { AddonBridgeService } from '../../core/addon-bridge/addon-bridge.service'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service'
import type { AuthService } from '../../core/auth/auth.service'
import type { HandoffCodeService } from '../../core/auth/handoff-code.service'
import type { CredentialTokenService } from '../../core/auth/credential-token.service.js'
import type { ConfigService } from '../../core/config/config.service'
import type { EventBusService } from '../../core/events/event-bus.service'
import type { FeatureService } from '../../core/feature/feature.service'
import type { LoggingService } from '../../core/logging/logging.service'
import type { MoleculerService } from '../../core/moleculer/moleculer.service'
import type { NetworkQualityService } from '../../core/network/network-quality.service'
import type { ReplEngineService } from '../../core/repl/repl-engine.service'
import type { ServerUpdateService } from '../../core/server-update/server-update.service'
import type { StreamProbeService } from '../../core/streaming/stream-probe.service'
import { createAddonSettingsRouter } from '../core/addon-settings.router.js'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import type { SessionBacking } from '../../auth/session-mint.js'
import { getSessionConnections } from '../../auth/session-connections.js'
import type { ExternalLinkIntents } from '../../auth/external-link-intents.js'
import { createAgentPairingRouter } from '../core/agent-pairing.router.js'
import { createCertificatesRouter } from '../core/certificates.router.js'
import { createNodeCertificatesClient } from '../../core/agent/node-certificates-client.js'
import { createAuthRouter, type NativeLinkRouterDeps } from '../core/auth.router.js'
import {
  buildAddonsProvider,
  buildIntegrationsProvider,
  buildNetworkQualityProvider,
  buildNodesProvider,
  buildSystemProvider,
  buildToastProvider,
  createNodeRootPackageLookup,
} from '../core/cap-providers.js'
import { createCapabilitiesRouter } from '../core/capabilities.router.js'
import { createClusterNodesRouter } from '../core/cluster-nodes.router.js'
import { createEventBusProxyRouter } from '../core/event-bus-proxy.router.js'
import { createHwAccelRouter } from '../core/hwaccel.router.js'
import { createLiveEventsRouter } from '../core/live-events.router.js'
import { createLogsRouter } from '../core/logs.router.js'
import { createNotificationsRouter } from '../core/notifications.router.js'
import { createPreferencesRouter, preferencesFromRegistry } from '../core/preferences.router.js'
import { createReplRouter } from '../core/repl.router.js'
import { buildServerManagementProvider } from '../core/server-management.provider.js'
import { createStreamProbeRouter } from '../core/stream-probe.router.js'
import { createSystemEventsRouter } from '../core/system-events.router.js'
import { buildRuntimeCapRouters, type ServerProviderFactory } from './cap-router-runtime.js'
import {
  type ClientClass,
  classifyClientRequest,
  deriveRelayOnly,
  extractUserAgent,
} from './client-ip.js'
import type { mountAllCaps } from './generated-cap-mounts.js'
import type { ServerProvidedCapName } from './server-provided-caps.js'
import type { TrpcContext } from './trpc.context.js'
import { trpcRouter } from './trpc.middleware'

export interface RouterServices {
  authService: AuthService
  /** The one token store (D892): `auth.mintToken` mints here. */
  credentialTokenService?: CredentialTokenService | null
  /** One-time native-app login handoff codes (in-memory, 60s TTL, single-use). */
  handoffCodeService: HandoffCodeService
  /** Pending D782 "link this sign-in account" intents, shared with `/api/auth/sso/finish`. */
  externalLinkIntents: ExternalLinkIntents
  /** Native-app link claims and browser handoff (D801); `null` = not offered. */
  nativeLink?: NativeLinkRouterDeps | null
  /** Real client address + trusted networks for the auth surface. */
  authNetworkPolicy?: AuthNetworkPolicy
  /** The login-session table the auth router's mint opens sessions in. */
  sessionBacking?: () => SessionBacking | null
  configService: ConfigService
  featureService: FeatureService
  loggingService: LoggingService
  eventBus: EventBusService
  agentRegistry: AgentRegistryService
  moleculer: MoleculerService
  addonRegistry: AddonRegistryService
  replEngine: ReplEngineService
  networkQualityService: NetworkQualityService
  addonBridge: AddonBridgeService
  addonPackageService: AddonPackageService
  notificationService: NotificationService | null
  toastService: ToastService | null
  capabilityRegistry: CapabilityRegistry | null
  streamProbe: StreamProbeService | null
  serverUpdateService: ServerUpdateService | null
}

type WebrtcSessionProvider = InferProvider<typeof webrtcSessionCapability>
type CreateSessionInput = Parameters<WebrtcSessionProvider['createSession']>[0]
type HandleOfferInput = Parameters<WebrtcSessionProvider['handleOffer']>[0]

/**
 * Merge the server-read User-Agent into a signaling call's
 * `consumerAttribution`, building a NEW input object (immutable — never
 * mutates the caller's input). When `userAgent` is null (mesh-originated
 * call, or a client that omits the header) the input passes through
 * unchanged. Any client-supplied `userAgent` is OVERWRITTEN — the hub
 * trusts only the request context, never the client.
 */
export function enrichInputWithUserAgent<
  TInput extends { consumerAttribution?: BrokerConsumerAttribution },
>(input: TInput, userAgent: string | null): TInput {
  if (userAgent === null) return input
  const base: BrokerConsumerAttribution = input.consumerAttribution ?? { kind: 'webrtc-browser' }
  return {
    ...input,
    consumerAttribution: { ...base, userAgent },
  }
}

/**
 * Operator gate for FORCING TURN-relay-only ICE on genuinely-remote viewers.
 * DEFAULT OFF.
 *
 * The forced relay↔relay path is disabled by default because it was NEVER
 * validated to deliver media. It was originally disabled on 2026-05-26 after a
 * connected relay session produced a black picture — ICE/DTLS completed but no
 * decodable media was forwarded over the relay (a MEDIA-FORWARD reliability
 * bug, not a signalling one). The later werift+0.22.9 patch
 * (`patches/werift+0.22.9.patch`) fixed a DIFFERENT bug — a host/srflx
 * candidate LEAK in the forced-relay SDP — and does nothing for relay
 * media-forward, so the connected-but-black regression remains unproven-fixed.
 *
 * And until 2026-09-12 that patch was not even RUNNING on a live node: it is
 * applied by `patch-package` in a dev tree only, and the closure installed
 * werift from npm unpatched (D478). So the leak this gate's re-enable path
 * assumes is fixed was, in fact, present in production the whole time — do not
 * run the one-real-remote-relay-session validation against a closure that
 * predates the closure-postinstall applier, or it will fail for that reason
 * rather than for the media-forward one it is meant to test.
 *
 * Until an operator confirms that ONE real remote relay session (4G /
 * Cloudflare-tunnel) actually delivers media, remote viewers stay on the same
 * `relayOnly:false` path as everyone else. Set `CAMSTACK_FORCE_RELAY_REMOTE=1`
 * (or `true`) to re-enable remote→relay once validated; the broker's pairClass
 * logging is the instrument for that validation.
 */
const FORCE_RELAY_REMOTE =
  process.env.CAMSTACK_FORCE_RELAY_REMOTE === '1' ||
  process.env.CAMSTACK_FORCE_RELAY_REMOTE === 'true'

/**
 * Inject the SERVER-computed `relayOnly` ICE override.
 *
 * The client's three-way classification (`lan | vpn | remote`, see
 * `client-ip.ts`) is ALWAYS computed by the caller and passed here so the
 * broker's pairClass logging can observe the viewer class for every session.
 * Whether that class actually forces a relay is gated by
 * `FORCE_RELAY_REMOTE` (default OFF — see above):
 *   - gate OFF → `relayOnly: false` for ALL classes (today's effective,
 *     validated behaviour: nobody is forced onto the unproven relay path).
 *   - gate ON  → `deriveRelayOnly(clientClass)` — only genuinely-remote
 *     viewers (public / CGNAT-4G / Cloudflare-tunnel) get `relayOnly: true`;
 *     `lan` and `vpn` (Tailscale) keep the low-latency direct host/srflx path.
 *
 * When the class is `null` (mesh-originated call — no request context) the
 * input passes through UNCHANGED so a trusted addon-set `relayOnly` (e.g.
 * Alexa) is never clobbered. Any client-supplied `relayOnly` on a
 * request-bound call IS overwritten — the hub trusts only the request context.
 *
 * Immutable — builds a NEW input object, never mutates the caller's.
 */
export function enrichInputWithRelayClass<TInput extends { relayOnly?: boolean }>(
  input: TInput,
  clientClass: ClientClass | null,
): TInput {
  if (clientClass === null) return input
  const relayOnly = FORCE_RELAY_REMOTE ? deriveRelayOnly(clientClass) : false
  return { ...input, relayOnly }
}

/**
 * Strip `talkback` from a REQUEST-bound `handleOffer` (D771).
 *
 * Talk-back sends the peer's microphone to the camera's speaker. Only a
 * trusted, mesh-originated caller may ask for it — today the Alexa export,
 * which has already checked the linked user may control the camera. A
 * browser's talk permission lives on the intercom cap's own surface (share
 * tokens gate it there); letting a request-bound `handleOffer` set this flag
 * would be a second door to the speaker. Same rule as `relayOnly`: a
 * mesh-originated call (`clientClass === null`) passes through unchanged.
 *
 * Immutable — builds a NEW input object, never mutates the caller's.
 */
export function stripTalkbackFromRequest(
  input: HandleOfferInput,
  clientClass: ClientClass | null,
): HandleOfferInput {
  if (clientClass === null || input.talkback === undefined) return input
  const { talkback: _dropped, ...rest } = input
  return rest
}

/**
 * Bias used to live here (`prefersTier: 'low'` for `remote`). That pinned
 * every phone-sized session — including LAN IPv6 GUA misclassified as remote
 * — onto the sub stream. Initial tier is now `pickAdaptiveTier` (default
 * low, downlink limiter including mid, viewport ceiling for tiny tiles). This function
 * stays as the documented seam so a future probe can still thread class
 * without a cap change; today it is a no-op.
 */
export function enrichHintsWithClientClass<
  TInput extends { target?: WebrtcStreamTarget; hints?: WebrtcClientHints },
>(input: TInput, _clientClass: ClientClass | null): TInput {
  return input
}

/**
 * Per-request wrapper around the resolved `webrtc-session` broker singleton.
 *
 * Two SERVER-side enrichments, both read from the tRPC request context (the
 * broker is a forked addon that cannot see the HTTP request):
 *  1. `relayOnly` — the ICE policy. The client is classified three ways
 *     (`lan | vpn | remote`, 2026-07-15): Tailscale (`vpn`) is distinguished
 *     from genuine internet (`remote`) and Cloudflare Tunnel's
 *     `CF-Connecting-IP` on the loopback connector path is honoured, closing
 *     the two blind spots the boolean classifier had (a tailnet client on the
 *     hub's own 100.64/10 address is `vpn`; a Cloudflare-tunneled viewer with
 *     a loopback socket peer is `remote`, not misread as LAN). The class is
 *     ALWAYS computed and threaded so the broker's pairClass logging can
 *     observe it — but FORCING remote viewers onto a relay↔relay path is
 *     GATED OFF by default (`CAMSTACK_FORCE_RELAY_REMOTE`, see
 *     `enrichInputWithRelayClass`).
 *
 *     Why gated: the forced-relay MEDIA-FORWARD path was disabled on
 *     2026-05-26 because a connected relay session delivered NO decodable
 *     media (ICE/DTLS up, picture black). The werift+0.22.9 patch
 *     (`patches/werift+0.22.9.patch`) fixed a DIFFERENT bug — the forced-relay
 *     SDP host/srflx candidate LEAK — and does NOT address relay
 *     media-forward, so the connected-but-black regression is still unproven-
 *     fixed. The flag lets the operator re-enable remote→relay only after
 *     validating that ONE real 4G / Cloudflare-tunnel relay session actually
 *     delivers media (the broker pairClass logging is the instrument). Until
 *     then every class gets `relayOnly:false`.
 *  2. `consumerAttribution.userAgent` — the browser UA for the broker's
 *     client list.
 *
 * All OTHER methods delegate straight through — auth, the remote-proxy
 * factory and every signaling behaviour are untouched.
 */
export function wrapWebrtcSessionProviderWithRelay(
  provider: WebrtcSessionProvider,
  ctx: TrpcContext,
): WebrtcSessionProvider {
  const userAgent = extractUserAgent(ctx.req)
  const clientClass = classifyClientRequest(ctx.req)
  // The login session this request runs under: media opened here dies with it
  // (`session-connections.ts`). A principal with no `sid` has nothing to tie to.
  const authSessionId = ctx.user?.sessionId
  const hold = (deviceId: number, mediaSessionId: string): void => {
    if (authSessionId === undefined) return
    getSessionConnections().trackMedia(authSessionId, {
      deviceId,
      mediaSessionId,
      close: () => provider.closeSession({ deviceId, sessionId: mediaSessionId }),
    })
  }
  return {
    ...provider,
    createSession: async (input: CreateSessionInput) => {
      const created = await provider.createSession(
        enrichHintsWithClientClass(
          enrichInputWithRelayClass(enrichInputWithUserAgent(input, userAgent), clientClass),
          clientClass,
        ),
      )
      hold(input.deviceId, created.sessionId)
      return created
    },
    handleOffer: async (input: HandleOfferInput) => {
      const answered = await provider.handleOffer(
        enrichHintsWithClientClass(
          enrichInputWithRelayClass(
            enrichInputWithUserAgent(stripTalkbackFromRequest(input, clientClass), userAgent),
            clientClass,
          ),
          clientClass,
        ),
      )
      hold(input.deviceId, answered.sessionId)
      return answered
    },
    closeSession: (input: { readonly deviceId: number; readonly sessionId: string }) => {
      if (authSessionId !== undefined) {
        getSessionConnections().forgetMedia(authSessionId, input.sessionId)
      }
      return provider.closeSession(input)
    },
  }
}

/**
 * Build the `server-provided` provider factory map (BIG PLAN 2). Caps marked
 * `mount: { kind: 'server-provided' }` have their provider supplied by the
 * server, keyed by cap NAME. The factory either composes backend services
 * (`system`, `nodes`, `integrations`, `addons`, `network-quality`, `toast`) or
 * transforms a registry provider (`webrtc-session` wraps the broker to inject
 * the request User-Agent). The runtime builder mounts the route from the live
 * def schemas and resolves the provider through this map instead of the
 * registry — keeping backend composition in `@camstack/server` (the
 * self-sufficiency invariant: `@camstack/system` never touches a backend
 * service). Each factory receives the per-request tRPC `ctx`.
 */
function buildServerProviders(
  services: RouterServices,
): Readonly<Record<ServerProvidedCapName, ServerProviderFactory>> {
  type SP = ServerProviderFactory
  const wrap =
    (fn: (ctx: TrpcContext) => unknown): SP =>
    (ctx) =>
      fn(ctx as TrpcContext) as ReturnType<SP>
  return {
    'network-quality': wrap(() => buildNetworkQualityProvider(services.networkQualityService)),
    system: wrap(() =>
      buildSystemProvider(
        services.featureService,
        services.capabilityRegistry,
        services.loggingService.createLogger('site-location'),
      ),
    ),
    toast: wrap((ctx) => buildToastProvider(services.toastService, ctx)),
    integrations: wrap(() =>
      buildIntegrationsProvider(
        services.addonRegistry,
        services.eventBus,
        services.loggingService,
        services.capabilityRegistry,
      ),
    ),
    nodes: wrap(() =>
      buildNodesProvider(
        services.agentRegistry,
        services.moleculer,
        services.addonRegistry,
        createNodeRootPackageLookup(services.moleculer, services.serverUpdateService),
        services.loggingService.createLogger('nodes'),
      ),
    ),
    // server-management — runtime-updatable root package (phase 1: hub only).
    'server-management': wrap(() => buildServerManagementProvider(services.serverUpdateService)),
    addons: wrap((ctx) =>
      buildAddonsProvider(
        services.addonRegistry,
        services.addonPackageService,
        services.loggingService,
        services.moleculer,
        services.configService,
        ctx,
        services.agentRegistry,
      ),
    ),
    // webrtc-session — the resolved broker singleton, wrapped per request to
    // inject the server-read User-Agent into signaling attribution (the broker
    // is a forked addon that can't see the HTTP request). Cross-node (agent-
    // hosted broker) calls route through the generic remote-proxy leg and skip
    // this local factory, exactly as the retired custom mount did.
    'webrtc-session': wrap((ctx) => {
      const provider =
        services.capabilityRegistry?.getSingleton<WebrtcSessionProvider>('webrtc-session') ?? null
      return provider ? wrapWebrtcSessionProviderWithRelay(provider, ctx) : null
    }),
  }
}

/**
 * Build the AppRouter capability track (BIG PLAN 2).
 *
 * The per-cap router CONSTRUCTION now lives in `@camstack/system`
 * (`buildCapRouters`), driven at runtime by `ALL_CAPABILITY_DEFINITIONS`
 * + the declarative `mount` hint on each cap def. A capability update
 * therefore ships via the framework plugin (`@camstack/types` +
 * `@camstack/system`) with NO `@camstack/server` rebuild — the value is
 * dynamic.
 *
 * The AppRouter TYPE stays codegen-derived: the dynamic value is assigned
 * to `ReturnType<typeof mountAllCaps>` (the generated per-cap router type
 * map) at the single documented type boundary below, so the SDK keeps
 * full procedure inference and `generate-api-types.ts` resolves the same
 * expanded type as before.
 *
 * Spread order: the dynamic caps first, then the hand-written core (non-cap)
 * routers. Every cap — including the former `custom` ones — is now built by the
 * runtime builder; the server only supplies `server-provided` provider factories
 * (`buildServerProviders`), never a hand-written cap-router override.
 */
function buildCapabilityRouters(services: RouterServices) {
  // ── Dynamic cap routers (value) → static cap-router map (type). ──────
  // The runtime builder returns `Record<string, unknown>`; assigning it to
  // `ReturnType<typeof mountAllCaps>` is the documented type boundary that
  // keeps the AppRouter type codegen-derived while the value is built from
  // the cap defs at runtime. `mountAllCaps` is imported for its TYPE only
  // (`import type`) — its value is never called; the codegen
  // `generated-cap-mounts.ts` / `generated-cap-routers.ts` remain the TYPE
  // source of record.
  const integrationRegistry = services.addonRegistry.getIntegrationRegistry()
  const deviceRegistry = services.addonRegistry.getDeviceRegistry()
  const dynamicCaps: ReturnType<typeof mountAllCaps> = buildRuntimeCapRouters({
    capabilityRegistry: services.capabilityRegistry,
    moleculer: services.moleculer,
    serverProviders: buildServerProviders(services),
    logger: services.loggingService.createLogger('cap-router'),
    resolveIntegrationAddonId: integrationRegistry
      ? async (integrationId) => {
          const row = await integrationRegistry.getIntegration(integrationId)
          return row?.addonId ?? null
        }
      : undefined,
    resolveDeviceAddonId: (camDeviceId) => deviceRegistry.getAddonId(camDeviceId),
  }) as ReturnType<typeof mountAllCaps>

  return {
    // ── Runtime-built cap routers: EVERY cap whose mount is
    //    `singleton` / `collection` / `device-native` / `server-provided`
    //    / `hub-only`. Only `skip` caps are excluded (never mounted). The
    //    former `custom` caps are gone: `snapshot-provider` was dead
    //    (deleted); `webrtc-session` is now a `server-provided` cap resolved
    //    by `buildServerProviders`. ──────
    ...dynamicCaps,

    // ── Non-cap (core) routers — hand-written, single-impl ──────────
    notifications: createNotificationsRouter(services.notificationService),
    // Raw DB proxy for forked workers to read/write addon store.
    // Workers use ctx.api.addonSettingsRaw.getGlobal.query({...}).
    // NOT the three-level settings gateway — that's the
    // `addonSettings` cap router (mounted dynamically above).
    addonSettingsRaw: createAddonSettingsRouter(services.configService),
    eventBusProxy: createEventBusProxyRouter(services.eventBus),
    repl: createReplRouter(services.replEngine),
    systemEvents: createSystemEventsRouter(services.eventBus),
    capabilities: createCapabilitiesRouter(services.capabilityRegistry, services.configService),
    logs: createLogsRouter(services.loggingService, services.capabilityRegistry),
    live: createLiveEventsRouter(services.eventBus, services.addonRegistry),
    // stream-probe — fixed core API (ffprobe wrapper), not a cap.
    streamProbe: createStreamProbeRouter(services.streamProbe),
    // hwaccel — fixed core API, repointed onto the `platform-probe` cap
    // (the sole cross-node-pinnable hwaccel surface). UI pipeline /
    // NodeDetail pages query per-node to show which hardware backend each
    // agent will use.
    hwaccel: createHwAccelRouter(services.capabilityRegistry, services.moleculer),
    // clusterNodes — fixed core API. Write-side purge for the durable
    // offline-node history (Track A "Forget node"); read side is push-only.
    clusterNodes: createClusterNodesRouter(services.agentRegistry),
    // certificates - Identity -> Certificates inventory (HTTPS per node, mesh CA). D855.
    certificates: createCertificatesRouter({
      registry: services.capabilityRegistry,
      agentRegistry: services.agentRegistry,
      nodeClient: (nodeId) => createNodeCertificatesClient(services.moleculer, nodeId),
      nodeAddonIds: (nodeId) => services.moleculer.getNodeAddonIds(nodeId),
      hubDataDir: path.resolve(
        services.configService.get<string>('server.dataPath') ?? 'camstack-data',
      ),
      log: services.loggingService.createLogger('certificates'),
    }),
    // preferences - the caller's own account preferences, synced across their devices (D894).
    preferences: createPreferencesRouter({
      preferences: preferencesFromRegistry(services.capabilityRegistry),
    }),
    // agentPairing - hub-initiated pairing of agents, unpairing (D857).
    agentPairing: createAgentPairingRouter({
      registry: services.capabilityRegistry,
      nodeClient: (nodeId) => createNodeCertificatesClient(services.moleculer, nodeId),
      log: services.loggingService.createLogger('agent-pairing'),
    }),
    auth: createAuthRouter(
      services.authService,
      services.capabilityRegistry,
      services.moleculer,
      services.handoffCodeService,
      services.externalLinkIntents,
      services.nativeLink ?? null,
      {
        ...(services.authNetworkPolicy !== undefined
          ? { network: services.authNetworkPolicy }
          : {}),
        ...(services.sessionBacking !== undefined ? { sessions: services.sessionBacking } : {}),
        credentialTokens: services.credentialTokenService ?? null,
        logger: services.loggingService.createLogger('auth'),
      },
    ),

    // NOT MOUNTED — `mount: { kind: 'skip' }` legacy provider shapes
    // (positional args / sync returns) that don't match the codegen
    // routers' {input}-object + Promise<T> contract. The runtime builder
    // skips them via `resolveCapMount` (task #195):
    //   - addon-routes / auth-provider / log-destination
    //   - restreamer / streaming-engine / webrtc
  }
}

export function buildAppRouter(services: RouterServices) {
  return trpcRouter({
    ...buildCapabilityRouters(services),
  })
}

export type AppRouter = ReturnType<typeof buildAppRouter>
