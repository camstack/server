import type {
  ModelCatalogEntry,
  ModelDownloadOptions,
  ModelDownloadResult,
  ModelFormat,
  ModelFormatEntry,
} from '@camstack/types'
import { HF_REPO, MODEL_FORMATS, hfModelUrl } from '@camstack/types/addon'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { HOSTED_MODEL_REVISIONS } from './hosted-model-revisions.js'

export function isNonEmptyFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0
}

/**
 * Sibling files of a single-file (non-directory) format — extra files the
 * format needs, fetched from the same remote directory as `url` and stored
 * flat alongside the main file in `modelsDir`. Catalog-declared via
 * `formatEntry.files`, e.g. OpenVINO IR lists its `.bin` weights next to the
 * `.xml`. The downloader stays format-agnostic; the convention lives in the
 * catalog data (like `MLPACKAGE_FILES` for the directory case).
 */
export function siblingFilesFor(formatEntry: ModelFormatEntry): readonly string[] {
  return formatEntry.isDirectory ? [] : (formatEntry.files ?? [])
}

/** Resolve a sibling's remote URL relative to the main file's directory. */
export function siblingUrl(mainUrl: string, sibling: string): string {
  return mainUrl.replace(/[^/]+$/, sibling)
}

/**
 * The relative filenames a model format occupies under `modelsDir` — the main
 * file (URL basename, or `${id}.${format}` fallback), its declared siblings
 * (e.g. the OpenVINO `.bin` next to the `.xml`), and any `extraFiles`. For a
 * directory bundle the single entry is the bundle dir itself (tar/extract
 * recurse into it).
 *
 * Used by model distribution (P2): the hub tars exactly these names from its
 * `modelsDir` and the agent untars them into its own `modelsDir`, so both ends
 * agree on the on-disk layout without re-deriving it.
 */
export function collectModelFiles(entry: ModelCatalogEntry, format: ModelFormat): string[] {
  const formatEntry = entry.formats[format]
  if (!formatEntry) return []
  const main = formatEntry.url.split('/').pop() ?? `${entry.id}.${format}`
  const names = [main, ...siblingFilesFor(formatEntry)]
  for (const extra of entry.extraFiles ?? []) names.push(extra.filename)
  return names
}

/**
 * Fetch headers for a model download. No credential: the CamStack model repos
 * are public, and no secret is ever read from the environment (operator rule —
 * a token, if a gated source ever needs one, is a keychain-backed setting).
 */
function buildHeaders(_url: string): Record<string, string> {
  return { 'User-Agent': 'CamStack/1.0' }
}

export type DownloadRedirectPolicy = (url: URL, hop: number) => void

/**
 * A download that the server ANSWERED with a non-2xx status. Typed so a caller
 * can tell "the file is not there" (404/410 — nothing a retry changes) from
 * "the server was unreachable" by the STATUS, never by matching the message:
 * the embedding encoder's requirements gate (D649) sends the first to a
 * terminal state after a bounded number of attempts and only cools down on
 * the second.
 */
export class ModelDownloadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    verb: 'downloading' | 'fetching',
  ) {
    super(`HTTP ${String(status)} ${verb} ${url}`)
    this.name = 'ModelDownloadHttpError'
  }
}

/** True when `err` is a {@link ModelDownloadHttpError} — same process only. */
export function isModelDownloadHttpError(err: unknown): err is ModelDownloadHttpError {
  return err instanceof ModelDownloadHttpError
}

