/**
 * `writeRetrainArchive`'s target: ONE streamed HTTP request, the archive as
 * its body. Pinned against a real local server: the bytes arrive whole and in
 * order, the target's headers are sent, the method is honoured, and a non-2xx
 * answer is a failure, never a success with a status nobody reads.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openRetrainUploadSink } from '../retrain-archive-upload.js'

interface Received {
  method: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

let server: Server | null = null

async function listen(status: number): Promise<{ url: string; received: Promise<Received> }> {
  let resolveReceived: (r: Received) => void = () => {}
  const received = new Promise<Received>((resolve) => {
    resolveReceived = resolve
  })
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      resolveReceived({
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      res.writeHead(status)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/upload`, received }
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

describe('retrain archive upload sink', () => {
  it('streams every chunk, in order, with the target headers and method', async () => {
    const { url, received } = await listen(201)
    const upload = openRetrainUploadSink({
      kind: 'http',
      method: 'PUT',
      url,
      headers: { 'x-upload-id': 'abc' },
    })
    await upload.sink.write(Buffer.from('hello '))
    await upload.sink.write(Buffer.from('world'))
    const status = await upload.finish()

    const got = await received
    expect(status).toBe(201)
    expect(got.method).toBe('PUT')
    expect(got.headers['x-upload-id']).toBe('abc')
    expect(got.headers['content-type']).toBe('application/x-tar')
    expect(got.body.toString()).toBe('hello world')
  })

  it('a non-2xx answer fails the upload', async () => {
    const { url } = await listen(403)
    const upload = openRetrainUploadSink({ kind: 'http', method: 'POST', url })
    await upload.sink.write(Buffer.from('x'))
    await expect(upload.finish()).rejects.toThrow(/403/)
  })
})
