/**
 * Thin wrapper around the `tailscale` CLI.
 *
 * Why CLI rather than the local API socket: `tailscaled` exposes its
 * control plane at `/var/run/tailscale/tailscaled.sock` but the wire
 * protocol is undocumented + the Go client is gnarly to port. The
 * `tailscale` CLI is the supported public interface, it covers every
 * action we need (`up`/`down`/`status --json`/`serve`/`funnel`), and
 * its output is stable JSON for `status` + non-fatal stderr for the
 * others.
 *
 * The wrapper:
 *   - resolves the binary path once (PATH lookup + macOS GUI install
 *     fallback at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`).
 *   - exposes Promise-based methods returning typed shapes.
 *   - never spawns long-lived processes — every call is one-shot.
 *
 * Operator-side prerequisite: `tailscaled` must be installed +
 * running. The addon surfaces "binary missing" / "daemon not running"
 * errors verbatim so the operator can act.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IScopedLogger } from '@camstack/types'
import { scrubSecret, withAuthKeyFile } from '../auth-key-file'

const execFileP = promisify(execFile)

const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  // macOS GUI install ships the CLI inside the .app bundle.
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

export class TailscaleCliError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
  ) {
    super(message)
    this.name = 'TailscaleCliError'
  }
}

/** Subset of `tailscale status --json` we actually use. */
export interface TailscaleStatusJson {
  readonly BackendState:
    | 'NoState'
    | 'NeedsLogin'
    | 'NeedsMachineAuth'
    | 'Starting'
    | 'Running'
    | 'Stopped'
  readonly Self?: {
    readonly ID: string
    readonly HostName: string
    readonly DNSName: string // e.g. "camstack.tail-abc.ts.net."
    readonly TailscaleIPs?: readonly string[]
    readonly Online: boolean
    readonly OS: string
    /**
     * Node capabilities granted by the tailnet ACL policy. Modern
     * tailscale (post-#11508) exposes them as a keyed map; the legacy
     * `Capabilities` string array is kept alongside for older daemons.
     * Funnel readiness = presence of `https://tailscale.com/cap/funnel`
     * (or the bare `funnel` token in the legacy array).
     */
    readonly CapMap?: Record<string, unknown>
    readonly Capabilities?: readonly string[]
  }
  readonly Peer?: Record<
    string,
    {
      readonly ID: string
      readonly HostName: string
      readonly DNSName: string
      readonly TailscaleIPs?: readonly string[]
      readonly Online: boolean
      readonly OS: string
      readonly LastSeen: string // ISO 8601
    }
  >
  readonly MagicDNSSuffix?: string
  readonly CurrentTailnet?: { readonly Name?: string; readonly MagicDNSSuffix?: string }
}

/**
 * Options for the per-ingress serve/funnel CLI calls. `targetPath` is
 * the public-facing mount path the operator wants the rule to live at
 * (default `/`). Tailscale's `serve` syntax accepts an optional
 * `--set-path=<path>` flag to attach the rule to a non-root prefix —
 * we drive it through this option.
 */
/**
 * Upstream scheme tailscale serve/funnel uses to reach the local
 * service. The camstack hub listens HTTPS-with-self-signed by default
 * (`tls.enabled`), so 'https+insecure' is the right default — plain
 * 'http' makes tailscale speak cleartext to the hub's TLS listener
 * and the proxy returns 502.
 */
export type UpstreamScheme = 'http' | 'https' | 'https+insecure'

export interface IngressRuleOptions {
  readonly port: number
  readonly enabled: boolean
  readonly targetPath?: string
  /** Defaults to 'https+insecure' when omitted. */
  readonly upstreamScheme?: UpstreamScheme
}

const NOOP_LOGGER: IScopedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => NOOP_LOGGER,
  withTags: () => NOOP_LOGGER,
}

/**
 * Construction options for {@link TailscaleCli}.
 *
 * When the tailscale-client addon runs in `onboard` mode it spawns a
 * private `tailscaled`; the ingress addon then drives the SAME daemon
 * by passing that daemon's `binPath` + `socketPath` here. Both unset
 * = host mode (auto-resolve the system binary + default socket).
 */
export interface TailscaleCliOptions {
  readonly logger?: IScopedLogger
  /** Explicit `tailscale` binary path. When unset, auto-resolved from PATH. */
  readonly binPath?: string
  /** `tailscaled` socket path, passed as `--socket=<path>`. When unset, the daemon default. */
  readonly socketPath?: string
}

export class TailscaleCli {
  private resolvedBin: string | null = null
  private readonly logger: IScopedLogger
  private readonly binPathOverride: string | undefined
  private readonly socketPath: string | undefined