export interface DownloadFileOptions {
  readonly onProgress?: (downloaded: number, total: number) => void
  /**
   * When set, redirects are followed manually and THIS policy is applied to
   * the initial URL and every Location hop before the next fetch. Absent ⇒
   * native `redirect: 'follow'` (backward compatible).
   */
  readonly redirectPolicy?: DownloadRedirectPolicy
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_MAX_REDIRECTS = 5

function normalizeDownloadOptions(
  third?: ((downloaded: number, total: number) => void) | DownloadFileOptions,
): DownloadFileOptions {
  if (typeof third === 'function') return { onProgress: third }
  return third ?? {}
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function resolveRedirectUrl(current: string, location: string): URL {
  return new URL(location, current)
}

/**
 * Download a single file from a URL to a destination path.
 * Streams to disk with optional progress callback.
 * Returns the destination path. Skips download if file already exists.
 *
 * The third argument remains a progress callback for existing callers. Pass
 * an options object to supply a per-hop redirect policy, timeout, or byte cap.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string>
export async function downloadFile(
  url: string,
  destPath: string,
  options: DownloadFileOptions,
): Promise<string>
export async function downloadFile(
  url: string,
  destPath: string,
  onProgressOrOptions?: ((downloaded: number, total: number) => void) | DownloadFileOptions,
): Promise<string> {
  if (fs.existsSync(destPath)) return destPath

  const opts = normalizeDownloadOptions(onProgressOrOptions)
  const fetchImpl = opts.fetchImpl ?? fetch
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  fs.mkdirSync(path.dirname(destPath), { recursive: true })

  // Atomic download: write to .downloading tmp, rename on success
  const tmpPath = destPath + '.downloading'

  try {
    let current = url
    const seen = new Set<string>()
    let response: Response | undefined
    const manual = opts.redirectPolicy !== undefined

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(current)
      if (opts.redirectPolicy) {
        opts.redirectPolicy(parsed, hop)
      }
      if (seen.has(parsed.href)) {
        throw new Error(`Redirect loop detected at ${parsed.href}`)
      }
      seen.add(parsed.href)

      const controller = opts.timeoutMs !== undefined ? new AbortController() : undefined
      const timer =
        controller && opts.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), opts.timeoutMs)
          : undefined
      try {
        response = await fetchImpl(current, {
          redirect: manual ? 'manual' : 'follow',
          headers: buildHeaders(current),
          ...(controller ? { signal: controller.signal } : {}),
        })
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (manual && isRedirectStatus(response.status)) {
        const location = response.headers.get('location')
        if (!location) {
          throw new Error(`Redirect ${response.status} missing Location header`)
        }
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (max ${maxRedirects}) downloading ${url}`)
        }
        current = resolveRedirectUrl(current, location).href
        continue
      }

      break
    }

    if (!response) throw new Error(`No response downloading ${url}`)
    if (manual && isRedirectStatus(response.status)) {
      throw new Error(`Too many redirects (max ${maxRedirects}) downloading ${url}`)
    }
    if (!response.ok) {
      throw new ModelDownloadHttpError(response.status, url, 'downloading')
    }
    if (!response.body) {
      throw new Error(`No response body from ${url}`)
    }

    const total = parseInt(response.headers.get('content-length') ?? '0', 10)
    let downloaded = 0

    const fileStream = fs.createWriteStream(tmpPath)
    const reader = response.body.getReader()

    try {
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array }
        if (done || !value) break
        downloaded += value.length
        if (opts.maxBytes !== undefined && downloaded > opts.maxBytes) {
          throw new Error(`Downloaded ${downloaded} bytes exceeds the ${opts.maxBytes}-byte limit`)
        }
        fileStream.write(value)
        opts.onProgress?.(downloaded, total)
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }

    fs.renameSync(tmpPath, destPath)
    return destPath
  } catch (err) {
    // Clean up partial download
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/**
 * Fetch JSON from a URL using native fetch().
 */
export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: buildHeaders(url),
  })
  if (!response.ok) {
    throw new ModelDownloadHttpError(response.status, url, 'fetching')
  }
  return response.json()
}

/**
 * Download a model with fallback URLs and optional SHA256 verification.
 * Legacy API preserved for backward compatibility -- delegates to downloadFile().
 */
