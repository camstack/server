import { createServer, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  buildHomematicConnectionTestProvider,
  CcuProbeError,
  httpPost,
  probeCcu,
  type CcuPost,
  type CcuProbeInput,
  type CcuProbeResult,
} from '../homematic-connection-test.js'
import { RecordingLogger } from './recording-logger.js'

const SECRET = 'S3cret-pass-word'

function provider(probe: (input: CcuProbeInput) => Promise<CcuProbeResult>) {
  const logger = new RecordingLogger()
  return {
    logger,
    run: buildHomematicConnectionTestProvider({ logger, probe }),
  }
}

const OK: CcuProbeResult = { interfaces: ['HmIP-RF', 'VirtualDevices'], namesUnlocked: true }

describe('testSettings outcomes', () => {
  it('rejects a missing or blank host without touching the network', async () => {
    const probe = vi.fn()
    const { run } = provider(probe)
    for (const settings of [{}, { host: '   ' }]) {
      const out = await run.testSettings({ settings })
      expect(out.outcome).toBe('rejected')
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects a username without a password (and the reverse): the library ignores half a login', async () => {
    const probe = vi.fn()
    const { run } = provider(probe)
    expect((await run.testSettings({ settings: { host: 'h', username: 'admin' } })).outcome).toBe(
      'rejected',
    )
    expect((await run.testSettings({ settings: { host: 'h', password: SECRET } })).outcome).toBe(
      'rejected',
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects a form with no interface enabled', async () => {
    const probe = vi.fn()
    const { run } = provider(probe)
    const out = await run.testSettings({
      settings: { host: 'h', enableHmipRf: false, enableGroups: false },
    })
    expect(out.outcome).toBe('rejected')
    expect(probe).not.toHaveBeenCalled()
  })

  it('validates, reporting the interfaces that answered and whether names are unlocked', async () => {
    const probe = vi.fn().mockResolvedValue(OK)
    const { run } = provider(probe)
    const out = await run.testSettings({
      settings: { host: ' 10.0.0.5 ', username: 'admin', password: SECRET, tls: true },
    })
    expect(out.outcome).toBe('validated')
    if (out.outcome === 'validated') {
      expect(out.detail).toContain('HmIP-RF')
      expect(out.detail).toContain('names and rooms')
    }
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '10.0.0.5',
        tls: true,
        username: 'admin',
        password: SECRET,
        interfaces: ['HmIP-RF', 'VirtualDevices'],
      }),
    )
  })

  it('says names stay raw addresses when no credentials were given', async () => {
    const { run } = provider(
      vi.fn().mockResolvedValue({ interfaces: ['HmIP-RF'], namesUnlocked: false }),
    )
    const out = await run.testSettings({ settings: { host: 'h' } })
    expect(out.outcome).toBe('validated')
    if (out.outcome === 'validated') expect(out.detail).toContain('no WebUI credentials')
  })

  it('rejects when the CCU refuses the WebUI credentials, and never echoes the password', async () => {
    const { run, logger } = provider(
      vi.fn().mockRejectedValue(new CcuProbeError('bad-credentials', 'access denied')),
    )
    const out = await run.testSettings({
      settings: { host: 'h', username: 'admin', password: SECRET },
    })
    expect(out.outcome).toBe('rejected')
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET)
  })

  it('rejects an address that answers but is not a CCU', async () => {
    const { run } = provider(vi.fn().mockRejectedValue(new CcuProbeError('not-a-ccu', 'html')))
    expect((await run.testSettings({ settings: { host: 'h' } })).outcome).toBe('rejected')
  })

  it('is inconclusive, not rejected, when the CCU cannot be reached (it may be rebooting)', async () => {
    const { run, logger } = provider(
      vi.fn().mockRejectedValue(new CcuProbeError('unreachable', 'connect ECONNREFUSED')),
    )
    const out = await run.testSettings({ settings: { host: 'h' } })
    expect(out.outcome).toBe('inconclusive')
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('is inconclusive on an unexpected failure', async () => {
    const { run } = provider(vi.fn().mockRejectedValue(new Error('boom')))
    expect((await run.testSettings({ settings: { host: 'h' } })).outcome).toBe('inconclusive')
  })
})

const XML_OK =
  '<?xml version="1.0"?><methodResponse><params><param><value><array/></value></param></params></methodResponse>'
const XML_RPC_PROBE_BODY = '<methodCall/>'
const XML_FAULT =
  '<methodResponse><fault><value><string>nope</string></value></fault></methodResponse>'