  constructor(opts: TailscaleCliOptions | IScopedLogger = {}) {
    // Back-compat: a bare IScopedLogger was the old single arg.
    if (typeof (opts as IScopedLogger).info === 'function' && !('logger' in opts)) {
      this.logger = opts as IScopedLogger
      this.binPathOverride = undefined
      this.socketPath = undefined
    } else {
      const o = opts as TailscaleCliOptions
      this.logger = o.logger ?? NOOP_LOGGER
      this.binPathOverride = o.binPath
      this.socketPath = o.socketPath
    }
  }

  /** Prepend `--socket=<path>` when driving an onboard daemon. */
  private withSocket(args: readonly string[]): string[] {
    return this.socketPath ? [`--socket=${this.socketPath}`, ...args] : [...args]
  }

  /** Locate the `tailscale` binary once and cache the result. */
  private async resolveBin(): Promise<string> {
    if (this.resolvedBin) return this.resolvedBin
    if (this.binPathOverride) {
      this.resolvedBin = this.binPathOverride
      this.logger.info('CLI binary (onboard override)', {
        meta: { bin: this.binPathOverride, socketPath: this.socketPath },
      })
      return this.binPathOverride
    }
    const tried: string[] = []
    for (const candidate of TAILSCALE_CANDIDATES) {
      try {
        await execFileP(candidate, ['version'], { timeout: 3_000 })
        this.resolvedBin = candidate
        this.logger.info('CLI binary resolved', {
          meta: { bin: candidate, candidatesTried: tried },
        })
        return candidate
      } catch {
        tried.push(candidate)
      }
    }
    throw new TailscaleCliError(
      'tailscale binary not found — install Tailscale from https://tailscale.com/download',
    )
  }

  async version(): Promise<string> {
    const bin = await this.resolveBin()
    const { stdout } = await execFileP(bin, this.withSocket(['version']), { timeout: 5_000 })
    return stdout.trim().split('\n')[0] ?? ''
  }

  async status(): Promise<TailscaleStatusJson> {
    const bin = await this.resolveBin()
    try {
      const { stdout } = await execFileP(bin, this.withSocket(['status', '--json']), {
        timeout: 10_000,
      })
      return JSON.parse(stdout) as TailscaleStatusJson
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      throw new TailscaleCliError(`tailscale status failed: ${e.message}`, e.stderr ?? '')
    }
  }

  /**
   * Whether the tailnet ACL policy grants THIS host the Funnel
   * attribute. Reads `Self.CapMap` / `Self.Capabilities` from
   * `tailscale status --json` — a pre-flight check so the addon can
   * fail fast with an actionable error BEFORE spending 15s on a
   * `tailscale funnel` call that the daemon would reject anyway.
   *
   * The funnel grant surfaces as a bare `funnel` key in the modern
   * CapMap; the legacy `Capabilities` string array carries either
   * `funnel` or a `.../cap/funnel` URL form.
   */
  async funnelCapable(): Promise<boolean> {
    const s = await this.status()
    const capMap = s.Self?.CapMap ?? {}
    if (Object.prototype.hasOwnProperty.call(capMap, 'funnel')) return true
    const legacy = s.Self?.Capabilities ?? []
    const capable = legacy.some((c) => c === 'funnel' || c.endsWith('/cap/funnel'))
    this.logger.info('funnelCapable check', {
      meta: { capable, capMapKeys: Object.keys(capMap), legacyCount: legacy.length },
    })
    return capable
  }

  /** Bring the daemon up with an auth key. Idempotent — calling
   *  while already joined returns immediately. */
  async up(input: { readonly authKey: string; readonly hostname?: string }): Promise<void> {
    const bin = await this.resolveBin()
    // The key travels in a 0600 file, never argv / env / error text (D783).
    await withAuthKeyFile(input.authKey, async (authKeyFlag) => {
      const args = ['up', authKeyFlag, '--reset']
      if (input.hostname) args.push(`--hostname=${input.hostname}`)
      try {
        await execFileP(bin, this.withSocket(args), { timeout: 60_000 })
      } catch (err) {
        const e = err as { stderr?: string; message: string }
        throw new TailscaleCliError(
          `tailscale up failed: ${scrubSecret(e.message, input.authKey)}`,
          scrubSecret(e.stderr ?? '', input.authKey),
        )
      }
    })
  }

  /** Leave the tailnet. After this the host's `100.x` address is
   *  released until the next `up`. */
  async down(): Promise<void> {
    const bin = await this.resolveBin()
    try {
      await execFileP(bin, this.withSocket(['down']), { timeout: 15_000 })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      throw new TailscaleCliError(`tailscale down failed: ${e.message}`, e.stderr ?? '')
    }
  }

