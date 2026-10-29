/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- pre-existing lint debt across this 800+ line bootstrap module. The flagged sites cross typed boundaries (Fastify request typing, AddonRouteRegistry, AuthService inherited methods) where the projectService context can't trace inheritance chains. Tracked separately; do not amend in unrelated edits. */

import { createLazyUiServing, type StaticUiProvider } from './ui-serving/lazy-ui-serving.js'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Server as TlsServer } from 'node:tls'
// Boot-time capability declaration runs over the auto-generated
// `ALL_CAPABILITY_DEFINITIONS` array — every `*.cap.ts` file that ships
// with `@camstack/types` is included automatically. Adding a new cap
// requires no edit to this file: drop the `*.cap.ts` and re-run
// `npx tsx scripts/generate-capability-router-types.ts`. The previous
// hand-curated list silently dropped caps (zones, zone-rules,
// zone-analytics, audio-metrics — see git for the regression).
// Sourced from `@camstack/system` (not `@camstack/types`) so the hub's
// capability surface refreshes on `camstack deploy packages/system` with no new
// server image. `@camstack/types` is never deployed to the hub.
import {
  AddonRouteRegistry,
  ALL_CAPABILITY_DEFINITIONS,
  allFamiliesListenHost,
  bindPendingLanHttp,
  createDeferredHeapWatchSink,
  createEventPlaneReader,
  createInspectorArrayBufferCensus,
  createMeshQueueReader,
  createSocketPlaneReader,
  createV8Reclaimer,
  DataPlaneRegistry,
  getLoggingGate,
  getMoleculerEventStats,
  getUserManagementInternal,
  HUB_MAIN_HEAP_WATCH_LABEL,
  hubMainRssBudget,
  onSessionsRevoked,
  proxyToUpstream,
  registerHttpsListener,
  registerLanHttpHandler,
  signalAllRunnerGroups,
  startEventLoopStallMonitor,
  startHeapWatch,
} from '@camstack/system'
import type { ILocalNetworkProvider } from '@camstack/types'
import fastifyCompress from '@fastify/compress'
import fastifyCookie from '@fastify/cookie'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import type { CreateWSSContextFnOptions } from '@trpc/server/adapters/ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { WebSocketServer } from 'ws'
import { registerAddonUploadRoute } from './api/addon-upload'
import { registerMeshMembershipRoutes } from './api/mesh-membership-routes'
import { registerAuthWhoamiRoute } from './api/auth-whoami'
import { registerBackupDownloadRoute } from './api/backup-download.js'
import { buildSettingsStoreGateway } from './api/core/cap-providers'
import { LoggingSettingsService } from './api/core/logging-settings'
import { RequestCensusService } from './api/core/request-census-settings'
import {
  createCorsPolicy,
  refuseForeignWsUpgrade,
  registerCorsPolicy,
} from './api/cors/register-cors-policy'
import {
  ADAPTIVE_PROBE_PER_IP_PER_MINUTE,
  registerAdaptiveProbeRoute,
} from './api/health/adaptive-probe.routes'
import { registerHealthRoutes } from './api/health/health.routes'
import { blankToNull, PRODUCT_VERSION_ENV } from './core/release-identity'
import { RunnerBootCheckService } from './core/runner-health/runner-boot-check'
import { clusterBaseUrlResolver, resolveHubBaseUrl } from './api/hub-cluster-url'
import { buildModelDistributorProvider } from './api/model-distributor.js'
import { dataPlaneReplayBody } from './api/data-plane/form-body.js'
import { registerOauth2Routes } from './api/oauth2/oauth2-routes.js'
import { registerEmbedAuthRoute } from './auth/embed-auth-route.js'
import { liveUserCheck } from './auth/live-user.js'
import { registerServerUploadRoute } from './api/server-upload'
import type { AgentDeliveryBroker } from './api/agent-addon-delivery'
import { registerServerUploadPropagateRoute } from './api/server-upload-propagate'
import { markSseRequestNoCompression } from './api/sse-no-compression.js'
import { registerFramePolicy } from './api/static/frame-policy'
import {
  resolvePrecompressedAsset,
  warmPrecompressedAssets,
} from './api/static/precompressed-asset.js'
import { FORWARDED_PREFIX_HEADER, parseForwardedPrefix, sendSpaShell } from './api/static/spa-mount'
import {
  addonBundleCacheControl,
  contentTypeForPath,
  isRetiredPublicPath,
  spaAssetCacheControl,
  spaShellCacheControl,
} from './api/static/spa-static'
import { buildCoreCapService, setRemotePrivilegeLogSink } from './api/trpc/core-cap-bridge'
import type { RemoteUpdateGrantDeps } from './api/trpc/remote-addon-update-grant'
import { getHttpRequestCensus } from './api/trpc/http-request-census.singleton'
import { recordTrpcHttpRequest } from './api/trpc/http-request-census-hook'
import type { TrpcContext } from './api/trpc/trpc.context'
import {
  createTrpcContext,
  bindHubCredentialStores,
  createWsTrpcContext,
  hubCredentialVerifier,
  requestFacts,
} from './api/trpc/trpc.context'
import {
  getSessionConnections,
  SESSION_ENDED_CLOSE_CODE,
  SESSION_ENDED_CLOSE_REASON,
} from './auth/session-connections.js'
import { buildAppRouter } from './api/trpc/trpc.router'
import { trpcErrorDeviceTags } from './api/trpc/trpc-error-device-tags'
import { describeTrpcPrincipal } from './api/trpc/trpc-error-principal'
import { attachWsCensusSession, identifyWsCensusSession } from './api/trpc/ws-request-census'
import { WsSlowConsumerGuard, wsConnectionFacts } from './api/trpc/ws-slow-consumer-guard.js'
import { addonRouteCaller, authorizeAddonBearer } from './auth/addon-route-auth.js'
import { SHARE_DEVICES_HEADER, SHARE_KIND_HEADER } from './auth/addon-route-share-gate.js'
import { createAuthNetworkPolicy } from './auth/auth-network-policy.js'
import { createSessionTokenCheck, sessionBackingFrom } from './auth/hub-sessions.js'
import { readSessionLifetimes } from './auth/session-lifetimes.js'
import { clientKeyFromRequest, createRateLimiter } from './auth/auth-rate-limit'
import { ExternalLinkIntents } from './auth/external-link-intents.js'
import {
  buildSessionCookie,
  clearSessionCookie,
  isSessionGradeJwtPayload,
  loginRedirectUrl,
  SESSION_COOKIE,
  sessionCookieIsSecure,
  shouldRedirectToLogin,
} from './auth/session-cookie.js'
import { createSessionMinter } from './auth/session-mint.js'
import { createSsoFinishDeps } from './auth/sso-finish-deps.js'
import { AppConfirmations } from './auth/app-confirmations.js'
import { registerAppConfirmRoutes } from './auth/app-confirm-routes.js'
import { registerAppPasskeyRoutes } from './auth/app-passkey-routes.js'
import { registerAppRefusedRoute } from './auth/app-refused-route.js'
import { resolvePasskeyProvider } from './auth/passkey-provider.js'
import { collectSecondFactors } from './auth/second-factors.js'
import { registerSsoRoutes } from './auth/sso-routes.js'
import { UsedBridgeIds } from './auth/used-bridge-ids.js'
import { NativeLinkCompletions } from './auth/native-link-completions.js'
import { loadBootstrapConfig, setupInfra } from './boot/boot-config'
import { loadPlatformKeychainKey } from './boot/platform-keychain-key'
import { runIntegrationIdBackfill } from './boot/integration-id-backfill'
import { PostBootService } from './boot/post-boot.service'
import { dropRetiredHubAddressEnv } from './boot/retired-public-url-env'
import { AddonPackageService } from './core/addon/addon-package.service'
import { AddonRegistryService } from './core/addon/addon-registry.service'
import { AddonBridgeService } from './core/addon-bridge/addon-bridge.service'
import { AddonPagesService } from './core/addon-pages/addon-pages.service'
import {
  AddonWidgetsService,
  stripBundleVersionSegment,
} from './core/addon-widgets/addon-widgets.service'
import { AgentRegistryService } from './core/agent/agent-registry.service'
import { buildAppLinkFiles, parseCertFingerprints } from './core/app-links/well-known-app-links'
import { AuthService } from './core/auth/auth.service'
import { HandoffCodeService } from './core/auth/handoff-code.service'
import { CredentialTokenService } from './core/auth/credential-token.service.js'
import { ConfigService } from './core/config/config.service'
import { EventBusService } from './core/events/event-bus.service'
import { FeatureService } from './core/feature/feature.service'
import { LoggingService } from './core/logging/logging.service'
import { MoleculerService } from './core/moleculer/moleculer.service'
import { NetworkQualityService } from './core/network/network-quality.service'
import { ReplEngineService } from './core/repl/repl-engine.service'
import { ServerUpdateService } from './core/server-update/server-update.service'
import { StorageService } from './core/storage/storage.service'
import { StreamProbeService } from './core/streaming/stream-probe.service'
import { bootManual } from './manual-boot'
import { runSingleCopyCleanup } from './single-copy-cleanup-runner.js'

// ---- Process-level error handlers ----

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Unhandled exception — server will continue:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Unhandled promise rejection — server will continue:', reason)
})

// ---- Graceful shutdown ----

// Kill all child processes immediately on signal, then let Fastify clean up.
// This is critical because tsx watch (dev) force-kills the main process after a short
// timeout — if we wait for Fastify OnModuleDestroy, children become orphans.
let shutdownStarted = false
function immediateChildCleanup(signal: string) {
  if (shutdownStarted) return
  shutdownStarted = true

  console.log(`[shutdown] Received ${signal} — killing child processes immediately…`)

  // Every addon-runner leads its OWN process group (D668), so the hub-group kill
  // below no longer reaches runners or their ffmpeg/llama-server children.
  // Signal each runner group first.
  const runnerGroups = signalAllRunnerGroups('SIGTERM')

  // Synchronously kill all children of this process via the OS.
  // This is fast and ensures no orphans even if Fastify shutdown is slow.
  try {
    const myPid = process.pid
    const isMac = process.platform === 'darwin'
    // pkill sends SIGTERM to all processes whose parent is our PID
    const cmd = isMac
      ? `pkill -TERM -P ${myPid} 2>/dev/null; true`
      : `kill -- -${myPid} 2>/dev/null; true`
    execSync(cmd, { timeout: 3000 })
    console.log(`[shutdown] Child processes signalled (runner groups: ${runnerGroups})`)
  } catch {
    // Best effort — children may have already exited
  }

  // Safety: force exit after 10s if Fastify shutdown stalls
  const timer = setTimeout(() => {
    console.error('[shutdown] Graceful shutdown timed out after 10s — forcing exit')
    process.exit(1)
  }, 10_000)
  timer.unref()
}

