/**
 * `importModelBundle` (D806): a trained detector's files arrive as ONE tar.
 *
 * Pinned: a good bundle lands FLAT in modelsDir (the Core ML package as a
 * directory), each format's `.revision` record is written, the rows are
 * registered and the hub marked available; a tampered tar, a tampered file, a
 * row naming an undeclared file, or an id another source owns is refused BY
 * NAME and leaves nothing behind; the same import twice is a no-op.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  CustomModelDescriptor,
  ImportModelBundleInput,
  ModelCatalogEntry,
  PeerBytesOpenResult,
} from '@camstack/types'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { type BundleImportDeps, importModelBundle } from '../bundle/bundle-import.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'bundle-import-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const ID = 'custom-yolov9m-640-ab12cd34'
const PKG = [
  'Manifest.json',
  'Data/com.apple.CoreML/model.mlmodel',
  'Data/com.apple.CoreML/weights/weight.bin',
]

const FILES: Record<string, Buffer> = {
  [`${ID}.onnx`]: Buffer.from('onnx'),
  [`${ID}-fp16.xml`]: Buffer.from('<xml/>'),
  [`${ID}-fp16.bin`]: Buffer.from('fp16-weights'),
  [`${ID}-int8.xml`]: Buffer.from('<xml8/>'),
  [`${ID}-int8.bin`]: Buffer.from('int8-weights'),
  ...Object.fromEntries(PKG.map((m) => [`${ID}.mlpackage/${m}`, Buffer.from(`pkg:${m}`)])),
}

function entries(): ModelCatalogEntry[] {
  const local = (id: string, file: string): string => `camstack-local://${id}/${file}`
  return [
    {
      id: ID,
      name: 'Fine-tuned',
      description: 'test',
      inputSize: { width: 640, height: 640 },
      labels: [],
      preprocessMode: 'letterbox',
      formats: {
        onnx: { url: local(ID, `${ID}.onnx`), sizeMB: 1, revision: sha(FILES[`${ID}.onnx`]!) },
        openvino: {
          url: local(ID, `${ID}-fp16.xml`),
          files: [`${ID}-fp16.bin`],
          runtimes: ['python'],
          sizeMB: 1,
          revision: sha(FILES[`${ID}-fp16.bin`]!),
        },
        coreml: {
          url: local(ID, `${ID}.mlpackage`),
          isDirectory: true,
          files: [...PKG],
          runtimes: ['python'],
          sizeMB: 1,
          revision: sha(FILES[`${ID}.mlpackage/${PKG[2]}`]!),
        },
      },
    },
    {
      id: `${ID}-int8`,
      name: 'Fine-tuned (INT8)',
      description: 'test',
      inputSize: { width: 640, height: 640 },
      labels: [],
      preprocessMode: 'letterbox',
      formats: {
        openvino: {
          url: local(`${ID}-int8`, `${ID}-int8.xml`),
          files: [`${ID}-int8.bin`],
          runtimes: ['python'],
          sizeMB: 1,
          revision: sha(FILES[`${ID}-int8.bin`]!),
        },
      },
    },
  ]
}

interface World {
  readonly input: ImportModelBundleInput
  readonly deps: BundleImportDeps
  readonly modelsDir: string
  readonly registered: CustomModelDescriptor[]
  readonly available: string[]
  readonly tarPath: string
}

async function world(opts: { tamperTar?: boolean; tamperFile?: string } = {}): Promise<World> {
  const src = await tempDir()
  for (const [name, body] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(src, name)), { recursive: true })
    const actual = name === opts.tamperFile ? Buffer.concat([body, Buffer.from('!')]) : body
    await writeFile(path.join(src, name), actual)
  }
  const tarPath = path.join(await tempDir(), 'bundle.tar')
  await create({ file: tarPath, cwd: src, portable: true }, Object.keys(FILES))
  if (opts.tamperTar === true)
    await writeFile(tarPath, Buffer.concat([await readFile(tarPath), Buffer.alloc(512)]))
  const tarBytes = await readFile(tarPath)
  const declaredTar =
    opts.tamperTar === true ? tarBytes.subarray(0, tarBytes.length - 512) : tarBytes
  const modelsDir = await tempDir()
  const registered: CustomModelDescriptor[] = []
  const available: string[] = []
  const open = async (): Promise<PeerBytesOpenResult> => ({
    kind: 'body',
    body: {
      status: 200,
      contentType: 'application/x-tar',
      declaredBytes: tarBytes.length,
      stream: createReadStream(tarPath),
      writeToFile: async (target, { maxBytes }) => {
        if (tarBytes.length > maxBytes) {
          return { kind: 'refused', code: 'too-large', detail: 'over', bytes: maxBytes }
        }
        await copyFile(tarPath, target)
        return { kind: 'written', bytes: tarBytes.length }
      },
      cancel: () => undefined,
    },
  })
  let n = 0
  return {
    tarPath,
    modelsDir,
    registered,
    available,
    input: {
      addonId: 'model-studio',
      stepId: 'object-detection',
      entries: entries(),
      bundle: {
        ticket: {
          url: 'http://127.0.0.1:1/t',
          hostNodeId: 'hub',
          expiresAtMs: 1,
          declaredBytes: null,
        },
        bytes: declaredTar.length,
        sha256: sha(declaredTar),
      },
      files: Object.entries(FILES).map(([p, body]) => ({
        path: p,
        bytes: body.length,
        sha256: sha(body),
      })),
      distribute: false,
    },
    deps: {
      modelsDir,
      stagingDir: await tempDir(),
      openTicket: open,
      listModels: async () => registered,
      upsert: async (d) => {
        registered.push(d)
      },
      markHubAvailable: async (modelId, format) => {
        available.push(`${modelId}:${format}`)
      },
      distribute: async () => [],
      newId: () => `n${String(++n)}`,
    },
  }
}

describe('importModelBundle', () => {
  it('places every file flat, writes revision records and registers both rows', async () => {
    const w = await world()
    const result = await importModelBundle(w.input, w.deps)
    expect(result).toEqual({ kind: 'imported', modelIds: [ID, `${ID}-int8`], distributed: [] })
    expect((await readFile(path.join(w.modelsDir, `${ID}.onnx`))).toString()).toBe('onnx')
    expect((await stat(path.join(w.modelsDir, `${ID}.mlpackage`))).isDirectory()).toBe(true)
    expect((await readFile(path.join(w.modelsDir, `${ID}.mlpackage`, PKG[2]!))).toString()).toBe(
      `pkg:${PKG[2]!}`,
    )
    expect((await readFile(path.join(w.modelsDir, `${ID}-fp16.xml.revision`), 'utf8')).trim()).toBe(
      sha(FILES[`${ID}-fp16.bin`]!),
    )
    expect(w.registered.map((d) => d.entry.id)).toEqual([ID, `${ID}-int8`])
    expect(w.available.toSorted()).toEqual(
      [`${ID}:onnx`, `${ID}:openvino`, `${ID}:coreml`, `${ID}-int8:openvino`].toSorted(),
    )
  })

  it('is a no-op the second time', async () => {
    const w = await world()
    await importModelBundle(w.input, w.deps)
    const again = await importModelBundle(w.input, w.deps)
    expect(again.kind).toBe('imported')
    expect(w.registered).toHaveLength(2)
  })

  it('refuses a tar that does not match its sha256 and leaves nothing behind', async () => {
    const w = await world({ tamperTar: true })
    const result = await importModelBundle(w.input, w.deps)
    expect(result.kind === 'refused' && result.reason).toBe('transfer-failed')
    expect(await readdir(w.modelsDir)).toEqual([])
    expect(w.registered).toEqual([])
  })

  it('refuses a file whose bytes are not the declared ones', async () => {
    const w = await world({ tamperFile: `${ID}-int8.bin` })
    const declaredTar = await readFile(w.tarPath)
    const input = {
      ...w.input,
      bundle: { ...w.input.bundle, bytes: declaredTar.length, sha256: sha(declaredTar) },
    }
    const result = await importModelBundle(input, w.deps)
    expect(result.kind === 'refused' && result.reason).toBe('checksum-mismatch')
    expect(await readdir(w.modelsDir)).toEqual([])
  })

  it('refuses a row that names a file the bundle does not declare', async () => {
    const w = await world()
    const input = { ...w.input, files: w.input.files.filter((f) => !f.path.endsWith('-int8.bin')) }
    const result = await importModelBundle(input, w.deps)
    expect(result.kind === 'refused' && result.reason).toBe('bundle-mismatch')
  })

  it('refuses an id another source already registered with other files', async () => {
    const w = await world()
    const other = entries()[0]!
    w.registered.push({
      stepId: 'object-detection',
      entry: { ...other, formats: { onnx: { url: 'https://x/y.onnx', sizeMB: 1 } } },
    })
    const result = await importModelBundle(w.input, w.deps)
    expect(result.kind === 'refused' && result.reason).toBe('id-taken')
  })
})
