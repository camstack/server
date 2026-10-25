import { userError } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import { EventCategory } from '@camstack/types'
import type { IScopedLogger, IEventBus } from '@camstack/types'
import {
  buildCloudflaredArgs,
  removeTokenFile,
  tokenFileIn,
  writeTokenFile,
} from './cloudflared-invocation'

type CloudflaredChild = ChildProcessByStdio<null, Readable, Readable>

/**
 * Endpoint shape the orchestrator + tRPC NetworkEndpointSchema expect.
 * Stricter than the legacy server-network.ts INetworkEndpoint (which
 * had id/type/provider/internal/capabilities/priority/status — none of
 * those are in the wire schema). The cap-mount validates against this.
 */
interface CloudflareEndpoint {
  url: string
  hostname: string
  port: number
  protocol: 'http' | 'https'
  /** `false` for Quick mode (random URL per respawn); `true` for a named tunnel. */
  stable: boolean
}

interface CloudflareStatus {
  connected: boolean
  endpoint: CloudflareEndpoint | null
  error?: string
}

export interface CloudflareTunnelConfig {
  /** 'quick' = cloudflared --url ... (random trycloudflare URL).
   *  'custom' = server-managed named tunnel pointed at `customHostname`. */
  readonly mode: 'quick' | 'custom'

  /** Local port to expose through the tunnel. */
  readonly localPort: number

  /** Whether to use an explicit custom port or auto-detect from env/cap. */
  readonly localPortMode: 'default' | 'custom'

  /** Local hostname the tunnel should target. Empty = `127.0.0.1`.
   *  Set automatically by the addon from the `local-network` cap so
   *  Docker sidecar deployments hit the hub container's eth0 instead
   *  of an unreachable loopback. */
  readonly localHost: string

  // ── Origin TLS overrides (applied to the cloudflared → origin hop) ──
  /** Skip TLS verification on the cloudflared→origin hop.
   *  Default true for camstack's self-signed cert. */
  readonly noTLSVerify: boolean
  /** Optional SNI hostname to send on the TLS handshake to the origin. */
  readonly originServerName: string
  /** Optional Host header override sent to the origin. */
  readonly httpHostHeader: string

  // ── Custom-mode persisted state (filled by enableCustom action) ──
  // All declared non-optional so `BaseAddon.defaults` can list them and
  // `resolveConfig` rehydrates them from disk. Empty string `''` is the
  // "not yet set" sentinel — `handleStart` checks for falsy.
  /** Cloudflare account id (probed during enableCustom). */
  readonly customAccountId: string
  /** Cloudflare tunnel id (returned by POST cfd_tunnel). */
  readonly customTunnelId: string
  /** JWT used by `cloudflared tunnel run --token` for this tunnel. */
  readonly customTunnelToken: string
  /** Zone id the CNAME was created in (for cleanup). */
  readonly customZoneId: string
  /** Zone name (e.g. "example.com") — used to compose the FQDN and as
   *  a display hint in the UI. Cached from the zone lookup so we don't
   *  need to hit Cloudflare every status read. */
  readonly customZoneName: string
  /** DNS record id of the CNAME (for cleanup on disable). */
  readonly customDnsRecordId: string
  /** Fully-qualified public hostname (e.g. "camstack.example.com") that
   *  resolves to this CamStack hub via the cnamed tunnel. */
  readonly customHostname: string

  // ── Form-only transient state (re-entered on each provisioning run) ──
  /** Cloudflare API token, persisted only so the form can roundtrip it
   *  inside one editing session. Cleared by `disableCustom`. */
  readonly customApiToken: string

  // ── Debug logging ─────────────────────────────────────────────────
  /** When true, spawn cloudflared with `--loglevel debug` AND
   *  `--transport-loglevel debug`. cloudflared emits per-request lifecycle
   *  lines (arrival from CF edge → dispatch to origin → response back)
   *  plus QUIC/HTTP2 stream timing, so operators can pinpoint whether a
   *  slow Lambda→hub call is stuck on the edge side (Cloudflare network)
   *  vs the origin side (cloudflared → local hub). Costly — leave OFF in
   *  production. Flipping it triggers an automatic respawn via
   *  `onConfigChanged`. */
  readonly debugLogging: boolean

