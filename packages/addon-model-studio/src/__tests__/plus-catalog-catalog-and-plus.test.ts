/**
 * D214 addendum — import plus catalog models WITHOUT hand-typed metadata.
 *
 *  - The PUBLIC catalog is a curated list with verified download URLs and the
 *    real characteristics (format, input size, decode, plus catalog labelmap), so
 *    registering one fills everything from the list.
 *  - plus catalog personal models come through the real api.frigate.video
 *    contract (GET /v1/auth/token with basic auth from the `uuid:40hex` key,
 *    Bearer for /v1/model/list, /v1/model/{id}, /v1/model/{id}/signed_url —
 *    verified against plus-catalog/plus.py) — the key never leaves the hub.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlusCatalogCatalogDescriptor,
  PLUS_CATALOG_PUBLIC_CATALOG,
} from '../plus-catalog/plus-catalog-catalog.js'
import {
  fetchPlusAccessToken,
  isValidPlusApiKey,
  listPlusModels,
  plusInfoToDescriptor,
  requestPlusModelDownload,
} from '../plus-catalog/plus-catalog-api.js'

describe('PLUS_CATALOG_PUBLIC_CATALOG', () => {
  it('carries the plus catalog default MobileDet EdgeTPU model with its real characteristics', () => {
    const entry = PLUS_CATALOG_PUBLIC_CATALOG.find((e) => e.id === 'frigate-mobiledet-edgetpu')
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.format).toBe('tflite')
    expect(entry.url).toBe(
      'https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite',
    )
    expect(entry.inputSize).toBe(320)
    expect(entry.postprocessor).toBe('ssd')
    // plus catalog's COCO-91 labelmap, order = class index (0 = person).
    expect(entry.labels[0]).toBe('person')
    expect(entry.labels[2]).toBe('car')
    expect(entry.labels.length).toBeGreaterThanOrEqual(90)
  })

  it('builds a registrable descriptor with the PUBLIC url (nodes download on demand)', () => {
    const d = buildPlusCatalogCatalogDescriptor('frigate-mobiledet-edgetpu')
    expect(d.stepId).toBe('object-detection')
    expect(d.entry.formats.tflite?.url).toMatch(/^https:\/\/github\.com\/google-coral/)
    expect(d.entry.postprocessor).toBe('ssd')
    expect(d.entry.inputSize).toEqual({ width: 320, height: 320 })
    expect(d.entry.labels[0]).toEqual({ id: 'person', name: 'person' })
    expect(d.entry.provider).toBe('frigate')
    expect(d.entry.group).toEqual({
      family: 'ssdlite-mobiledet',
      tier: 'default',
      resolution: 320,
    })
  })

  it('throws on an unknown catalog id', () => {
    expect(() => buildPlusCatalogCatalogDescriptor('no-such')).toThrow(/catalog/i)
  })
})

const VALID_KEY = `${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}:${'f'.repeat(40)}`

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

function fakeFetch(routes: Record<string, unknown>): { calls: string[]; fetch: FetchLike } {
  const calls: string[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push(
      `${url}|auth=${init?.headers?.['authorization'] ?? init?.headers?.['Authorization'] ?? ''}`,
    )
    const body = routes[url]
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { calls, fetch }
}

describe('frigate-plus client', () => {
  it('validates the documented key format', () => {
    expect(isValidPlusApiKey(VALID_KEY)).toBe(true)
    expect(isValidPlusApiKey('not-a-key')).toBe(false)
    expect(isValidPlusApiKey('')).toBe(false)
  })

  it('exchanges the key for a token via GET /v1/auth/token with basic auth', async () => {
    const { calls, fetch } = fakeFetch({
      'https://api.frigate.video/v1/auth/token': { accessToken: 'tok123', expires: 9999999999 },
    })
    const token = await fetchPlusAccessToken(fetch, VALID_KEY)
    expect(token).toBe('tok123')
    const [userPart, passPart] = VALID_KEY.split(':')
    const expectedBasic = `Basic ${Buffer.from(`${userPart}:${passPart}`).toString('base64')}`
    expect(calls[0]).toBe(`https://api.frigate.video/v1/auth/token|auth=${expectedBasic}`)
  })

  it('rejects a malformed key BEFORE any network call', async () => {
    const { calls, fetch } = fakeFetch({})
    await expect(fetchPlusAccessToken(fetch, 'garbage')).rejects.toThrow(/key/i)
    expect(calls).toEqual([])
  })

  it('lists models with the Bearer token — the REAL contract wraps them in { list: [...] } (plus-catalog/api/app.py reads models["list"])', async () => {
    const { calls, fetch } = fakeFetch({
      'https://api.frigate.video/v1/auth/token': { accessToken: 'tok123', expires: 9999999999 },
      'https://api.frigate.video/v1/model/list': {
        list: [
          {
            id: 'abc123',
            name: 'My yard model',
            type: 'yolonas',
            isBaseModel: false,
            baseModel: 'yolonas-2024',
            supportedDetectors: ['onnx', 'openvino'],
            trainDate: '2026-08-01T00:00:00Z',
            width: 320,
            height: 320,
          },
          {
            id: 'base01',
            name: 'YOLOv9 base',
            type: 'yolov9',
            isBaseModel: true,
            baseModel: 'yolov9-2025',
            supportedDetectors: ['onnx'],
            trainDate: '2026-07-01T00:00:00Z',
            width: 320,
            height: 320,
          },
        ],
      },
    })
    const models = await listPlusModels(fetch, VALID_KEY)
    expect(models.map((m) => m.id)).toEqual(['abc123', 'base01'])
    expect(models[0]).toMatchObject({
      isBaseModel: false,
      baseModel: 'yolonas-2024',
      supportedDetectors: ['onnx', 'openvino'],
      trainDate: '2026-08-01T00:00:00Z',
    })
    expect(models[1]?.isBaseModel).toBe(true)
    expect(calls[1]).toContain('|auth=Bearer tok123')
  })

  it('resolves info + signed download url for one model', async () => {
    const { fetch } = fakeFetch({
      'https://api.frigate.video/v1/auth/token': { accessToken: 'tok123', expires: 9999999999 },
      'https://api.frigate.video/v1/model/abc123': {
        id: 'abc123',
        type: 'yolonas',
        width: 320,
        height: 320,
        labelMap: { '0': 'person', '1': 'car' },
      },
      'https://api.frigate.video/v1/model/abc123/signed_url': { url: 'https://cdn/x.onnx' },
    })
    const dl = await requestPlusModelDownload(fetch, VALID_KEY, 'abc123')
    expect(dl.downloadUrl).toBe('https://cdn/x.onnx')
    expect(dl.info.type).toBe('yolonas')
  })
})

describe('plusInfoToDescriptor', () => {
  it('maps a yolonas model to onnx + the yolonas decode with the API labelmap in index order', () => {
    const d = plusInfoToDescriptor(
      {
        id: 'abc123',
        type: 'yolonas',
        width: 320,
        height: 320,
        labelMap: { '1': 'car', '0': 'person' },
      },
      {
        modelId: 'my-plus-model',
        name: 'My Plus Model',
        filename: 'my-plus-model.onnx',
        sizeMB: 49,
      },
    )
    expect(d.stepId).toBe('object-detection')
    expect(d.entry.formats.onnx?.url).toBe('camstack-local://my-plus-model/my-plus-model.onnx')
    expect(d.entry.postprocessor).toBe('yolonas')
    expect(d.entry.inputSize).toEqual({ width: 320, height: 320 })
    expect(d.entry.labels.map((l) => l.id)).toEqual(['person', 'car'])
    expect(d.entry.provider).toBe('frigate')
    expect(d.entry.group).toEqual({
      family: 'yolonas',
      tier: 'default',
      resolution: 320,
    })
  })

  it('maps mobiledet to tflite + ssd, and yolov9 onnx to the yolo decode', () => {
    const mobiledet = plusInfoToDescriptor(
      { id: 'm1', type: 'mobiledet', width: 320, height: 320, labelMap: { '0': 'person' } },
      { modelId: 'plus-mobiledet', name: 'x', filename: 'plus-mobiledet.tflite', sizeMB: 5 },
    )
    expect(mobiledet.entry.formats.tflite).toBeDefined()
    expect(mobiledet.entry.postprocessor).toBe('ssd')

    const yolov9 = plusInfoToDescriptor(
      { id: 'y1', type: 'yolov9', width: 320, height: 320, labelMap: { '0': 'person' } },
      { modelId: 'plus-y9', name: 'y', filename: 'plus-y9.onnx', sizeMB: 25 },
    )
    expect(yolov9.entry.formats.onnx).toBeDefined()
    expect(yolov9.entry.postprocessor).toBe('yolo')
  })

  it('fills labelmap index holes so the logit order stays aligned', () => {
    const d = plusInfoToDescriptor(
      {
        id: 'h1',
        type: 'yolonas',
        width: 320,
        height: 320,
        labelMap: { '0': 'person', '2': 'dog' },
      },
      { modelId: 'holes', name: 'h', filename: 'holes.onnx', sizeMB: 1 },
    )
    expect(d.entry.labels.map((l) => l.id)).toEqual(['person', 'unknown-1', 'dog'])
  })
})
