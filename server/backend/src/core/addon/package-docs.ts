/**
 * README and CHANGELOG for one published package, read on the hub.
 *
 * README is the npm packument `readme` (the version's own field, else the
 * packument root). CHANGELOG is `CHANGELOG.md` inside that version's tarball.
 * A registry failure is a typed `error` on the side that failed — never an
 * empty document. `missing` means the registry answered and the file was not
 * there. Successful and missing answers are cached; errors are not, so the
 * next open retries.
 */

export const PACKAGE_DOCS_TTL_MS = 10 * 60 * 1000

export interface PackageDocOk {
  readonly status: 'ok'
  readonly markdown: string
}

export interface PackageDocMissing {
  readonly status: 'missing'
}

export interface PackageDocError {
  readonly status: 'error'
  readonly message: string
}

export type PackageDocBody = PackageDocOk | PackageDocMissing | PackageDocError

export interface PackageDocs {
  readonly name: string
  readonly version: string
  readonly readme: PackageDocBody
  readonly changelog: PackageDocBody
}

export interface RegistryFetchOk {
  readonly ok: true
  readonly body: unknown
}

export interface RegistryFetchFail {
  readonly ok: false
  readonly message: string
}

export type RegistryFetch = RegistryFetchOk | RegistryFetchFail

export interface TarballFetchOk {
  readonly ok: true
  readonly bytes: Buffer
}

export interface TarballFetchFail {
  readonly ok: false
  readonly message: string
}

export type TarballFetch = TarballFetchOk | TarballFetchFail

export interface PackageDocsClient {
  fetchPackument(name: string): Promise<RegistryFetch>
  fetchTarball(url: string): Promise<TarballFetch>
  readChangelog(bytes: Buffer): Promise<string | null>
}

export interface PackageDocsReader {
  load(name: string, version?: string): Promise<PackageDocs>
}

interface CacheEntry {
  readonly docs: PackageDocs
  readonly expiresAt: number
}

interface ResolvedPackument {
  readonly status: 'ok'
  readonly version: string
  readonly readme: string
  readonly tarballUrl: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value }
  }
  return {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function docFromMarkdown(markdown: string): PackageDocBody {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return { status: 'missing' }
  return { status: 'ok', markdown }
}

function errorDocs(name: string, version: string, message: string): PackageDocs {
  const body: PackageDocError = { status: 'error', message }
  return { name, version, readme: body, changelog: body }
}

function resolvePackument(
  body: unknown,
  requested: string | undefined,
): ResolvedPackument | PackageDocError {
  const packument = asRecord(body)
  const distTags = asRecord(packument['dist-tags'])
  const versions = asRecord(packument['versions'])
  const tagged = requested === undefined ? asString(distTags['latest']) : ''
  const named = requested !== undefined && versions[requested] !== undefined ? requested : ''
  const fromTag = requested !== undefined ? asString(distTags[requested]) : ''
  const version = named || fromTag || tagged
  if (version.length === 0 || versions[version] === undefined) {
    return {
      status: 'error',
      message:
        requested === undefined
          ? 'packument has no latest version'
          : `no version resolved for ${requested}`,
    }
  }
  const meta = asRecord(versions[version])
  const dist = asRecord(meta['dist'])
  const versionReadme = asString(meta['readme'])
  const rootReadme = asString(packument['readme'])
  const tarball = asString(dist['tarball'])
  return {
    status: 'ok',
    version,
    readme: versionReadme.length > 0 ? versionReadme : rootReadme,
    tarballUrl: tarball.length > 0 ? tarball : null,
  }
}

function cacheable(docs: PackageDocs): boolean {
  return docs.readme.status !== 'error' && docs.changelog.status !== 'error'
}

export function createPackageDocsReader(options: {
  readonly client: PackageDocsClient
  readonly now?: () => number
  readonly ttlMs?: number
}): PackageDocsReader {
  const cache = new Map<string, CacheEntry>()
  const now = options.now ?? ((): number => Date.now())
  const ttlMs = options.ttlMs ?? PACKAGE_DOCS_TTL_MS

  async function load(name: string, requested?: string): Promise<PackageDocs> {
    const directKey = requested !== undefined ? `${name}@${requested}` : `${name}@`
    const hit = cache.get(directKey)
    if (hit !== undefined && hit.expiresAt > now()) return hit.docs

    const packument = await options.client.fetchPackument(name)
    if (!packument.ok) return errorDocs(name, requested ?? '', packument.message)

    const resolved = resolvePackument(packument.body, requested)
    if (resolved.status === 'error') return errorDocs(name, requested ?? '', resolved.message)

    const key = `${name}@${resolved.version}`
    const resolvedHit = cache.get(key)
    if (resolvedHit !== undefined && resolvedHit.expiresAt > now()) return resolvedHit.docs

    const readme = docFromMarkdown(resolved.readme)
    const changelog = await loadChangelog(
      name,
      resolved.version,
      resolved.tarballUrl,
      options.client,
    )
    const docs: PackageDocs = { name, version: resolved.version, readme, changelog }
    if (cacheable(docs)) {
      const entry: CacheEntry = { docs, expiresAt: now() + ttlMs }
      cache.set(key, entry)
      cache.set(directKey, entry)
    }
    return docs
  }

  return { load }
}

async function loadChangelog(
  name: string,
  version: string,
  tarballUrl: string | null,
  client: PackageDocsClient,
): Promise<PackageDocBody> {
  if (tarballUrl === null) {
    return { status: 'error', message: `no tarball url for ${name}@${version}` }
  }
  const tarball = await client.fetchTarball(tarballUrl)
  if (!tarball.ok) return { status: 'error', message: tarball.message }
  try {
    const text = await client.readChangelog(tarball.bytes)
    if (text === null) return { status: 'missing' }
    return docFromMarkdown(text)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'changelog read failed'
    return { status: 'error', message }
  }
}