  // ── Transport protocol ────────────────────────────────────────────
  /** Force the cloudflared ↔ Cloudflare-edge transport protocol.
   *
   *  - `'auto'` (default): let cloudflared pick — typically QUIC.
   *  - `'http2'`: TCP+TLS transport with HTTP/2 multiplexing. Slower
   *    handshake but fairer flow-control under burst; useful as a
   *    workaround for QUIC stream stalls observed under concurrent
   *    request bursts (one big request gets queued behind many small
   *    ones for tens of seconds).
   *  - `'quic'`: explicit QUIC/HTTP3 — same as default but pinned. */
  readonly protocol: 'auto' | 'http2' | 'quic'
}

/**
 * Direct child_process.spawn() driver for the `cloudflared` binary.
 *
 * Why no IProcessManager: `IKernelServices` doesn't expose one to addons,
 * and ProcessConfig doesn't have an output-callback hook. We need stdout
 * to live-parse the Quick-tunnel public URL, so spawn directly.
 *
 * Lifecycle:
 *   - start() spawns the binary, attaches stdout/stderr line forwarders
 *     (every line → `this.logger.info` with `tags.topic='tunnel'`),
 *     watches for the `https://*.trycloudflare.com` line on Quick mode,
 *     and updates `this.endpoint.url` when found.
 *   - stop() sends SIGTERM, escalates to SIGKILL after 5s.
 *   - Auto-restart on unexpected exit, capped at 5 retries.
 */

const QUICK_URL_REGEX = /\bhttps:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i

export class CloudflareTunnelService {
  readonly id = 'cloudflare-tunnel'
  readonly type = 'cloudflare'

  private endpoint: CloudflareEndpoint | null = null
  private lastError: string | undefined
  private child: CloudflaredChild | null = null
  /** Resolved cloudflared path/command (set on first start, reused on restart). */
  private cloudflaredBin = 'cloudflared'
  private restartCount = 0
  private intentionalStop = false
  private static readonly MAX_RESTARTS = 5
  private static readonly STOP_GRACE_MS = 5_000

  constructor(
    private readonly config: CloudflareTunnelConfig,
    private readonly logger: IScopedLogger,
    private readonly eventBus: IEventBus,
    /**
     * Resolver for the `cloudflared` binary, awaited lazily at `start()` so the
     * binary is provisioned on first use (PATH install or a copy downloaded +
     * cached in the addon's data dir) — never at addon init. Defaults to the
     * bare command for backward compatibility / tests.
     */
    private readonly resolveCloudflaredBin: () => Promise<string> = async () => 'cloudflared',
    /**
     * Owner-only directory (inside the addon's data dir) where the named-tunnel
     * token file is written right before each spawn. Required for custom mode;
     * there is no argv / env fallback (D783).
     */
    private readonly tokenFileDir: string | null = null,
  ) {}

