/**
 * Server-owned plugin catalog catalog import. The only client input is `manifestId`.
 * Downloads use the pinned host/repo/revision, a bounded staging dir, LFS /
 * size / checksum checks, and atomic finalize with cleanup on every failure.
 */
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CustomModelDescriptor, ModelCatalogEntry, ModelFormat } from '@camstack/types'
import {
  normalizePluginCatalogDrift,
  type PluginCatalogCatalogDrift,
} from './plugin-catalog-tree-drift.js'
import {
  assertPluginCatalogFileSha256,
  assertPluginCatalogRelativePath,
  buildPluginCatalogResolveUrl,
  getPluginCatalogManifestEntry,
  PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
  type PluginCatalogManifestEntry,
  type PluginCatalogManifestFile,
} from './plugin-catalog-yolo-manifest.js'

export const PLUGIN_CATALOG_IMPORT_MAX_FILE_BYTES = 256 * 1024 * 1024

/** Deterministic bundle digest: sorted `path\\0sha256` lines, never the primary file alone. */
export function pluginCatalogBundleFingerprint(entry: {
  readonly files: readonly { readonly relativePath: string; readonly sha256: string }[]
}): string {
  const hash = createHash('sha256')
  const lines = entry.files.map((file) => `${file.relativePath}\0${file.sha256}`).toSorted()
  hash.update(lines.join('\n'))
  return hash.digest('hex')
}
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'
const SIZE_TOLERANCE = 0.01

export interface PluginCatalogImportDeps {
  readonly stagingDir: string
  readonly modelsDir: string
  readonly maxFileBytes?: number
  driftFor(manifestId: string): Promise<PluginCatalogCatalogDrift>
  downloadFile(url: string, destPath: string): Promise<string>
  fileSha256?(filePath: string): Promise<string>
  resolveEntry?(manifestId: string): PluginCatalogManifestEntry | undefined
}

function isLfsPointer(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(128)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8').startsWith(LFS_POINTER_PREFIX)
  } finally {
    fs.closeSync(fd)
  }
}

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

function assertInside(root: string, dest: string): string {
  const rootResolved = path.resolve(root)
  const destResolved = path.resolve(dest)
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`
  if (destResolved !== rootResolved && !destResolved.startsWith(prefix)) {
    throw new Error(`Refusing to write outside the destination root: ${dest}`)
  }
  return destResolved
}

function rejectSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing symlink at ${filePath}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

function sizeOutOfTolerance(actual: number, declared: number): boolean {
  if (declared <= 0) return true
  const delta = Math.abs(actual - declared) / declared
  return delta > SIZE_TOLERANCE
}

function localBasename(entry: PluginCatalogManifestEntry): string {
  if (entry.format === 'coreml') {
    const manifest = entry.files.find((file) => file.relativePath.endsWith('/Manifest.json'))
    const dir = manifest?.relativePath.replace(/\/Manifest\.json$/, '') ?? `${entry.id}.mlpackage`
    return dir.split('/').pop() ?? `${entry.id}.mlpackage`
  }
  if (entry.format === 'openvino') {
    return `${entry.id}.xml`
  }
  if (entry.format === 'tflite') {
    return `${entry.id}.tflite`
  }
  const main = entry.files[0]?.relativePath.split('/').pop()
  return main ?? `${entry.id}.onnx`
}

/**
 * Library registration descriptor: keeps manifesto remote URLs (HF resolve).
 * Files land on a node only via Distribute / downloadModel — not hub staging.
 */
export function buildPluginCatalogRegistryDescriptor(
  entry: PluginCatalogManifestEntry,
): CustomModelDescriptor {
  return {
    stepId: 'object-detection',
    entry: {
      ...entry.model,
      classMap: PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
      formats: { ...entry.model.formats },
      name: entry.model.name,
      description: entry.model.description,
      provider: 'scrypted',
    },
  }
}

function buildImportedDescriptor(
  entry: PluginCatalogManifestEntry,
  localName: string,
): CustomModelDescriptor {
  const catalog: ModelCatalogEntry = {
    ...entry.model,
    classMap: PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
    formats: { ...entry.model.formats },
    name: entry.model.name,
    description: entry.model.description,
    provider: 'scrypted',
  }
  const format = entry.format as ModelFormat
  const previous = catalog.formats[format]
  if (format === 'coreml') {
    catalog.formats = {
      ...catalog.formats,
      coreml: {
        url: `camstack-local://${entry.id}/${localName}`,
        sizeMB: previous?.sizeMB ?? entry.files.reduce((sum, file) => sum + file.size, 0) / 1e6,
        isDirectory: true,
        files: previous?.files ?? [
          'Manifest.json',
          'Data/com.apple.CoreML/model.mlmodel',
          'Data/com.apple.CoreML/weights/weight.bin',
        ],
        runtimes: ['python'],
      },
    }
  } else if (format === 'openvino') {
    catalog.formats = {
      ...catalog.formats,
      openvino: {
        url: `camstack-local://${entry.id}/${localName}`,
        sizeMB: previous?.sizeMB ?? entry.files.reduce((sum, file) => sum + file.size, 0) / 1e6,
        files: [`${entry.id}.bin`],
        runtimes: ['python'],
      },
    }
  } else {
    catalog.formats = {
      ...catalog.formats,
      [format]: {
        url: `camstack-local://${entry.id}/${localName}`,
        sizeMB: previous?.sizeMB ?? entry.files.reduce((sum, file) => sum + file.size, 0) / 1e6,
        ...(previous?.runtimes !== undefined ? { runtimes: previous.runtimes } : {}),
      },
    }
  }
  return { stepId: 'object-detection', entry: catalog }
}

