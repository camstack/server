/**
 * The GGUF download loop, against a REAL local HTTP server.
 *
 * A fake `fetch` would prove nothing here: what is being asserted is the
 * behaviour of the shared `downloadFile` over a real socket — that it follows
 * a redirect, that it streams, and above all that an interrupted transfer
 * leaves NO partial file behind. That last one cannot be faked, because the
 * thing that could go wrong is a `.downloading` temp file surviving a
 * destroyed socket and then being renamed over a good model on the retry.
 *
 * `127.0.0.1` on an ephemeral port; nothing reaches the network.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ModelCatalogEntry } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- the revision rule is the shared downloader's (build-time dep, as in model-ops.ts)
import { resolveFormatRevision } from '@camstack/system/addon-utils'
import { LLM_MODEL_CATALOG } from '../runtime/llm-model-catalog.js'
import { createDefaultModelOps, planFiles } from '../runtime/model-ops.js'
import type { ModelDownloadProgress } from '../runtime/runtime-provider.js'

const MAIN_BODY = Buffer.alloc(64 * 1024, 7)
const PROJ_BODY = Buffer.alloc(16 * 1024, 9)

interface Harness {
  readonly base: string
  readonly modelsDir: string
  /** Kills the connection after this many bytes of the main file. */
  cutMainAfter: number | null
  mainRequests: number
}

