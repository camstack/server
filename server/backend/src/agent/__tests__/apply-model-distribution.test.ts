import { describe, it, expect, vi } from 'vitest'
import {
  applyModelDistribution,
  type ModelDistributionSeam,
  type DistributeModelParams,
} from '../apply-model-distribution.js'

const params: DistributeModelParams = {
  modelId: 'ov-model',
  format: 'openvino',
  source: { url: 'https://hub/api/addons/deploy-bundle/x', token: 't', sha256: 'abc', bytes: 3 },
}

function seam(over: Partial<ModelDistributionSeam> = {}): ModelDistributionSeam {
  return {
    modelsDir: '/data/models',
    fetchBundle: async () => Buffer.from('tgz'),
    extract: async () => undefined,
    mkdirp: () => undefined,
    ...over,
  }
}

describe('applyModelDistribution', () => {
  it('fetches, extracts into modelsDir, and reports success', async () => {
    const extract = vi.fn(async () => undefined)
    const mkdirp = vi.fn()
    const res = await applyModelDistribution(seam({ extract, mkdirp }), params)
    expect(mkdirp).toHaveBeenCalledWith('/data/models')
    expect(extract).toHaveBeenCalledWith(Buffer.from('tgz'), '/data/models')
    expect(res).toEqual({
      success: true,
      modelId: 'ov-model',
      format: 'openvino',
      path: '/data/models',
    })
  })

  it('propagates a fetch failure (sha256/bytes mismatch) without extracting', async () => {
    const extract = vi.fn()
    await expect(
      applyModelDistribution(
        seam({
          fetchBundle: async () => {
            throw new Error('bundle sha256 mismatch')
          },
          extract,
        }),
        params,
      ),
    ).rejects.toThrow(/sha256 mismatch/)
    expect(extract).not.toHaveBeenCalled()
  })
})