export async function downloadModel(options: ModelDownloadOptions): Promise<ModelDownloadResult> {
  const { url, fallbackUrls = [], destDir, filename, expectedSha256, onProgress } = options

  const fname = filename ?? url.split('/').pop() ?? 'model.bin'
  const destPath = path.join(destDir, fname)

  // Check cache
  if (fs.existsSync(destPath)) {
    return { filePath: destPath, downloadedBytes: 0, fromCache: true }
  }

  fs.mkdirSync(destDir, { recursive: true })

  const urls = [url, ...fallbackUrls]
  let lastError: Error | null = null

  for (const tryUrl of urls) {
    try {
      await downloadFile(tryUrl, destPath, onProgress)

      // Verify SHA256 if provided
      if (expectedSha256) {
        const hash = await computeSha256(destPath)
        if (hash !== expectedSha256) {
          fs.unlinkSync(destPath)
          throw new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${hash}`)
        }
      }

      const stat = fs.statSync(destPath)
      return { filePath: destPath, downloadedBytes: stat.size, fromCache: false }
    } catch (e) {
      lastError = e as Error
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
    }
  }

  throw lastError ?? new Error(`Failed to download model from ${url}`)
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// ModelCatalogEntry-based helpers
// ---------------------------------------------------------------------------
//
// These are the standalone counterparts to `ModelDownloadService.ensure()`
// for callers that don't need a class-based catalog and just want to
// resolve a single `ModelCatalogEntry` against `modelsDir`. Detection
// pipeline previously kept its own copy of this logic
// (`addon-detection-pipeline/src/engine/model-downloader.ts`); merging
// them here lets every addon (detection, audio-analyzer, embedding-
// encoder, …) share one source of truth.

/** Progress callback: (downloadedBytes, totalBytes | undefined) */
export type DownloadProgressCallback = (downloaded: number, total: number | undefined) => void

/**
 * Download every file in a HuggingFace directory bundle (e.g. `.mlpackage`)
 * atomically. `knownFiles` lists the relative paths inside the directory; a
 * bundle that declares none is listed through the Hugging Face tree API. The
 * staging directory replaces `destDir` only when every file arrived, so a
 * bundle already on disk keeps serving until then.
 */
async function downloadDirectory(
  url: string,
  destDir: string,
  knownFiles: readonly string[] | undefined,
  onProgress?: DownloadProgressCallback,
): Promise<void> {
  const match = url.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)/)
  if (!match) throw new Error(`Cannot parse HuggingFace URL: ${url}`)
  const [, repo, dirPath] = match
  if (repo === undefined || dirPath === undefined) {
    throw new Error(`Cannot parse HuggingFace URL: ${url}`)
  }

  const relativePaths =
    knownFiles !== undefined && knownFiles.length > 0
      ? knownFiles
      : (await listHfFiles(repo, dirPath)).map((f) => f.substring(dirPath.length + 1))
  if (relativePaths.length === 0) {
    throw new Error(`No files found in HuggingFace directory: ${dirPath}`)
  }
  const files = relativePaths.map((f) => ({
    relativePath: f,
    fileUrl: `https://huggingface.co/${repo}/resolve/main/${dirPath}/${f}`,
  }))

  const tmpDir = destDir + '.downloading'
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  let totalDownloaded = 0
  try {
    for (const file of files) {
      const destPath = path.join(tmpDir, file.relativePath)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      await downloadFile(file.fileUrl, destPath, (downloaded, _total) => {
        onProgress?.(totalDownloaded + downloaded, undefined)
      })
      totalDownloaded += fs.statSync(destPath).size
    }
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.renameSync(tmpDir, destDir)
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
}

interface HfTreeEntry {
  readonly type: string
  readonly path: string
}

function isHfTreeEntry(value: unknown): value is HfTreeEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'path' in value &&
    typeof value.path === 'string'
  )
}

/** Every file path (repo-relative) under `dirPath`, recursively, via the HF tree API. */
async function listHfFiles(repo: string, dirPath: string): Promise<readonly string[]> {
  const listing = await fetchJson(`https://huggingface.co/api/models/${repo}/tree/main/${dirPath}`)
  if (!Array.isArray(listing)) throw new Error(`Unexpected HuggingFace tree for ${dirPath}`)
  const files: string[] = []
  for (const entry of listing) {
    if (!isHfTreeEntry(entry)) continue
    if (entry.type === 'file') files.push(entry.path)
    else if (entry.type === 'directory') files.push(...(await listHfFiles(repo, entry.path)))
  }
  return files
}

/**
 * Where a node records the catalog `revision` of the format it downloaded:
 * a sibling of the file or bundle, `<name>.revision` (D743). Outside the
 * bundle, so a `.mlpackage` keeps exactly the hosted files.
 */
export function revisionRecordPath(modelPath: string): string {
  return `${modelPath}.revision`
}

function readRevisionRecord(modelPath: string): string | null {
  try {
    return fs.readFileSync(revisionRecordPath(modelPath), 'utf8').trim()
  } catch {
    return null
  }
}

/** The CamStack model mirror. Every artefact under it has a generated revision. */
export const HOSTED_MODEL_MIRROR_PREFIX: string = hfModelUrl(HF_REPO, '')

/**
 * The revision a format must be at — the ONE rule every model download path
 * reads (D743, D744). An inline `revision` wins; otherwise a format hosted on
 * the CamStack mirror takes the revision generated for its path from the
 * mirror's LFS metadata (`hosted-model-revisions.ts`); anything else has none.
 */
