import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  deleteMapImage,
  getMapBaseUrl,
  serveMapImage,
  setMapBaseUrl,
  setMapImage,
} from '../dreame-map-store.js'

interface ResCapture {
  res: ServerResponse
  status: number | null
  headers: Record<string, unknown> | null
  body: unknown
}

/** Minimal ServerResponse capture — records writeHead status/headers + the body. */
function fakeRes(): ResCapture {
  const cap: ResCapture = {
    res: null as unknown as ServerResponse,
    status: null,
    headers: null,
    body: undefined,
  }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      cap.status = status
      cap.headers = headers ?? {}
      return res
    },
    end(chunk?: unknown) {
      cap.body = chunk
      return res
    },
  } as unknown as ServerResponse
  cap.res = res
  return cap
}

function reqFor(url: string): IncomingMessage {
  return { url } as IncomingMessage
}

describe('dreame-map-store base url', () => {
  it('round-trips the client base url and clears to null', () => {
    setMapBaseUrl('/addon/provider-dreame/map')
    expect(getMapBaseUrl()).toBe('/addon/provider-dreame/map')
    setMapBaseUrl(null)
    expect(getMapBaseUrl()).toBeNull()
  })
})

describe('serveMapImage', () => {
  it('404s when no map is cached for the requested did', () => {
    deleteMapImage('missing')
    const cap = fakeRes()
    serveMapImage(reqFor('/map?did=missing'), cap.res)
    expect(cap.status).toBe(404)
  })

  it('404s when the request carries no did', () => {
    const cap = fakeRes()
    serveMapImage(reqFor('/map'), cap.res)
    expect(cap.status).toBe(404)
  })

  it('streams the cached PNG with an image/png content-type', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    setMapImage('d1', { bytes: png, contentType: 'image/png', ts: 123 })
    const cap = fakeRes()
    serveMapImage(reqFor('/map?did=d1'), cap.res)
    expect(cap.status).toBe(200)
    expect(cap.headers?.['content-type']).toBe('image/png')
    expect(cap.body).toBe(png)
    deleteMapImage('d1')
  })

  it('streams the cached SVG (mower) with an image/svg+xml content-type', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')
    setMapImage('m1', { bytes: svg, contentType: 'image/svg+xml', ts: 7 })
    const cap = fakeRes()
    serveMapImage(reqFor('/map?did=m1'), cap.res)
    expect(cap.status).toBe(200)
    expect(cap.headers?.['content-type']).toBe('image/svg+xml')
    expect(cap.body).toBe(svg)
    deleteMapImage('m1')
  })
})
