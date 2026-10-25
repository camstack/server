import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ModelCatalogEntry, ModelDistributeInput } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  distributeModelWith,
  type ModelDistributorSeam,
  tarModelFiles,
} from '../model-distributor.js'

const entry: ModelCatalogEntry = {
  id: 'ov-model',
  name: 'OV',
  description: '',
  inputSize: { width: 640, height: 640 },
  labels: [],
  formats: {
    openvino: {
      url: 'http://x/camstack-ov-model.xml',
      sizeMB: 1,
      files: ['camstack-ov-model.bin'],
    },
  },
}

function baseSeam(over: Partial<ModelDistributorSeam> = {}): ModelDistributorSeam {
  return {
    modelsDir: '/data/models',
    isPresent: () => true,
    fileExists: () => true,
    tar: async () => Buffer.from('tgz'),
    stage: async () => ({
      url: 'https://hub/api/addons/deploy-bundle/x',
      token: 't',
      sha256: 'abc',
      bytes: 3,
    }),
    callAgent: async () => ({ path: '/data/models' }),
    ...over,
  }
}

const input: ModelDistributeInput = {
  targetNodeId: 'agent-a',
  modelId: 'ov-model',
  format: 'openvino',
  entry,
}

describe('distributeModelWith', () => {
  it('no-ops for the hub target (already resident)', async () => {
    const callAgent = vi.fn()
    const res = await distributeModelWith(baseSeam({ callAgent }), {
      ...input,
      targetNodeId: 'hub',
    })
    expect(res).toEqual({ ok: true, sha256: '', bytes: 0, path: '/data/models' })
    expect(callAgent).not.toHaveBeenCalled()
  })

  it('throws when the format is not present on the hub', async () => {
    await expect(distributeModelWith(baseSeam({ isPresent: () => false }), input)).rejects.toThrow(
      /not present on hub/,
    )
  })

  it('tars + stages + triggers the agent pull and returns the staged digest', async () => {
    const tar = vi.fn(async () => Buffer.from('tgz'))
    const callAgent = vi.fn(async () => ({ path: '/agent/data/models' }))
    const res = await distributeModelWith(baseSeam({ tar, callAgent }), input)
    expect(tar).toHaveBeenCalledWith(['camstack-ov-model.xml', 'camstack-ov-model.bin'])
    expect(callAgent).toHaveBeenCalledWith('agent-a', {
      modelId: 'ov-model',
      format: 'openvino',
      source: expect.objectContaining({ sha256: 'abc', bytes: 3 }),
    })
    expect(res).toEqual({ ok: true, sha256: 'abc', bytes: 3, path: '/agent/data/models' })
  })
})

describe('tarModelFiles', () => {
  it('produces a gzip tar that round-trips the files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tar-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.xml'), 'AAA')
      fs.writeFileSync(path.join(dir, 'a.bin'), 'BBB')
      const buf = await tarModelFiles(dir, ['a.xml', 'a.bin'])
      expect(buf.length).toBeGreaterThan(0)
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-untar-'))
      fs.writeFileSync(path.join(out, 'b.tgz'), buf)
      execFileSync('tar', ['-xzf', path.join(out, 'b.tgz'), '-C', out])
      expect(fs.readFileSync(path.join(out, 'a.xml'), 'utf8')).toBe('AAA')
      expect(fs.readFileSync(path.join(out, 'a.bin'), 'utf8')).toBe('BBB')
      fs.rmSync(out, { recursive: true, force: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