export function resolveFormatRevision(formatEntry: ModelFormatEntry): string | undefined {
  if (formatEntry.revision !== undefined) return formatEntry.revision
  if (!formatEntry.url.startsWith(HOSTED_MODEL_MIRROR_PREFIX)) return undefined
  return HOSTED_MODEL_REVISIONS[formatEntry.url.slice(HOSTED_MODEL_MIRROR_PREFIX.length)]
}

/** The member of a Core ML package that holds its weights. */
const COREML_WEIGHT_MEMBER = 'Data/com.apple.CoreML/weights/weight.bin'

/**
 * The file whose sha256 IS a format's revision: a Core ML package's
 * `weight.bin`, an OpenVINO IR's `.bin` sibling, otherwise the file itself.
 * `null` for a bundle that is not a Core ML package (nothing to hash).
 */
export type RevisionWeightFile =
  | { readonly in: 'bundle'; readonly member: string }
  | { readonly in: 'sibling'; readonly name: string }
  | { readonly in: 'main' }

export function revisionWeightFile(formatEntry: ModelFormatEntry): RevisionWeightFile | null {
  if (formatEntry.isDirectory) {
    return formatEntry.url.endsWith('.mlpackage')
      ? { in: 'bundle', member: COREML_WEIGHT_MEMBER }
      : null
  }
  const weights = siblingFilesFor(formatEntry).find((f) => f.endsWith('.bin'))
  return weights !== undefined ? { in: 'sibling', name: weights } : { in: 'main' }
}

/** Where the revision's weight file is hosted — what the mirror's `lfs.oid` describes. */
export function revisionWeightUrl(formatEntry: ModelFormatEntry): string | null {
  const weights = revisionWeightFile(formatEntry)
  if (weights === null) return null
  switch (weights.in) {
    case 'bundle':
      return `${formatEntry.url}/${weights.member}`
    case 'sibling':
      return siblingUrl(formatEntry.url, weights.name)
    case 'main':
      return formatEntry.url
  }
}

function revisionWeightPath(
  modelsDir: string,
  modelPath: string,
  formatEntry: ModelFormatEntry,
): string | null {
  const weights = revisionWeightFile(formatEntry)
  if (weights === null) return null
  switch (weights.in) {
    case 'bundle':
      return path.join(modelPath, weights.member)
    case 'sibling':
      return path.join(modelsDir, weights.name)
    case 'main':
      return modelPath
  }
}

/**
 * True when the copy at `modelPath` is RECORDED at the revision the format
 * must be at. A format without a revision is current whenever it is present
 * (the behaviour before revisions existed); with one, the node's record must
 * match it — no record means the copy has not been proven current yet.
 */
function isCurrentRevision(modelPath: string, formatEntry: ModelFormatEntry): boolean {
  const revision = resolveFormatRevision(formatEntry)
  return revision === undefined || readRevisionRecord(modelPath) === revision
}

function writeRevisionRecord(modelPath: string, revision: string | undefined): void {
  if (revision === undefined) return
  const record = revisionRecordPath(modelPath)
  const tmp = `${record}.tmp`
  fs.writeFileSync(tmp, `${revision}\n`)
  fs.renameSync(tmp, record)
}

/**
 * Prove an unrecorded (or differently recorded) copy current by hashing its
 * weight file: when it IS the revision, record it and skip the download. This
 * is what keeps a new revision from re-downloading every copy that already
 * holds the right bytes — a copy fetched before revisions existed, one that a
 * hub distributed, one fetched before the catalog caught up with the mirror.
 */
async function adoptByHash(
  modelsDir: string,
  modelPath: string,
  formatEntry: ModelFormatEntry,
): Promise<boolean> {
  const revision = resolveFormatRevision(formatEntry)
  if (revision === undefined) return false
  const weights = revisionWeightPath(modelsDir, modelPath, formatEntry)
  if (weights === null || !isNonEmptyFile(weights)) return false
  if ((await computeSha256(weights)) !== revision) return false
  writeRevisionRecord(modelPath, revision)
  return true
}

