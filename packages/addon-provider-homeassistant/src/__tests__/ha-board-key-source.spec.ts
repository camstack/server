import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  HaBoardKeySource,
  type BoardKeyHaBroker,
  type BoardKeyHttp,
  type BoardKeyHttpResponse,
} from '../ha-board-key-source.js'

const WIFI_PASSWORD = 'wifi-passphrase-DO-NOT-LEAK'
const OTA_PASSWORD = 'ota-password-DO-NOT-LEAK'
const API_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4='
const SLUG = '5c53de3b_esphome'
const INGRESS = '/api/hassio_ingress/tok-abc/'

interface Line {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

function logger(lines: Line[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const l: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => l,
    withTags: () => l,
  }
  return l
}

interface WsCall {
  readonly endpoint: string
  readonly method: string
}

/** A broker whose supervisor answers come from `replies`, keyed `method endpoint`. */
function broker(
  replies: Record<string, unknown>,
  calls: WsCall[],
  baseUrl: string | null = 'https://ha.example.com/',
): BoardKeyHaBroker {
  return {
    id: 'ha_001',
    name: 'Home',
    baseUrl,
    send: async (message) => {
      const endpoint = String(message['endpoint'])
      const method = String(message['method'])
      calls.push({ endpoint, method })
      const reply = replies[`${method} ${endpoint}`]
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

const HEALTHY = {
  'get /discovery': { discovery: [{ addon: SLUG, service: 'esphome', uuid: 'x', config: {} }] },
  [`get /addons/${SLUG}/info`]: { ingress_url: INGRESS, name: 'ESPHome' },
  'post /ingress/session': { session: 'sess-1' },
}

function json(body: unknown, status = 200): BoardKeyHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

interface HttpCall {
  readonly url: string
  readonly cookie: string | undefined
}

function http(routes: Record<string, BoardKeyHttpResponse>, calls: HttpCall[]): BoardKeyHttp {
  return async (url, init) => {
    calls.push({ url, cookie: init.headers['Cookie'] })
    const hit = routes[url]
    if (hit === undefined) throw new Error(`unexpected ${url}`)
    return hit
  }
}

const JSON_CONFIG = {
  esphome: { name: 'kitchen' },
  wifi: { ssid: 'home', password: WIFI_PASSWORD },
  ota: [{ platform: 'esphome', password: OTA_PASSWORD }],
  api: { encryption: { key: API_KEY } },
}

function setup(options: {
  replies?: Record<string, unknown>
  routes?: Record<string, BoardKeyHttpResponse>
  baseUrl?: string | null
}) {
  const lines: Line[] = []
  const ws: WsCall[] = []
  const web: HttpCall[] = []
  const source = new HaBoardKeySource({
    brokers: {
      list: () => [broker(options.replies ?? HEALTHY, ws, options.baseUrl)],
    },
    http: http(options.routes ?? {}, web),
    logger: logger(lines),
  })
  return { source, lines, ws, web }
}

describe('HaBoardKeySource', () => {
  it('walks discovery, add-on info, ingress session, then reads the key over the cookie', async () => {
    const { source, ws, web } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}json-config?configuration=kitchen.yaml`]:
          json(JSON_CONFIG),
      },
    })
    const result = await source.getBoardKey('ha_001', 'kitchen.yaml')
    expect(result).toEqual({ ok: true, key: API_KEY })
    expect(ws.map((c) => `${c.method} ${c.endpoint}`)).toEqual([
      'get /discovery',
      `get /addons/${SLUG}/info`,
      'post /ingress/session',
    ])
    expect(web).toEqual([
      {
        url: `https://ha.example.com${INGRESS}json-config?configuration=kitchen.yaml`,
        cookie: 'ingress_session=sess-1',
      },
    ])
  })

  it('returns only the key: no other secret is in the result or in any log line', async () => {
    const { source, lines } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}json-config?configuration=kitchen.yaml`]:
          json(JSON_CONFIG),
      },
    })
    const result = await source.getBoardKey('ha_001', 'kitchen.yaml')
    const everything = JSON.stringify([result, lines])
    expect(everything).not.toContain(WIFI_PASSWORD)
    expect(everything).not.toContain(OTA_PASSWORD)
    expect(Object.keys(result).sort()).toEqual(['key', 'ok'])
  })

  it('does not log a secret even when the config is unusable', async () => {
    const { source, lines } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}json-config?configuration=kitchen.yaml`]: json({
          wifi: { password: WIFI_PASSWORD },
          api: { encryption: { key: 7 } },
        }),
      },
    })
    const result = await source.getBoardKey('ha_001', 'kitchen.yaml')
    expect(result).toEqual({ ok: false, reason: 'unreadable-config' })
    expect(JSON.stringify([result, lines])).not.toContain(WIFI_PASSWORD)
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('reports a board with no api encryption as such, not as unreadable', async () => {
    const { source } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}json-config?configuration=plain.yaml`]: json({
          wifi: { password: WIFI_PASSWORD },
          api: {},
        }),
      },
    })
    expect(await source.getBoardKey('ha_001', 'plain.yaml')).toEqual({
      ok: false,
      reason: 'no-encryption-key',
    })
  })

  it('refuses with not-admin when the supervisor denies the ingress session', async () => {
    const denied = Object.assign(new Error('Unauthorized'), { code: 'unauthorized' })
    const { source, web } = setup({ replies: { ...HEALTHY, 'post /ingress/session': denied } })
    const result = await source.getBoardKey('ha_001', 'kitchen.yaml')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-admin')
    expect(web).toEqual([])
  })

  it('reports no-builder when no add-on announced esphome', async () => {
    const { source } = setup({ replies: { ...HEALTHY, 'get /discovery': { discovery: [] } } })
    expect(await source.listBoards('ha_001')).toEqual({ ok: false, reason: 'no-builder' })
  })

  it('refuses an ingress url that is not under the ingress prefix', async () => {
    const { source, web } = setup({
      replies: {
        ...HEALTHY,
        [`get /addons/${SLUG}/info`]: { ingress_url: '//evil.example.net/x/' },
      },
    })
    expect(await source.listBoards('ha_001')).toEqual({ ok: false, reason: 'no-ingress-url' })
    expect(web).toEqual([])
  })

  it('has no ingress url for a supervisor-token broker', async () => {
    const { source } = setup({ baseUrl: null })
    const result = await source.listBoards('ha_001')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-ingress-url')
  })

  it('names an unknown source and an unknown board', async () => {
    const { source } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}json-config?configuration=gone.yaml`]: json({}, 404),
      },
    })
    expect(await source.listBoards('nope')).toEqual({ ok: false, reason: 'unknown-source' })
    const result = await source.getBoardKey('ha_001', 'gone.yaml')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown-board')
  })

  it('lists the builder boards and the sources', async () => {
    const { source } = setup({
      routes: {
        [`https://ha.example.com${INGRESS}devices`]: json({
          configured: [
            { name: 'kitchen', configuration: 'kitchen.yaml', address: 'kitchen.local' },
            { name: 'attic', configuration: 'attic.yaml' },
          ],
          importable: [],
        }),
      },
    })
    expect(source.listSources()).toEqual([{ sourceId: 'ha_001', name: 'Home' }])
    expect(await source.listBoards('ha_001')).toEqual({
      ok: true,
      boards: [
        { configuration: 'kitchen.yaml', name: 'kitchen', address: 'kitchen.local' },
        { configuration: 'attic.yaml', name: 'attic', address: null },
      ],
    })
  })
})
