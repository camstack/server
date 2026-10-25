/**
 * `custom-model-registry.importModelBundle` — a model whose files arrive as
 * ONE tar from another addon (D806; the training orchestrator is the first
 * caller).
 *
 * Model Studio's upload path takes one `.onnx`/`.tflite` at a time; a trained
 * detector is an ONNX, two OpenVINO IR pairs and a Core ML package, which is
 * a directory. So the bundle is taken whole over `ctx.peerBytes` (D613),
 * checked against its declared sha256 AND against every declared file, and
 * only then moved into the hub's FLAT modelsDir — the layout every model
 * download path already resolves (`<modelsDir>/<basename of the url>`).
 *
 * Nothing is half-imported: the files land in a staging directory first, the
 * registry row is written only after every file is in place, and a refusal
 * names its reason (`checksum-mismatch`, `bundle-mismatch`, `invalid-entry`,
 * `id-taken`, `transfer-failed`).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type CustomModelDescriptor,
  type ImportModelBundleInput,
  type ImportModelBundleResult,
  MODEL_FORMATS,
  type ModelCatalogEntry,
  type ModelFormat,
  type ModelFormatEntry,
  type PeerBytesOpenResult,
  type PeerBytesTicket,
} from '@camstack/types'
import { extractBundleTar } from './bundle-tar.js'

const LOCAL_SCHEME = 'camstack-local://'

export interface DistributionOutcome {
  readonly modelId: string
  readonly nodeId: string
  readonly format: ModelFormat
  readonly ok: boolean
  readonly error?: string
}

export interface BundleImportDeps {
  readonly modelsDir: string
  /** A private scratch directory; created and cleaned by the importer. */
  readonly stagingDir: string
  readonly openTicket: (ticket: PeerBytesTicket) => Promise<PeerBytesOpenResult>
  readonly listModels: () => Promise<readonly CustomModelDescriptor[]>
  readonly upsert: (descriptor: CustomModelDescriptor) => Promise<void>
  readonly markHubAvailable: (modelId: string, format: ModelFormat, bytes: number) => Promise<void>
  readonly distribute: (modelId: string) => Promise<readonly DistributionOutcome[]>
  readonly newId: () => string
}

type Refusal = Extract<ImportModelBundleResult, { kind: 'refused' }>
const refuse = (reason: Refusal['reason'], detail: string): Refusal => ({
  kind: 'refused',
  reason,
  detail,
})

/** The bundle paths one format occupies: main file + siblings, or the package members. */
export function formatBundlePaths(entry: ModelCatalogEntry, format: ModelFormat): string[] | null {
  const fmt = entry.formats[format]
  if (fmt === undefined) return []
  const prefix = `${LOCAL_SCHEME}${entry.id}/`
  if (!fmt.url.startsWith(prefix)) return null
  const main = fmt.url.slice(prefix.length)
  if (main === '' || main.includes('/')) return null
  if (fmt.isDirectory === true) return (fmt.files ?? []).map((member) => `${main}/${member}`)
  return [main, ...(fmt.files ?? [])]
}

function presentFormats(entry: ModelCatalogEntry): ModelFormat[] {
  return MODEL_FORMATS.filter((format) => entry.formats[format] !== undefined)
}

function entryPaths(entry: ModelCatalogEntry): string[] | null {
  const out: string[] = []
  for (const format of presentFormats(entry)) {
    const paths = formatBundlePaths(entry, format)
    if (paths === null) return null
    out.push(...paths)
  }
  return out
}

