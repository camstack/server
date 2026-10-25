/**
 * POST /api/server-upload — the dev server-deploy channel's upload gateway.
 *
 * `camstack deploy-server` packs the whole `@camstack/server` workspace
 * closure at one uniform dev version (`<base>-dev.<epochSeconds>`) and
 * uploads every tarball here in ONE multipart request (plus a `version`
 * field). The route validates fail-closed and stores the set under
 * `<dataDir>/server-root/dev-uploads/<version>/` together with a
 * `manifest.json` (package name → tgz filename) — which
 * `RootUpdateService.stageAndActivate` later consumes to stage from the
 * tarballs instead of the npm registry.
 *
 * Guards (all fail-closed, nothing is written until EVERY check passes):
 *   - same admin/upload-scope auth chain as `/api/addons/upload`
 *     (`authorizeUploadRequest`),
 *   - the version MUST be dev-channel shaped (`-dev.<epoch>` suffix) — this
 *     route serves ONLY the dev channel,
 *   - no path traversal in the version or any filename,
 *   - every tarball must carry `package/package.json` with an
 *     `@camstack/*` name and a version equal to the declared dev version.
 *
 * REGISTRATION ORDER: `@fastify/multipart` must already be registered on
 * the instance (done by `registerAddonUploadRoute`) — this route only adds
 * the handler.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  devUploadVersionDir,
  isDevChannelVersion,
  serverRootDir,
  writeDevUploadManifest,
} from '../server-root/index.js'
import { isTarballFilename, readTarballManifest } from './tarball-manifest.js'
import {
  authorizeUploadRequest,
  type UploadAuthAddonRegistry,
  type UploadAuthTokenVerifier,
} from './upload-auth.js'

/** Minimal structural logger — satisfied by `IScopedLogger`. */
export interface ServerUploadLogger {
  debug(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  error(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

export interface ServerUploadRouteOptions {
  readonly authService: UploadAuthTokenVerifier
  readonly addonRegistry: UploadAuthAddonRegistry
  readonly logger: ServerUploadLogger
  /** Test override — defaults to `$CAMSTACK_DATA` (or `camstack-data`). */
  readonly dataDir?: string
}

/**
 * Version chars beyond the dev-channel shape check: strictly semver-ish
 * (alnum, dots, dashes) so the version can never traverse out of
 * `dev-uploads/` when used as a directory name.
 */
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/

export interface UploadedTarball {
  readonly filename: string
  readonly buffer: Buffer
}

export interface ValidatedPackage {
  readonly name: string
  readonly buffer: Buffer
}

export interface ValidationFailure {
  readonly error: string
}

function isValidationFailure(
  value: readonly ValidatedPackage[] | ValidationFailure,
): value is ValidationFailure {
  return 'error' in value
}

function hasPathTraversal(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name.includes('..')
}

/** `@camstack/server` → `camstack-server.tgz` — server-derived, never client-named. */
function flattenedTgzName(packageName: string): string {
  return `${packageName.replace(/^@/, '').replace(/\//g, '-')}.tgz`
}

/**
 * Validate the whole tarball set against the declared dev version.
 * Fail-closed: the FIRST failure rejects the entire upload — nothing is
 * written unless every tarball passes.
 *
 * The path-traversal guard is defense-in-depth: `@fastify/multipart`
 * already normalises filenames to their basename, and the stored tgz name
 * is derived server-side from the validated PACKAGE name — a client
 * filename never becomes a filesystem path.
 */
export function validateTarballSet(
  files: readonly UploadedTarball[],
  version: string,
): readonly ValidatedPackage[] | ValidationFailure {
  const seen = new Set<string>()
  const validated: ValidatedPackage[] = []
  for (const file of files) {
    if (hasPathTraversal(file.filename)) {
      return { error: `Refused: filename contains path separators (${file.filename})` }
    }
    if (!isTarballFilename(file.filename)) {
      return { error: `Refused: ${file.filename} is not a .tgz/.tar.gz archive` }
    }
    const manifest = readTarballManifest(file.buffer, file.filename)
    if (manifest === null) {
      return {
        error: `Refused: ${file.filename} is missing or has a malformed package/package.json`,
      }
    }
    if (!manifest.name.startsWith('@camstack/')) {
      return {
        error: `Refused: ${file.filename} declares non-@camstack package "${manifest.name}"`,
      }
    }
    if (manifest.version !== version) {
      return {
        error:
          `Refused: ${file.filename} (${manifest.name}) declares version ` +
          `${manifest.version}, expected the uploaded dev version ${version}`,
      }
    }
    if (seen.has(manifest.name)) {
      return { error: `Refused: duplicate package in upload set (${manifest.name})` }
    }
    seen.add(manifest.name)
    validated.push({ name: manifest.name, buffer: file.buffer })
  }
  return validated
}

export function registerServerUploadRoute(
  fastify: FastifyInstance,
  options: ServerUploadRouteOptions,
): void {
  const { authService, addonRegistry, logger } = options

  fastify.post('/api/server-upload', async (request, reply) => {
    const auth = await authorizeUploadRequest({
      authHeader: request.headers.authorization,
      authService,
      addonRegistry,
    })
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error })
    }

    // Drain the multipart stream first (files can precede or follow the
    // version field), then validate the whole set before touching disk.
    let version: string | null = null
    const files: UploadedTarball[] = []
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        files.push({ filename: part.filename, buffer: await part.toBuffer() })
      } else if (part.fieldname === 'version' && typeof part.value === 'string') {
        version = part.value
      }
    }

    if (version === null || version.length === 0) {
      return reply.status(400).send({ error: 'Missing "version" field' })
    }
    if (!SAFE_VERSION_RE.test(version) || !isDevChannelVersion(version)) {
      return reply.status(400).send({
        error:
          `Refused: version "${version}" is not dev-channel shaped — this route only ` +
          'accepts `<base>-dev.<epochSeconds>` versions produced by `camstack deploy-server`.',
      })
    }
    if (files.length === 0) {
      return reply.status(400).send({ error: 'No tarballs uploaded' })
    }

    const validated = validateTarballSet(files, version)
    if (isValidationFailure(validated)) {
      logger.warn('server-upload rejected', { meta: { version, error: validated.error } })
      return reply.status(400).send({ error: validated.error })
    }

    const dataDir = path.resolve(options.dataDir ?? process.env['CAMSTACK_DATA'] ?? 'camstack-data')
    const versionDir = devUploadVersionDir(serverRootDir(dataDir), version)
    fs.mkdirSync(versionDir, { recursive: true })
    const packages: Record<string, string> = {}
    for (const pkg of validated) {
      const tgzName = flattenedTgzName(pkg.name)
      fs.writeFileSync(path.join(versionDir, tgzName), pkg.buffer)
      packages[pkg.name] = tgzName
    }
    writeDevUploadManifest(versionDir, { version, packages })

    logger.info('server-upload stored dev closure', {
      meta: { version, packages: Object.keys(packages), dir: versionDir },
    })
    return reply.send({
      success: true,
      version,
      packages: Object.keys(packages),
    })
  })
}
