/**
 * Chunked model-file upload store (hub-side).
 *
 * A model file cannot ride ONE tRPC mutation — the hub's HTTP body limit is
 * ~1 MB — so the page streams it as base64 chunks through three custom
 * actions (`beginModelUpload` / `appendModelUpload` / `commitModelUpload`).
 * Chunks are appended to a staging file; commit verifies completeness and
 * moves the artifact into the node's shared modelsDir, where the
 * `camstack-local://<modelId>/<filename>` catalog-URL convention resolves it
 * by basename (see `ensureModel`) and `model-distributor` can tar it to
 * agents.
 *
 * Fail-closed everywhere: path-traversal-proof filenames, extension
 * allowlist, per-upload byte accounting against the DECLARED total, and a
 * global size cap. sha256 is computed incrementally on append so commit does
 * not re-read the file.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID, type Hash } from 'node:crypto'

/** plus catalog artifacts top out around ~100 MB (YOLO-NAS S ≈ 50 MB). */
export const MODEL_UPLOAD_MAX_BYTES = 512 * 1024 * 1024

export const MODEL_UPLOAD_ALLOWED_EXTENSIONS = ['.onnx', '.tflite'] as const

const FILENAME_RE = /^[a-zA-Z0-9._-]+$/

/**
 * Validate an upload filename: plain basename (no separators, no traversal),
 * conservative charset, allowlisted model extension. Returns it unchanged so
 * call sites read as an assertion. Throws with an actionable message.
 */
export function sanitizeModelFilename(filename: string): string {
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !FILENAME_RE.test(filename)
  ) {
    throw new Error(
      `Invalid model filename "${filename}" — plain basename with letters, digits, dot, underscore, hyphen only`,
    )
  }
  const allowed = MODEL_UPLOAD_ALLOWED_EXTENSIONS.some((ext) => filename.endsWith(ext))
  if (!allowed) {
    throw new Error(
      `Unsupported model file extension on "${filename}" — expected one of ${MODEL_UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`,
    )
  }
  return filename
}

interface ActiveUpload {
  readonly filename: string
  readonly totalBytes: number
  readonly stagingPath: string
  readonly hash: Hash
  received: number
}

export interface ModelUploadStoreOptions {
  /** Directory staged (partial) uploads are written into. */
  readonly stagingDir: string
  /** The node's shared models directory — commit's destination. */
  readonly modelsDir: string
  /** Override for tests; defaults to {@link MODEL_UPLOAD_MAX_BYTES}. */
  readonly maxBytes?: number
}

export class ModelUploadStore {
  private readonly uploads = new Map<string, ActiveUpload>()
  private readonly opts: ModelUploadStoreOptions
  private readonly maxBytes: number

  constructor(opts: ModelUploadStoreOptions) {
    this.opts = opts
    this.maxBytes = opts.maxBytes ?? MODEL_UPLOAD_MAX_BYTES
  }

  begin(input: { filename: string; totalBytes: number }): { uploadId: string } {
    const filename = sanitizeModelFilename(input.filename)
    if (!Number.isFinite(input.totalBytes) || input.totalBytes <= 0) {
      throw new Error('totalBytes must be a positive number')
    }
    if (input.totalBytes > this.maxBytes) {
      throw new Error(
        `Upload too large: ${input.totalBytes} bytes exceeds the ${this.maxBytes}-byte cap`,
      )
    }
    fs.mkdirSync(this.opts.stagingDir, { recursive: true })
    const uploadId = randomUUID()
    const stagingPath = path.join(this.opts.stagingDir, `${uploadId}-${filename}`)
    fs.writeFileSync(stagingPath, Buffer.alloc(0))
    this.uploads.set(uploadId, {
      filename,
      totalBytes: input.totalBytes,
      stagingPath,
      hash: createHash('sha256'),
      received: 0,
    })
    return { uploadId }
  }

  append(input: { uploadId: string; chunkBase64: string }): { received: number } {
    const upload = this.mustGet(input.uploadId)
    const chunk = Buffer.from(input.chunkBase64, 'base64')
    if (chunk.length === 0) throw new Error('Empty chunk')
    if (upload.received + chunk.length > upload.totalBytes) {
      // Poisoned upload — drop it so a retry starts clean.
      this.abort({ uploadId: input.uploadId })
      throw new Error(
        `Chunk exceeds the declared totalBytes (${upload.totalBytes}) — upload aborted`,
      )
    }
    fs.appendFileSync(upload.stagingPath, chunk)
    upload.hash.update(chunk)
    upload.received += chunk.length
    return { received: upload.received }
  }

  commit(input: { uploadId: string }): { filename: string; bytes: number; sha256: string } {
    const upload = this.mustGet(input.uploadId)
    if (upload.received !== upload.totalBytes) {
      throw new Error(
        `Upload incomplete: received ${upload.received} of ${upload.totalBytes} bytes`,
      )
    }
    fs.mkdirSync(this.opts.modelsDir, { recursive: true })
    const destPath = path.join(this.opts.modelsDir, upload.filename)
    fs.renameSync(upload.stagingPath, destPath)
    this.uploads.delete(input.uploadId)
    return {
      filename: upload.filename,
      bytes: upload.received,
      sha256: upload.hash.digest('hex'),
    }
  }

  abort(input: { uploadId: string }): { ok: true } {
    const upload = this.uploads.get(input.uploadId)
    if (upload) {
      try {
        fs.rmSync(upload.stagingPath, { force: true })
      } catch {
        // Staging cleanup is best-effort — the map removal below is what
        // invalidates the upload.
      }
      this.uploads.delete(input.uploadId)
    }
    return { ok: true }
  }

  private mustGet(uploadId: string): ActiveUpload {
    const upload = this.uploads.get(uploadId)
    if (!upload) throw new Error(`Unknown uploadId "${uploadId}" — begin a new upload`)
    return upload
  }
}
