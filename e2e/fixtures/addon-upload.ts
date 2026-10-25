/**
 * Tarball-upload helper for E2E.
 *
 * Mirrors what `camstack deploy` does on the wire: `npm pack` a
 * package dir → POST the resulting .tgz to `/api/addons/upload` as a
 * multipart/form-data body. The CLI subprocess itself adds nothing
 * beyond auth-token caching, so the test exercises the same hub
 * codepath without depending on `camstack login` having written a
 * session file.
 *
 * Why hand-rolled multipart instead of `globalThis.FormData`: the hub
 * runs HTTPS with a self-signed dev cert. The native fetch's
 * Undici dispatcher can be made TLS-permissive but introduces a
 * second TLS code path to maintain; reusing `https.request` keeps
 * parity with the rest of `e2e/fixtures/api-client.ts`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as https from 'node:https'

const insecureAgent = new https.Agent({ rejectUnauthorized: false })

/**
 * `npm pack <pkgDir>` produces `<scope-name>-<version>.tgz` in cwd.
 * We point cwd at the package dir itself so the tarball lands next
 * to it — easy to find + clean up under one rmSync.
 */
export function packAddon(pkgDir: string): string {
  // --ignore-scripts: a fixture may pre-declare a prepack/prepublishOnly
  // hook; we don't want them firing during the test setup.
  execFileSync('npm', ['pack', '--ignore-scripts'], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tgz = readdirSync(pkgDir).find((f) => f.endsWith('.tgz'))
  if (!tgz) {
    throw new Error(`npm pack in ${pkgDir} produced no .tgz`)
  }
  return join(pkgDir, tgz)
}

export interface UploadResult {
  readonly status: number
  readonly body: string
}

/**
 * POST a .tgz to `/api/addons/upload` on the hub at `port`.
 * Caller passes the admin Bearer token. Optional `addonId` field is
 * accepted by the route but not required here — the hub derives it
 * from the package's camstack.addons[] manifest.
 */
export async function uploadTarball(
  port: number,
  token: string,
  tgzPath: string,
  options: { nodeId?: string } = {},
): Promise<UploadResult> {
  const file = readFileSync(tgzPath)
  const filename = tgzPath.split('/').pop() ?? 'addon.tgz'
  const boundary = `camstack-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const parts: Buffer[] = []
  if (options.nodeId) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="nodeId"\r\n\r\n` +
          `${options.nodeId}\r\n`,
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/gzip\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  )
  const body = Buffer.concat(parts)

  return await new Promise<UploadResult>((resolve, reject) => {
    const req = https.request(
      `https://localhost:${port}/api/addons/upload`,
      {
        method: 'POST',
        agent: insecureAgent,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.byteLength),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(60_000, () => {
      req.destroy(new Error('addon upload timed out'))
    })
    req.write(body)
    req.end()
  })
}
