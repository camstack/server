import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- the revision rule is the downloader's (build-time dep, as in audio-pipeline.ts)
import { resolveFormatRevision } from '@camstack/system/addon-utils'
import { ensureYamnetFiles } from '../audio-pipeline.js'
import { AUDIO_CLASSIFIER_MODELS } from '../../detection-pipeline/registry/model-catalogs.js'

// The YAMNet model is a hosted catalog artefact like any other: it is fetched
// through `ensureModel`, so a copy replaced in place on the mirror is fetched
// again (D743, D744). It used to be an `existsSync` + `downloadFile` of a
// hand-built URL, which kept any file already on disk forever.
describe('YAMNet model files ride the catalog download path', () => {
  let modelsDir: string
  const onnx = () => path.join(modelsDir, 'camstack-yamnet.onnx')
  const labels = () => path.join(modelsDir, 'camstack-yamnet-labels.json')

  function serve(): string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      asked.push(url)
      return new Response(url.endsWith('.json') ? '[]' : 'NEW', { status: 200 })
    })
    return asked
  }

  beforeEach(() => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-yamnet-'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(modelsDir, { recursive: true, force: true })
  })

  it('the catalog entry is the one the analyzer loads, labels included', () => {
    const entry = AUDIO_CLASSIFIER_MODELS.find((m) => m.id === 'yamnet-onnx')
    expect(entry?.formats.onnx?.url).toMatch(
      /\/audioClassification\/yamnet\/onnx\/camstack-yamnet\.onnx$/,
    )
    expect(entry?.extraFiles?.map((f) => f.filename)).toEqual(['camstack-yamnet-labels.json'])
  })

  it('a copy that is not the revision on the mirror is fetched again', async () => {
    fs.writeFileSync(onnx(), 'OLD')
    fs.writeFileSync(labels(), '[]')
    const asked = serve()
    const files = await ensureYamnetFiles(modelsDir)
    expect(files).toEqual({ modelPath: onnx(), labelsPath: labels() })
    expect(asked.filter((u) => u.endsWith('camstack-yamnet.onnx'))).toHaveLength(1)
    expect(fs.readFileSync(onnx(), 'utf8')).toBe('NEW')
  })

  it('a copy recorded at the revision is used without a request', async () => {
    const onnxFormat = AUDIO_CLASSIFIER_MODELS.find((m) => m.id === 'yamnet-onnx')?.formats.onnx
    const revision = onnxFormat === undefined ? undefined : resolveFormatRevision(onnxFormat)
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    fs.writeFileSync(onnx(), 'CURRENT')
    fs.writeFileSync(`${onnx()}.revision`, `${revision ?? ''}\n`)
    fs.writeFileSync(labels(), '[]')
    const asked = serve()
    await ensureYamnetFiles(modelsDir)
    expect(asked).toEqual([])
    expect(fs.readFileSync(onnx(), 'utf8')).toBe('CURRENT')
  })
})
