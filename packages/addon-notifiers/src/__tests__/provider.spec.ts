/**
 * Unit tests for the notifiers `notification-output` collection provider.
 *
 * Everything runs against an in-memory settings-store fake and one or two fake
 * adapters — no network. The provider's contract is: degrade with the pure
 * engine, isolate every adapter/transport failure into `SendResult.error`
 * (never throw through the cap), redact secrets on read, merge them on write.
 */

import type {
  ConfigUISchema,
  Notification,
  Target,
  TargetKind,
  TargetKindCaps,
  PreparedAttachment,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type {
  HttpNotifierAdapter,
  HttpRequestPlan,
  HttpResponseLike,
  NotifierAdapter,
} from '../adapters/adapter.js'
import { createNotificationOutputProvider, type HttpSender } from '../provider.js'
import { REDACTED_MARKER } from '../secrets.js'
import { makeNotifiersRecords } from './fake-records.js'
import { TargetStore } from '../target-store.js'

// ── Fixtures ────────────────────────────────────────────────────────

const TEXT_CAPS: TargetKindCaps = {
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  levels: [
    { id: 'low', label: 'Low', ordinal: 2 },
    { id: 'normal', label: 'Normal', ordinal: 3 },
    { id: 'high', label: 'High', ordinal: 4 },
  ],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 1000,
}

function configSchemaWithSecret(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'main',
        title: 'Main',
        fields: [
          { type: 'text', key: 'url', label: 'URL' },
          { type: 'password', key: 'token', label: 'Token' },
        ],
      },
    ],
  }
}

function makeDescriptor(kind: string): TargetKind {
  return {
    kind,
    label: `Fake ${kind}`,
    icon: 'bell',
    addonId: 'notifiers',
    configSchema: configSchemaWithSecret(),
    supportsDiscovery: false,
    caps: TEXT_CAPS,
  }
}

/** Records the last prepared body/level so tests can assert the degrade ran. */
interface CapturingAdapter extends HttpNotifierAdapter {
  lastPlan?: HttpRequestPlan
}

function okAdapter(kind = 'fake'): CapturingAdapter {
  const adapter: CapturingAdapter = {
    descriptor: makeDescriptor(kind),
    destinationKeys: ['url'],
    buildRequest: (config, prepared) => {
      const plan: HttpRequestPlan = {
        url: String(config['url'] ?? 'https://example.test/hook'),
        method: 'POST',
        body: {
          kind: 'json',
          value: { body: prepared.body, level: prepared.level?.id ?? null },
        },
      }
      adapter.lastPlan = plan
      return plan
    },
  }
  return adapter
}

function throwingAdapter(kind = 'boom'): NotifierAdapter {
  return {
    descriptor: makeDescriptor(kind),
    destinationKeys: ['url'],
    buildRequest: () => {
      throw new Error('build exploded')
    },
  }
}

const okResponse: HttpResponseLike = {
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => '',
}

const okSender: HttpSender = async () => okResponse

async function makeProvider(adapters: readonly NotifierAdapter[], httpSend: HttpSender = okSender) {
  const world = await makeNotifiersRecords()
  const store = TargetStore.of(world.records)
  const provider = createNotificationOutputProvider({ store, adapters, httpSend })
  return { provider, store }
}

function target(overrides: Partial<Target> = {}): Target {
  return {
    id: 't1',
    name: 'My ntfy',
    kind: 'fake',
    addonId: 'notifiers',
    enabled: true,
    config: { url: 'https://example.test/hook', token: 'supersecret' },
    ...overrides,
  }
}

const NOTIFICATION: Notification = { body: 'hello world', format: 'text', priority: 3 }

// ── listTargetKinds ─────────────────────────────────────────────────

describe('listTargetKinds', () => {
  it('returns each adapter descriptor stamped with addonId', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    const kinds = await provider.listTargetKinds({})
    expect(kinds).toHaveLength(1)
    expect(kinds[0]?.kind).toBe('fake')
    expect(kinds[0]?.addonId).toBe('notifiers')
  })

  it('is empty when no adapters are registered', async () => {
    const { provider } = await makeProvider([])
    expect(await provider.listTargetKinds({})).toEqual([])
  })
})

// ── CRUD round-trip ─────────────────────────────────────────────────