function input(overrides: Partial<CcuProbeInput> = {}): CcuProbeInput {
  return {
    host: 'ccu',
    tls: false,
    username: '',
    password: '',
    interfaces: ['HmIP-RF'],
    ...overrides,
  }
}

describe('probeCcu', () => {
  it('asks each enabled interface on the library port (plain and TLS)', async () => {
    const urls: string[] = []
    const post: CcuPost = async (url) => {
      urls.push(url)
      return { status: 200, text: XML_OK }
    }
    await probeCcu(
      input({ interfaces: ['HmIP-RF', 'BidCos-RF', 'VirtualDevices', 'BidCos-Wired'] }),
      post,
    )
    expect(urls).toEqual([
      'http://ccu:2010/',
      'http://ccu:2001/',
      'http://ccu:9292/groups',
      'http://ccu:2000/',
    ])
    urls.length = 0
    await probeCcu(input({ tls: true }), post)
    expect(urls).toEqual(['https://ccu:42010/'])
  })

  it('succeeds when only some interfaces answer, naming the ones that did', async () => {
    const post: CcuPost = async (url) => {
      if (url.includes(':2010')) return { status: 200, text: XML_OK }
      throw new Error('connect ECONNREFUSED')
    }
    const result = await probeCcu(input({ interfaces: ['HmIP-RF', 'BidCos-RF'] }), post)
    expect(result.interfaces).toEqual(['HmIP-RF'])
    expect(result.namesUnlocked).toBe(false)
  })

  it('classifies a port that answers with something other than XML-RPC as not-a-ccu', async () => {
    const post: CcuPost = async () => ({
      status: 200,
      text: '<html>router</html>',
    })
    await expect(probeCcu(input(), post)).rejects.toMatchObject({ kind: 'not-a-ccu' })
  })

  it('treats an XML-RPC fault as an answer: the server is there', async () => {
    const result = await probeCcu(input(), async () => ({ status: 200, text: XML_FAULT }))
    expect(result.interfaces).toEqual(['HmIP-RF'])
  })

  it('classifies every interface refusing the connection as unreachable', async () => {
    const post: CcuPost = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    await expect(probeCcu(input(), post)).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('logs in over JSON-RPC when credentials are given, then logs out', async () => {
    const methods: string[] = []
    const post: CcuPost = async (url, body) => {
      if (url.endsWith('/api/homematic.cgi')) {
        const method = String(JSON.parse(body).method)
        methods.push(method)
        return { status: 200, text: JSON.stringify({ result: 'sid-1', error: null }) }
      }
      return { status: 200, text: XML_OK }
    }
    const result = await probeCcu(input({ username: 'admin', password: SECRET }), post)
    expect(result.namesUnlocked).toBe(true)
    expect(methods).toEqual(['Session.login', 'Session.logout'])
  })

  it('classifies a refused login as bad-credentials', async () => {
    const post: CcuPost = async (url) => {
      if (url.endsWith('/api/homematic.cgi')) {
        return {
          status: 200,
          text: JSON.stringify({ result: null, error: { code: 401, message: 'access denied' } }),
        }
      }
      return { status: 200, text: XML_OK }
    }
    await expect(
      probeCcu(input({ username: 'admin', password: 'wrong' }), post),
    ).rejects.toMatchObject({ kind: 'bad-credentials' })
  })

  it('does not call the WebUI at all without credentials', async () => {
    const urls: string[] = []
    await probeCcu(input(), async (url) => {
      urls.push(url)
      return { status: 200, text: XML_OK }
    })
    expect(urls.some((u) => u.endsWith('/api/homematic.cgi'))).toBe(false)
  })

  it('an unreachable WebUI after a good XML-RPC answer is unreachable, not a pass', async () => {
    const post: CcuPost = async (url) => {
      if (url.endsWith('/api/homematic.cgi')) throw new Error('connect ETIMEDOUT')
      return { status: 200, text: XML_OK }
    }
    await expect(
      probeCcu(input({ username: 'admin', password: SECRET }), post),
    ).rejects.toMatchObject({ kind: 'unreachable' })
  })
})

function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server is not listening')
  return address.port
}

describe('httpPost (the production transport)', () => {
  it('returns the status and body of whatever answered', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200
      res.end(XML_OK)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = portOf(server)
      const reply = await httpPost(`http://127.0.0.1:${port}/`, XML_RPC_PROBE_BODY, 'text/xml')
      expect(reply.status).toBe(200)
      expect(reply.text).toContain('<methodResponse')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects when nothing listens, so the probe can call it unreachable', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = portOf(server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(httpPost(`http://127.0.0.1:${port}/`, '', 'text/xml')).rejects.toThrow()
  })
})