/** Availability/format selection uses the manifesto format, never key order. */
export function resolvePluginCatalogImportedFormat(
  manifestId: string,
  descriptor: CustomModelDescriptor,
): ModelFormat {
  const entry = getPluginCatalogManifestEntry(manifestId)
  if (!entry) {
    throw new Error(`resolvePluginCatalogImportedFormat: unknown manifest id "${manifestId}"`)
  }
  const format = entry.format as ModelFormat
  if (!descriptor.entry.formats[format]) {
    throw new Error(
      `resolvePluginCatalogImportedFormat: descriptor for "${manifestId}" is missing manifesto format ${format}`,
    )
  }
  return format
}

export async function verifyPluginCatalogStagedFile(
  destPath: string,
  file: PluginCatalogManifestFile,
  deps: Pick<PluginCatalogImportDeps, 'maxFileBytes' | 'fileSha256'>,
): Promise<void> {
  const maxBytes = deps.maxFileBytes ?? PLUGIN_CATALOG_IMPORT_MAX_FILE_BYTES
  if (file.size > maxBytes) {
    throw new Error(`Declared size ${file.size} exceeds the ${maxBytes}-byte limit`)
  }
  if (!fs.existsSync(destPath)) {
    throw new Error(`missing downloaded file for ${file.relativePath}`)
  }
  rejectSymlink(destPath)
  const actual = fs.statSync(destPath).size
  if (actual > maxBytes) {
    throw new Error(`Downloaded ${actual} bytes exceeds the ${maxBytes}-byte limit`)
  }
  if (isLfsPointer(destPath)) {
    throw new Error(`Downloaded an LFS pointer instead of the artifact (${file.relativePath})`)
  }
  if (sizeOutOfTolerance(actual, file.size)) {
    throw new Error(
      `Downloaded size ${actual} is outside tolerance of declared ${file.size} for ${file.relativePath}`,
    )
  }
  const expected = assertPluginCatalogFileSha256(file.sha256, file.relativePath)
  const digest = await (deps.fileSha256 ?? hashFileSha256)(destPath)
  if (digest !== expected) {
    throw new Error(`sha256 checksum mismatch for ${file.relativePath}`)
  }
}