describe('target CRUD', () => {
  it('insert → list → update → delete round-trip', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])

    await provider.upsertTarget({ target: target() })
    let list = await provider.listTargets({})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('My ntfy')

    await provider.upsertTarget({ target: target({ name: 'Renamed' }) })
    list = await provider.listTargets({})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('Renamed')

    await provider.deleteTarget({ targetId: 't1' })
    expect(await provider.listTargets({})).toEqual([])
  })

  it('setTargetEnabled flips the flag', async () => {
    const { provider, store } = await makeProvider([okAdapter('fake')])
    await provider.upsertTarget({ target: target({ enabled: true }) })
    await provider.setTargetEnabled({ targetId: 't1', enabled: false })
    const stored = await store.getById('t1')
    expect(stored?.enabled).toBe(false)
  })
})

// ── Secret redaction + merge ────────────────────────────────────────

describe('secret handling', () => {
  it('blanks password-typed fields on listTargets (presence marker only)', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    await provider.upsertTarget({ target: target() })
    const list = await provider.listTargets({})
    expect(list[0]?.config['token']).toBe(REDACTED_MARKER)
    // Non-secret fields are untouched.
    expect(list[0]?.config['url']).toBe('https://example.test/hook')
  })

  it('preserves the stored secret when the operator re-submits the marker', async () => {
    const { provider, store } = await makeProvider([okAdapter('fake')])
    await provider.upsertTarget({
      target: target({ config: { url: 'https://a', token: 'realtoken' } }),
    })
    // Second save comes back from the UI with the redaction marker, not the value.
    await provider.upsertTarget({
      target: target({ name: 'Edited', config: { url: 'https://a', token: REDACTED_MARKER } }),
    })
    const stored = await store.getById('t1')
    expect(stored?.config['token']).toBe('realtoken')
    expect(stored?.name).toBe('Edited')
  })

  it('upsertTarget returns a redacted target', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    const saved = await provider.upsertTarget({ target: target() })
    expect(saved.config['token']).toBe(REDACTED_MARKER)
    expect(saved.addonId).toBe('notifiers')
  })
})

// ── send() dispatch ─────────────────────────────────────────────────

