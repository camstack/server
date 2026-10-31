import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, Notification } from '../../index.js'
import {
  publicEndpointReaderFrom,
  type PublicEndpointReader,
  resolveAttachmentUrls,
} from '../attachment-url.js'

const base = (url: string): Notification => ({
  body: 'x',
  format: 'text',
  priority: 3,
  deviceId: 42,
  attachments: [{ mediaType: 'image', url }],
})
const logger = () => {
  const log: IScopedLogger & { warn: ReturnType<typeof vi.fn> } = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  }
  return log
}
const resolved: PublicEndpointReader = async () => ({
  kind: 'resolved',
  origin: 'https://hub.example.com',
})

describe('resolveAttachmentUrls', () => {
  it('makes a root-relative url absolute on the public endpoint', async () => {
    const out = await resolveAttachmentUrls({
      notification: base('/addon/notifiers/samples/image'),
      readPublicEndpoint: resolved,
    })
    expect(out.attachments?.[0]?.url).toBe('https://hub.example.com/addon/notifiers/samples/image')
  })

  it('leaves an absolute url untouched and never reads the palette', async () => {
    const read = vi.fn(resolved)
    const n = base('https://cdn.example.com/a.jpg')
    const out = await resolveAttachmentUrls({ notification: n, readPublicEndpoint: read })
    expect(out).toBe(n)
    expect(read).not.toHaveBeenCalled()
  })

  it('drops the attachment with a named reason when no public endpoint exists', async () => {
    const log = logger()
    const out = await resolveAttachmentUrls({
      notification: base('/a/b'),
      readPublicEndpoint: async () => ({ kind: 'none' }),
      logger: log,
    })
    expect(out.attachments).toEqual([])
    expect(out.body).toBe('x')
    expect(log.warn.mock.calls[0]?.[0]).toContain('no-public-endpoint')
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({ tags: { deviceId: 42 } })
  })

  it('drops with a DIFFERENT reason when the read failed', async () => {
    const log = logger()
    const out = await resolveAttachmentUrls({
      notification: base('/a/b'),
      readPublicEndpoint: async () => ({ kind: 'failed', error: 'boom' }),
      logger: log,
    })
    expect(out.attachments).toEqual([])
    expect(log.warn.mock.calls[0]?.[0]).toContain('public-endpoint-read-failed: boom')
    expect(log.warn.mock.calls[0]?.[0]).not.toContain('no-public-endpoint')
  })
})

describe('publicEndpointReaderFrom', () => {
  it('maps resolved / null / rejection to the three readings', async () => {
    const mk = (q: () => Promise<{ roles: { publicEndpoint: { resolved: string | null } } }>) =>
      publicEndpointReaderFrom({ getAddresses: { query: q } })()
    expect(
      await mk(async () => ({ roles: { publicEndpoint: { resolved: 'https://h' } } })),
    ).toEqual({
      kind: 'resolved',
      origin: 'https://h',
    })
    expect(await mk(async () => ({ roles: { publicEndpoint: { resolved: null } } }))).toEqual({
      kind: 'none',
    })
    expect(
      await mk(async () => {
        throw new Error('down')
      }),
    ).toEqual({ kind: 'failed', error: 'down' })
  })
})