  async start(): Promise<CloudflareEndpoint> {
    this.logger.info('Starting Cloudflare tunnel', {
      meta: { mode: this.config.mode, localPort: this.config.localPort },
      tags: { topic: 'tunnel', phase: 'starting' },
    })

    if (this.config.mode === 'custom') {
      if (!this.config.customTunnelToken) {
        const err = userError(
          'cloudflare.custom-not-configured',
          undefined,
          'Custom tunnel not configured — run "Enable" from settings first',
        )
        this.logger.error(err.message, { tags: { topic: 'tunnel', phase: 'config-error' } })
        throw err
      }
      if (!this.config.customHostname) {
        const err = new Error('Custom tunnel missing public hostname — re-run "Enable"')
        this.logger.error(err.message, { tags: { topic: 'tunnel', phase: 'config-error' } })
        throw err
      }
    }

    if (this.child !== null) {
      this.logger.warn('Cloudflare tunnel already running — refusing to spawn a duplicate', {
        tags: { topic: 'tunnel', phase: 'already-running' },
      })
      if (this.endpoint) return this.endpoint
    }

    this.intentionalStop = false
    this.restartCount = 0
    this.lastError = undefined
    // Provision cloudflared lazily on first start (PATH install, or download +
    // cache in the addon data dir) — kept out of the base hub image. Cached for
    // subsequent restarts (the sync spawnChild reads the resolved path).
    try {
      this.cloudflaredBin = await this.resolveCloudflaredBin()
    } catch (err) {
      this.logger.error('Failed to provision cloudflared binary', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'provision-error' },
      })
      throw err
    }
    this.spawnChild()

    // Quick mode: placeholder until cloudflared's stdout reports the
    // real *.trycloudflare.com URL. Custom mode: we already know the
    // public hostname (set by enableCustom), so reflect it immediately.
    const placeholderHost =
      this.config.mode === 'custom' ? this.config.customHostname! : 'pending.trycloudflare.com'

    this.endpoint = {
      url: `https://${placeholderHost}`,
      hostname: placeholderHost,
      port: 443,
      protocol: 'https',
      stable: this.config.mode === 'custom',
    }

    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: 'cloudflare-tunnel' },
      category: EventCategory.NetworkTunnelStarted,
      data: { url: this.endpoint.url, stable: this.endpoint.stable },
    })

    return this.endpoint
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Cloudflare tunnel', {
      meta: { hadProcess: this.child !== null, hadEndpoint: this.endpoint !== null },
      tags: { topic: 'tunnel', phase: 'stopping' },
    })

    this.intentionalStop = true
    if (this.child !== null) {
      const child = this.child
      this.child = null
      try {
        child.kill('SIGTERM')
        // Escalate to SIGKILL if it doesn't exit within the grace window.
        const killTimer = setTimeout(() => {
          if (!child.killed) {
            this.logger.warn('cloudflared did not exit within grace — SIGKILL', {
              tags: { topic: 'tunnel', phase: 'force-kill' },
            })
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
          }
        }, CloudflareTunnelService.STOP_GRACE_MS)
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            clearTimeout(killTimer)
            resolve()
          })
        })
      } catch (err) {
        this.logger.warn('cloudflared process stop reported an error', {
          meta: { error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tunnel', phase: 'stop-error' },
        })
      }
    }
    // Normally already removed by the child's exit handler; covers a child
    // that never spawned or an exit we did not observe.
    if (this.tokenFileDir) removeTokenFile(tokenFileIn(this.tokenFileDir))
    this.endpoint = null

    this.logger.info('Cloudflare tunnel stopped', {
      tags: { topic: 'tunnel', phase: 'stopped' },
    })

    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: 'cloudflare-tunnel' },
      category: EventCategory.NetworkTunnelStopped,
      data: {},
    })
  }

  getEndpoint(): CloudflareEndpoint | null {
    return this.endpoint
  }

  getStatus(): CloudflareStatus {
    const status: CloudflareStatus = {
      connected: this.endpoint !== null,
      endpoint: this.endpoint,
    }
    if (this.lastError !== undefined) status.error = this.lastError
    return status
  }

  // ── Internals ─────────────────────────────────────────────────

  private writeTokenFileForSpawn(): string {
    if (!this.tokenFileDir) {
      throw new Error('cloudflared: no private directory for the tunnel token file')
    }
    return writeTokenFile(this.tokenFileDir, this.config.customTunnelToken)
  }

  private spawnChild(): void {
    // The named-tunnel token goes in a 0600 file, never argv / env / logs
    // (D783). Written fresh for each spawn, deleted when this child exits.
    const tokenFile = this.config.mode === 'custom' ? this.writeTokenFileForSpawn() : null
    const args = buildCloudflaredArgs(this.config, tokenFile)

    let child: CloudflaredChild
    try {
      // `cloudflaredBin` was resolved (PATH or downloaded) in start() before the
      // first spawnChild; restarts reuse the cached path.
      child = spawn(this.cloudflaredBin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      if (tokenFile) removeTokenFile(tokenFile)
      this.logger.error('Failed to spawn cloudflared (binary missing?)', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'spawn-error' },
      })
      throw err
    }

    this.child = child
    this.logger.info('cloudflared spawned', {
      // Safe to log: the token sits in a file; argv holds only its path.
      meta: { pid: child.pid, args: args.join(' ') },
      tags: { topic: 'tunnel', phase: 'spawned' },
    })

    // Forward each line of stdout/stderr to the addon logger. cloudflared
    // intermixes JSON-structured messages with human-readable ones; we
    // emit them as raw text in `meta.line` and let the operator filter.
    const forwardLines = (stream: NodeJS.ReadableStream, level: 'info' | 'warn'): void => {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          // Live Quick-tunnel URL detection. cloudflared logs it once on
          // startup; we capture the FIRST match and update the endpoint
          // so the UI reflects the real public domain.
          if (this.config.mode === 'quick') {
            const match = line.match(QUICK_URL_REGEX)
            if (match && this.endpoint && this.endpoint.url !== match[0]) {
              try {
                const parsed = new URL(match[0])
                this.endpoint = {
                  url: match[0],
                  hostname: parsed.hostname,
                  port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
                  protocol: parsed.protocol === 'https:' ? 'https' : 'http',
                  stable: false,
                }
              } catch {
                // Fallback if URL constructor rejects the captured string
                this.endpoint = { ...this.endpoint, url: match[0] }
              }
              this.logger.info('Quick tunnel URL ready', {
                meta: { url: match[0] },
                tags: { topic: 'tunnel', phase: 'quick-url-ready' },
              })
              this.eventBus.emit({
                id: randomUUID(),
                timestamp: new Date(),
                source: { type: 'addon', id: 'cloudflare-tunnel' },
                category: EventCategory.NetworkTunnelStarted,
                data: { url: match[0], stable: false, updated: true },
              })
            }
          }
          if (level === 'warn') {
            this.logger.warn(line, { tags: { topic: 'tunnel', stream: 'stderr' } })
          } else {
            this.logger.info(line, { tags: { topic: 'tunnel', stream: 'stdout' } })
          }
        }
      })
    }
    forwardLines(child.stdout, 'info')
    // cloudflared writes everything to stderr by convention — keep it
    // logged at info level rather than warn so the noise doesn't drown
    // out real warnings. Only true failures (exit) get warn/error.
    forwardLines(child.stderr, 'info')

    child.on('exit', (code, signal) => {
      if (tokenFile) removeTokenFile(tokenFile)
      this.logger.info('cloudflared exited', {
        meta: { code, signal, intentional: this.intentionalStop },
        tags: { topic: 'tunnel', phase: 'exited' },
      })
      if (this.child === child) this.child = null

      if (!this.intentionalStop && this.restartCount < CloudflareTunnelService.MAX_RESTARTS) {
        this.restartCount++
        const backoffMs = Math.min(1_000 * Math.pow(2, this.restartCount), 30_000)
        this.logger.warn('cloudflared crashed — restarting with backoff', {
          meta: { attempt: this.restartCount, backoffMs },
          tags: { topic: 'tunnel', phase: 'restarting' },
        })
        setTimeout(() => {
          if (!this.intentionalStop) {
            try {
              this.spawnChild()
            } catch (err) {
              this.logger.error('cloudflared restart failed', {
                meta: { error: err instanceof Error ? err.message : String(err) },
                tags: { topic: 'tunnel', phase: 'restart-error' },
              })
            }
          }
        }, backoffMs)
      } else if (!this.intentionalStop) {
        this.logger.error('cloudflared crashed too many times — giving up', {
          meta: { restartCount: this.restartCount },
          tags: { topic: 'tunnel', phase: 'gave-up' },
        })
        this.endpoint = null
      }
    })

    child.on('error', (err) => {
      this.logger.error('cloudflared process error', {
        meta: { error: err.message },
        tags: { topic: 'tunnel', phase: 'process-error' },
      })
    })
  }
}