function sameRevisions(a: ModelCatalogEntry, b: ModelCatalogEntry): boolean {
  for (const format of MODEL_FORMATS) {
    const ra: ModelFormatEntry | undefined = a.formats[format]
    const rb: ModelFormatEntry | undefined = b.formats[format]
    if (ra === undefined && rb === undefined) continue
    if (ra?.revision === undefined || ra.revision !== rb?.revision) return false
  }
  return true
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function importModelBundle(
  input: ImportModelBundleInput,
  deps: BundleImportDeps,
): Promise<ImportModelBundleResult> {
  // 1. The rows must describe exactly the declared files, under their own ids.
  const declared = new Map(input.files.map((f) => [f.path, f]))
  const covered = new Set<string>()
  for (const entry of input.entries) {
    const paths = entryPaths(entry)
    if (paths === null) {
      return refuse(
        'invalid-entry',
        `"${entry.id}": every format URL must be ${LOCAL_SCHEME}${entry.id}/<file>`,
      )
    }
    for (const p of paths) {
      if (!declared.has(p))
        return refuse(
          'bundle-mismatch',
          `"${entry.id}" names "${p}", which the bundle does not declare`,
        )
      covered.add(p)
    }
  }

  // 2. An id another source registered is never overwritten; the same import twice is a no-op.
  const existing = new Map((await deps.listModels()).map((m) => [m.entry.id, m.entry]))
  const fresh: ModelCatalogEntry[] = []
  for (const entry of input.entries) {
    const prior = existing.get(entry.id)
    if (prior === undefined) fresh.push(entry)
    else if (!sameRevisions(prior, entry))
      return refuse('id-taken', `"${entry.id}" is already registered with other files`)
  }
  if (fresh.length === 0)
    return { kind: 'imported', modelIds: input.entries.map((e) => e.id), distributed: [] }

  const work = path.join(deps.stagingDir, `bundle-${deps.newId()}`)
  await mkdir(work, { recursive: true })
  try {
    // 3. Take the tar, bounded by its declared size, and check it whole.
    const opened = await deps.openTicket(input.bundle.ticket)
    if (opened.kind === 'refused')
      return refuse('transfer-failed', `${opened.code}: ${opened.detail}`)
    const tarPath = path.join(work, 'bundle.tar')
    const written = await opened.body.writeToFile(tarPath, { maxBytes: input.bundle.bytes })
    if (written.kind === 'refused')
      return refuse('transfer-failed', `${written.code}: ${written.detail}`)
    if (
      written.bytes !== input.bundle.bytes ||
      (await sha256File(tarPath)) !== input.bundle.sha256
    ) {
      return refuse('checksum-mismatch', 'the bundle does not match its declared size and sha256')
    }

    // 4. Unpack ONLY the declared files, each against its own sha256.
    const unpacked = path.join(work, 'files')
    const extracted = await extractBundleTar(tarPath, unpacked, new Set(declared.keys()))
    if (extracted.kind === 'refused') return refuse('bundle-mismatch', extracted.detail)
    for (const file of input.files) {
      const got = extracted.files.find((f) => f.path === file.path)
      if (got === undefined)
        return refuse('bundle-mismatch', `"${file.path}" is missing from the bundle`)
      if (got.sha256 !== file.sha256 || got.bytes !== file.bytes) {
        return refuse('checksum-mismatch', `"${file.path}" does not match its declared sha256`)
      }
    }

    // 5. Move into the flat modelsDir, write revision records, then register.
    await mkdir(deps.modelsDir, { recursive: true })
    for (const entry of fresh) await placeEntry(entry, unpacked, deps)
    for (const entry of fresh) {
      await deps.upsert({ stepId: input.stepId, entry })
      for (const format of presentFormats(entry)) {
        const bytes = (formatBundlePaths(entry, format) ?? []).reduce(
          (sum, p) => sum + (declared.get(p)?.bytes ?? 0),
          0,
        )
        await deps.markHubAvailable(entry.id, format, bytes)
      }
    }
    const distributed: DistributionOutcome[] = []
    if (input.distribute) {
      for (const entry of fresh) distributed.push(...(await deps.distribute(entry.id)))
    }
    return { kind: 'imported', modelIds: input.entries.map((e) => e.id), distributed }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function placeEntry(
  entry: ModelCatalogEntry,
  unpacked: string,
  deps: BundleImportDeps,
): Promise<void> {
  for (const format of presentFormats(entry)) {
    const fmt = entry.formats[format]
    if (fmt === undefined) continue
    const main = fmt.url.slice(`${LOCAL_SCHEME}${entry.id}/`.length)
    const names = fmt.isDirectory === true ? [main] : [main, ...(fmt.files ?? [])]
    for (const name of names) {
      const target = path.join(deps.modelsDir, name)
      await rm(target, { recursive: true, force: true })
      await moveInto(path.join(unpacked, name), target)
    }
    // The node's record of what it holds (D743): next to the main file / package.
    if (fmt.revision !== undefined) {
      const record = path.join(deps.modelsDir, `${main}.revision`)
      await writeFile(record, `${fmt.revision}\n`, 'utf8')
    }
  }
}

/** Rename, or copy-then-remove when staging and modelsDir sit on different filesystems. */
async function moveInto(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch (err: unknown) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EXDEV')) throw err
    await cp(source, target, { recursive: true })
    await rm(source, { recursive: true, force: true })
  }
}