describe('send', () => {
  it('unknown targetId yields a typed error, never throws', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    const result = await provider.send({ targetId: 'nope', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Unknown target/)
  })

  it('disabled target is skipped with a result (not dispatched)', async () => {
    const adapter = okAdapter('fake')
    const { provider } = await makeProvider([adapter])
    await provider.upsertTarget({ target: target({ enabled: false }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disabled/i)
    expect(adapter.lastPlan).toBeUndefined()
  })

  it('dispatches through the adapter and surfaces renderedAs (prepareNotification ran)', async () => {
    const adapter = okAdapter('fake')
    const { provider } = await makeProvider([adapter])
    await provider.upsertTarget({ target: target() })
    const result = await provider.send({
      targetId: 't1',
      notification: { body: 'ping', format: 'text', priority: 4 },
    })
    expect(result.success).toBe(true)
    expect(result.renderedAs).toBeDefined()
    // priority 4 → nearest declared ordinal level = 'high'.
    expect(result.renderedAs?.level).toBe('high')
    expect(result.renderedAs?.format).toBe('text')
    // buildRequest saw the degraded body.
    expect(adapter.lastPlan).toBeDefined()
  })

  it('isolates a buildRequest throw into SendResult.error', async () => {
    const { provider } = await makeProvider([throwingAdapter('boom')])
    await provider.upsertTarget({ target: target({ kind: 'boom' }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/buildRequest failed/)
    // renderedAs still reported even on failure.
    expect(result.renderedAs).toBeDefined()
  })

  it('isolates a transport (fetch) rejection into SendResult.error', async () => {
    const rejectingSender: HttpSender = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { provider } = await makeProvider([okAdapter('fake')], rejectingSender)
    await provider.upsertTarget({ target: target() })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/request failed/)
  })

  it('maps a non-ok HTTP response to a failure result', async () => {
    const failSender: HttpSender = async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'nope',
    })
    const { provider } = await makeProvider([okAdapter('fake')], failSender)
    await provider.upsertTarget({ target: target() })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/502/)
  })

  it('passes the response body text to adapter.parseResult', async () => {
    let seenBody: string | undefined
    const parsing: NotifierAdapter = {
      descriptor: makeDescriptor('parse'),
      destinationKeys: ['url'],
      buildRequest: (config) => ({ url: String(config['url'] ?? 'https://x'), method: 'POST' }),
      parseResult: (res, bodyText) => {
        seenBody = bodyText
        return res.ok ? { success: true } : { success: false, error: `body:${bodyText}` }
      },
    }
    const bodySender: HttpSender = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"errors":["invalid token"]}',
    })
    const { provider } = await makeProvider([parsing], bodySender)
    await provider.upsertTarget({ target: target({ kind: 'parse' }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(seenBody).toBe('{"errors":["invalid token"]}')
    expect(result.success).toBe(false)
    expect(result.error).toBe('body:{"errors":["invalid token"]}')
    // renderedAs still surfaced alongside the parsed error.
    expect(result.renderedAs).toBeDefined()
  })

  it('kind with no adapter yields an error, not a throw', async () => {
    const { provider } = await makeProvider([])
    // Persist a target of an unknown kind directly, then attempt send.
    await provider.upsertTarget({ target: target({ kind: 'ghost' }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No adapter/)
  })

  it('adapter.probe ok:false blocks send before HTTP (no false success)', async () => {
    let httpCalls = 0
    const probing: CapturingAdapter = {
      ...okAdapter('probe-kind'),
      probe: async () => ({
        ok: false,
        resolvedUrl: 'https://api.example/getStateInstance',
        httpStatus: 200,
        stateInstance: 'notAuthorized',
        error: 'Instance notAuthorized — scan the QR in the Green API console',
      }),
    }
    const countingSender: HttpSender = async () => {
      httpCalls += 1
      return okResponse
    }
    const { provider } = await makeProvider([probing], countingSender)
    await provider.upsertTarget({ target: target({ kind: 'probe-kind' }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/notAuthorized/)
    expect(httpCalls).toBe(0)
  })

  it('adapter.probe ok:true allows send', async () => {
    const probing: CapturingAdapter = {
      ...okAdapter('probe-ok'),
      probe: async () => ({
        ok: true,
        resolvedUrl: 'https://api.example/getStateInstance',
        httpStatus: 200,
        stateInstance: 'authorized',
      }),
    }
    const { provider } = await makeProvider([probing])
    await provider.upsertTarget({ target: target({ kind: 'probe-ok' }) })
    const result = await provider.send({ targetId: 't1', notification: NOTIFICATION })
    expect(result.success).toBe(true)
  })
})

// ── probe / clone secrets ───────────────────────────────────────────

describe('probeTargetConfig + cloneSecretsFrom', () => {
  it('restores a blank password from targetId before probing', async () => {
    let seenToken: unknown
    const probing: NotifierAdapter = {
      ...okAdapter('secret-probe'),
      probe: async (config) => {
        seenToken = config['token']
        return {
          ok: true,
          resolvedUrl: 'https://api.example/probe',
          httpStatus: 200,
        }
      },
    }
    const { provider } = await makeProvider([probing])
    await provider.upsertTarget({
      target: target({
        kind: 'secret-probe',
        config: { url: 'https://x', token: 'live-secret' },
      }),
    })
    const result = await provider.probeTargetConfig({
      kind: 'secret-probe',
      config: { url: 'https://x' },
      targetId: 't1',
    })
    expect(result.ok).toBe(true)
    expect(seenToken).toBe('live-secret')
  })

  it('cloneSecretsFrom copies the stored token onto a new target id', async () => {
    const adapter = okAdapter('clone-kind')
    const { provider, store } = await makeProvider([adapter])
    await provider.upsertTarget({
      target: target({
        id: 'src',
        kind: 'clone-kind',
        config: { url: 'https://x', token: 'cloned-secret' },
      }),
    })
    await provider.upsertTarget({
      target: target({
        id: 'dup',
        name: 'Alerts Copy',
        kind: 'clone-kind',
        config: { url: 'https://x' },
      }),
      cloneSecretsFrom: 'src',
    })
    const stored = await store.getById('dup')
    expect(stored?.config['token']).toBe('cloned-secret')
  })

  it('getTarget returns the live secret (listTargets stays redacted)', async () => {
    const adapter = okAdapter('secret-kind')
    const { provider } = await makeProvider([adapter])
    await provider.upsertTarget({
      target: target({
        kind: 'secret-kind',
        config: { url: 'https://x', token: 'live-token' },
      }),
    })
    const listed = await provider.listTargets({})
    expect(listed[0]?.config['token']).toBe('__redacted__')
    const full = await provider.getTarget({ targetId: 't1' })
    expect(full.config['token']).toBe('live-token')
  })
})

// ── testTarget ──────────────────────────────────────────────────────

describe('testTarget', () => {
  it('sends a canned notification when no sample is given', async () => {
    const adapter = okAdapter('fake')
    const { provider } = await makeProvider([adapter])
    await provider.upsertTarget({ target: target() })
    const result = await provider.testTarget({ targetId: 't1' })
    expect(result.success).toBe(true)
    expect(adapter.lastPlan).toBeDefined()
  })

  it('probe failure makes testTarget report success:false', async () => {
    const probing: NotifierAdapter = {
      ...okAdapter('probe-test'),
      probe: async () => ({
        ok: false,
        resolvedUrl: 'https://api.example/getStateInstance',
        stateInstance: 'notAuthorized',
        error: 'Instance notAuthorized — scan the QR',
      }),
    }
    const { provider } = await makeProvider([probing])
    await provider.upsertTarget({ target: target({ kind: 'probe-test' }) })
    const result = await provider.testTarget({ targetId: 't1' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/notAuthorized/)
  })

  it('unknown target yields a typed error', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    const result = await provider.testTarget({ targetId: 'nope' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Unknown target/)
  })
})

// ── discoverTargets ─────────────────────────────────────────────────

describe('discoverTargets', () => {
  it('returns [] for a kind with no adapter', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    expect(await provider.discoverTargets({ kind: 'ghost' })).toEqual([])
  })

  it('returns [] for an adapter without discover()', async () => {
    const { provider } = await makeProvider([okAdapter('fake')])
    expect(await provider.discoverTargets({ kind: 'fake' })).toEqual([])
  })

  it('delegates to adapter.discover and isolates its throw', async () => {
    const discovering: NotifierAdapter = {
      descriptor: makeDescriptor('disc'),
      destinationKeys: ['url'],
      buildRequest: () => ({ url: 'https://x' }),
      discover: async () => [
        { kind: 'disc', suggestedName: 'Found', config: { url: 'https://x' } },
      ],
    }
    const throwingDiscover: NotifierAdapter = {
      descriptor: makeDescriptor('bad'),
      destinationKeys: ['url'],
      buildRequest: () => ({ url: 'https://x' }),
      discover: async () => {
        throw new Error('discover boom')
      },
    }
    const { provider } = await makeProvider([discovering, throwingDiscover])
    const found = await provider.discoverTargets({ kind: 'disc' })
    expect(found).toHaveLength(1)
    expect(found[0]?.suggestedName).toBe('Found')
    // Discover failures propagate so the UI can show why (e.g. notAuthorized).
    await expect(provider.discoverTargets({ kind: 'bad' })).rejects.toThrow(/discover boom/)
  })

  it('forwards the incoming (partial, unsaved) connection config to adapter.discover', async () => {
    let seen: Record<string, unknown> | undefined
    const capturing: NotifierAdapter = {
      descriptor: makeDescriptor('cfg'),
      destinationKeys: ['url'],
      buildRequest: () => ({ url: 'https://x' }),
      discover: async (config) => {
        seen = { ...config }
        return [{ kind: 'cfg', suggestedName: 'X', config: {} }]
      },
    }
    const { provider } = await makeProvider([capturing])
    await provider.discoverTargets({
      kind: 'cfg',
      config: { host: 'https://gotify.local', token: 'abc' },
    })
    expect(seen).toEqual({ host: 'https://gotify.local', token: 'abc' })
  })

  it('passes an empty config object when none is supplied', async () => {
    let seen: Record<string, unknown> | undefined
    const capturing: NotifierAdapter = {
      descriptor: makeDescriptor('cfg2'),
      destinationKeys: ['url'],
      buildRequest: () => ({ url: 'https://x' }),
      discover: async (config) => {
        seen = { ...config }
        return []
      },
    }
    const { provider } = await makeProvider([capturing])
    await provider.discoverTargets({ kind: 'cfg2' })
    expect(seen).toEqual({})
  })
})

// ── relative attachment urls ────────────────────────────────────────

describe('relative attachment urls (test-panel samples)', () => {
  function imageAdapter(seen: PreparedAttachment[]): NotifierAdapter {
    const base = okAdapter('imgfake')
    return {
      ...base,
      descriptor: {
        ...base.descriptor,
        caps: { ...TEXT_CAPS, attachments: { mediaTypes: ['image'], mode: 'url', max: 1 } },
      },
      buildRequest: (config, prepared) => {
        seen.push(...prepared.attachments)
        return okAdapter().buildRequest(config, prepared)
      },
    }
  }

  it('hands the adapter an absolute url on the public endpoint', async () => {
    const seen: PreparedAttachment[] = []
    const world = await makeNotifiersRecords()
    const store = TargetStore.of(world.records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [imageAdapter(seen)],
      httpSend: okSender,
      readPublicEndpoint: async () => ({ kind: 'resolved', origin: 'https://hub.example.com' }),
    })
    await provider.upsertTarget({ target: target({ kind: 'imgfake' }) })
    const res = await provider.testTarget({
      targetId: 't1',
      sample: {
        body: 'x',
        format: 'text',
        priority: 3,
        attachments: [{ mediaType: 'image', url: '/addon/notifiers/samples/image' }],
      },
    })
    expect(res.success).toBe(true)
    expect(seen[0]?.url).toBe('https://hub.example.com/addon/notifiers/samples/image')
  })
})