/** True when every file of the format is on disk, whatever revision it holds. */
function isCompleteCopy(
  modelsDir: string,
  modelPath: string,
  formatEntry: ModelFormatEntry,
): boolean {
  if (!fs.existsSync(modelPath)) return false
  if (formatEntry.isDirectory) return fs.existsSync(path.join(modelPath, 'Manifest.json'))
  if (fs.statSync(modelPath).size <= 0) return false
  return siblingFilesFor(formatEntry).every((f) => isNonEmptyFile(path.join(modelsDir, f)))
}

/**
 * Replace a single-file format and its siblings that are already on disk.
 * `downloadFile` keeps an existing file, so every file is fetched to a
 * `.updating` name first and moved over the old one only when ALL of them
 * arrived: a failed fetch leaves the old copy serving.
 */
async function replaceSingleFileFormat(
  url: string,
  modelPath: string,
  modelsDir: string,
  siblings: readonly string[],
  onProgress?: DownloadProgressCallback,
): Promise<void> {
  const parts = [
    { url, dest: modelPath },
    ...siblings.map((f) => ({ url: siblingUrl(url, f), dest: path.join(modelsDir, f) })),
  ].map((p) => ({ ...p, staged: `${p.dest}.updating` }))
  try {
    for (const [i, part] of parts.entries()) {
      fs.rmSync(part.staged, { force: true })
      await downloadFile(
        part.url,
        part.staged,
        i === 0
          ? (downloaded: number, total: number) =>
              onProgress?.(downloaded, total === 0 ? undefined : total)
          : undefined,
      )
    }
  } catch (err) {
    for (const part of parts) fs.rmSync(part.staged, { force: true })
    throw err
  }
  for (const part of parts) fs.renameSync(part.staged, part.dest)
}

/**
 * Resolve a `ModelCatalogEntry` against `modelsDir`: download model file
 * (or directory bundle) + extra files (labels JSON, charset dict, …),
 * skip if already on disk. Returns the local model path.
 */
export async function ensureModel(
  modelsDir: string,
  entry: ModelCatalogEntry,
  format: ModelFormat,
  onProgress?: DownloadProgressCallback,
): Promise<string> {
  const formatEntry = entry.formats[format]
  if (!formatEntry) {
    throw new Error(
      `Model "${entry.id}" has no ${format} format. Available: ${Object.keys(entry.formats).join(', ')}`,
    )
  }

  // Extras (labels, dicts) — independent of format.
  if (entry.extraFiles) {
    for (const extra of entry.extraFiles) {
      await downloadFile(extra.url, path.join(modelsDir, extra.filename))
    }
  }

  const filename = formatEntry.url.split('/').pop() ?? `${entry.id}.${format}`
  const modelPath = path.join(modelsDir, filename)
  const siblings = siblingFilesFor(formatEntry)

  let outdated = false
  if (fs.existsSync(modelPath)) {
    if (formatEntry.isDirectory && !fs.existsSync(path.join(modelPath, 'Manifest.json'))) {
      // Stale half-downloaded mlpackage — wipe and re-fetch.
      fs.rmSync(modelPath, { recursive: true, force: true })
    } else if (siblings.some((f) => !isNonEmptyFile(path.join(modelsDir, f)))) {
      // Main file cached but a declared sibling (e.g. OpenVINO `.bin`
      // weights) is missing/empty — fall through and (re)fetch. An outdated
      // main file is replaced with it, never paired with new siblings.
      outdated =
        !isCurrentRevision(modelPath, formatEntry) &&
        !(await adoptByHash(modelsDir, modelPath, formatEntry))
    } else if (
      isCurrentRevision(modelPath, formatEntry) ||
      (await adoptByHash(modelsDir, modelPath, formatEntry))
    ) {
      return modelPath
    } else {
      // Complete, but these are not the bytes the revision names: the mirror
      // replaced them in place since this node fetched them (D743).
      outdated = true
    }
  }

  fs.mkdirSync(modelsDir, { recursive: true })

  if (formatEntry.isDirectory) {
    // Staged in `<bundle>.downloading` and swapped in whole: an outdated
    // bundle keeps serving until the new one is complete.
    await downloadDirectory(formatEntry.url, modelPath, formatEntry.files, onProgress)
  } else if (outdated) {
    await replaceSingleFileFormat(formatEntry.url, modelPath, modelsDir, siblings, onProgress)
  } else {
    await downloadFile(formatEntry.url, modelPath, (downloaded, total) =>
      onProgress?.(downloaded, total === 0 ? undefined : total),
    )
    // Sibling files (no separate progress: the UI treats the set as one
    // model download keyed on the main file).
    for (const sibling of siblings) {
      await downloadFile(siblingUrl(formatEntry.url, sibling), path.join(modelsDir, sibling))
    }
  }

  writeRevisionRecord(modelPath, resolveFormatRevision(formatEntry))
  return modelPath
}

