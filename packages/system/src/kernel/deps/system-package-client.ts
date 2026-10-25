import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import type { PackageInstallRequest, PackageInstallResult } from './system-package-broker.js'

/** Default path the entrypoint binds before dropping to uid 1001. */
export const DEFAULT_PKGD_SOCKET = '/run/camstack/pkgd.sock'

export function pkgdSocketPath(): string {
  return process.env['CAMSTACK_PKGD_SOCKET'] ?? DEFAULT_PKGD_SOCKET
}

export function privilegedHelperAvailable(socketPath: string = pkgdSocketPath()): boolean {
  return existsSync(socketPath)
}

/**
 * One JSON object per line. The helper answers one request per connection.
 */
export function requestPrivilegedInstall(
  req: PackageInstallRequest,
  socketPath: string = pkgdSocketPath(),
  timeoutMs: number = 6 * 60 * 1000,
): Promise<PackageInstallResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    const chunks: Buffer[] = []
    const finish = (result: PackageInstallResult): void => {
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `privileged helper timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, ...req })}\n`)
    })
    socket.on('data', (data) => {
      chunks.push(data)
      const text = Buffer.concat(chunks).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(text.slice(0, nl)) as { ok?: boolean; error?: string }
        finish({
          ok: parsed.ok === true,
          ...(parsed.error !== undefined ? { error: parsed.error } : {}),
        })
      } catch (err) {
        finish({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: err.message })
    })
    socket.on('end', () => {
      if (chunks.length === 0) {
        clearTimeout(timer)
        finish({ ok: false, error: 'privileged helper closed without a reply' })
      }
    })
  })
}
