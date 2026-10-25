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
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import type { IScopedLogger } from '@camstack/types'
import { scrubSecret, withAuthKeyFile } from '../auth-key-file'

const execFileP = promisify(execFile)

/**
 * Interactive-login handle returned by `TailscaleCli.startInteractiveLogin`.
 *
 * The child `tailscale up` process keeps running while the operator
 * authenticates in their browser; once the control plane accepts the
 * device the CLI self-terminates. The caller can `cancel()` to kill
 * the process if the user abandons the flow.
 */
export interface TailscaleLoginHandle {
  /** The verification URL printed by `tailscale up`. */
  readonly loginUrl: string
  /** Kill the underlying `tailscale up` process. Idempotent. */
  cancel(): void
}

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

/**
 * Subset of `tailscale status --json` we actually use. The structure
 * is documented at https://tailscale.com/kb/1080/cli — we mirror only
 * the fields driving `mesh-network.getStatus` and `listPeers`. Adding
 * a field here is cheap; adding one to the cap schema requires a
 * codegen pass.
 */
export interface TailscalePeerStatus {
  readonly ID: string
  readonly HostName: string
  readonly DNSName: string
  readonly TailscaleIPs?: readonly string[]
  readonly Online: boolean
  readonly OS?: string
  readonly LastSeen?: string
  readonly LastHandshake?: string
  readonly Relay?: string
  readonly CurAddr?: string
  readonly TxBytes?: number
  readonly RxBytes?: number
  readonly Tags?: readonly string[]
  readonly UserID?: number
  readonly ExitNode?: boolean
  readonly ExitNodeOption?: boolean
  readonly KeyExpiry?: string
  readonly PrimaryRoutes?: readonly string[]
  readonly AllowedIPs?: readonly string[]
  readonly Active?: boolean
}

export interface TailscaleStatusJson {
  readonly BackendState:
    | 'NoState'
    | 'NeedsLogin'
    | 'NeedsMachineAuth'
    | 'Starting'
    | 'Running'
    | 'Stopped'
  readonly Self?: TailscalePeerStatus
  readonly Peer?: Record<string, TailscalePeerStatus>
  readonly MagicDNSSuffix?: string
  readonly CurrentTailnet?: {
    readonly Name?: string
    readonly MagicDNSSuffix?: string
    readonly MagicDNSEnabled?: boolean
  }
  /**
   * `User` map keyed by numeric `UserID` — peers' owners. Pre-2024
   * tailscale CLI returns this; we use it to resolve `peer.userLogin`.
   */
  readonly User?: Record<string, { readonly LoginName?: string; readonly DisplayName?: string }>
  readonly Version?: string
  readonly ControlURL?: string
}

/**
 * `tailscale debug prefs` JSON — surfaces the daemon's per-config
 * preferences (advertised routes / tags, accept-routes, accept-dns,
 * ssh, shields-up, exit-node selection). The status JSON does NOT
 * include these reliably, so for an accurate read of "what's configured"
 * we read `prefs` and merge with status fields.
 */
export interface TailscalePrefsJson {
  readonly RouteAll?: boolean
  readonly CorpDNS?: boolean
  readonly RunSSH?: boolean
  readonly ShieldsUp?: boolean
  readonly AdvertiseTags?: readonly string[]
  readonly AdvertiseRoutes?: readonly string[]
  readonly ExitNodeID?: string
  readonly ExitNodeIP?: string
  readonly Hostname?: string
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
 * `onboard mode` (the addon spawns its own `tailscaled`) sets both
 * `binPath` (the downloaded `tailscale` CLI) and `socketPath` (the
 * private daemon socket). `host mode` leaves both undefined — the CLI
 * then auto-resolves the system binary and talks to the system
 * `tailscaled` on its default socket.
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

  /**
   * Prepend the `--socket=<path>` global flag when running in onboard
   * mode. tailscale global flags MUST come before the subcommand, so
   * this wraps the per-call arg array.
   */
  private withSocket(args: readonly string[]): string[] {
    return this.socketPath ? [`--socket=${this.socketPath}`, ...args] : [...args]
  }

