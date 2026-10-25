import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { uploadAddon, type MultipartFetch } from '../lib/upload-addon.js'

describe('uploadAddon', () => {
  let tmpDir: string
  let tarball: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-upload-'))
    tarball = path.join(tmpDir, 'fake-addon.tgz')
    fs.writeFileSync(tarball, 'not-a-real-tarball-but-bytes')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POSTs the tarball to /api/addons/upload with the Bearer header', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedMethod = ''
    const fakeFetch: MultipartFetch = async (url, init) => {
      capturedUrl = String(url)
      capturedMethod = init.method
      capturedHeaders = { ...init.headers }
      return new Response(JSON.stringify({ ok: true, id: 'new-addon-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const result = await uploadAddon({
      server: 'https://hub.example/',
      token: 'secret-token-xyz',
      tarballPath: tarball,
      fetchImpl: fakeFetch,
    })

    expect(capturedUrl).toBe('https://hub.example/api/addons/upload')
    expect(capturedMethod).toBe('POST')
    expect(capturedHeaders['Authorization']).toBe('Bearer secret-token-xyz')
    // The form-data library sets content-type with a boundary —
    // ensure it's present.
    const contentTypeKey = Object.keys(capturedHeaders).find(
      (k) => k.toLowerCase() === 'content-type',
    )
    expect(contentTypeKey).toBeDefined()
    expect(capturedHeaders[contentTypeKey!]).toMatch(/^multipart\/form-data; boundary=/)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, id: 'new-addon-1' })
  })

  it('throws when the tarball does not exist', async () => {
    await expect(
      uploadAddon({
        server: 'https://hub',
        token: 't',
        tarballPath: path.join(tmpDir, 'missing.tgz'),
        fetchImpl: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toThrow(/tarball not found/)
  })

  it('throws on non-2xx with the server-provided body in the message', async () => {
    const fakeFetch: MultipartFetch = async () =>
      new Response(JSON.stringify({ error: 'manifest invalid' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      uploadAddon({
        server: 'https://hub',
        token: 't',
        tarballPath: tarball,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/HTTP 400.*manifest invalid/)
  })

  it('parses non-JSON server responses as plain text', async () => {
    const fakeFetch: MultipartFetch = async () =>
      new Response('plain text response', { status: 200 })
    const result = await uploadAddon({
      server: 'https://hub',
      token: 't',
      tarballPath: tarball,
      fetchImpl: fakeFetch,
    })
    expect(result.body).toBe('plain text response')
  })

  it('strips trailing slashes from the server URL when composing the endpoint', async () => {
    let capturedUrl = ''
    const fakeFetch: MultipartFetch = async (url) => {
      capturedUrl = String(url)
      return new Response('{}', { status: 200 })
    }
    await uploadAddon({
      server: 'https://hub.example///',
      token: 't',
      tarballPath: tarball,
      fetchImpl: fakeFetch,
    })
    expect(capturedUrl).toBe('https://hub.example/api/addons/upload')
  })
})
