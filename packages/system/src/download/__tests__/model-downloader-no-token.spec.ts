/**
 * No Hugging Face token is ever read from the environment (operator rule: no
 * secret travels through env). The CamStack model repos are public, so a
 * download to huggingface.co carries no Authorization header — even when a
 * stray `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` is set on the host.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadFile } from '../model-downloader.js'

const ENV_KEYS = ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'] as const

describe('model downloader — no Hugging Face token from the environment', () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-no-token-'))
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      process.env[k] = 'hf_env_secret'
    }
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('sends no Authorization header to huggingface.co', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as typeof fetch
    await downloadFile(
      'https://huggingface.co/camstack/models/resolve/main/model.onnx',
      path.join(dir, 'model.onnx'),
      { fetchImpl },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.['Authorization']).toBeUndefined()
    expect(seen[0]?.['User-Agent']).toBe('CamStack/1.0')
  })
})
