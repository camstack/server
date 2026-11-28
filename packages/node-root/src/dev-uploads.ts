/**
 * Dev server-deploy channel — layout + manifest for locally-uploaded root
 * package closures (ZERO-DEP: node:fs/node:path only, same constraint as
 * root-state.ts — the baked starter bundles this module).
 *
 * `dominevo deploy-server` packs every workspace package in the server's
 * `@dominevo/*` closure at one uniform dev version
 * (`<base>-dev.<epochSeconds>`) and uploads the tarballs to
 * `POST /api/server-upload`. The hub stores them under:
 *
 *   <dataDir>/server-root/dev-uploads/<version>/
 *     <flattened-pkg-name>.tgz        one per uploaded package
 *     manifest.json                   { version, packages: { name → filename } }
 *
 * `RootUpdateService.stageAndActivate` detects the dir and stages from these
 * tarballs (synthetic package.json with `file:` refs + `overrides`) instead
 * of the npm registry. Everything downstream — probation boot, promote,
 * rollback — is version-string driven and unchanged; the `-dev.` suffix is
 * self-describing.
 *
 * Spec: docs/superpowers/specs — dev server-deploy channel (2026-07-13).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEV_UPLOADS_DIRNAME = 'dev-uploads'
export const DEV_UPLOAD_MANIFEST_FILE = 'manifest.json'

/** Number of dev-uploads entries retained by the promote-time sweep. */
export const DEV_UPLOADS_KEEP_COUNT = 3

/**
 * Dev-channel version shape: `<semver-base>-dev.<epochSeconds>`. The suffix
 * is sortable, self-describing, and can never collide with a published
 * registry version. The upload route and the staging branch BOTH gate on it.
 */
const DEV_CHANNEL_VERSION_RE = /-dev\.\d+$/

export function isDevChannelVersion(version: string): boolean {
  return DEV_CHANNEL_VERSION_RE.test(version)
}

/**
 * The `<epochSeconds>` ordering key of a dev-channel version (or dir name).
 * Returns null for anything that is not dev-channel shaped — the sweep
 * treats those as oldest so malformed residue is collected first.
 */
export function devChannelEpoch(version: string): number | null {
  const match = /-dev\.(\d+)$/.exec(version)
  if (match === null) return null
  const epoch = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(epoch) ? null : epoch
}

/** `<dataDir>/server-root/dev-uploads` */
export function devUploadsDir(rootDir: string): string {
  return path.join(rootDir, DEV_UPLOADS_DIRNAME)
}

/** `<dataDir>/server-root/dev-uploads/<version>` */
export function devUploadVersionDir(rootDir: string, version: string): string {
  return path.join(devUploadsDir(rootDir), version)
}

// ---------------------------------------------------------------------------
// Manifest IO
// ---------------------------------------------------------------------------

/**
 * Written by the hub's `/api/server-upload` route after validating every
 * tarball; read by the staging branch. Maps each uploaded package NAME to
 * its tgz FILENAME inside the version dir — staging never has to re-derive
 * package names from flattened filenames.
 */
export interface DevUploadManifest {
  readonly version: string
  readonly packages: Readonly<Record<string, string>>
  /**
   * Epoch milliseconds at which the CLI built the closure (taken once per
   * deploy, before packing). The install passes `--before` from it so nothing
   * published to npm after the build can enter the tree (#681). Absent on a
   * manifest written by an older CLI. Zero-dep module: a plain optional field,
   * checked by hand like the rest of the manifest.
   */
  readonly buildTimeMs?: number
}

export function devUploadManifestPath(versionDirPath: string): string {
  return path.join(versionDirPath, DEV_UPLOAD_MANIFEST_FILE)
}

function isDevUploadManifest(v: unknown): v is DevUploadManifest {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  if (typeof m['version'] !== 'string') return false
  const packages = m['packages']
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) return false
  if (!Object.values(packages).every((filename) => typeof filename === 'string')) return false
  const buildTimeMs = m['buildTimeMs']
  return (
    buildTimeMs === undefined || (typeof buildTimeMs === 'number' && Number.isFinite(buildTimeMs))
  )
}

/** Read + validate the manifest. Returns null when missing/corrupt. */
export function readDevUploadManifest(versionDirPath: string): DevUploadManifest | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(devUploadManifestPath(versionDirPath), 'utf-8'))
    return isDevUploadManifest(raw) ? raw : null
  } catch {
    return null
  }
}

/** Write the manifest atomically (tmp sibling + rename). Creates the dir. */
export function writeDevUploadManifest(versionDirPath: string, manifest: DevUploadManifest): void {
  fs.mkdirSync(versionDirPath, { recursive: true })
  const target = devUploadManifestPath(versionDirPath)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/** Margin added to the build time so a registry mirror's clock skew cannot hide a pin made at build. */
export const DEV_UPLOAD_BEFORE_MARGIN_MS = 5 * 60_000

/** The `--before` npm argument for a manifest, or null when it records no build time (older CLI). */
export function devUploadBeforeArg(manifest: DevUploadManifest): string | null {
  if (manifest.buildTimeMs === undefined) return null
  return `--before=${new Date(manifest.buildTimeMs + DEV_UPLOAD_BEFORE_MARGIN_MS).toISOString()}`
}
