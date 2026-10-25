/**
 * Pack / unpack a hub `server-root/dev-uploads/<version>/` directory for
 * agent fan-out (`POST /api/server-upload/propagate` → `$agent.stageDevUploads`).
 *
 * One gzipped tar carries every tarball + `manifest.json`. Fail-closed on
 * path traversal and on a layout that would not satisfy RootUpdateService.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tar from 'tar'
import {
  DEV_UPLOAD_MANIFEST_FILE,
  isDevChannelVersion,
  readDevUploadManifest,
} from '../server-root/index.js'

/** Version chars safe as a single path segment (matches server-upload). */
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/

export function isSafeDevUploadVersion(version: string): boolean {
  return SAFE_VERSION_RE.test(version) && isDevChannelVersion(version)
}

function hasPathTraversal(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name.includes('..')
}

/**
 * Pack every file in `versionDir` (basename entries only) into a gzipped tar.
 * Refuses if the manifest is missing/invalid or lists a missing tarball.
 */
export async function packDevUploadVersionDir(versionDir: string): Promise<Buffer> {
  const manifest = readDevUploadManifest(versionDir)
  if (manifest === null) {
    throw new Error(`dev-uploads manifest missing or invalid in ${versionDir}`)
  }
  for (const filename of Object.values(manifest.packages)) {
    if (hasPathTraversal(filename)) {
      throw new Error(`dev-uploads package filename refuses path traversal: ${filename}`)
    }
    const abs = path.join(versionDir, filename)
    if (!fs.existsSync(abs)) {
      throw new Error(`dev-uploads tarball listed in manifest is missing: ${filename}`)
    }
  }
  if (!fs.existsSync(path.join(versionDir, DEV_UPLOAD_MANIFEST_FILE))) {
    throw new Error(`dev-uploads manifest file missing in ${versionDir}`)
  }

  const entries = fs.readdirSync(versionDir).filter((name) => {
    const st = fs.statSync(path.join(versionDir, name))
    return st.isFile() && !hasPathTraversal(name)
  })
  if (entries.length === 0) {
    throw new Error(`dev-uploads version dir is empty: ${versionDir}`)
  }

  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const stream = tar.c({ gzip: true, cwd: versionDir, portable: true }, entries)
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return Buffer.concat(chunks)
}

export interface UnpackDevUploadsResult {
  readonly versionDir: string
  readonly packageCount: number
}

/**
 * Extract a packed version dir into `serverRoot/dev-uploads/<version>/`
 * atomically (stage sibling + rename). Validates version shape, entry names,
 * and that the extracted layout matches the manifest.
 */
export async function unpackDevUploadVersionBundle(args: {
  readonly serverRoot: string
  readonly version: string
  readonly bundle: Buffer
}): Promise<UnpackDevUploadsResult> {
  const { serverRoot, version, bundle } = args
  if (!isSafeDevUploadVersion(version)) {
    throw new Error(`Refused: version "${version}" is not a safe dev-channel version for staging`)
  }

  const uploadsRoot = path.join(serverRoot, 'dev-uploads')
  fs.mkdirSync(uploadsRoot, { recursive: true })
  const finalDir = path.join(uploadsRoot, version)
  const stagingDir = path.join(
    uploadsRoot,
    `.staging-${version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(stagingDir, { recursive: true })

  const tmpTgz = path.join(
    os.tmpdir(),
    `camstack-dev-uploads-${version.replace(/[^\w.-]/g, '_')}-${Date.now()}.tgz`,
  )
  try {
    fs.writeFileSync(tmpTgz, bundle)
    let refusedEntry: string | null = null
    await tar.x({
      file: tmpTgz,
      cwd: stagingDir,
      gzip: true,
      // Basename-only layout. Skipping the entry (filter false) then failing
      // after extract avoids an unhandled throw from tar's async parser.
      filter: (entryPath) => {
        const name = entryPath.replace(/^\.\//, '')
        if (hasPathTraversal(name) || path.isAbsolute(name) || name.includes('/')) {
          refusedEntry = entryPath
          return false
        }
        return true
      },
    })
    if (refusedEntry !== null) {
      throw new Error(`Refused: archive entry is not a basename: ${refusedEntry}`)
    }

    const manifest = readDevUploadManifest(stagingDir)
    if (manifest === null) {
      throw new Error('extracted archive has no valid manifest.json')
    }
    if (manifest.version !== version) {
      throw new Error(
        `extracted manifest version mismatch: expected ${version}, got ${manifest.version}`,
      )
    }
    for (const filename of Object.values(manifest.packages)) {
      if (hasPathTraversal(filename)) {
        throw new Error(`manifest package filename refuses path traversal: ${filename}`)
      }
      if (!fs.existsSync(path.join(stagingDir, filename))) {
        throw new Error(`extracted archive missing package tarball: ${filename}`)
      }
    }

    // Replace any previous incomplete/stale version dir.
    fs.rmSync(finalDir, { recursive: true, force: true })
    fs.renameSync(stagingDir, finalDir)
    return {
      versionDir: finalDir,
      packageCount: Object.keys(manifest.packages).length,
    }
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    throw err
  } finally {
    try {
      fs.unlinkSync(tmpTgz)
    } catch {
      /* best-effort */
    }
  }
}
