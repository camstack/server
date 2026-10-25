/**
 * TailscaledDaemon — manages an addon-owned `tailscaled` process.
 *
 * "Onboard" client mode: instead of piggy-backing on a system
 * `tailscaled`, the addon downloads the static Tailscale bundle
 * (`tailscale` + `tailscaled`) and runs its own daemon in userspace-
 * networking mode. Userspace mode needs no TUN device and no root —
 * it's the same mode Tailscale's own containers use — so it's safe
 * to spawn from an addon process.
 *
 * The daemon gets a PRIVATE socket + state dir under the addon's
 * dataDir, fully isolated from any system Tailscale. The companion
 * `tailscale` CLI is pointed at that socket via `--socket=<path>`
 * (see TailscaleCli `socketPath` option).
 *
 * Lifecycle: `start()` downloads (once) + spawns; `stop()` kills the
 * child. The addon calls these from onInitialize / onShutdown when
 * `clientMode === 'onboard'`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IAddonDepsManager, IScopedLogger } from '@camstack/types'

/**
 * Tailscale static-build version to download for onboard mode.
 * Pinned so a fleet stays reproducible; bump deliberately. Must be a
 * real published release — verify at
 * `pkgs.tailscale.com/stable/?mode=json`.
 * The matching tarball lives at
 * `https://pkgs.tailscale.com/stable/tailscale_<version>_<arch>.tgz`
 * (NOTE: no OS component — Tailscale ships static tarballs for Linux
 * only, so the filename carries just version + arch).
 */
export const ONBOARD_TAILSCALE_VERSION = '1.96.4'

/** Tailscale's Linux static-build arch names (`process.arch` mapped). */
type LinuxArch = 'amd64' | 'arm64' | 'arm' | '386'

/**
 * Resolve the Tailscale static-build arch for the current host.
 *
 * Onboard mode is **Linux-only**: Tailscale publishes the standalone
 * `tailscaled` tarball solely for Linux — `pkgs.tailscale.com/stable/`
 * lists arch-only filenames, no darwin/windows builds. macOS and
 * Windows ship the GUI app, which embeds its own daemon and exposes
 * no downloadable static binary. On those platforms the operator must
 * install Tailscale and use `clientMode: 'host'`.
 */
function resolveArch(): LinuxArch {
  if (process.platform !== 'linux') {
    throw new Error(
      `onboard Tailscale: clientMode 'onboard' is supported only on Linux. ` +
        `Tailscale publishes static tailscaled binaries solely for Linux; ` +
        `on '${process.platform}' install the Tailscale app and switch ` +
        `clientMode to 'host'.`,
    )
  }
  switch (process.arch) {
    case 'x64':
      return 'amd64'
    case 'arm64':
      return 'arm64'
    case 'arm':
      return 'arm'
    case 'ia32':
      return '386'
    default:
      throw new Error(
        `onboard Tailscale: unsupported Linux arch '${process.arch}' — ` +
          `no Tailscale static build available. Use clientMode: 'host'.`,
      )
  }
}

export interface TailscaledHandle {
  /** Path to the downloaded `tailscale` CLI binary. */
  readonly cliPath: string
  /** Unix socket the daemon listens on — pass to TailscaleCli. */
  readonly socketPath: string
}

export class TailscaledDaemon {
  private child: ChildProcess | null = null
  private handle: TailscaledHandle | null = null

  constructor(
    private readonly deps: IAddonDepsManager,
    private readonly dataDir: string,
    private readonly logger: IScopedLogger,
  ) {}

  /** True once `start()` has spawned a live daemon. */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /**
   * Download the static bundle (once, cached by ctx.deps) + spawn
   * `tailscaled` in userspace-networking mode. Idempotent — returns
   * the existing handle if already started.
   */
  async start(): Promise<TailscaledHandle> {
    if (this.handle && this.isRunning()) return this.handle

    const arch = resolveArch()
    const version = ONBOARD_TAILSCALE_VERSION
    const innerDir = `tailscale_${version}_${arch}`
    const tarball = `${innerDir}.tgz`
    const downloadUrl = `https://pkgs.tailscale.com/stable/${tarball}`

    this.logger.info('onboard: ensuring tailscaled binary', {
      meta: { version, arch, downloadUrl },
    })

    // ctx.deps.ensureBinary checks local cache → PATH → downloads. We
    // ask for both binaries from the same archive; the deps manager
    // caches the download so the second call is a no-op extract.
    const daemonPath = await this.deps.ensureBinary({
      name: 'tailscaled',
      downloadUrl,
      isArchive: true,
      archiveFormat: 'tar.gz',
      archiveInnerPath: `${innerDir}/tailscaled`,
    })
    const cliPath = await this.deps.ensureBinary({
      name: 'tailscale',
      downloadUrl,
      isArchive: true,
      archiveFormat: 'tar.gz',
      archiveInnerPath: `${innerDir}/tailscale`,
    })

    const runtimeDir = path.join(this.dataDir, 'tailscaled')
    const stateDir = path.join(runtimeDir, 'state')
    const socketPath = path.join(runtimeDir, 'tailscaled.sock')
    fs.mkdirSync(stateDir, { recursive: true })

    // Userspace networking: no TUN, no root. --port=0 lets the OS pick
    // the WireGuard UDP port. --socket overrides the default
    // /var/run path so we never collide with a system tailscaled.
    const args = [
      '--tun=userspace-networking',
      `--socket=${socketPath}`,
      `--statedir=${stateDir}`,
      '--port=0',
      '--verbose=1',
    ]
    this.logger.info('onboard: spawning tailscaled', { meta: { daemonPath, args } })

    const child = spawn(daemonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    child.stdout?.on('data', (b: Buffer) => {
      this.logger.debug('tailscaled stdout', { meta: { line: b.toString('utf-8').trim() } })
    })
    child.stderr?.on('data', (b: Buffer) => {
      this.logger.debug('tailscaled stderr', { meta: { line: b.toString('utf-8').trim() } })
    })
    child.on('exit', (code, signal) => {
      this.logger.warn('onboard: tailscaled exited', { meta: { code, signal } })
      this.child = null
    })

    // Wait for the socket file to appear — the daemon creates it once
    // its local API is up. Bounded poll so a broken binary fails fast.
    await this.waitForSocket(socketPath, 15_000)

    this.handle = { cliPath, socketPath }
    this.logger.info('onboard: tailscaled ready', { meta: { socketPath } })
    return this.handle
  }

  /** Kill the daemon. Idempotent. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    this.child = null
    this.handle = null
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    this.logger.info('onboard: tailscaled stopped')
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(socketPath)) return
      if (!this.isRunning()) {
        throw new Error(
          'onboard: tailscaled exited before its socket appeared — check the daemon logs',
        )
      }
      await new Promise((res) => setTimeout(res, 250))
    }
    throw new Error(
      `onboard: tailscaled socket did not appear within ${timeoutMs}ms at ${socketPath}`,
    )
  }
}