process.on('SIGTERM', () => immediateChildCleanup('SIGTERM'))
process.on('SIGINT', () => immediateChildCleanup('SIGINT'))

// ---- Orphan cleanup ----

/**
 * Kill leftover camstack processes from a previous crash.
 * Targets: coreml_inference.py (Python engines).
 * Only kills processes whose parent is PID 1 (orphaned) to avoid killing children of a live server.
 */
function cleanupOrphanProcesses(): void {
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  if (!isMac && !isLinux) return

  let killed = 0

  try {
    // Find orphaned coreml_inference.py processes (ppid=1 means orphaned)
    const cmd = isMac
      ? "ps -eo pid,ppid,command | grep -E 'coreml_inference\\.py' | grep -v grep"
      : "ps -eo pid,ppid,cmd | grep -E 'coreml_inference\\.py' | grep -v grep"

    const output = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim()
    if (!output) return

    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[0]!, 10)
      const ppid = parseInt(parts[1]!, 10)

      // Only kill orphans (ppid=1) — never kill children of a running server
      if (ppid !== 1 || isNaN(pid) || pid === process.pid) continue

      try {
        process.kill(pid, 'SIGTERM')
        killed++
      } catch {
        // Process may have already exited
      }
    }
  } catch {
    // grep returns exit code 1 when no matches — that's fine
  }

  if (killed > 0) {
    console.log(`[cleanup] Killed ${killed} orphaned camstack process(es) from a previous run`)
  }
}

/**
 * Send a static SPA asset, preferring a cached brotli copy.
 *
 * Setting `content-encoding` is what stops `@fastify/compress` from running:
 * its `onSend` hook bails out when the reply already declares an encoding
 * other than `identity` (`@fastify/compress/index.js:250`). Verified in the
 * plugin, not assumed — a second pass over an already-compressed body would
 * reach the client as garbage.
 *
 * The content type is set from the ORIGINAL path. The file being streamed is
 * `<name>.br`, and inferring from that would label a JavaScript bundle
 * `application/brotli`, which no browser will execute.
 *
 * Every failure path serves the original file unchanged, so this can only ever
 * be an optimisation: a client that does not accept brotli, an image, a
 * read-only dist and a missing file all end up on exactly the previous
 * behaviour.
 */
async function sendMaybePrecompressed(
  reply: FastifyReply,
  absolutePath: string,
  acceptEncoding: string | undefined,
): Promise<FastifyReply> {
  if (reply.getHeader('content-type') === undefined) {
    reply.type(contentTypeForPath(absolutePath))
  }
  const resolved = await resolvePrecompressedAsset(absolutePath, acceptEncoding, (msg, meta) =>
    console.log(`[static] ${msg} ${JSON.stringify(meta)}`),
  )
  if (resolved.encoding === 'br') {
    reply.header('content-encoding', 'br')
    reply.header('vary', 'accept-encoding')
  }
  // `sendFile` used to set this; a raw stream would go out chunked, which
  // costs the client its download progress and any length-based preload.
  try {
    reply.header('content-length', String(fs.statSync(resolved.filePath).size))
  } catch {
    // Racing a redeploy that replaced the file — chunked is a fine fallback.
  }
  return reply.send(fs.createReadStream(resolved.filePath))
}

// ---- Bootstrap ----

