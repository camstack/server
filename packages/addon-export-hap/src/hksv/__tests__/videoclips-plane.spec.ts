/**
 * The two data-plane routes the HomeKit clip source answers with.
 *
 * `/addon/export-hap/hksv-clip/<deviceId>/<stem>.mp4` — the teed fMP4 itself,
 * with `Range`, streamed off the disk it was written to. Bytes NEVER travel
 * through a cap call (D9/D18): the cap answers a URL and this route produces
 * the bytes, in the same process that wrote them, so there is no cross-runner
 * hand-off and no 50 MiB buffer anywhere.
 *
 * `/addon/export-hap/hksv-clip-thumb/<deviceId>/<stem>.jpg` — the VOUCHED
 * still. It is only ever offered for a JPEG the store already stat'd, so this
 * route has no mint path and a miss is a plain 404, not a 204-with-a-reason:
 * nothing re-mints a teed clip.
 *
 * Driven through a REAL `http` server against REAL files, because `Range` is
 * the whole point of the route and a fake `ServerResponse` would only prove the
 * handler agrees with the fake.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHksvClipPlanes } from '../videoclips-plane.js'

const DEVICE_ID = 101
const STEM = 'hksv_101_1789000000000-3'
const CLIP_BYTES = Buffer.from('0123456789abcdef', 'utf8')

interface LogLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
  readonly tags?: Record<string, unknown>
}

let logs: LogLine[] = []

function logger(): IScopedLogger {
  const record =
    (level: string) =>
    (message: string, payload?: LogPayload): void => {
      logs.push({ level, message, meta: payload?.meta ?? {}, tags: payload?.tags ?? {} })
    }
  const log = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: the routes only ever call these six.
  return log as unknown as IScopedLogger
}

let root = ''
let server: Server | null = null
let base = ''

async function serve(kind: 'media' | 'thumb'): Promise<void> {
  const planes = createHksvClipPlanes({
    logger: logger(),
    artifactPath: async (deviceId, stem, artifact) => {
      if (!Number.isFinite(deviceId)) return null
      return join(root, String(deviceId), `${stem}${artifact === 'clip' ? '.mp4' : '.jpg'}`)
    },
  })
  const handler = kind === 'media' ? planes.mediaHandler : planes.thumbHandler
  const created = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve))
  server = created
  const address = created.address()
  const port =
    typeof address === 'string' || address === null ? 0 : (address satisfies AddressInfo).port
  base = `http://127.0.0.1:${String(port)}`
}

beforeEach(async () => {
  logs = []
  root = await mkdtemp(join(tmpdir(), 'hksv-plane-'))
  await mkdir(join(root, String(DEVICE_ID)), { recursive: true })
  await writeFile(join(root, String(DEVICE_ID), `${STEM}.mp4`), CLIP_BYTES)
  await writeFile(join(root, String(DEVICE_ID), `${STEM}.jpg`), Buffer.from('jpeg'))
})

afterEach(async () => {
  if (server !== null) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
  await rm(root, { recursive: true, force: true })
})

describe('the clip media route', () => {
  it('serves the whole file and ADVERTISES ranges', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(CLIP_BYTES.byteLength))
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CLIP_BYTES)
  })

  it('answers a RANGE with 206 and exactly those bytes', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, {
      headers: { range: 'bytes=4-7' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 4-7/${String(CLIP_BYTES.byteLength)}`)
    expect(await res.text()).toBe('4567')
  })

  it('answers an open-ended and a suffix range', async () => {
    await serve('media')
    const open = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, {
      headers: { range: 'bytes=12-' },
    })
    expect(open.status).toBe(206)
    expect(await open.text()).toBe('cdef')
    const suffix = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, {
      headers: { range: 'bytes=-4' },
    })
    expect(suffix.status).toBe(206)
    expect(await suffix.text()).toBe('cdef')
  })

  it('answers 416 for a range past the end — never a silently empty 206', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, {
      headers: { range: 'bytes=9999-' },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${String(CLIP_BYTES.byteLength)}`)
  })

  it('answers HEAD with the size and no body', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(CLIP_BYTES.byteLength))
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('404s a clip that is not there, and SAYS so with the device tagged', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/hksv_101_1-9.mp4`)
    expect(res.status).toBe(404)
    expect(logs.some((l) => l.level === 'warn' && l.tags['deviceId'] === DEVICE_ID)).toBe(true)
  })

  it('refuses a path that is not a device id and a stem', async () => {
    await serve('media')
    expect((await fetch(`${base}/101/../../etc/passwd.mp4`)).status).toBe(400)
    expect((await fetch(`${base}/not-a-device/${STEM}.mp4`)).status).toBe(400)
    expect((await fetch(`${base}/101/${STEM}.mov`)).status).toBe(400)
  })

  it('refuses a method that is not a read', async () => {
    await serve('media')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.mp4`, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('GET')
  })
})

describe('the clip thumbnail route', () => {
  it('serves the vouched JPEG as immutable', async () => {
    await serve('thumb')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/${STEM}.jpg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(String(res.headers.get('cache-control'))).toContain('immutable')
    expect(await res.text()).toBe('jpeg')
  })

  it('404s a still that is gone — there is no mint to fall back on', async () => {
    await serve('thumb')
    const res = await fetch(`${base}/${String(DEVICE_ID)}/hksv_101_1-9.jpg`)
    expect(res.status).toBe(404)
  })
})
