/**
 * The media route: what reaches the filesystem, and what `Range` answers.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'

import { ClipArtifactStore } from '../clip-artifact-store.js'
import {
  CLIP_FILE_REASON_CODE_HEADER,
  clipFileRefusalStatus,
  createClipPlaybackHandler,
  parseRange,
  type ClipFileRefusal,
} from '../clip-data-plane.js'
import { CLIP_STILL_REASON_HEADER } from '@camstack/types'

/** A logger fake — the documented type boundary a test double needs. */
function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

interface RouteProbe {
  readonly status: number
  readonly asked: readonly string[]
  readonly headers: Record<string, string>
}

async function ask(
  url: string,
  refusal: ClipFileRefusal = { code: 'catalog-miss', detail: 'nothing by that name' },
): Promise<RouteProbe> {
  const asked: string[] = []
  const handler = createClipPlaybackHandler({
    logger: makeLogger(),
    resolvePath: async (deviceId, clipKey) => {
      asked.push(`${String(deviceId)}|${clipKey}`)
      return { kind: 'refused', refusal }
    },
  })
  let status = 0
  let headers: Record<string, string> = {}
  const res = {
    writeHead: (code: number, given?: Record<string, string>) => {
      status = code
      headers = given ?? {}
    },
    end: () => {},
  } as unknown as ServerResponse
  await handler({ method: 'GET', url, headers: {} } as unknown as IncomingMessage, res)
  return { status, asked, headers }
}

describe('the media route', () => {
  it('reaches the resolver only for a well-formed device and window key', async () => {
    const probe = await ask('/3836/1790151808-1790151882.mp4')
    expect(probe.asked).toEqual(['3836|1790151808-1790151882'])
  })

  it('refuses a traversal segment BEFORE anything touches the filesystem', async () => {
    // This segment arrives from a URL. `..` in it is a read outside the
    // scratch, so it never becomes a resolver call at all.
    for (const url of [
      '/3836/..%2f..%2fetc%2fpasswd.mp4',
      '/3836/../../secret.mp4',
      '/3836/abc-def.mp4',
      '/3836/1790151808.mp4',
      '/notadevice/1-2.mp4',
    ]) {
      const probe = await ask(url)
      expect(probe.status).toBe(400)
      expect(probe.asked).toEqual([])
    }
  })

  /**
   * D617. The operator asked for a 106 MB clip, waited 228.6 s and got
   * `HTTP 404, 0 bytes` — with the provider having named the reason on a WARN
   * line at the same instant. A bare 404 is what a typo in the URL gets, so
   * "the camera's own copy of this recording is damaged" reached nobody and
   * was read as a size limit.
   */
  it('carries the refusal REASON and a status that is not 404 for a camera fault', async () => {
    const probe = await ask('/3836/1790168287-1790168435.mp4', {
      code: 'camera-refused',
      detail: 'the camera delivered all 105971106 bytes it declared — they are not a container',
    })
    expect(probe.status).toBe(502)
    expect(probe.headers[CLIP_STILL_REASON_HEADER]).toContain('105971106')
    expect(probe.headers[CLIP_FILE_REASON_CODE_HEADER]).toBe('camera-refused')
  })

  it('answers 404 ONLY for a clip this node has no row for', async () => {
    const probe = await ask('/3836/1790168287-1790168435.mp4', {
      code: 'catalog-miss',
      detail: 'list the window that holds this clip first',
    })
    expect(probe.status).toBe(404)
    expect(probe.headers[CLIP_FILE_REASON_CODE_HEADER]).toBe('catalog-miss')
  })

  it('maps each refusal code to a status that means what it says', () => {
    expect(clipFileRefusalStatus('catalog-miss')).toBe(404)
    expect(clipFileRefusalStatus('camera-refused')).toBe(502)
    expect(clipFileRefusalStatus('fetch-failed')).toBe(502)
    expect(clipFileRefusalStatus('too-large-to-transfer')).toBe(413)
  })

  it('answers 405 for a write verb', async () => {
    const handler = createClipPlaybackHandler({
      logger: makeLogger(),
      resolvePath: async () => ({
        kind: 'refused',
        refusal: { code: 'catalog-miss', detail: 'nothing by that name' },
      }),
    })
    let status = 0
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: () => {},
    } as unknown as ServerResponse
    await handler(
      { method: 'DELETE', url: '/3836/1-2.mp4', headers: {} } as unknown as IncomingMessage,
      res,
    )
    expect(status).toBe(405)
  })
})

describe('ClipArtifactStore key safety', () => {
  it('accepts only a `<startSec>-<endSec>` key', () => {
    expect(ClipArtifactStore.isSafeKey('1790151808-1790151882')).toBe(true)
    expect(ClipArtifactStore.isSafeKey('../../etc/passwd')).toBe(false)
    expect(ClipArtifactStore.isSafeKey('abc-def')).toBe(false)
    expect(ClipArtifactStore.isSafeKey('')).toBe(false)
  })

  it('refuses to reserve a path for an unsafe key', async () => {
    const store = new ClipArtifactStore({ root: '/tmp/does-not-matter' })
    await expect(store.reserve(1, '../../escape')).rejects.toThrow(/not a safe artifact key/)
    expect(await store.pathIfPresent(1, '../../escape')).toBeNull()
  })
})

describe('parseRange', () => {
  it('reads the three real forms', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('calls a range past the end unsatisfiable rather than empty', () => {
    // A player that asked past the end must learn it did, not receive zero
    // bytes that look like the end of the file.
    expect(parseRange('bytes=2000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })

  it('treats an absent or unreadable header as "the whole file"', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })
})