export async function importPluginCatalogCatalogModel(
  input: { manifestId: string },
  deps: PluginCatalogImportDeps,
): Promise<CustomModelDescriptor> {
  const entry = (deps.resolveEntry ?? getPluginCatalogManifestEntry)(input.manifestId)
  if (!entry) {
    throw new Error(`importPluginCatalogCatalogModel: unknown manifest id "${input.manifestId}"`)
  }
  for (const file of entry.files) {
    assertPluginCatalogFileSha256(file.sha256, file.relativePath)
  }
  const drift = normalizePluginCatalogDrift(await deps.driftFor(entry.id))
  if (drift.status !== 'ok') {
    throw new Error(
      `importPluginCatalogCatalogModel: entry "${entry.id}" is blocked by drift (${drift.status}${drift.details ? `: ${drift.details}` : ''})`,
    )
  }

  fs.mkdirSync(deps.stagingDir, { recursive: true })
  fs.mkdirSync(deps.modelsDir, { recursive: true })
  const stagingRoot = path.join(deps.stagingDir, `imp-${randomUUID()}`)
  fs.mkdirSync(stagingRoot, { recursive: true })

  try {
    const staged: Array<{ file: PluginCatalogManifestFile; dest: string }> = []
    for (const file of entry.files) {
      const relative = assertPluginCatalogRelativePath(file.relativePath)
      const dest = assertInside(stagingRoot, path.join(stagingRoot, ...relative.split('/')))
      const url = buildPluginCatalogResolveUrl(relative)
      await deps.downloadFile(url, dest)
      await verifyPluginCatalogStagedFile(dest, file, deps)
      staged.push({ file, dest })
    }

    if (entry.format === 'coreml') {
      const hasManifest = staged.some((row) => row.file.relativePath.endsWith('Manifest.json'))
      const hasModel = staged.some((row) => row.file.relativePath.endsWith('model.mlmodel'))
      const hasWeight = staged.some((row) => row.file.relativePath.endsWith('weight.bin'))
      if (!hasManifest || !hasModel || !hasWeight || staged.length < 3) {
        throw new Error(
          'CoreML payload is incomplete — Manifest.json, model and weights are required',
        )
      }
    }
    if (entry.format === 'openvino') {
      const hasXml = staged.some((row) => row.file.relativePath.endsWith('.xml'))
      const hasBin = staged.some((row) => row.file.relativePath.endsWith('.bin'))
      if (!hasXml || !hasBin) {
        throw new Error('OpenVINO payload is incomplete — xml and bin siblings are required')
      }
    }

    const localName = localBasename(entry)
    const finalMain = assertInside(deps.modelsDir, path.join(deps.modelsDir, localName))
    rejectSymlink(finalMain)

    if (entry.format === 'coreml') {
      const pkgRel = staged
        .find((row) => row.file.relativePath.endsWith('Manifest.json'))
        ?.file.relativePath.replace(/\/Manifest\.json$/, '')
      if (!pkgRel) throw new Error('CoreML payload is incomplete — Manifest.json missing')
      const stagedPkg = path.join(stagingRoot, ...pkgRel.split('/'))
      fs.rmSync(finalMain, { recursive: true, force: true })
      fs.renameSync(stagedPkg, finalMain)
    } else if (entry.format === 'openvino') {
      const xml = staged.find((row) => row.file.relativePath.endsWith('.xml'))
      const bin = staged.find((row) => row.file.relativePath.endsWith('.bin'))
      if (!xml || !bin) throw new Error('OpenVINO payload is incomplete')
      const xmlDest = finalMain
      const binDest = assertInside(deps.modelsDir, path.join(deps.modelsDir, `${entry.id}.bin`))
      fs.renameSync(xml.dest, xmlDest)
      fs.renameSync(bin.dest, binDest)
    } else {
      const only = staged[0]
      if (!only) throw new Error('payload is incomplete')
      fs.renameSync(only.dest, finalMain)
    }

    return buildImportedDescriptor(entry, localName)
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
  }
}
