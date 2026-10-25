/**
 * `offerRetrainArchive`'s body: the archive written into the ticket's HTTP
 * response. Pinned against a real loopback server and client: every chunk
 * arrives in order, a reader that stops reading is waited for (write()'s
 * return is honoured), and a client that goes away fails the writer instead
 * of buffering the rest of the dataset in memory.
 */
import { createServer, get, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { responseArchiveSink, serveRetrainArchive } from '../retrain-archive-offer.js'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string }> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/` }
}

function fetchAll(url: string): Promise<{ status: number; body: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          type: String(res.headers['content-type']),
        }),
      )
      res.on('error', reject)
    }).on('error', reject)
  })
}

describe('retrain archive offer', () => {
  it('streams every chunk, in order, as a tar body', async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => Buffer.alloc(64 * 1024, i))
    const done: { error: unknown } = { error: undefined }
    const { url } = await serve((req, res) => {
      serveRetrainArchive(req, res, async (sink) => {
        for (const c of chunks) await sink.write(c)
      }).catch((err: unknown) => {
        done.error = err
      })
    })
    const got = await fetchAll(url)
    expect(got.status).toBe(200)
    expect(got.type).toBe('application/x-tar')
    expect(got.body.equals(Buffer.concat(chunks))).toBe(true)
    expect(done.error).toBeUndefined()
  })

  it('fails the writer when the reader goes away instead of buffering', async () => {
    let failure: unknown = null
    let wrote = 0
    const finished = new Promise<void>((resolve) => {
      void serve((_req, res) => {
        const sink = responseArchiveSink(res)
        void (async () => {
          try {
            for (let i = 0; i < 10_000; i += 1) {
              await sink.write(Buffer.alloc(256 * 1024, 1))
              wrote += 1
            }
          } catch (err: unknown) {
            failure = err
          }
          resolve()
        })()
      }).then(({ url }) => {
        const req = get(url, (res) => {
          res.once('data', () => req.destroy())
        })
        req.on('error', () => undefined)
      })
    })
    await finished
    expect(failure).toBeInstanceOf(Error)
    expect(wrote).toBeLessThan(10_000)
  })
})