  /** Locate the `tailscale` binary once and cache the result. */
  private async resolveBin(): Promise<string> {
    if (this.resolvedBin) return this.resolvedBin
    // Onboard mode hands us an explicit downloaded-binary path.
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
   * Read the daemon's current preferences (`tailscale debug prefs`).
   * Status JSON doesn't surface acceptRoutes / acceptDns / shieldsUp /
   * ssh / advertiseRoutes reliably; prefs does. Used by `getStatus`
   * to fill those `MeshStatus` fields.
   *
   * Returns null when the daemon isn't ready or the debug command
   * isn't available on this tailscale build (rare). Caller treats
   * null as "unknown" and surfaces sane defaults.
   */
  async prefs(): Promise<TailscalePrefsJson | null> {
    const bin = await this.resolveBin()
    try {
      const { stdout } = await execFileP(bin, this.withSocket(['debug', 'prefs']), {
        timeout: 5_000,
      })
      return JSON.parse(stdout) as TailscalePrefsJson
    } catch {
      return null
    }
  }

  /**
   * Patch the daemon's runtime preferences via `tailscale set`.
   * Unlike `up`, `set` doesn't re-trigger account auth — it just
   * updates the listed knobs. We invoke it with one flag at a time
   * so a single unsupported value (older tailscale) doesn't roll back
   * the whole patch.
   */
  async setPrefs(patch: {
    readonly advertisedRoutes?: readonly string[]
    readonly advertisedTags?: readonly string[]
    readonly acceptRoutes?: boolean
    readonly acceptDns?: boolean
    readonly shieldsUp?: boolean
    readonly ssh?: boolean
    readonly hostname?: string
    readonly exitNodeId?: string
  }): Promise<void> {
    const bin = await this.resolveBin()
    const flags: string[] = []
    if (patch.advertisedRoutes !== undefined) {
      flags.push(`--advertise-routes=${patch.advertisedRoutes.join(',')}`)
    }
    if (patch.advertisedTags !== undefined) {
      flags.push(`--advertise-tags=${patch.advertisedTags.join(',')}`)
    }
    if (patch.acceptRoutes !== undefined) flags.push(`--accept-routes=${patch.acceptRoutes}`)
    if (patch.acceptDns !== undefined) flags.push(`--accept-dns=${patch.acceptDns}`)
    if (patch.shieldsUp !== undefined) flags.push(`--shields-up=${patch.shieldsUp}`)
    if (patch.ssh !== undefined) flags.push(`--ssh=${patch.ssh}`)
    if (patch.hostname !== undefined) flags.push(`--hostname=${patch.hostname}`)
    if (patch.exitNodeId !== undefined) {
      // Empty string disables the exit-node selection.
      flags.push(patch.exitNodeId === '' ? '--exit-node=' : `--exit-node=${patch.exitNodeId}`)
    }
    if (flags.length === 0) return
    try {
      await execFileP(bin, this.withSocket(['set', ...flags]), { timeout: 30_000 })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      throw new TailscaleCliError(`tailscale set failed: ${e.message}`, e.stderr ?? '')
    }
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

  /**
   * Start an interactive `tailscale up` (no `--auth-key`) and resolve
   * with the verification URL the daemon prints to stdout/stderr.
   *
   * The returned handle keeps the child process alive — it self-exits
   * once the user authenticates in the browser, and `cancel()` kills
   * it if the operator gives up.
   *
   * Times out (and kills the child) when no URL is observed within
   * `timeoutMs` (default 5_000).
   */
  async startInteractiveLogin(
    input: { readonly hostname?: string; readonly timeoutMs?: number } = {},
  ): Promise<TailscaleLoginHandle> {
    const bin = await this.resolveBin()
    const args = ['up']
    if (input.hostname) args.push(`--hostname=${input.hostname}`)
    const timeoutMs = input.timeoutMs ?? 5_000

    const child: ChildProcessWithoutNullStreams = spawn(bin, this.withSocket(args), {
      stdio: 'pipe',
    })

    const loginUrlPattern = /https:\/\/login\.tailscale\.com\/a\/[a-z0-9]+/i

    return new Promise<TailscaleLoginHandle>((resolve, reject) => {
      let settled = false
      let stderrBuf = ''

      const cancel = (): void => {
        if (!child.killed) {
          child.kill()
        }
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cancel()
        reject(
          new TailscaleCliError(
            `tailscale up did not print a login URL within ${timeoutMs}ms`,
            stderrBuf,
          ),
        )
      }, timeoutMs)

      const onData = (chunk: Buffer): void => {
        if (settled) return
        const text = chunk.toString('utf8')
        stderrBuf += text
        const match = text.match(loginUrlPattern)
        if (match) {
          settled = true
          clearTimeout(timer)
          // Detach the listeners — let the child keep running until
          // the user finishes authenticating in the browser.
          child.stdout.off('data', onData)
          child.stderr.off('data', onData)
          resolve({ loginUrl: match[0], cancel })
        }
      }

      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new TailscaleCliError(`tailscale up failed to spawn: ${err.message}`, stderrBuf))
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Code 0 with no URL printed = silent re-login from cached
        // credentials. The daemon already had a session bound; running
        // `tailscale up` with no `--auth-key` just resumed it.
        // Resolve with an empty loginUrl so the caller knows "no URL
        // to show, poll getStatus() for joined: true".
        if (code === 0) {
          resolve({ loginUrl: '', cancel })
          return
        }
        reject(
          new TailscaleCliError(
            `tailscale up exited (code=${code ?? 'null'}) before printing a login URL`,
            stderrBuf,
          ),
        )
      })
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

  /**
   * Wipe the daemon's stored account binding. After this the
   * BackendState transitions to `NeedsLogin` and a fresh `up` (no
   * `--auth-key`) will print a new browser-redirect login URL.
   *
   * Distinct from `down()` which keeps credentials and reconnects
   * silently on next `up`. Operators use `logout` when handing off
   * the device or switching tailnets.
   */
  async logout(): Promise<void> {
    const bin = await this.resolveBin()
    try {
      await execFileP(bin, this.withSocket(['logout']), { timeout: 15_000 })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      throw new TailscaleCliError(`tailscale logout failed: ${e.message}`, e.stderr ?? '')
    }
  }

  /** `tailscale serve` — exposes a local port to peers in the same
   *  tailnet over HTTPS with auto-issued cert. Mutating call; the
   *  daemon persists the rule across restarts. */
  async serve(input: { readonly port: number; readonly enabled: boolean }): Promise<void> {
    const bin = await this.resolveBin()
    const args = input.enabled
      ? ['serve', '--bg', `http://127.0.0.1:${input.port}`]
      : ['serve', '--bg', 'off']
    this.logger.info('serve: invoking CLI', {
      meta: { bin, args, enabled: input.enabled, port: input.port },
    })
    try {
      const { stdout, stderr } = await execFileP(bin, this.withSocket(args), { timeout: 15_000 })
      this.logger.info('serve: CLI returned', {
        meta: { stdout: trimForLog(stdout), stderr: trimForLog(stderr) },
      })
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string }
      const stderr = e.stderr ?? ''
      const stdout = e.stdout ?? ''
      this.logger.error('serve: CLI failed', {
        meta: {
          bin,
          args,
          message: e.message,
          stderr: trimForLog(stderr),
          stdout: trimForLog(stdout),
        },
      })
      throw new TailscaleCliError(
        `tailscale serve failed: ${e.message}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`,
        stderr,
      )
    }
  }

