/**
 * npm-pack tarball manifest inspection — shared by the addon upload route
 * (`/api/addons/upload`) and the dev server-deploy upload route
 * (`/api/server-upload`).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface TarballManifest {
  readonly name: string
  readonly version: string
}

const TARBALL_EXTENSIONS = ['.tgz', '.tar.gz']

export function isTarballFilename(filename: string): boolean {
  return TARBALL_EXTENSIONS.some((ext) => filename.endsWith(ext))
}

/**
 * Validate an uploaded tarball by extracting its `package.json` and
 * checking it declares `name` + `version`. Runs BEFORE any install branch
 * so broken archives are rejected at the gateway instead of failing
 * mid-extraction downstream (which has no clean rollback).
 *
 * The routine writes the buffer to a scratch path and invokes `tar` with
 * `-xzO` to stream-extract just `package/package.json` to stdout. No full
 * unpack is needed — npm-pack layout always puts the manifest at that
 * fixed inner path. Returns null (not throw) on malformed archives so
 * the caller can surface a precise 400 response.
 */
export function readTarballManifest(buffer: Buffer, filename: string): TarballManifest | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tarball-check-'))
  const tgzPath = path.join(tmpDir, path.basename(filename))
  try {
    fs.writeFileSync(tgzPath, buffer)
    const output = execFileSync('tar', ['-xzO', '-f', tgzPath, 'package/package.json'], {
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed: unknown = JSON.parse(output.toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const pkg = parsed as Record<string, unknown>
    if (typeof pkg['name'] !== 'string' || typeof pkg['version'] !== 'string') return null
    return { name: pkg['name'], version: pkg['version'] }
  } catch {
    return null
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