/** What {@link adoptModelRevisions} found: `<modelId>/<format>` keys. */
export interface ModelRevisionAdoption {
  /** Copies proven current by hash and recorded — no download needed. */
  readonly adopted: readonly string[]
  /** Complete copies holding other bytes — `ensureModel` fetches them again. */
  readonly stale: readonly string[]
}

/**
 * Walk `entries` and record the revision of every complete copy on disk that
 * hashes to it, so a node's listing reports present models as downloaded
 * without waiting for something to `ensureModel` them. Offline: it reads
 * files and never fetches. A copy already recorded current is not re-hashed.
 */
export async function adoptModelRevisions(
  modelsDir: string,
  entries: readonly ModelCatalogEntry[],
): Promise<ModelRevisionAdoption> {
  const adopted: string[] = []
  const stale: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const format of Object.keys(entry.formats).filter(isModelFormat)) {
      const formatEntry = entry.formats[format]
      if (formatEntry === undefined || resolveFormatRevision(formatEntry) === undefined) continue
      const modelPath = getModelFilePath(modelsDir, entry, format)
      if (modelPath === null || seen.has(modelPath)) continue
      seen.add(modelPath)
      if (!isCompleteCopy(modelsDir, modelPath, formatEntry)) continue
      if (isCurrentRevision(modelPath, formatEntry)) continue
      const key = `${entry.id}/${format}`
      if (await adoptByHash(modelsDir, modelPath, formatEntry)) adopted.push(key)
      else stale.push(key)
    }
  }
  return { adopted, stale }
}

function isModelFormat(value: string): value is ModelFormat {
  return MODEL_FORMATS.some((f) => f === value)
}

/** Compute the on-disk path for a given model + format, even when not yet downloaded. */
export function getModelFilePath(
  modelsDir: string,
  entry: ModelCatalogEntry,
  format: ModelFormat,
): string | null {
  const formatEntry = entry.formats[format]
  if (!formatEntry) return null
  const filename = formatEntry.url.split('/').pop() ?? `${entry.id}.${format}`
  return path.join(modelsDir, filename)
}

/**
 * True iff the model file (or `Manifest.json` for directory bundles) exists and
 * is non-empty, and — when the format has a revision ({@link
 * resolveFormatRevision}) — the node recorded that same revision for it
 * (D743). Synchronous, so it never hashes: a copy not yet proven current
 * answers false until `ensureModel` or {@link adoptModelRevisions} records it.
 */
export function isModelDownloaded(
  modelsDir: string,
  entry: ModelCatalogEntry,
  format: ModelFormat,
): boolean {
  const formatEntry = entry.formats[format]
  if (!formatEntry) return false
  const modelPath = getModelFilePath(modelsDir, entry, format)
  if (!modelPath || !fs.existsSync(modelPath)) return false
  if (!isCurrentRevision(modelPath, formatEntry)) return false
  // A single-file format is only complete when every declared sibling
  // (e.g. OpenVINO `.bin` weights) is present and non-empty too.
  return isCompleteCopy(modelsDir, modelPath, formatEntry)
}

/** Remove the on-disk model file/directory. Returns true if something was deleted. */
export function deleteModelFromDisk(
  modelsDir: string,
  entry: ModelCatalogEntry,
  format: ModelFormat,
): boolean {
  const modelPath = getModelFilePath(modelsDir, entry, format)
  if (!modelPath || !fs.existsSync(modelPath)) return false
  fs.rmSync(revisionRecordPath(modelPath), { force: true })
  const formatEntry = entry.formats[format]
  if (formatEntry?.isDirectory) {
    fs.rmSync(modelPath, { recursive: true, force: true })
  } else {
    fs.unlinkSync(modelPath)
    // Remove declared sibling files too (e.g. OpenVINO `.bin`) so a
    // re-download starts from a clean slate.
    if (formatEntry) {
      for (const sibling of siblingFilesFor(formatEntry)) {
        const sibPath = path.join(modelsDir, sibling)
        if (fs.existsSync(sibPath)) fs.unlinkSync(sibPath)
      }
    }
  }
  return true
}