  /** `tailscale funnel` — exposes a local port to the open internet
   *  via Tailscale's edge. Requires Funnel ACL grant in the tailnet
   *  policy. Same shape as `serve`. */
  async funnel(input: { readonly port: number; readonly enabled: boolean }): Promise<void> {
    const bin = await this.resolveBin()
    const args = input.enabled
      ? ['funnel', '--bg', `http://127.0.0.1:${input.port}`]
      : ['funnel', '--bg', 'off']
    this.logger.info('funnel: invoking CLI', {
      meta: { bin, args, enabled: input.enabled, port: input.port },
    })
    try {
      const { stdout, stderr } = await execFileP(bin, this.withSocket(args), { timeout: 15_000 })
      this.logger.info('funnel: CLI returned', {
        meta: { stdout: trimForLog(stdout), stderr: trimForLog(stderr) },
      })
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string }
      const stderr = e.stderr ?? ''
      const stdout = e.stdout ?? ''
      this.logger.error('funnel: CLI failed', {
        meta: {
          bin,
          args,
          message: e.message,
          stderr: trimForLog(stderr),
          stdout: trimForLog(stdout),
        },
      })
      throw new TailscaleCliError(
        `tailscale funnel failed: ${e.message}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`,
        stderr,
      )
    }
  }
}

/** Truncate long stdout/stderr blobs so the log entry stays readable. */
function trimForLog(s: string, max = 800): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…[+${trimmed.length - max} bytes]`
}