let server: Server
let harness: Harness
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'camstack-gguf-'))
  const state: { cutMainAfter: number | null; mainRequests: number } = {
    cutMainAfter: null,
    mainRequests: 0,
  }
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    // A 302 to the real location — HF always redirects `resolve` to a CDN.
    if (url === '/main.gguf') {
      res.writeHead(302, { location: '/cdn/main.gguf' })
      res.end()
      return
    }
    if (url === '/cdn/main.gguf') {
      state.mainRequests += 1
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(MAIN_BODY.length) })
        res.end()
        return
      }
      res.writeHead(200, { 'content-length': String(MAIN_BODY.length) })
      if (state.cutMainAfter !== null) {
        res.write(MAIN_BODY.subarray(0, state.cutMainAfter))
        // Destroy the socket mid-body: the client sees a truncated stream.
        res.socket?.destroy()
        return
      }
      res.end(MAIN_BODY)
      return
    }
    if (url === '/mmproj-F16.gguf') {
      res.writeHead(200, { 'content-length': String(PROJ_BODY.length) })
      res.end(PROJ_BODY)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  harness = {
    base: `http://127.0.0.1:${String(port)}`,
    modelsDir: dir,
    get cutMainAfter() {
      return state.cutMainAfter
    },
    set cutMainAfter(v: number | null) {
      state.cutMainAfter = v
    },
    get mainRequests() {
      return state.mainRequests
    },
    set mainRequests(v: number) {
      state.mainRequests = v
    },
  }
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

/** A vision entry: main GGUF + an mmproj companion, the shape a resolved HF
 *  reference produces. */
function entry(base: string): ModelCatalogEntry {
  return {
    id: 'llm-custom-test',
    name: 'test',
    description: 'custom GGUF',
    formats: { gguf: { url: `${base}/main.gguf`, sizeMB: MAIN_BODY.length / (1024 * 1024) } },
    inputSize: { width: 0, height: 0 },
    labels: [],
    extraFiles: [
      {
        url: `${base}/mmproj-F16.gguf`,
        filename: 'mmproj-F16.gguf',
        sizeMB: PROJ_BODY.length / (1024 * 1024),
      },
    ],
  }
}

describe('planFiles', () => {
  it('puts the main weights first and the companions after', () => {
    const plan = planFiles('/models', entry('http://x'))
    expect(plan.map((f) => f.filename)).toEqual(['main.gguf', 'mmproj-F16.gguf'])
  })
})

describe('createDefaultModelOps.ensure', () => {
  it('follows a redirect and lands every file of the plan', async () => {
    const ops = createDefaultModelOps(harness.modelsDir)
    const seen: ModelDownloadProgress[] = []
    const result = await ops.ensure(entry(harness.base), (p) => seen.push(p))

    expect(result).toBe(path.join(harness.modelsDir, 'main.gguf'))
    expect(readFileSync(path.join(harness.modelsDir, 'main.gguf')).length).toBe(MAIN_BODY.length)
    expect(readFileSync(path.join(harness.modelsDir, 'mmproj-F16.gguf')).length).toBe(
      PROJ_BODY.length,
    )
    // No temp file survives a success.
    expect(readdirSync(harness.modelsDir).filter((f) => f.endsWith('.downloading'))).toEqual([])
  })

  it('reports progress for the COMPANION too, not only the main file', async () => {
    const ops = createDefaultModelOps(harness.modelsDir)
    const seen: ModelDownloadProgress[] = []
    await ops.ensure(entry(harness.base), (p) => seen.push(p))

    // The regression this guards: `ensureModel` downloaded extras with no
    // callback at all, so a 0.9 GB projector moved in total silence.
    expect(seen.some((p) => p.file === 'main.gguf')).toBe(true)
    expect(seen.some((p) => p.file === 'mmproj-F16.gguf')).toBe(true)
    expect(seen.every((p) => p.fileCount === 2)).toBe(true)

    // Bytes accumulate across the whole install and never go backwards.
    const bytes = seen.map((p) => p.downloadedBytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b))
    expect(Math.max(...bytes)).toBeGreaterThanOrEqual(MAIN_BODY.length)
  })

  it('leaves NO partial file when the transfer is cut, and a retry succeeds', async () => {
    harness.cutMainAfter = 1024
    const ops = createDefaultModelOps(harness.modelsDir)

    await expect(ops.ensure(entry(harness.base), () => {})).rejects.toThrow()

    // The failure must not leave anything a later start could mistake for the
    // model — neither a truncated `main.gguf` nor a stray `.downloading`.
    expect(existsSync(path.join(harness.modelsDir, 'main.gguf'))).toBe(false)
    expect(readdirSync(harness.modelsDir).filter((f) => f.includes('.downloading'))).toEqual([])

    harness.cutMainAfter = null
    await ops.ensure(entry(harness.base), () => {})
    expect(readFileSync(path.join(harness.modelsDir, 'main.gguf')).length).toBe(MAIN_BODY.length)
  })

  it('skips a file already on disk and leaves it out of the total', async () => {
    writeFileSync(path.join(harness.modelsDir, 'mmproj-F16.gguf'), PROJ_BODY)
    const ops = createDefaultModelOps(harness.modelsDir)
    const seen: ModelDownloadProgress[] = []
    await ops.ensure(entry(harness.base), (p) => seen.push(p))

    expect(seen.every((p) => p.fileCount === 1)).toBe(true)
    expect(seen.every((p) => p.file === 'main.gguf')).toBe(true)
    // A pre-existing file counted into `totalBytes` would park the bar at 25%
    // forever — the total must describe the work actually remaining.
    const totals = new Set(seen.map((p) => p.totalBytes))
    expect(totals).toEqual(new Set([MAIN_BODY.length]))
  })

  it('does not re-fetch on a second ensure', async () => {
    const ops = createDefaultModelOps(harness.modelsDir)
    await ops.ensure(entry(harness.base), () => {})
    const after = harness.mainRequests
    await ops.ensure(entry(harness.base), () => {})
    expect(harness.mainRequests).toBe(after)
  })
})

// D744 — `createDefaultModelOps` drives its own file loop (for multi-file
// progress) and never writes a revision record, so a GGUF format that RESOLVED
// a revision would read stale forever. GGUFs are third-party and checked by
// their own sha256 after download instead; this keeps it that way until the
// loop learns the revision contract.
describe('LLM catalog formats carry no revision', () => {
  it('no GGUF format resolves one', () => {
    const withRevision = LLM_MODEL_CATALOG.filter((m) => {
      const gguf = m.entry.formats.gguf
      return gguf !== undefined && resolveFormatRevision(gguf) !== undefined
    }).map((m) => m.meta.id)
    expect(withRevision).toEqual([])
  })
})
