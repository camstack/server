/**
 * The downloader tells one observer whether Hugging Face ANSWERED, so the hub
 * can raise "cannot be reached" without a poller of its own. A 404 is a missing
 * file (the host answered); a thrown fetch or a 5xx is an outage.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadFile,
  setHuggingFaceReachabilityObserver,
  type HuggingFaceReachabilityOutcome,
} from '../model-downloader.js'

const HF_URL = 'https://huggingface.co/camstack/camstack-models/resolve/main/m.onnx'

describe('model downloader — Hugging Face reachability', () => {
  let dir: string
  let heard: HuggingFaceReachabilityOutcome[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reach-'))
    heard = []
    setHuggingFaceReachabilityObserver((outcome) => heard.push(outcome))
  })

  afterEach(() => {
    setHuggingFaceReachabilityObserver(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a thrown fetch as not reached', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND huggingface.co')
    }
    await expect(downloadFile(HF_URL, path.join(dir, 'a.onnx'), { fetchImpl })).rejects.toThrow()
    expect(heard).toEqual([{ reached: false, detail: 'getaddrinfo ENOTFOUND huggingface.co' }])
  })

  it('reports a 503 as not reached', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', { status: 503 })
    await expect(downloadFile(HF_URL, path.join(dir, 'b.onnx'), { fetchImpl })).rejects.toThrow()
    expect(heard).toEqual([{ reached: false, detail: 'HTTP 503' }])
  })

  it('reports a 404 as reached: the host answered', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', { status: 404 })
    await expect(downloadFile(HF_URL, path.join(dir, 'c.onnx'), { fetchImpl })).rejects.toThrow()
    expect(heard).toEqual([{ reached: true, detail: 'HTTP 404' }])
  })

  it('stays silent for a host that is not Hugging Face', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('down')
    }
    await expect(
      downloadFile('https://example.com/m.onnx', path.join(dir, 'd.onnx'), { fetchImpl }),
    ).rejects.toThrow()
    expect(heard).toEqual([])
  })
})