async function bootstrap() {
  // The hub's address comes from the `local-network` cap, never from env. A
  // retired address variable is dropped here — before any addon runner is
  // forked, so no child can read it — and warned about once a logger exists
  // (below). See `boot/retired-public-url-env.ts`.
  const publicUrlWarning = dropRetiredHubAddressEnv(process.env)
  // A desktop hub's keychain master key arrives on an inherited pipe (D788).
  // Read and closed before anything is forked, so no runner inherits it.
  const platformKey = loadPlatformKeychainKey()
  if (platformKey.kind === 'loaded') {
    console.log(`[keychain] master key provided by the ${platformKey.label}`)
  } else if (platformKey.kind === 'failed') {
    console.warn(`[keychain] the desktop app's key pipe could not be read: ${platformKey.error}`)
  }
  // hub-main's own memory, on the record. Deliberately started HERE and not in
  // the starter: the starter runs from the image's /opt closure, which only
  // changes with a new image, while this entry is what `applyServerUpdate`
  // replaces — so the telemetry reaches a running hub the same day it is
  // written. See packages/system/src/kernel/heap-watch.ts for why it exists
  // (four silent OOMs in ~15h, one nine seconds after a viewer connected).
  //
  // The reclaimer is what turns the heartbeat from a report into a fix. hub-main's
  // RSS is a HIGH-WATER MARK — measured over 1019 samples and seven boots, it never
  // once fell below the running maximum of heapTotal+external — because V8 keeps the
  // 256KB pages it committed at a sawtooth peak, and an ordinary major GC does not
  // return them. `createV8Reclaimer()` returns undefined if V8 declines, and the
  // heartbeat then behaves exactly as it did before.
  //
  // What it recovers, and what it does NOT: the reclaimer is
  // `gc({ execution: 'sync', flavor: 'last-resort' })` — V8 and only V8. It hands back the
  // 256KB pages V8 committed at a sawtooth peak, which on 2026-08-27 was ~1.3GB of a 4.87GiB
  // process. The other ~2.8GB, spread across 13 anonymous mappings >=64MB, is glibc memory
  // already freed by the allocator and never returned to the kernel; nothing in this repository
  // calls `malloc_trim`, and no V8 flavor reaches it. So the pass is a real bound on the V8
  // share and touches none of the share that grew. It is telemetry plus a partial bound, not a
  // fix — do not read a reclaim line as "the leak was handled".
  const heapReclaimer = createV8Reclaimer()
  const heapReclaim = heapReclaimer === undefined ? undefined : { reclaim: heapReclaimer }
  // ...and the budget the heartbeat alarms on. hub-main has no manifest to declare one in, and
  // the entrypoint that would be the obvious alternative is the least deployable surface here —
  // the image never carries this repo's backend. So the number lives in `@camstack/server`,
  // which is what `applyServerUpdate` replaces, for exactly the reason the heartbeat itself is
  // started from this file. See `hubMainRssBudget` for why 4096, and why it is expected to fire.
  //
  // The sink is DEFERRED. Started here, before any logger exists, the heartbeat could only ever
  // reach `console.log` — which is not a log destination, so for 42 hours Loki carried a `[mem]`
  // line for every runner in the cluster and none for the largest process in it. The sink is
  // repointed at `LoggingService` the moment it exists (below), and boot lines keep going to
  // stdout exactly as before. See `createDeferredHeapWatchSink`.
  const heapWatchSink = createDeferredHeapWatchSink(HUB_MAIN_HEAP_WATCH_LABEL)
  // ...and the event planes, which is the OTHER half of what this process is.
  // hub-main's `arrayBuffers` is a rate, not a set: every forced compaction
  // drops it to 12-29MB (ten passes out of ten, 2026-08-29), so the number to
  // watch is the slope — 181-330MB/min steady, one burst of >=1.3GB in <=11s —
  // and the traffic behind it is ~22 000 socket reads/s and ~22 500 writes/s at
  // a 0.33KB mean. `LocalChildRegistry` has counted that per child since the
  // fan-out gate was built and NOTHING had ever read it; `getMoleculerEventStats`
  // likewise. This surfaces both.
  //
  // Every source is read LAZILY: this runs as the first statement of bootstrap()
  // and `MoleculerService` does not exist for hundreds of lines. Until it does,
  // the reader reports `undefined` and the line carries no fan-out fields at all
  // — a plane that does not exist yet must not be reported as a silent one.
  let moleculerForEventPlane: MoleculerService | null = null
  startHeapWatch(
    HUB_MAIN_HEAP_WATCH_LABEL,
    heapWatchSink.sink,
    undefined,
    heapReclaim,
    undefined,
    undefined,
    true,
    hubMainRssBudget(),
    {
      eventPlane: createEventPlaneReader({
        registry: () => moleculerForEventPlane?.childRegistry ?? null,
        crossNodeStats: () => {
          const broker = moleculerForEventPlane?.broker
          return broker === undefined ? null : getMoleculerEventStats(broker)
        },
      }),
      // The fan-out counters above answered their own question and sharpened
      // this one: the event plane is 4% of this process's ~44 000 socket
      // syscalls/s. The other 96% had no instrument — `/proc` reports one
      // rchar/wchar pair per PROCESS and has no per-socket breakdown, so the
      // best attribution available was a correlation with `hub/pipeline-
      // analytics` computed from a runner whose rchar also counts page-cache
      // reads. These counters live on the channel itself, so the attribution is
      // per peer and per frame kind. Same lazy registry, same reason.
      socketPlane: createSocketPlaneReader({
        registry: () => moleculerForEventPlane?.childRegistry ?? null,
      }),
      // The write queue to every peer NODE, from Moleculer's own writer
      // sockets. Those are unref'd (`TcpWriter.connect`), so the 2026-09-10
      // exclusion of "every socket queue" — a sum over `_getActiveHandles()` —
      // never saw them. With the UDS queues above, every outbound plane this
      // process writes to is now on the line and judged on every probe (D446).
      meshQueue: createMeshQueueReader(() => moleculerForEventPlane?.broker ?? null),
      // The ArrayBuffer census, armed by the probe itself. Twice on 2026-09-10
      // this process's `arrayBuffers` climbed linearly for an hour (to 1.3 GB
      // and to 5 GB, both LIVE across a forced compaction) and released in one
      // instant, with no line at either boundary; the measurement that names
      // the shape existed and was never run because it needed a human awake
      // during the episode. Now the heartbeat takes it: one forced full GC —
      // the pause a reclaim pass already costs — walked in memory, nothing
      // written, on a threshold held for a minute, at most twice an hour.
      // It is NOT a heap snapshot; see `array-buffer-census.ts`.
      arrayBufferCensus: { census: createInspectorArrayBufferCensus() },
    },
  )

  // Clean up orphaned processes from previous crashes before starting
  cleanupOrphanProcesses()

  // SPA fallback — set later when admin UI is resolved, used by addon route catch-all
  let spaIndexHtml: string | null = null

  // --- Phase 1 + 2: Load config, setup storage locations, TLS ---
  // Resolution order: explicit CONFIG_PATH wins (lets operators put the
  // bootstrap config on its own mount, e.g. a /config volume). Otherwise
  // default it UNDER the data root (CAMSTACK_DATA) so a plain data-dir mount
  // also persists config.yaml. Falls back to the historical cwd-relative
  // path for local/dev runs where neither env var is set.
  const configPath =
    process.env.CONFIG_PATH ??
    path.join(process.env.CAMSTACK_DATA ?? path.join(process.cwd(), 'camstack-data'), 'config.yaml')
  const bootstrapConfig = loadBootstrapConfig(configPath)
  const infra = await setupInfra(configPath, bootstrapConfig)

  const { dataPath, tlsOptions, tlsCert } = infra
  const port = infra.bootstrapConfig.server.port
  const host = infra.bootstrapConfig.server.host

  // --- Phase 3: Create app + tRPC register + listen ---
  const fastifyOpts: Record<string, unknown> = tlsOptions ? { https: tlsOptions } : {}
  const app = await bootManual({ infra, fastifyOpts })
  app.enableShutdownHooks()

  const fastify = app.getHttpAdapter().getInstance()
  // Which browser origins may read hub responses, and open the /trpc socket
  // (D707): the hub's own, the hosted viewer PWA, the native embed's opaque
  // `null`, and the operator's `server.corsOrigins`. First hook on the
  // instance so every route — and every OPTIONS — is judged.
  if (publicUrlWarning !== undefined) {
    app.get(LoggingService).createLogger('public-url').warn(publicUrlWarning)
  }
  const corsConfig = app.get(ConfigService)
  const corsPolicy = createCorsPolicy({
    configuredOrigins: () => corsConfig.get('server.corsOrigins'),
    logger: app.get(LoggingService).createLogger('cors'),
  })
  registerCorsPolicy(fastify, corsPolicy)
  await fastify.register(fastifyCookie)
  // Every HTML document the hub serves may be framed by its own origin only
  // (D425). Stamped here, on the one instance, so no shell-send site added
  // later can ship without it.
  registerFramePolicy(fastify)

  // Gzip/Brotli compression for all responses (including static JS/CSS).
  // Registered before @fastify/static so the compress plugin wraps the
  // static send path — hashed admin-ui chunks go from ~2MB to ~600KB on
  // the wire. threshold:1024 skips compression for tiny payloads.
  //
  // SSE opt-out FIRST: without it a gzipped low-rate event stream starves
  // silently in the compressor buffer — see `api/sse-no-compression.ts` for
  // the mechanism and the live measurement.
  fastify.addHook('onRequest', async (request) => {
    markSseRequestNoCompression(request)
  })
  await fastify.register(fastifyCompress, { global: true, threshold: 1024 })

  // Data-plane POST bodies: the addon reverse-proxy (`proxyToUpstream`) pipes
  // `request.raw` upstream, but Fastify's default application/json parser would
  // drain it first, so a POST body would reach the addon empty. Register a
  // passthrough parser for application/octet-stream (used by data-plane POST
  // clients, e.g. the app log shipper → stream-broker `clientlog`) that leaves
  // the raw stream intact for piping. No effect on JSON API routes.
  fastify.addContentTypeParser('application/octet-stream', (_req, _payload, done) =>
    done(null, undefined),
  )

  // Make LocationManager available to StorageService before lifecycle hooks run
  const storageService = app.get(StorageService)
  storageService.setLocationManager(infra.locationManager)

  // ConfigService — SettingsStore is wired later by the settings-store capability consumer
  const config = app.get(ConfigService)
  // The real client address behind a trusted proxy, and the opt-in trusted
  // networks — read from settings per request (auth-network-policy.ts).
  const authNetwork = createAuthNetworkPolicy((key) => config.get<unknown>(key))
  // Public addon routes that declare `rateLimit: 'auth'` (an IdP start /
  // callback) and the SSO finish: 30 per minute per real client address.
  const authRouteLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })
  // Login sessions (local-auth's table, reached through its hub-internal
  // surface): every session token minted from here on carries a `sid`, and
  // every verify of one asks whether that session is still live.
  const sessionLifetimes = () => readSessionLifetimes((key) => config.get<unknown>(key))

  // Register addon upload route (multipart — must be registered before tRPC).
  // We pass AddonRegistryService so the handler can resolve the
  // `user-management` cap singleton at request time (the credential
  // verifier reads users and admin bits there — see upload-auth.ts).
  try {
    const uploadAuthService = app.get(AuthService)
    const uploadAddonBridge = app.get(AddonBridgeService)
    const uploadMoleculer = app.get(MoleculerService)
    const uploadAddonRegistry = app.get(AddonRegistryService)
    const uploadAddonPackage = app.get(AddonPackageService)
    const uploadLogger = app.get(LoggingService).createLogger('addon-upload')
    // The delivery ledger marks "the hub is writing addons to this node" for
    // the whole deploy+reload, so the addon back-fill cannot read the roster
    // gap a deploy opens and repair the node over the bytes just shipped.
    await registerAddonUploadRoute(
      fastify,
      uploadAddonBridge,
      uploadAuthService,
      uploadMoleculer,
      uploadAddonRegistry,
      uploadAddonPackage,
      uploadLogger,
      clusterBaseUrlResolver(() =>
        uploadAddonRegistry
          .getCapabilityRegistry()
          .getSingleton<ILocalNetworkProvider>('local-network'),
      ),
      app.get(AgentRegistryService).deliveryLedger,
    )
    console.log('[bootstrap] Addon upload route registered at POST /api/addons/upload')
    // Dev server-deploy channel gateway (`camstack deploy-server`). MUST be
    // registered AFTER registerAddonUploadRoute — it reuses the multipart
    // plugin that route installs on this instance.
    registerServerUploadRoute(fastify, {
      authService: uploadAuthService,
      addonRegistry: uploadAddonRegistry,
      logger: app.get(LoggingService).createLogger('server-upload'),
    })
    console.log('[bootstrap] Server upload route registered at POST /api/server-upload')
    registerServerUploadPropagateRoute(fastify, {
      authService: uploadAuthService,
      addonRegistry: uploadAddonRegistry,
      logger: app.get(LoggingService).createLogger('server-upload-propagate'),
      broker: uploadMoleculer.broker as AgentDeliveryBroker,
      resolveClusterBaseUrl: clusterBaseUrlResolver(() =>
        uploadAddonRegistry
          .getCapabilityRegistry()
          .getSingleton<ILocalNetworkProvider>('local-network'),
      ),
    })
    console.log(
      '[bootstrap] Server upload propagate route registered at POST /api/server-upload/propagate',
    )
    // Companion endpoint: /api/auth/whoami — verifies any hub credential
    // through the one verifier, returns the resolved identity + scopes.
    // Mirrors the addon-upload auth chain so the CLI can ping for
    // token-still-valid without consuming a real cap.
    await registerAuthWhoamiRoute(fastify, uploadAuthService, uploadAddonRegistry)
    console.log('[bootstrap] Auth whoami route registered at GET /api/auth/whoami')
    // A refused (forgotten / unpaired) agent asks here whether it is still a member (D857).
    registerMeshMembershipRoutes(fastify, {
      logger: app.get(LoggingService).createLogger('mesh-membership'),
    })
  } catch (err) {
    console.warn('[bootstrap] Failed to register addon upload route:', err)
  }

  // Register tRPC plugin on Fastify BEFORE listen.
  // If registration fails, start in degraded mode: serve a health warning endpoint.
  // Instantiate new core services
  const loggingService = app.get(LoggingService)
  // The heap heartbeat's handover: from here on hub-main's `[mem]` lines go through the log
  // manager like every runner's do — buffer, console destination, rotated file and Loki — so
  // the one process that mediates every cross-runner call is finally trendable next to the
  // runners it forked, in the same vocabulary. Destinations that register later (Loki is an
  // addon, so it does) are replayed the ring buffer, so the lines between here and then ship
  // too. Deliberately the FIRST thing done with `loggingService`.
  const heapWatchLogger = loggingService.createLogger('heap-watch')
  heapWatchSink.attach({
    info: (line) => {
      heapWatchLogger.info(line)
    },
    warn: (line) => {
      heapWatchLogger.warn(line)
    },
  })
  // ...and the OTHER thing the heartbeat cannot see. `[mem]` is a 5-minute
  // timer: it fired at dt = 300020 / 300066 / 299991 ms straight through the
  // 2026-09-09 analytics silences, which proves nothing about a 10-second
  // freeze. Every runner's UDS request waits on THIS loop, so a hub-main stall
  // is delivered to every addon as "you are slow" — the exact confusion
  // `pipeline-analytics`' frame-lag line exists to break, and this is the half
  // that says whether hub-main was the one holding the events. Same monitor
  // `detection-pipeline`, `recorder` and `pipeline-analytics` arm.
  //
  // Armed HERE and not at the top of `bootstrap()`, for the reason the heap
  // sink is deferred: before `loggingService` exists the lines could only
  // reach `console.log`, which is not a log destination. Never stopped: the
  // interval is `unref`ed, so it cannot hold the process open, and hub-main's
  // shutdown is process exit.
  const stallLogger = loggingService.createLogger('event-loop')
  startEventLoopStallMonitor(stallLogger)
  const addonRouteRegistry = new AddonRouteRegistry()
  const dataPlaneRegistry = new DataPlaneRegistry()

  // Use Fastify-managed notification/toast wrappers (globally provided by NotificationModule)
  const { NotificationServiceWrapper } = await import(
    './core/notification/notification-wrapper.service'
  )
  const { ToastServiceWrapper } = await import('./core/notification/toast-wrapper.service')
  const notificationWrapper = app.get(NotificationServiceWrapper)
  const toastWrapper = app.get(ToastServiceWrapper)
  // Expose the underlying core services for the tRPC router
  const notificationService = notificationWrapper.service
  const toastService = toastWrapper.service

  // Wire AddonRouteRegistry and NotificationService
  const addonRegistry = app.get(AddonRegistryService)
  addonRegistry.setAddonRouteRegistry(addonRouteRegistry)
  addonRegistry.setDataPlaneRegistry(dataPlaneRegistry)

  // ── Configure the CapabilityRegistry (created in AddonRegistryService constructor) ──
  const capabilityRegistry = addonRegistry.getCapabilityRegistry()

  // D842: the scoped grant behind a node's own-node `addons.updatePackage`. The
  // hub's record is its installed package version; every decision is audited.
  const remoteUpdateGrantDeps = (): RemoteUpdateGrantDeps => ({
    hubInstalledVersion: (name) => {
      try {
        return (
          app
            .get(AddonPackageService)
            .listInstalled()
            .find((p) => p.name === name)?.version ?? null
        )
      } catch {
        return null
      }
    },
    audit: async (event) => {
      try {
        const internal = getUserManagementInternal(
          capabilityRegistry.getSingleton('user-management'),
        )
        if (internal === null) {
          console.warn('[bootstrap] agent addon update not audited: no user-management internal')
          return
        }
        await internal.audit.record(event)
      } catch (err) {
        console.warn('[bootstrap] agent addon update audit row not written:', err)
      }
    },
  })
  const sessionBacking = sessionBackingFrom(capabilityRegistry, sessionLifetimes)
  // From here on every verify of a session-grade token — tRPC, addon routes,
  // the session cookie, OAuth authorize, uploads, health — requires its
  // session to be live (`hub-sessions.ts`).
  app.get(AuthService).setSessionCheck(createSessionTokenCheck(capabilityRegistry))

  // Declare every shipped capability BEFORE app.init() so addon
  // registerProvider() calls (in-process or via the Moleculer bridge
  // from forked workers / agents) find their definition during
  // onModuleInit. The list comes from the codegen — see the import
  // comment above for the rationale.
  for (const capDef of ALL_CAPABILITY_DEFINITIONS) {
    capabilityRegistry.declareCapability(capDef)
  }

  // Hub-internal `sso-bridge` provider — gives auth-provider addons
  // (OIDC, SAML, …) a typed gateway to mint an HMAC-signed
  // bridge token before redirecting to `/api/auth/sso/finish`. Without
  // this, the finish endpoint would have to trust unsigned query params
  // (anyone could craft `?isAdmin=1`). Backed by AuthService.
  const authServiceForBridge = app.get(AuthService)
  capabilityRegistry.registerProvider('sso-bridge', '$hub', {
    signBridgeToken: async ({
      claims,
      ttlSec,
    }: {
      claims: {
        userId: string
        username: string
        isAdmin: boolean
        provider: string
        email?: string
        displayName?: string
      }
      ttlSec?: number
    }) => {
      const token = authServiceForBridge.signSsoBridgeToken(claims, ttlSec ?? 300)
      return { token }
    },
    verifyBridgeToken: async ({ token }: { token: string }) => {
      return authServiceForBridge.verifySsoBridgeToken(token)
    },
  })

  // Wire registry into NotificationService for proxy-based output resolution
  notificationService.setRegistry(capabilityRegistry)

  // Hub metrics and sub-process info now come from Moleculer service discovery
  // and the distributed metrics-provider capability — no manual wiring needed.

  let trpcRegistered = false
  let appRouter: ReturnType<typeof buildAppRouter> | null = null

  // The one token store (D892, D895): rows in the `core-auth` records — admin
  // tokens, scoped tokens and share links alike; the JWT is signed with the
  // session signing key.
  const credentialTokenService = new CredentialTokenService(
    app.get(AuthService),
    loggingService.createLogger('tokens'),
  )
  addonRegistry.setCredentialTokenService(credentialTokenService)
  // Every surface that verifies a bearer reads the same stores (D892).
  bindHubCredentialStores({ tokenRows: credentialTokenService })
  // One-time native-app login handoff codes (in-memory, 60s TTL, single-use) —
  // minted by `auth.createHandoffCode`, redeemed by the viewer app via the
  // public `auth.redeemHandoffCode`.
  const handoffCodeService = new HandoffCodeService()
  // Pending "link this sign-in account" intents (D782) — minted by
  // `auth.beginExternalLink`, consumed once by `/api/auth/sso/finish`.
  const externalLinkIntents = new ExternalLinkIntents()
  // Native-app links parked for the app to claim, and one-time codes that
  // open the account page signed in, in a browser (D801).
  const nativeLinkCompletions = new NativeLinkCompletions()
  // `jti`s of login bridges already finished — a bridge is single-use.
  const usedBridgeIds = new UsedBridgeIds()
  const browserHandoffCodes = new HandoffCodeService()
  // Parked "sign the app in?" confirmations of the two native app flows (D858).
  const appConfirmations = new AppConfirmations()
  const nativeLinkMinter = createSessionMinter({
    signer: app.get(AuthService),
    directory: () => capabilityRegistry.getSingleton('user-management'),
    sessions: sessionBacking,
  })
  const nativeLinkWiring = () => ({
    auth: app.get(AuthService),
    registry: capabilityRegistry,
    moleculer: app.get(MoleculerService),
    minter: nativeLinkMinter,
    linkIntents: externalLinkIntents,
    nativeLinks: nativeLinkCompletions,
    usedBridgeIds,
  })

  const buildRouter = (): ReturnType<typeof buildAppRouter> =>
    buildAppRouter({
      authService: app.get(AuthService),
      credentialTokenService,
      handoffCodeService,
      externalLinkIntents,
      nativeLink: {
        completions: nativeLinkCompletions,
        browserHandoffs: browserHandoffCodes,
        // The SSO finish's own link step — the same conflict rule, the same
        // store — run for the app's claim instead of the browser's return.
        link: (input) => createSsoFinishDeps(nativeLinkWiring(), undefined).identities.link(input),
      },
      configService: config,
      authNetworkPolicy: authNetwork,
      sessionBacking,
      featureService: app.get(FeatureService),

      loggingService,
      eventBus: app.get(EventBusService),
      agentRegistry: app.get(AgentRegistryService),
      moleculer: app.get(MoleculerService),
      addonRegistry,
      replEngine: app.get(ReplEngineService),
      networkQualityService: app.get(NetworkQualityService),
      addonBridge: app.get(AddonBridgeService),
      addonPackageService: app.get(AddonPackageService),
      notificationService,
      toastService,
      capabilityRegistry,
      streamProbe: app.get(StreamProbeService),
      serverUpdateService: app.get(ServerUpdateService),
    })

  // ── The core-cap mesh bridge, mounted BEFORE a single addon boots (D171) ──
  //
  // `$core-caps` exposes the hub's core (non-addon) tRPC routers on the mesh so
  // a forked addon's `ctx.api.<coreCap>` resolves. It used to be registered
  // after `app.init()` returned — and `app.init()` IS the addon boot, so for
  // the whole of it every core-cap call was structurally unanswerable:
  // `brokerTransportLink` polled the full 30 s discovery deadline and
  // fast-failed, with no boot-window retry (core caps are excluded from it).
  // One such await held `device-manager`, and with it every camera (D167).
  //
  // The router is safe to build here: `buildCapabilityRouters` is driven by
  // `ALL_CAPABILITY_DEFINITIONS` (declared above, before init) and every
  // provider — registry singleton or `server-provided` factory — is resolved
  // PER REQUEST, not at build time. That is the two-phase shape: the route is
  // on the mesh immediately, each provider completes on its own schedule, and
  // a caller that is early gets an immediate, typed answer instead of 30 s of
  // silence. The same router instance is handed to Fastify after init, so
  // there is exactly one.
  await app.init({
    beforeAddonBoot: () => {
      try {
        appRouter = buildRouter()
        {
          const meshBroker = app.get(MoleculerService)
          // D802: another node's call runs as `node:<id>`, never the hub's own principal.
          meshBroker.registerCoreCapService(
            buildCoreCapService(appRouter, undefined, {
              ownNodeId: meshBroker.nodeId,
              remoteUpdateGrant: remoteUpdateGrantDeps(),
            }),
          )
        }
        console.log('[bootstrap] core-cap mesh bridge registered ($core-caps) — before addon boot')
      } catch (err) {
        // Never abort boot for this: a hub without the bridge is degraded
        // (core-cap calls fast-fail), a hub that refuses to start is down.
        appRouter = null
        console.warn('[bootstrap] Failed to register core-cap mesh bridge early:', err)
      }
    },
  })
  console.log('[bootstrap] app.init() complete — all onModuleInit hooks have run')

  // Mark registry as ready — providers from app.init() are now registered
  capabilityRegistry.ready()

  // Register log-receiver service for agent log forwarding (after app.init
  // so Moleculer re-advertises the service list to the network)
  const moleculer = app.get(MoleculerService)
  // Hand the heartbeat its event-plane sources. The reader holds this by
  // closure and re-reads `childRegistry` / `broker` on every line, so a registry
  // that is rebuilt later is picked up without re-wiring anything.
  moleculerForEventPlane = moleculer
  moleculer.registerLogReceiver()

  // Hub-internal `model-distributor` provider — pushes a model format that is
  // resident on the hub `/data/models` to an agent's `/data/models` (Model
  // Studio P2). Registered in the CapabilityRegistry (not just the tRPC
  // router) so forked addons (addon-model-studio) can reach it via `ctx.api`,
  // not only external HTTP clients. Needs the broker + the deploy-stage
  // registry, which an addon can't access.
  capabilityRegistry.registerProvider(
    'model-distributor',
    '$hub',
    buildModelDistributorProvider(
      moleculer,
      loggingService,
      clusterBaseUrlResolver(() =>
        capabilityRegistry.getSingleton<ILocalNetworkProvider>('local-network'),
      ),
    ),
  )

  // ── Health routes (hub self + agent forwarding) ──────────────────
  // Registered after app.init() so the AgentRegistryService is wired and
  // the Moleculer broker is ready to forward `$agent.health` calls.
  try {
    const hubVersion = readHubVersion()
    registerHealthRoutes(fastify, {
      moleculer,
      agentRegistry: app.get(AgentRegistryService),
      hubVersion,
      productVersion: blankToNull(process.env[PRODUCT_VERSION_ENV]),
      // Read the live flag at request time — flips to true once the tRPC
      // router finishes registering (see `trpcRegistered = true` below).
      isReady: () => trpcRegistered,
      verifyToken: (token) => app.get(AuthService).verifyToken(token),
      runnerBootCheck: () => app.get(RunnerBootCheckService).current(),
    })
    console.log(`[bootstrap] Health routes registered (hub v${hubVersion})`)
    registerAdaptiveProbeRoute(fastify, {
      verifyToken: (token) => app.get(AuthService).verifyToken(token),
      limiter: createRateLimiter({
        windowMs: 60_000,
        max: ADAPTIVE_PROBE_PER_IP_PER_MINUTE,
      }),
      network: authNetwork,
    })
  } catch (err) {
    console.warn('[bootstrap] Failed to register health routes:', err)
  }

  // Seed the device-name cache the log formatter consults so logs
  // emitted before the first DeviceRegistered already resolve names.
  // Subsequent registers/unregisters flow through the event-bus
  // subscription installed in `LoggingService.attachDeviceNameStream`.
  try {
    const dm = capabilityRegistry.getSingleton('device-manager') as {
      listAll?: (input: { addonId?: string }) => Promise<readonly { id: number; name: string }[]>
    } | null
    if (dm?.listAll) {
      const devices = await dm.listAll({})
      loggingService.setDeviceNames(devices.map((d) => ({ id: d.id, name: d.name })))
      loggingService.createLogger('logging').info('device-name cache seeded from device-manager', {
        meta: { count: devices.length, ids: devices.map((d) => d.id) },
      })
    } else {
      loggingService
        .createLogger('logging')
        .warn('device-name cache seed skipped — device-manager not available')
    }
  } catch (err) {
    console.warn(
      '[bootstrap] device-name cache seed skipped:',
      err instanceof Error ? err.message : err,
    )
  }

  // The process-wide HTTP request census. Disarmed here and for the rest of
  // this boot unless `restore()` (below, just before `listen`) finds a window
  // an operator armed earlier. The logger is attached now so a restored census
  // has somewhere to report before the first request arrives.
  const httpRequestCensus = getHttpRequestCensus()
  const trpcLogger = loggingService.createLogger('tRPC')
  httpRequestCensus.setLogger(trpcLogger)
  setRemotePrivilegeLogSink(trpcLogger)

  try {
    const authService = app.get(AuthService)
    // Normally already built and bridged onto the mesh in `beforeAddonBoot`
    // above — this is the fallback for the case where that failed, so a hub
    // whose mesh bridge could not be mounted still serves HTTP.
    if (appRouter === null) {
      appRouter = buildRouter()
      try {
        {
          const meshBroker = app.get(MoleculerService)
          // D802: another node's call runs as `node:<id>`, never the hub's own principal.
          meshBroker.registerCoreCapService(
            buildCoreCapService(appRouter, undefined, {
              ownNodeId: meshBroker.nodeId,
              remoteUpdateGrant: remoteUpdateGrantDeps(),
            }),
          )
        }
        console.log('[bootstrap] core-cap mesh bridge registered ($core-caps) — late fallback')
      } catch (err) {
        console.warn('[bootstrap] Failed to register core-cap mesh bridge:', err)
      }
    }

    await fastify.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: appRouter,
        createContext: async ({ req }: { req: FastifyRequest }) => {
          const trpcCtx = await createTrpcContext(
            req,
            authService,
            addonRegistry,
            // A bearer refused for NOT being an API credential never reaches a
            // procedure, so `onError` below never sees it — the refusal would
            // be silent without this. Same reason the addon gate logs (D103).
            app.get(LoggingService).createLogger('tRPC'),
          )
          // WHO called, counted here because this is the first point at which
          // a principal exists AND the only one tRPC runs exactly once per
          // HTTP request (batched or not). Disarmed this is a boolean read and
          // a return — see `http-request-census-hook.ts`.
          recordTrpcHttpRequest(httpRequestCensus, req, trpcCtx.user)
          return trpcCtx
        },
        onError: ({
          path: trpcPath,
          error,
          ctx,
          input,
        }: {
          path: string | undefined
          error: { code: string; message: string; cause?: unknown }
          ctx?: TrpcContext
          input?: unknown
        }) => {
          const trpcLogger = app.get(LoggingService).createLogger('tRPC')
          trpcLogger.warn('tRPC error', {
            // WHICH camera. A refusal on a device-scoped path that names no
            // deviceId cannot answer "one camera or all of them?" — the
            // question always asked first (2026-08-29, `intercom.startSession`).
            tags: trpcErrorDeviceTags(trpcPath, input),
            meta: {
              code: error.code,
              path: trpcPath ?? '?',
              // WHO was refused. A FORBIDDEN with no principal cannot be tied
              // to the integration that hit it, and an operator grepping for
              // the integration finds nothing — which reads as "the hub logged
              // nothing" (2026-08-09).
              principal: describeTrpcPrincipal(ctx?.user),
              message: error.message,
            },
          })
          if (error.cause)
            trpcLogger.warn('tRPC error cause', {
              meta: {
                cause:
                  error.cause instanceof Error ? error.cause.message : JSON.stringify(error.cause),
              },
            })
        },
      },
    })
    trpcRegistered = true

    // Register addon-pages static file endpoint
    const addonPagesService = app.get(AddonPagesService)
    fastify.get<{ Params: { addonId: string; '*': string } }>(
      '/api/addon-pages/:addonId/*',
      async (request, reply) => {
        const { addonId } = request.params
        const filePath = request.params['*']
        if (!filePath) {
          return reply.status(400).send('Missing file path')
        }
        const resolved = addonPagesService.resolveBundle(addonId, filePath)
        if (!resolved) {
          return reply.status(404).send('Not found')
        }
        const ext = path.extname(resolved).toLowerCase()
        const contentType =
          ext === '.js' || ext === '.mjs'
            ? 'application/javascript'
            : ext === '.css'
              ? 'text/css'
              : ext === '.json'
                ? 'application/json'
                : ext === '.html'
                  ? 'text/html'
                  : 'application/octet-stream'
        const stream = fs.createReadStream(resolved)
        return reply
          .header('cache-control', addonBundleCacheControl(resolved))
          .type(contentType)
          .send(stream)
      },
    )

    // Register addon-widgets static file endpoint — same shape as
    // addon-pages but reads bundles from each addon's
    // `dist/widgets.mjs` (declared per-widget in `addon-widgets-source`
    // metadata). Path-traversal protection + cap-registration check
    // both live in `AddonWidgetsService.resolveBundle`.
    const addonWidgetsService = app.get(AddonWidgetsService)
    fastify.get<{ Params: { addonId: string; '*': string } }>(
      '/api/addon-widgets/:addonId/*',
      async (request, reply) => {
        const { addonId } = request.params
        const filePath = request.params['*']
        if (!filePath) {
          return reply.status(400).send('Missing file path')
        }
        const resolved = addonWidgetsService.resolveBundle(addonId, filePath)
        if (!resolved) {
          return reply.status(404).send('Not found')
        }
        const ext = path.extname(resolved).toLowerCase()
        const contentType =
          ext === '.js' || ext === '.mjs'
            ? 'application/javascript'
            : ext === '.css'
              ? 'text/css'
              : ext === '.json'
                ? 'application/json'
                : ext === '.html'
                  ? 'text/html'
                  : 'application/octet-stream'
        // A content-versioned request (`v<hash>/…`) is content-addressed: the
        // URL changes iff the bundle changed, so EVERYTHING under it — even the
        // fixed-name `_stub.js`/`remoteEntry.js` — is safely immutable (this
        // defeats a CDN edge serving a stale stub). Legacy unversioned requests
        // keep the per-file revalidation policy.
        const { versioned } = stripBundleVersionSegment(filePath)
        const cacheControl = versioned
          ? 'public, max-age=31536000, immutable'
          : addonBundleCacheControl(resolved)
        const stream = fs.createReadStream(resolved)
        return reply.header('cache-control', cacheControl).type(contentType).send(stream)
      },
    )

    // Serve static assets (e.g. SVG icons) from an addon's package directory
    fastify.get<{ Params: { addonId: string; '*': string } }>(
      '/api/addon-assets/:addonId/*',
      async (request, reply) => {
        const { addonId } = request.params
        const assetPath = request.params['*'] ?? ''

        const packageDir = addonRegistry.getAddonPackageDir(addonId)
        if (!packageDir) {
          return reply.code(404).send({ error: 'Addon not found' })
        }

        const resolvedPackageDir = path.resolve(packageDir)
        const filePath = path.resolve(resolvedPackageDir, assetPath)

        // Security: prevent path traversal attacks
        if (
          !filePath.startsWith(resolvedPackageDir + path.sep) &&
          filePath !== resolvedPackageDir
        ) {
          return reply.code(403).send({ error: 'Access denied' })
        }

        if (!fs.existsSync(filePath)) {
          return reply.code(404).send({ error: 'Asset not found' })
        }

        const ext = path.extname(filePath).toLowerCase()
        const contentTypes: Record<string, string> = {
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.json': 'application/json',
          '.webp': 'image/webp',
        }
        const contentType = contentTypes[ext] ?? 'application/octet-stream'

        reply.header('content-type', contentType)
        reply.header('cache-control', 'public, max-age=86400')
        return reply.send(fs.readFileSync(filePath))
      },
    )

    // ── SSO finish + browser handoff ────────────────────────────────
    // OIDC redirects to the finish with an HMAC-signed, single-use LOGIN
    // bridge bound to the browser that started it; the session is minted by
    // THE session mint from the user record as it is now (D712). Rules in
    // `auth/sso-finish.ts`, routes in `auth/sso-routes.ts`.
    const ssoMinter = createSessionMinter({
      signer: app.get(AuthService),
      directory: () => capabilityRegistry.getSingleton('user-management'),
      sessions: sessionBacking,
    })
    registerSsoRoutes(fastify, {
      wiring: {
        auth: app.get(AuthService),
        registry: capabilityRegistry,
        moleculer: app.get(MoleculerService),
        minter: ssoMinter,
        linkIntents: externalLinkIntents,
        nativeLinks: nativeLinkCompletions,
        usedBridgeIds,
      },
      network: authNetwork,
      limiter: authRouteLimiter,
      browserHandoffCodes,
      confirmations: appConfirmations,
      minter: ssoMinter,
      logger: app.get(LoggingService).createLogger('sso-finish'),
    })

    // ── Passkey sign-in for the native app (D858) ───────────────────
    // A standalone page + two same-origin legs; the assertion ends in a handoff
    // code at the app's custom scheme, never in a web session.
    registerAppPasskeyRoutes(fastify, {
      passkeys: () => resolvePasskeyProvider(capabilityRegistry, app.get(MoleculerService)),
      secondFactors: (userId) => {
        const um = capabilityRegistry.getSingleton('user-management')
        return collectSecondFactors(
          {
            ...(um && typeof um.getTotpStatus === 'function'
              ? {
                  getTotpStatus: (input: { userId: string }) => um.getTotpStatus(input),
                }
              : {}),
            passkeyProvider: () =>
              resolvePasskeyProvider(capabilityRegistry, app.get(MoleculerService)),
          },
          userId,
          'passkey',
        )
      },
      minter: ssoMinter,
      confirmations: appConfirmations,
      network: authNetwork,
      limiter: authRouteLimiter,
      logger: app.get(LoggingService).createLogger('app-passkey'),
    })
    registerAppRefusedRoute(fastify)
    // The last step of both app flows: "Sign in the app as <user>?" - the
    // handoff code is minted only when the person presses Continue (D858).
    registerAppConfirmRoutes(fastify, {
      confirmations: appConfirmations,
      handoffCodes: handoffCodeService,
      network: authNetwork,
      limiter: authRouteLimiter,
      logger: app.get(LoggingService).createLogger('app-confirm'),
    })

    // ── Backup archive download ─────────────────────────────────────
    // Streams an archive through the storage cap's chunked-download
    // protocol at the pace the client reads it (D447). The route, its
    // auth chain and the drain-respecting pump live in `api/backup-download*`.
    registerBackupDownloadRoute(fastify, {
      verifier: app.get(AuthService),
      capabilities: capabilityRegistry,
      logger: app.get(LoggingService).createLogger('backup-download'),
    })

    // POST /api/auth/session — upgrade a tRPC-issued JWT to a browser cookie.
    fastify.post<{ Body: { token?: string } }>('/api/auth/session', async (request, reply) => {
      const token = request.body?.token
      if (!token) return reply.status(400).send({ error: 'token required' })
      let ttlSec: number
      try {
        const payload = authService.verifyToken(token) // throws on invalid/expired
        // SESSION-grade JWTs only: challenge/bridge tokens (`kind`-tagged,
        // e.g. the totp-challenge from login leg 1) verify under the same
        // secret — accepting one here handed out a cookie that bypassed
        // the second factor on every cookie-gated surface.
        if (!isSessionGradeJwtPayload(payload)) {
          return reply.status(401).send({ error: 'invalid token' })
        }
        const expSec = typeof payload.exp === 'number' ? payload.exp : 0
        ttlSec = Math.max(0, expSec - Math.floor(Date.now() / 1000))
      } catch {
        return reply.status(401).send({ error: 'invalid token' })
      }
      const c = buildSessionCookie(token, ttlSec, {
        secure: sessionCookieIsSecure(request.protocol, request.headers, FORWARDED_PREFIX_HEADER),
      })
      reply.setCookie(c.name, c.value, c.options)
      return reply.send({ ok: true })
    })

    // DELETE /api/auth/session — clear the cookie on logout.
    fastify.delete('/api/auth/session', async (request, reply) => {
      const c = clearSessionCookie({
        secure: sessionCookieIsSecure(request.protocol, request.headers, FORWARDED_PREFIX_HEADER),
      })
      reply.setCookie(c.name, c.value, c.options)
      return reply.send({ ok: true })
    })

    // GET /api/embed-auth — a person's login session becomes the embed's
    // cookie (`auth/embed-auth-route.ts`); nothing else this hub signed does.
    registerEmbedAuthRoute(fastify, {
      verifyToken: (token) => authService.verifyToken(token),
      isLiveUser: liveUserCheck(capabilityRegistry),
    })

    // Every refusal on the addon gate is a request an operator will be asking
    // about ("why did Home Assistant stop actuating?"). Its own scope so the
    // reason is greppable rather than buried in the bootstrap logger.
    const addonGateLogger = app.get(LoggingService).createLogger('addon-route-auth')
    const addonVerifier = hubCredentialVerifier({
      authService,
      addonRegistry,
      logger: addonGateLogger,
    })

    // Addon HTTP API route catch-all: /addon/:addonId/*
    // Only handles non-GET or routes that actually exist in the addon route registry.
    // GET requests that don't match an addon route are SPA pages — handled by the /* fallback.
    //
    // `compress: false`: the bridged reply body of a FORKED addon crosses the
    // UDS route bridge as opaque bytes; piping those through the hub's global
    // @fastify/compress emits an EMPTY brotli stream for any compressible body
    // >1KiB (live-diagnosed 2026-07-16 — broke the notifier SVG icons; same
    // class addon-upload.ts already dodges). Addons that care about coding own
    // it end-to-end (see the notifier icon routes).
    fastify.all<{
      Params: { addonId: string; '*': string }
      Querystring: Record<string, string>
      Headers: Record<string, string>
      Body: unknown
    }>('/addon/:addonId/*', { compress: false }, async (request, reply) => {
      const { addonId } = request.params
      const subPath = request.params['*'] ?? ''
      const method = request.method
      const fullPath = `/addon/${addonId}/${subPath}`
      const query: Record<string, string> = request.query ?? {}
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v
        else if (Array.isArray(v)) headers[k] = v.join(',')
      }

      // ── HTTP data-plane: reverse-proxy to the addon's own listener ───────
      // Checked BEFORE control routes. A hit means the addon serves this prefix
      // via `ctx.dataPlane` (it streams the bytes with real req/res); the hub
      // authenticates here, then pipes. Same origin/cert as the admin-ui.
      const dpMatch = dataPlaneRegistry.match(addonId, subPath)
      if (dpMatch) {
        const access = dpMatch.endpoint.access
        let shareHeaders: Readonly<Record<string, string>> | null = null
        if (access !== 'public') {
          const authHeader = request.headers.authorization
          const cookieToken = request.cookies?.[SESSION_COOKIE]
          if (!authHeader && !cookieToken) {
            return reply.status(401).send({ error: 'Unauthorized' })
          }
          const token = authHeader ? authHeader.replace('Bearer ', '') : cookieToken!
          // The ONE verifier and the ONE scope matcher, as on tRPC (D892). A
          // share principal is admitted only by a plane that opted in to its
          // kind, and its devices travel in headers the HUB sets — whatever
          // the client sent under those names is dropped below.
          const auth = await authorizeAddonBearer({
            bearer: token,
            verifier: addonVerifier,
            target: {
              addonId,
              method,
              access,
              share: dpMatch.endpoint.share ?? [],
            },
            facts: requestFacts(request),
            logger: addonGateLogger,
          })
          if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
          shareHeaders = auth.shareHeaders
        }
        const qIdx = request.url.indexOf('?')
        const queryString = qIdx >= 0 ? request.url.slice(qIdx) : ''
        // Forward the FULL sub-path INCLUDING the prefix — the addon's facility
        // multiplexes by prefix, so it strips the prefix itself. (`dpMatch.rest`
        // is only used to pick the endpoint, not to rewrite the path.)
        const upstreamPath = `/${subPath}${queryString}`
        // The share headers are the HUB's to write: drop whatever the client
        // sent under those names, then set the validated scope, if any.
        for (const name of Object.keys(request.raw.headers)) {
          if (
            name.toLowerCase() === SHARE_KIND_HEADER ||
            name.toLowerCase() === SHARE_DEVICES_HEADER
          )
            delete request.raw.headers[name]
        }
        if (shareHeaders !== null) Object.assign(request.raw.headers, shareHeaders)
        const replayBody = dataPlaneReplayBody(request.raw, request.body, addonGateLogger)
        if (replayBody === null) {
          return reply.status(500).send({ error: 'Request body could not be forwarded' })
        }
        // Take over the socket — `proxyToUpstream` drives the raw response.
        reply.hijack()
        proxyToUpstream({
          baseUrl: dpMatch.endpoint.baseUrl,
          secret: dpMatch.endpoint.secret,
          upstreamPath,
          clientReq: request.raw,
          clientRes: reply.raw,
          ...(replayBody !== undefined ? { replayBody } : {}),
        })
        return
      }

      const match = addonRouteRegistry.matchRoute(method, fullPath)
      if (!match) {
        if (isRetiredPublicPath(fullPath)) {
          return reply.status(404).send({ error: 'Not found' })
        }
        if (method === 'GET' && spaIndexHtml) {
          // An addon deep-link that is not an addon ROUTE is an admin-UI page —
          // serve the admin shell, under the SAME no-store policy as `/`. This
          // send used to carry no cache header at all, so browsers kept the
          // index.html of a previous build (and its dead hashed asset names)
          // across deploys until a force refresh.
          return sendSpaShell(reply, spaIndexHtml, request.headers)
        }
        return reply.status(404).send({ error: 'Not found' })
      }

      // A route that asked for it (an IdP start / callback) is limited per
      // REAL client address before its handler runs.
      if (match.route.rateLimit === 'auth') {
        const routeClient = clientKeyFromRequest(request, authNetwork)
        if (routeClient !== null) {
          const verdict = authRouteLimiter.check(`route:${addonId}:${routeClient}`)
          if (!verdict.allowed) {
            reply.header('retry-after', String(verdict.retryAfterSeconds))
            return reply.status(429).send({ error: 'Too many attempts' })
          }
        }
      }

      // Auth check based on route.access
      if (match.route.access !== 'public') {
        const authHeader = request.headers.authorization
        // Browser navigation has no Authorization header — fall back to the
        // session cookie, and if that is missing bounce to the login page.
        const cookieToken = request.cookies?.[SESSION_COOKIE]
        if (!authHeader && !cookieToken) {
          if (shouldRedirectToLogin(request.method, request.headers.accept)) {
            const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
            return reply.redirect(
              loginRedirectUrl(
                fullPath + qs,
                parseForwardedPrefix(request.headers['x-forwarded-prefix']),
              ),
            )
          }
          return reply.status(401).send({ error: 'Unauthorized' })
        }
        const token = authHeader ? authHeader.replace('Bearer ', '') : cookieToken!
        // The ONE verifier and the ONE scope matcher, as on tRPC (D892).
        const auth = await authorizeAddonBearer({
          bearer: token,
          verifier: addonVerifier,
          target: { addonId, method, access: match.route.access },
          facts: requestFacts(request),
          logger: addonGateLogger,
        })
        if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
        // NOTE: the handler call used to sit INSIDE the JWT try, so a throw
        // from an addon's own route handler was reported as `401 Invalid token`.
        const addonRequest = {
          params: match.params,
          query,
          body: request.body,
          headers,
          ...addonRouteCaller(auth.principal),
        }
        const addonReply = buildAddonReply(reply)
        return match.route.handler(addonRequest, addonReply)
      }

      // Public route — no auth required
      const addonRequest = {
        params: match.params,
        query,
        body: request.body,
        headers,
      }
      const addonReply = buildAddonReply(reply)
      return match.route.handler(addonRequest, addonReply)
    })

    // ── OAuth2 authorization endpoints ─────────────────────────────────────
    // Mounted under /api/oauth2/* so they sit inside the universal "/api/"
    // namespace already excluded from the SPA catch-all everywhere.
    // getRegistry is a closure so it always resolves the live registry at
    // request time (safe even if called before ready()).
    registerOauth2Routes(fastify, {
      getRegistry: () => capabilityRegistry,
      verifyToken: (t) => authService.verifyToken(t),
      isLiveUser: liveUserCheck(capabilityRegistry),
      // The hub's public endpoint from the `local-network` cap (the flagged
      // address, else tunnel, then mesh, then LAN). `localhost` only when the
      // palette names nothing — the dev case, where it is the truth.
      publicHubUrl: () =>
        resolveHubBaseUrl(
          () => capabilityRegistry.getSingleton<ILocalNetworkProvider>('local-network'),
          'publicEndpoint',
        ).catch(() => `https://localhost:${port}`),
      // Every /authorize refusal is a dropped account-linking attempt. Without
      // this scope the drop is invisible in Loki and the only signal left is an
      // operator noticing that linking stopped working.
      logger: app.get(LoggingService).createLogger('oauth2'),
    })
    console.log('[bootstrap] OAuth2 routes registered at /api/oauth2/*')

    // Attach tRPC WebSocket handler using noServer mode to avoid
    // Fastify intercepting the upgrade request with a 400 response.
    //
    // `perMessageDeflate` is NOT the default — `ws` ships it off — and the
    // viewer talks to us over `wsLink` EXCLUSIVELY, so without this every
    // boot response travelled uncompressed while the HTTP routes were getting
    // brotli. Measured on the live hub: `deviceManager.listAll` is 271 KB raw
    // and 22 KB brotli, and the whole viewer boot is ~1.8 MB of tRPC JSON.
    //
    // The zlib settings are deliberately conservative rather than maximal.
    // `serverNoContextTakeover` + a 1024-byte window mean each connection
    // keeps NO persistent deflate context between messages: it costs a few
    // points of ratio and it bounds per-socket memory, which is the trade this
    // hub wants — it has hit a heap ceiling before, and a compression context
    // per viewer is exactly the kind of growth that is invisible until it is
    // not. `threshold` leaves small frames (subscription ticks) alone, where
    // framing overhead would exceed the saving.
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: {
        threshold: 1024,
        zlibDeflateOptions: { level: 3, memLevel: 7, chunkSize: 16 * 1024 },
        zlibInflateOptions: { chunkSize: 16 * 1024 },
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
      },
    })
    // The WS plane of the transport census, hooked PER OPERATION.
    //
    // It cannot hang off `createContext` below: that factory runs once per
    // CONNECTION and is reused for every frame the socket ever sends, so a
    // census wired there fires once every 37 connections instead of once every
    // call. The frame is the only place an operation is observable from
    // outside the adapter — see `ws-request-census.ts`. Registered before
    // `applyWSSHandler` so no socket can be accepted without a session.
    // A subscriber that stops READING is disconnected, not buffered until the
    // hub dies. On 2026-09-10 the only WS client (the operator's phone, viewer
    // in the background, JS suspended, TCP open) queued 88 MB of JSON strings
    // in hub-main's old_space with no bound and no line. See
    // `ws-slow-consumer-guard.ts` for the policy and the alternatives it beat.
    const wsSlowConsumerGuard = new WsSlowConsumerGuard({
      logger: app.get(LoggingService).createLogger('tRPC:ws'),
    })
    wsSlowConsumerGuard.start()
    wss.on('connection', (client, req) => {
      attachWsCensusSession(
        httpRequestCensus,
        client,
        req,
        app.get(LoggingService).createLogger('tRPC:ws'),
      )
      wsSlowConsumerGuard.attach(client, wsConnectionFacts(req))
    })

    // Revoking a login session ends what it holds: its sockets (close 4401
    // `session-ended`) and its live media. See `auth/session-connections.ts`.
    const sessionConnections = getSessionConnections()
    sessionConnections.setLogger(app.get(LoggingService).createLogger('session-revocation'))
    onSessionsRevoked((event) => {
      sessionConnections.endSessions({
        sessionIds: event.sessionIds,
        userId: event.userId,
        allOfUser: event.allOfUser,
        exceptSessionId: event.exceptSessionId,
        reason: event.reason,
      })
    })

    applyWSSHandler({
      wss,
      router: appRouter,
      // The complement of the bound above, for the SUSPENDED client: a PING is
      // a text frame the client's JS must answer, and a backgrounded app's JS
      // does not run — so the socket is terminated ~40 s into the background
      // instead of accumulating for the night, and the app reconnects on
      // return (every WS client of this hub is `@trpc/client` >= 11, which
      // answers PING with PONG; the viewer pins ^11.16). The bound stays: it
      // covers a client whose JS runs but whose link cannot drain the events.
      // A termination here closes with 1006; the guard's close line names it.
      keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 10_000 },
      createContext: async (opts: CreateWSSContextFnOptions) => {
        const wsCtx = await createWsTrpcContext(
          opts,
          authService,
          addonRegistry,
          app.get(LoggingService).createLogger('tRPC:ws'),
        )
        // The connection's identity, derived ONCE and reused for every
        // operation on this socket. Frames that arrived while the bearer was
        // still resolving are held by the session and released here.
        const principal = describeTrpcPrincipal(wsCtx.user)
        identifyWsCensusSession(opts.res, principal)
        wsSlowConsumerGuard.identify(opts.res, principal)
        const connectionLogger = app.get(LoggingService).createLogger('tRPC:ws')
        if (wsCtx.credentialRejected === true) {
          // A bearer that resolves to nobody (revoked, expired): say so with
          // the close code the client recognises, instead of leaving an
          // anonymous socket open for the client to poll.
          connectionLogger.info('Closing a socket whose credential was refused', {
            meta: { principal, code: SESSION_ENDED_CLOSE_CODE },
          })
          opts.res.close(SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON)
        } else if (wsCtx.user !== null) {
          const untrack = sessionConnections.trackSocket(opts.res, {
            userId: wsCtx.user.id,
            sessionId: wsCtx.user.sessionId,
          })
          opts.res.once('close', untrack)
        }
        return wsCtx
      },
      onError: ({
        path: trpcPath,
        error,
        ctx,
        input,
      }: {
        path: string | undefined
        error: { code: string; message: string; cause?: unknown }
        ctx?: TrpcContext
        input?: unknown
      }) => {
        const trpcLogger = app.get(LoggingService).createLogger('tRPC:ws')
        trpcLogger.warn('tRPC error', {
          // The socket the viewer uses — this is the transport that logged the
          // four `intercom.startSession` refusals with no camera on them.
          tags: trpcErrorDeviceTags(trpcPath, input),
          meta: {
            code: error.code,
            path: trpcPath ?? '?',
            principal: describeTrpcPrincipal(ctx?.user),
            message: error.message,
          },
        })
        if (error.cause)
          trpcLogger.warn('tRPC error cause', {
            meta: {
              cause:
                error.cause instanceof Error ? error.cause.message : JSON.stringify(error.cause),
            },
          })
      },
    })

    // Manually handle HTTP upgrade for /trpc path.
    // Must use 'upgrade' on the raw Node HTTP server BEFORE Fastify processes it.
    const httpServer = fastify.server
    // Remove any existing upgrade listeners that might conflict
    const existingUpgradeListeners = httpServer.listeners('upgrade')
    httpServer.removeAllListeners('upgrade')

    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = (request.url ?? '').split('?')[0]
      if (pathname === '/trpc') {
        // CORS does not cover a WebSocket: refuse a foreign page here (D707).
        if (refuseForeignWsUpgrade(corsPolicy, request.headers, socket)) return
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      } else {
        // Re-emit for other upgrade handlers (agent WS, etc.)
        // `EventEmitter.listeners()` returns `Function[]` with no call
        // signature — use Reflect.apply to invoke without a cast.
        for (const listener of existingUpgradeListeners) {
          Reflect.apply(listener, httpServer, [request, socket, head])
        }
      }
    })
  } catch (err) {
    console.error('[bootstrap] tRPC registration failed — starting in degraded mode:', err)
    // Register a fallback health endpoint that signals degraded state
    fastify.get('/trpc/health', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.status(503).send({
        status: 'degraded',
        message: 'tRPC router failed to initialize. Check server logs.',
      })
    })
  }

  // Wire the app router into AddonRegistry so addons get context.api
  if (appRouter) {
    await addonRegistry.setAppRouter(appRouter)
    console.log('[bootstrap] AddonRegistry wired with tRPC direct caller')
  }

  // ScopedTokenManager and admin user creation handled by local-auth addon.

  // Both UI bundles are resolved LAZILY and single-flight (D876): a request that
  // finds nothing served triggers one attempt, and a re-registered provider
  // (addon update/restart) moves the served directory.
  const uiLogger = (level: 'info' | 'warn' | 'error', message: string): void => {
    if (level === 'error') console.error(`[bootstrap] ${message}`)
    else if (level === 'warn') console.warn(`[bootstrap] ${message}`)
    else console.log(`[bootstrap] ${message}`)
  }
  const hubUiProvider = (capName: 'admin-ui' | 'viewer-ui'): StaticUiProvider | null => {
    // HUB-NODE-SCOPED resolution — never the cluster-global singleton. An agent
    // node registers the same cap (agent-only placement) and its `getStaticDir()`
    // answers with a path on the agent's filesystem.
    const capRegistry = app.get(AddonRegistryService).getCapabilityRegistry()
    return capRegistry?.getSingletonForNode<StaticUiProvider>(capName, 'hub') ?? null
  }
  const adminUi = createLazyUiServing({
    label: 'Admin UI',
    // CAMSTACK_SKIP_ADMIN_UI_WAIT: e2e runs that do not need the SPA.
    lookup: () =>
      process.env['CAMSTACK_SKIP_ADMIN_UI_WAIT'] === '1' ? null : hubUiProvider('admin-ui'),
    log: uiLogger,
    onServed: ({ staticDir, indexPath }) => {
      spaIndexHtml = indexPath
      warmPrecompressedAssets(staticDir, (msg, meta) =>
        console.log(`[static] ${msg} ${JSON.stringify(meta)}`),
      )
    },
  })
  const viewerUi = createLazyUiServing({
    label: 'Viewer UI',
    lookup: () => hubUiProvider('viewer-ui'),
    log: uiLogger,
    onServed: ({ staticDir }) => {
      warmPrecompressedAssets(staticDir, (msg, meta) =>
        console.log(`[static] ${msg} ${JSON.stringify(meta)}`),
      )
    },
  })
  const VIEWER_MOUNT = '/viewer/camstack'

  // Register UI routes before Fastify starts, but resolve their forked
  // providers after listen. During a cold boot the control plane is therefore
  // immediately reachable while the non-critical UI runners finish starting.
  // Universal/App Link handshake: the domain's half of the pair the viewer
  // app already declares (applinks entitlement + autoVerify intent filter).
  // Unauthenticated by design — Apple's CDN and Android's verifier fetch these
  // with no cookies; content-type must be application/json and no redirect.
  {
    const { appleAppSiteAssociation, assetLinks } = buildAppLinkFiles(
      parseCertFingerprints(process.env['CAMSTACK_ANDROID_CERT_SHA256']),
    )
    const aasa = JSON.stringify(appleAppSiteAssociation)
    const assetlinks = JSON.stringify(assetLinks)
    fastify.get('/.well-known/apple-app-site-association', async (_request, reply) =>
      reply.type('application/json').send(aasa),
    )
    fastify.get('/apple-app-site-association', async (_request, reply) =>
      reply.type('application/json').send(aasa),
    )
    fastify.get('/.well-known/assetlinks.json', async (_request, reply) =>
      reply.type('application/json').send(assetlinks),
    )
  }

  fastify.get('/viewer', async (_request, reply) => reply.redirect(`${VIEWER_MOUNT}/`))
  fastify.get('/viewer/', async (_request, reply) => reply.redirect(`${VIEWER_MOUNT}/`))
  fastify.get('/webrtc-test.html', async (_request, reply) => {
    const webrtcTestPath = path.join(dataPath, 'webrtc-test.html')
    if (!fs.existsSync(webrtcTestPath)) return reply.callNotFound()
    return reply.type('text/html').send(fs.createReadStream(webrtcTestPath))
  })
  fastify.get('/viewer/*', async (request, reply) => {
    const served = await viewerUi.get()
    if (!served) {
      return reply.status(503).send({ error: 'Viewer UI is starting' })
    }
    const { staticDir, indexPath } = served
    const pathOnly = request.url.split('?')[0] ?? request.url
    let rel = ''
    if (pathOnly.startsWith(`${VIEWER_MOUNT}/`)) {
      rel = pathOnly.slice(VIEWER_MOUNT.length + 1)
    }
    if (rel && /\.[a-zA-Z0-9]+$/.test(pathOnly)) {
      const abs = path.join(staticDir, rel)
      if ((abs === staticDir || abs.startsWith(staticDir + path.sep)) && fs.existsSync(abs)) {
        reply.header('cache-control', spaAssetCacheControl(rel))
        reply.type(contentTypeForPath(rel))
        return sendMaybePrecompressed(reply, abs, request.headers['accept-encoding'])
      }
      return reply.callNotFound()
    }
    reply.header('cache-control', spaShellCacheControl())
    return reply.type('text/html').send(fs.createReadStream(indexPath))
  })

  fastify.get('/*', async (request, reply) => {
    const url = request.url
    if (isRetiredPublicPath(url)) return reply.callNotFound()
    if (
      url.startsWith('/trpc') ||
      url.startsWith('/api/') ||
      url.startsWith('/agent') ||
      url.startsWith('/health') ||
      url.startsWith('/adaptive-probe') ||
      url.startsWith('/viewer')
    ) {
      return reply.callNotFound()
    }
    const served = await adminUi.get()
    if (!served) {
      return reply.status(503).send({ error: 'Admin UI is starting' })
    }
    const { staticDir, indexPath } = served
    const pathOnly = url.split('?')[0] ?? url
    // The shell asked for BY NAME is still the shell: it gets the mount
    // injection and the no-store policy, never the asset branch.
    if (pathOnly !== '/index.html' && /\.[a-zA-Z0-9]+$/.test(pathOnly)) {
      const rel = pathOnly.replace(/^\/+/, '')
      const abs = path.join(staticDir, rel)
      if ((abs === staticDir || abs.startsWith(staticDir + path.sep)) && fs.existsSync(abs)) {
        reply.header('cache-control', spaAssetCacheControl(rel))
        return sendMaybePrecompressed(reply, abs, request.headers['accept-encoding'])
      }
      return reply.callNotFound()
    }
    // A relayed navigation (`X-Forwarded-Prefix`) gets a shell that says where
    // it is mounted; without the header the shell is served as before.
    return sendSpaShell(reply, indexPath, request.headers)
  })

  // Boot-time attempt, after listen. Later attempts are driven by requests.
  const resolveAdminUi = async (): Promise<void> => {
    await adminUi.get()
  }
  const resolveViewerUi = async (): Promise<void> => {
    await viewerUi.get()
  }

  // Establish the logging mirror and re-arm any diagnostic window that was
  // armed BEFORE this boot.
  //
  // Deliberately here, immediately before `listen`: the tRPC plugin is
  // registered long before this point but the socket is not open yet, so the
  // census is already counting when the first client reconnects — which is
  // the entire window the boot storm lives in. Awaited (one KV read) rather
  // than fired and forgotten, because "it will probably finish in time" is not
  // a property a measurement can rest on. It must never be the reason a hub
  // fails to boot, hence the catch — and a restore that fails leaves the
  // mirror at its default rather than inventing a level (D49).
  try {
    const settingsStore = buildSettingsStoreGateway(capabilityRegistry)
    const loggingLogger = loggingService.createLogger('logging-settings')
    await new LoggingSettingsService({
      store: settingsStore,
      gate: getLoggingGate(),
      requestCensus: new RequestCensusService({
        census: httpRequestCensus,
        store: settingsStore,
        logger: loggingLogger,
      }),
      logger: loggingLogger,
    }).restore()
  } catch (censusErr: unknown) {
    console.warn(
      '[bootstrap] logging settings restore skipped:',
      censusErr instanceof Error ? censusErr.message : censusErr,
    )
  }

  try {
    const listenHost = allFamiliesListenHost(host).host
    try {
      await app.listen(port, listenHost)
    } catch (listenErr: unknown) {
      if (listenHost === '::' && host !== '::') {
        await app.listen(port, '0.0.0.0')
      } else {
        throw listenErr
      }
    }
  } catch (listenErr: unknown) {
    if (
      listenErr !== null &&
      typeof listenErr === 'object' &&
      'code' in listenErr &&
      listenErr.code === 'EADDRINUSE'
    ) {
      console.error(
        `[bootstrap] FATAL: Port ${port} is already in use. Stop the other process or change server.port in config.yaml.`,
      )
      process.exit(1)
    }
    throw listenErr
  }

  const logger = app.get(LoggingService).createLogger('System')
  const protocol = tlsOptions ? 'https' : 'http'
  logger.info('CamStack server listening', {
    meta: { protocol, host, port, trpcRegistered },
  })

  // Certificate actions (Network → Local access) swap the served certificate
  // in place through this registration — without it an upload sat on disk
  // while the listener kept serving the boot-time leaf (D726).
  if (tlsOptions) {
    if (fastify.server instanceof TlsServer) {
      registerHttpsListener(fastify.server, tlsOptions)
    } else {
      logger.warn('HTTPS listener is not a TLS server — certificate changes need a restart')
    }
  }

  // LAN HTTP sibling — same Fastify request graph, dedicated port. Handler
  // is registered as soon as we have the instance; bind happens after HTTPS
  // is up so a failed HTTPS listen does not leave HTTP serving alone.
  registerLanHttpHandler({
    onRequest: (req, res) => {
      fastify.server.emit('request', req, res)
    },
    onUpgrade: (req, socket, head) => {
      fastify.server.emit('upgrade', req, socket, head)
    },
  })
  try {
    const lanHttp = await bindPendingLanHttp()
    if (lanHttp.listening) {
      logger.info('LAN HTTP listening', { meta: { port: lanHttp.port } })
    } else if (lanHttp.error) {
      logger.warn('LAN HTTP not bound', {
        meta: { error: lanHttp.error, port: lanHttp.port },
      })
    }
  } catch (err: unknown) {
    logger.warn('LAN HTTP bind failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // UI runners are not part of control-plane readiness. Their mutable route
  // state switches from 503 to static serving as soon as each capability is up.
  void Promise.all([resolveAdminUi(), resolveViewerUi()])

  // Post-boot: fork workers, register device streams, emit system.boot
  const postBoot = app.get(PostBootService)
  await postBoot.run({ port, host, dataPath, trpcRegistered, tlsCert })

  // D877: ONE check, ~60 s after the boot sequence, of the runners this node
  // planned against what its process service holds. Stored in memory and served
  // on `getServerPackageStatus` / `/health`; not a timer loop.
  app.get(RunnerBootCheckService).scheduleAfterBoot()

  // The hub reached ready — when this boot is the PROBATION boot of a freshly
  // staged @camstack/server root, promote it (currentVersion ← pending, N-1
  // retained for rollback) and disarm the starter's crash-loop auto-rollback.
  try {
    const confirm = app.get(ServerUpdateService).confirmBootHealthy()
    if (confirm.promoted !== null) {
      logger.info('Server root package update confirmed healthy', {
        meta: { version: confirm.promoted },
      })
    }
  } catch (err) {
    logger.warn('Server root boot confirmation failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // ONE COPY PER NODE — the sweep, at the only moment it is safe (D45, task 32).
  //
  // The boot above is confirmed healthy and the hub is serving, so the legacy
  // `<dataDir>/framework` tree and any host-provided package under the addon
  // root are redundant: nothing loads them, and each is a resolution race that
  // has already cost this project three wrong diagnoses in one evening.
  //
  // It runs HERE and not in the launcher because "healthy" is the gate. Before
  // the hub is up, the copies this removes are the recovery path — the image
  // seeds them for exactly the boot that would otherwise fail. The agent runs
  // the SAME function at its own confirmation point; neither role owns a
  // private idea of what may be deleted.
  void runSingleCopyCleanup({
    dataDir: dataPath,
    addonRoot: process.env['CAMSTACK_ADDONS_DIR'] ?? path.join(dataPath, 'addons'),
    log: (line) => logger.info(line),
  })

  // One-time backfill: stamp integrationId on devices created before the
  // device-manager forwarder started stamping it (legacy camera providers),
  // so deleting their integration cascades them. Idempotent — only touches
  // untagged top-level devices of single-instance addons.
  try {
    const dmForBackfill = capabilityRegistry.getSingleton('device-manager') as {
      listAll?: (input: { addonId?: string }) => Promise<
        readonly {
          id: number
          addonId: string
          parentDeviceId: number | null
          integrationId?: string
        }[]
      >
      setIntegrationId?: (input: { deviceId: number; integrationId: string }) => Promise<void>
    } | null
    const integrationRegistry = addonRegistry.getIntegrationRegistry()
    if (dmForBackfill?.listAll && dmForBackfill?.setIntegrationId && integrationRegistry) {
      const listAll = dmForBackfill.listAll
      const setIntegrationId = dmForBackfill.setIntegrationId
      const backfillLogger = loggingService.createLogger('integration-backfill')
      await runIntegrationIdBackfill({
        listIntegrations: async () =>
          (await integrationRegistry.listIntegrations()).map((i) => ({
            id: i.id,
            addonId: i.addonId,
          })),
        listDevices: async () =>
          (await listAll({})).map((d) => ({
            id: d.id,
            addonId: d.addonId,
            parentDeviceId: d.parentDeviceId,
            integrationId: d.integrationId,
          })),
        setIntegrationId: (deviceId, integrationId) =>
          setIntegrationId({ deviceId, integrationId }),
        logger: {
          info: (message, meta) => backfillLogger.info(message, { meta }),
          warn: (message, meta) => backfillLogger.warn(message, { meta }),
        },
      })
    }
  } catch (err) {
    console.warn(
      '[bootstrap] integrationId backfill skipped:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Read the hub's own package version (best-effort) for /health responses.
 */
function readHubVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json')
    if (fs.existsSync(pkgPath)) {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        version?: string
      }
      if (typeof raw.version === 'string') return raw.version
    }
  } catch {
    // best-effort
  }
  return 'unknown'
}

/**
 * Build an AddonHttpReply wrapper around a Fastify reply.
 */
function buildAddonReply(reply: FastifyReply) {
  const wrapper = {
    status(code: number) {
      reply.status(code)
      return wrapper
    },
    code(code: number) {
      reply.code(code)
      return wrapper
    },
    send(data: unknown) {
      reply.send(data)
    },
    redirect(url: string) {
      reply.redirect(url)
    },
    header(name: string, value: string) {
      reply.header(name, value)
      return wrapper
    },
    type(mime: string) {
      reply.type(mime)
      return wrapper
    },
  }
  return wrapper
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
