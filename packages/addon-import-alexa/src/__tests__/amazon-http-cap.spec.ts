import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_RESPONSE_BYTES, readCappedBody } from '../amazon-auth/http.js'

describe('the Amazon response body cap', () => {
  it('reads a body under the cap', async () => {
    await expect(readCappedBody(Readable.from([Buffer.from('{"a":1}')]))).resolves.toBe('{"a":1}')
  })

  it('aborts a body above the cap', async () => {
    const chunk = Buffer.alloc(512 * 1024, 97)
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 10; i += 1) yield chunk
      })(),
    )
    expect(MAX_RESPONSE_BYTES).toBeLessThan(10 * chunk.length)
    await expect(readCappedBody(body)).rejects.toThrow(/too large/)
  })
})