  /** `tailscale serve` — exposes a local port to peers in the same
   *  tailnet over HTTPS with auto-issued cert. Mutating call; the
   *  daemon persists the rule across restarts.
   *
   *  When `targetPath` is provided we pass `--set-path=<path>` so
   *  multiple serve rules can co-exist under different prefixes
   *  without overwriting each other. */
  async serve(input: IngressRuleOptions): Promise<void> {
    const bin = await this.resolveBin()
    const args = this.buildIngressArgs('serve', input)
    this.logger.info('serve: invoking CLI', { meta: { bin, args, ...input } })
    try {
      const { stdout, stderr } = await execFileP(bin, this.withSocket(args), { timeout: 15_000 })
      this.logger.info('serve: CLI returned', {
        meta: { stdout: trimForLog(stdout), stderr: trimForLog(stderr) },
      })
    } catch (err) {
      throw this.wrapCliError('tailscale serve', err, bin, args)
    }
  }

  /** `tailscale funnel` — exposes a local port to the open internet
   *  via Tailscale's edge. Requires Funnel ACL grant in the tailnet
   *  policy. Same shape as `serve`. */
  async funnel(input: IngressRuleOptions): Promise<void> {
    const bin = await this.resolveBin()
    const args = this.buildIngressArgs('funnel', input)
    this.logger.info('funnel: invoking CLI', { meta: { bin, args, ...input } })
    try {
      const { stdout, stderr } = await execFileP(bin, this.withSocket(args), { timeout: 15_000 })
      this.logger.info('funnel: CLI returned', {
        meta: { stdout: trimForLog(stdout), stderr: trimForLog(stderr) },
      })
    } catch (err) {
      throw this.wrapCliError('tailscale funnel', err, bin, args)
    }
  }

  /**
   * Build a TailscaleCliError that propagates BOTH stdout and stderr
   * up to the caller. The tailscale CLI is inconsistent about which
   * stream it uses for human-readable errors — `funnel` (and at least
   * some `serve` paths) writes the actionable hint to STDOUT when
   * the host lacks the ACL grant (e.g. "Funnel is not enabled on
   * your tailnet. To enable, visit: https://login.tailscale.com/...").
   * Reading only stderr loses that hint and the operator sees a bare
   * "Command failed: …" with no recovery path.
   *
   * Special-cases the "Funnel is not enabled" outcome: extracts the
   * enable-URL the CLI prints and surfaces a concise, single-line
   * actionable error instead of dumping the raw multi-line blob.
   */
  private wrapCliError(
    verb: string,
    err: unknown,
    bin: string,
    args: readonly string[],
  ): TailscaleCliError {
    const e = err as { stderr?: string; stdout?: string; message: string; code?: number }
    const stderr = (e.stderr ?? '').trim()
    const stdout = (e.stdout ?? '').trim()
    this.logger.error(`${verb}: CLI failed`, {
      meta: {
        bin,
        args,
        message: e.message,
        stderr: trimForLog(stderr),
        stdout: trimForLog(stdout),
      },
    })

    // Funnel-not-enabled is the single most common Funnel failure —
    // give it a dedicated, concise error with just the enable-URL.
    const combined = `${stdout}\n${stderr}`
    if (/funnel is not enabled/i.test(combined)) {
      const url =
        combined.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] ??
        'https://login.tailscale.com/admin/settings/funnel'
      return new TailscaleCliError(
        `Funnel is not enabled on your tailnet. Enable it for this host at: ${url}`,
        stderr.length > 0 ? stderr : stdout,
      )
    }

    const detail =
      stderr.length > 0
        ? `--- stderr ---\n${stderr}`
        : stdout.length > 0
          ? `--- stdout ---\n${stdout}`
          : ''
    return new TailscaleCliError(
      `${verb} failed: ${e.message.trim()}${detail ? `\n${detail}` : ''}`,
      stderr.length > 0 ? stderr : stdout,
    )
  }

  /**
   * Single source of truth for the serve/funnel arg shape. The CLI
   * accepts the same flag layout for both verbs, so we share the
   * builder. `--set-path` is only emitted when the operator picks a
   * non-root mount.
   */
  private buildIngressArgs(verb: 'serve' | 'funnel', input: IngressRuleOptions): readonly string[] {
    const path = (input.targetPath ?? '').trim()
    if (!input.enabled) {
      const out: string[] = [verb, '--bg']
      if (path && path !== '/') out.push(`--set-path=${path}`)
      out.push('off')
      return out
    }
    const out: string[] = [verb, '--bg']
    if (path && path !== '/') out.push(`--set-path=${path}`)
    const scheme = input.upstreamScheme ?? 'https+insecure'
    out.push(`${scheme}://127.0.0.1:${input.port}`)
    return out
  }
}

/** Truncate long stdout/stderr blobs so the log entry stays readable. */
function trimForLog(s: string, max = 800): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…[+${trimmed.length - max} bytes]`
}
