/**
 * Read one file out of an npm tarball without unpacking the rest.
 *
 * npm packs the package under a `package/` prefix. A changelog the registry
 * page shows is `package/CHANGELOG.md` (or the same name at the archive root).
 * Nested copies (`package/docs/CHANGELOG.md`) are not the package changelog.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

const TAR_TIMEOUT_MS = 30_000
const TAR_MAX_BUFFER = 2_000_000

/** True for `CHANGELOG.md` or `package/CHANGELOG.md`, any letter case. */
export function isPackedChangelogPath(entry: string): boolean {
  const parts = entry.split('/').filter((part) => part.length > 0)
  if (parts.length !== 1 && parts.length !== 2) return false
  const base = parts[parts.length - 1] ?? ''
  return base.toLowerCase() === 'changelog.md'
}

/**
 * Returns the changelog text, or `null` when the archive has no
 * `CHANGELOG.md`. Throws when `tar` itself fails.
 */
export async function readPackedChangelog(tgz: Buffer): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `camstack-docs-${randomUUID()}.tgz`)
  fs.writeFileSync(tmpFile, tgz)
  try {
    const listed = await execFileAsync('tar', ['-tzf', tmpFile], {
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: TAR_MAX_BUFFER,
      encoding: 'utf8',
    })
    const entry = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => isPackedChangelogPath(line))
    if (entry === undefined) return null
    const extracted = await execFileAsync('tar', ['-xOzf', tmpFile, entry], {
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: TAR_MAX_BUFFER,
      encoding: 'utf8',
    })
    return extracted.stdout
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}
