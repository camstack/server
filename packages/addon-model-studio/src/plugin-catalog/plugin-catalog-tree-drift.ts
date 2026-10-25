/**
 * Read-only drift check: compare the local plugin catalog YOLO manifest to a
 * Hugging Face tree. Never mutates the manifest and never auto-imports
 * remote-only files.
 */
import {
  PLUGIN_CATALOG_HF_HOST,
  PLUGIN_CATALOG_HF_REPO,
  type PluginCatalogManifestEntry,
} from './plugin-catalog-yolo-manifest.js'

export const PLUGIN_CATALOG_KNOWN_DRIFT_STATUSES = [
  'ok',
  'missing',
  'size-changed',
  'unavailable',
] as const

export type PluginCatalogCatalogDriftStatus = (typeof PLUGIN_CATALOG_KNOWN_DRIFT_STATUSES)[number]

export type PluginCatalogCatalogDrift = Readonly<{
  manifestId: string
  status: PluginCatalogCatalogDriftStatus
  details?: string
}>

/** Fail-closed: a future/unknown status is never treated as `ok`. */
export function normalizePluginCatalogDrift(row: {
  readonly manifestId: string
  readonly status: string
  readonly details?: string
}): PluginCatalogCatalogDrift {
  if ((PLUGIN_CATALOG_KNOWN_DRIFT_STATUSES as readonly string[]).includes(row.status)) {
    return {
      manifestId: row.manifestId,
      status: row.status as PluginCatalogCatalogDriftStatus,
      ...(row.details !== undefined ? { details: row.details } : {}),
    }
  }
  return {
    manifestId: row.manifestId,
    status: 'unavailable',
    details: row.details ?? `unknown drift status: ${row.status}`,
  }
}

export type PluginCatalogHfTreeFile = Readonly<{
  path: string
  size: number
  lfs?: Readonly<{ oid?: string; size?: number; pointerSize?: number }>
}>

const EXCLUDED_RE =
  /(?:^|\/)ncnn(?:\/|$)|(?:^|\/)(?:clip|craft)(?:\/|$)|(?:^|\/|_)(?:face|seg|vgg)(?:\/|_|\.|$)/i

export function isExcludedPluginCatalogPath(relativePath: string): boolean {
  return EXCLUDED_RE.test(relativePath)
}

function remoteSize(file: PluginCatalogHfTreeFile): number {
  return file.lfs?.size ?? file.size
}

export function comparePluginCatalogManifestDrift(
  manifest: readonly PluginCatalogManifestEntry[],
  tree: readonly PluginCatalogHfTreeFile[],
): readonly PluginCatalogCatalogDrift[] {
  const byPath = new Map(tree.map((file) => [file.path, file]))
  return manifest.map((entry) => {
    const missing: string[] = []
    const changed: string[] = []
    for (const file of entry.files) {
      const remote = byPath.get(file.relativePath)
      if (!remote) {
        missing.push(file.relativePath)
        continue
      }
      if (remoteSize(remote) !== file.size) {
        changed.push(`${file.relativePath} declared ${file.size} remote ${remoteSize(remote)}`)
      }
    }
    if (missing.length > 0) {
      return {
        manifestId: entry.id,
        status: 'missing',
        details: `missing: ${missing.join(', ')}`,
      }
    }
    if (changed.length > 0) {
      return {
        manifestId: entry.id,
        status: 'size-changed',
        details: `size-changed: ${changed.join(', ')}`,
      }
    }
    return { manifestId: entry.id, status: 'ok' }
  })
}

export class PluginCatalogTreeLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginCatalogTreeLinkError'
  }
}

function assertPluginCatalogTreePageUrl(url: URL, revision: string): void {
  if (url.protocol !== 'https:') {
    throw new PluginCatalogTreeLinkError(`Refusing non-https tree link: ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new PluginCatalogTreeLinkError('Refusing tree link with userinfo')
  }
  if (url.origin !== `${PLUGIN_CATALOG_HF_HOST}`) {
    throw new PluginCatalogTreeLinkError(`Refusing tree link origin ${url.origin}`)
  }
  const expectedPath = `/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${revision}`
  if (url.pathname !== expectedPath) {
    throw new PluginCatalogTreeLinkError(
      `Refusing tree link path/revision ${url.pathname} (expected ${expectedPath})`,
    )
  }
}

/**
 * Parse `Link: <...>; rel="next"` and accept only an HTTPS huggingface.co
 * tree URL for the same repo + revision. Relative hrefs resolve against the
 * current page URL. Never returns a URL that failed validation.
 */
export function resolvePluginCatalogTreeNextLink(
  header: string,
  currentUrl: string,
  revision: string,
): string | undefined {
  if (!header) return undefined
  const match = /<([^>]+)>;\s*rel="next"/.exec(header)
  if (!match?.[1]) return undefined
  let resolved: URL
  try {
    resolved = new URL(match[1], currentUrl)
  } catch {
    throw new PluginCatalogTreeLinkError(`Refusing unparsable tree next link: ${match[1]}`)
  }
  assertPluginCatalogTreePageUrl(resolved, revision)
  return resolved.href
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchPluginCatalogRemoteTree(opts: {
  fetchImpl: typeof fetch
  revision?: string
  retryDelayMs?: number
  maxRetries?: number
}): Promise<readonly PluginCatalogHfTreeFile[]> {
  const revision = opts.revision ?? 'main'
  const maxRetries = opts.maxRetries ?? 4
  const retryDelayMs = opts.retryDelayMs ?? 200
  let lastError: Error = new Error('plugin catalog Hugging Face tree unavailable')
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const files: PluginCatalogHfTreeFile[] = []
      let url: string | undefined =
        `${PLUGIN_CATALOG_HF_HOST}/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`
      let pages = 0
      while (url) {
        pages += 1
        if (pages > 50)
          throw new Error('plugin catalog Hugging Face tree pagination exceeded the bound')
        assertPluginCatalogTreePageUrl(new URL(url), revision)
        const response = await opts.fetchImpl(url, {
          redirect: 'manual',
          headers: { 'User-Agent': 'CamStack/1.0' },
        })
        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308
        ) {
          throw new PluginCatalogTreeLinkError(
            `Refusing tree API redirect ${response.status} (fail-closed, no follow)`,
          )
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching plugin catalog Hugging Face tree`)
        }
        const payload = (await response.json()) as ReadonlyArray<{
          readonly type?: string
          readonly path?: string
          readonly size?: number
          readonly lfs?: {
            readonly oid?: string
            readonly size?: number
            readonly pointerSize?: number
          }
        }>
        for (const entry of payload) {
          if (entry.type !== 'file' || !entry.path) continue
          files.push({
            path: entry.path,
            size: entry.size ?? entry.lfs?.size ?? 0,
            ...(entry.lfs !== undefined ? { lfs: entry.lfs } : {}),
          })
        }
        url = resolvePluginCatalogTreeNextLink(response.headers.get('link') ?? '', url, revision)
      }
      return files
    } catch (err) {
      if (err instanceof PluginCatalogTreeLinkError) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      await sleep(Math.min(retryDelayMs * 2 ** attempt, 3_000))
    }
  }
  throw new Error(`plugin catalog Hugging Face tree unavailable: ${lastError.message}`)
}
