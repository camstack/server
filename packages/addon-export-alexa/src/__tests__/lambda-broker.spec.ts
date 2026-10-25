/**
 * The skill Lambda's token broker (D753), exercised end to end with every
 * outside party faked: api.amazon.com (LWA), the hub, SSM Parameter Store and
 * DynamoDB. No network, no AWS SDK.
 *
 * The properties that matter, each pinned below:
 *   - the LWA client secret is read from an SSM SecureString parameter
 *     (decrypted on read) and is sent ONLY to
 *     api.amazon.com — never to a hub, never into a log;
 *   - a hub on the broker receives a credential and an access token, NEVER the
 *     refresh token;
 *   - a hub without the broker route still links (legacy fallback) unless the
 *     fallback is switched off — the zero-downtime cut-over;
 *   - a broker credential is per link, verified in constant time, rotatable
 *     and revocable, and a wrong one is indistinguishable from an unknown one.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

// ── Typed views of the CommonJS Lambda modules ───────────────────────

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
  json(): Promise<unknown>
  readonly headers: { get(name: string): string | null }
}
interface FetchInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}
type FetchFn = (url: string, init?: FetchInit) => Promise<FakeResponse>

interface LinkItem {
  linkId: string
  secretHash: string
  status: string
  refreshToken: string
  accessToken: string
  accessExpiresAt: number
  hubUrl?: string
  origin: string
  createdAt: number
  lastUsedAt: number
  ttl: number
  version: number
}
interface TokenStore {
  items: Map<string, LinkItem>
  get(linkId: string): Promise<LinkItem | null>
  create(item: LinkItem): Promise<void>
  replace(item: LinkItem, expectedVersion: number): Promise<boolean>
  remove(linkId: string): Promise<void>
}
interface Credential {
  clientId: string
  clientSecret: string
  previousClientSecret?: string
  source: string
}
interface SecretSource {
  lwa(): Promise<Credential | null>
  skill(): Promise<Credential | null>
  invalidate(kind: 'lwa' | 'skill'): void
}
interface LambdaConsole {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
interface HandlerDeps {
  env?: Record<string, string | undefined>
  fetch?: FetchFn
  store?: TokenStore | null
  secrets?: SecretSource
  now?: () => number
  randomBytes?: (n: number) => Buffer
  log?: LambdaConsole
}
type Handler = (event: unknown) => Promise<Record<string, unknown>>

const lambda = require('../../lambda-template/index.js') as {
  createHandler(deps: HandlerDeps): Handler
  BROKER_HEADER: string
}
const { createSecretSource } = require('../../lambda-template/secrets.js') as {
  createSecretSource(opts: {
    env: Record<string, string | undefined>
    readParameter: (name: string) => Promise<string>
    now?: () => number
    ttlMs?: number
  }): SecretSource
}
interface FakeSsmCommand {
  readonly kind: string
  readonly input: Record<string, unknown>
}
const { createAwsClients } = require('../../lambda-template/aws.js') as {
  createAwsClients(opts?: { loadSdk?: (name: string) => unknown }): {
    send(name: string, input: Record<string, unknown>): Promise<unknown>
    readParameter(name: string): Promise<string>
  }
}
const store = require('../../lambda-template/token-store.js') as {
  createMemoryTokenStore(): TokenStore
  createDynamoTokenStore(opts: {
    send: (name: string, input: Record<string, unknown>) => Promise<unknown>
    tableName: string
  }): Omit<TokenStore, 'items'>
  marshal(item: Partial<LinkItem>): Record<string, unknown>
  unmarshal(raw: Record<string, unknown>): Partial<LinkItem>
}
const broker = require('../../lambda-template/broker.js') as {
  mintCredential(randomBytes: (n: number) => Buffer): {
    linkId: string
    secretHash: string
    credential: string
  }
  parseCredential(raw: unknown): { linkId: string; secret: string } | null
  secretMatches(secret: string, hash: string): boolean
}

// ── Fixtures (values are built here; none is a real secret) ──────────

const LWA_ID = 'lwa-client-id'
const LWA_SECRET = ['lwa', 'secret', 'value', 'one'].join('-')
const LWA_SECRET_ROTATED = ['lwa', 'secret', 'value', 'two'].join('-')
const SKILL_ID = 'skill-client-id'
const SKILL_SECRET = ['skill', 'secret', 'current'].join('-')
const SKILL_SECRET_PREV = ['skill', 'secret', 'previous'].join('-')
const HUB = 'https://hub.example.test'
const LWA_PARAM_NAME = '/camstack/alexa/lwa'
const SKILL_PARAM_NAME = '/camstack/alexa/skill'
const BROKER_URL = 'https://broker.example.test'
const T0 = 1_800_000_000_000

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}
const GRANTEE = jwtWith({ hubUrl: HUB, sub: 'u1' })

function response(status: number, body: unknown): FakeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => 'application/json' },
  }
}

interface Call {
  url: string
  init: FetchInit
}

/** A scripted world: LWA, the hub's routes, and a recorder of every request. */
function world(opts: {
  lwa?: (form: URLSearchParams) => FakeResponse
  hub?: (path: string, init: FetchInit) => FakeResponse
}) {
  const calls: Call[] = []
  let refreshCount = 0
  const fetch: FetchFn = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === 'https://api.amazon.com/auth/o2/token') {
      const form = new URLSearchParams(init.body ?? '')
      if (opts.lwa) return opts.lwa(form)
      if (form.get('client_secret') !== LWA_SECRET) {
        return response(401, { error: 'invalid_client' })
      }
      if (form.get('grant_type') === 'authorization_code') {
        return response(200, {
          access_token: 'AT-from-code',
          refresh_token: 'RT-user',
          expires_in: 3600,
        })
      }
      if (form.get('refresh_token') === 'RT-revoked') {
        return response(400, { error: 'invalid_grant' })
      }
      refreshCount += 1
      return response(200, { access_token: `AT-refreshed-${refreshCount}`, expires_in: 3600 })
    }
    if (url.startsWith(HUB)) {
      const path = url.slice(HUB.length)
      if (opts.hub) return opts.hub(path, init)
      return response(200, { ok: true })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  return { fetch, calls }
}

function recordingLog() {
  const lines: unknown[] = []
  const log: LambdaConsole = {
    info: (...a) => lines.push(a),
    warn: (...a) => lines.push(a),
    error: (...a) => lines.push(a),
  }
  return { log, lines }
}

function ssmSecrets(values: { lwa?: string; skill?: string }): {
  secrets: SecretSource
  reads: string[]
  set(kind: 'lwa' | 'skill', value: string): void
} {
  const current = { ...values }
  const reads: string[] = []
  const secrets = createSecretSource({
    env: { LWA_PARAM: LWA_PARAM_NAME, SKILL_PARAM: SKILL_PARAM_NAME },
    readParameter: async (name) => {
      reads.push(name)
      const v = name === LWA_PARAM_NAME ? current.lwa : current.skill
      if (v === undefined) throw new Error('ParameterNotFound')
      return v
    },
  })
  return {
    secrets,
    reads,
    set: (kind, value) => {
      current[kind] = value
    },
  }
}

const lwaJson = (secret = LWA_SECRET) => JSON.stringify({ clientId: LWA_ID, clientSecret: secret })
const skillJson = (extra: Record<string, string> = {}) =>
  JSON.stringify({ clientId: SKILL_ID, clientSecret: SKILL_SECRET, ...extra })

let counter = 0
/** Deterministic, distinct random bytes. */
function seqRandom(n: number): Buffer {
  counter += 1
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (counter * 31 + i * 7) & 0xff
  return b
}

function makeHandler(over: Partial<HandlerDeps> & { fetch: FetchFn }) {
  const memory = store.createMemoryTokenStore()
  const handler = lambda.createHandler({
    env: {
      LAMBDA_REDIRECT_URI: `${BROKER_URL}/token`,
      TOKENS_TABLE: 'camstack-alexa-tokens',
      ...over.env,
    },
    fetch: over.fetch,
    store: over.store === undefined ? memory : over.store,
    secrets: over.secrets ?? ssmSecrets({ lwa: lwaJson(), skill: skillJson() }).secrets,
    now: over.now ?? (() => T0),
    randomBytes: seqRandom,
    log: over.log ?? recordingLog().log,
  })
  return { handler, memory }
}

function acceptGrantEvent() {
  return {
    directive: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'AcceptGrant',
        messageId: 'm1',
        payloadVersion: '3',
      },
      payload: {
        grant: { type: 'OAuth2.AuthorizationCode', code: 'GRANT-CODE' },
        grantee: { type: 'BearerToken', token: GRANTEE },
      },
    },
  }
}

function urlEvent(path: string, opts: { bearer?: string; body?: unknown; method?: string } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method: opts.method ?? 'POST' } },
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    body: opts.body === undefined ? '' : JSON.stringify(opts.body),
    isBase64Encoded: false,
  }
}

function bodyOf(res: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(res.body)) as Record<string, unknown>
}

function eventName(res: Record<string, unknown>): string {
  const ev = res.event as { header: { name: string } }
  return ev.header.name
}

/** Link through AcceptGrant and return the credential the hub received. */
async function linkedHub(over: Partial<HandlerDeps> = {}) {
  let delivered: Record<string, unknown> | null = null
  const w = world({
    hub: (path, init) => {
      if (path === '/addon/export-alexa/oauth/broker-link') {
        delivered = JSON.parse(init.body ?? '{}') as Record<string, unknown>
        return response(200, { ok: true })
      }
      return response(404, { error: 'Not found' })
    },
  })
  const base = over.fetch ?? w.fetch
  const fetch: FetchFn = async (url, init = {}) => {
    if (over.fetch && url.endsWith('/addon/export-alexa/oauth/broker-link')) {
      delivered = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    }
    return base(url, init)
  }
  const h = makeHandler({ ...over, fetch })
  const res = await h.handler(acceptGrantEvent())
  expect(eventName(res)).toBe('AcceptGrant.Response')
  if (!delivered) throw new Error('hub never received broker-link')
  return { ...h, w, delivered: delivered as Record<string, unknown> }
}

// ── Secrets ──────────────────────────────────────────────────────────

describe('secret source', () => {
  it('reads the SSM parameter once per TTL and re-reads after invalidate', async () => {
    let now = 0
    const reads: string[] = []
    const src = createSecretSource({
      env: { LWA_PARAM: LWA_PARAM_NAME },
      readParameter: async (name) => {
        reads.push(name)
        return lwaJson()
      },
      now: () => now,
      ttlMs: 1000,
    })
    expect((await src.lwa())?.clientSecret).toBe(LWA_SECRET)
    await src.lwa()
    expect(reads).toHaveLength(1)
    now = 1001
    await src.lwa()
    expect(reads).toHaveLength(2)
    src.invalidate('lwa')
    await src.lwa()
    expect(reads).toHaveLength(3)
  })

  it('falls back to the legacy env vars only when no parameter name is configured', async () => {
    const src = createSecretSource({
      env: { LWA_CLIENT_ID: 'id', LWA_CLIENT_SECRET: 'env-secret' },
      readParameter: async () => {
        throw new Error('must not be called')
      },
    })
    expect(await src.lwa()).toEqual({ clientId: 'id', clientSecret: 'env-secret', source: 'env' })
    expect(await src.skill()).toBeNull()
  })

  it('rejects a malformed secret without echoing its value', async () => {
    const src = createSecretSource({
      env: { LWA_PARAM: LWA_PARAM_NAME },
      readParameter: async () => JSON.stringify({ clientSecret: LWA_SECRET }),
    })
    const err = await src.lwa().catch((e: unknown) => e)
    expect(String(err)).toContain(LWA_PARAM_NAME)
    expect(String(err)).not.toContain(LWA_SECRET)
  })
})

/**
 * A fake `@aws-sdk/client-ssm` module: records every command and answers
 * GetParameter from `values` (name → decrypted SecureString value). The real
 * SDK is never loaded; `loaded` records every module the wiring asked for.
 */
function fakeSsmSdk(values: Record<string, string | undefined>) {
  const commands: FakeSsmCommand[] = []
  const loaded: string[] = []
  let clients = 0
  class GetParameterCommand implements FakeSsmCommand {
    readonly kind = 'GetParameter'
    constructor(readonly input: Record<string, unknown>) {}
  }
  class SSMClient {
    constructor() {
      clients += 1
    }
    async send(cmd: FakeSsmCommand) {
      commands.push(cmd)
      const name = String(cmd.input.Name)
      if (!(name in values)) {
        throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' })
      }
      const value = values[name]
      // A real SecureString read WITHOUT decryption returns ciphertext.
      if (cmd.input.WithDecryption !== true)
        return { Parameter: { Name: name, Value: 'AQICAH-ciphertext' } }
      return {
        Parameter: {
          Name: name,
          Type: 'SecureString',
          ...(value === undefined ? {} : { Value: value }),
        },
      }
    }
  }
  const loadSdk = (name: string) => {
    loaded.push(name)
    if (name === '@aws-sdk/client-ssm') return { SSMClient, GetParameterCommand }
    throw new Error(`unexpected SDK module ${name}`)
  }
  return { loadSdk, commands, loaded, clientCount: () => clients, values }
}

describe('AWS wiring: SSM Parameter Store', () => {
  it('reads a SecureString with decryption requested, through one reused client', async () => {
    const sdk = fakeSsmSdk({ [LWA_PARAM_NAME]: lwaJson(), [SKILL_PARAM_NAME]: skillJson() })
    const aws = createAwsClients({ loadSdk: sdk.loadSdk })
    expect(await aws.readParameter(LWA_PARAM_NAME)).toBe(lwaJson())
    expect(await aws.readParameter(SKILL_PARAM_NAME)).toBe(skillJson())
    expect(sdk.commands.map((c) => [c.kind, c.input])).toEqual([
      ['GetParameter', { Name: LWA_PARAM_NAME, WithDecryption: true }],
      ['GetParameter', { Name: SKILL_PARAM_NAME, WithDecryption: true }],
    ])
    expect(sdk.clientCount()).toBe(1)
    expect(sdk.loaded.every((m) => m === '@aws-sdk/client-ssm')).toBe(true)
  })

  it('names the parameter, never a value, when it has no value', async () => {
    const sdk = fakeSsmSdk({ [LWA_PARAM_NAME]: undefined })
    const aws = createAwsClients({ loadSdk: sdk.loadSdk })
    const err = await aws.readParameter(LWA_PARAM_NAME).catch((e: unknown) => e)
    expect(String(err)).toContain(LWA_PARAM_NAME)
  })

  it('feeds the credential source end to end, decrypting and caching', async () => {
    const sdk = fakeSsmSdk({ [LWA_PARAM_NAME]: lwaJson(), [SKILL_PARAM_NAME]: skillJson() })
    const aws = createAwsClients({ loadSdk: sdk.loadSdk })
    const src = createSecretSource({
      env: { LWA_PARAM: LWA_PARAM_NAME, SKILL_PARAM: SKILL_PARAM_NAME },
      readParameter: (name) => aws.readParameter(name),
    })
    expect(await src.lwa()).toEqual({ clientId: LWA_ID, clientSecret: LWA_SECRET, source: 'ssm' })
    expect((await src.skill())?.clientSecret).toBe(SKILL_SECRET)
    await src.lwa()
    expect(sdk.commands).toHaveLength(2)
  })

  it('never logs a parameter value — on success, on rotation, or on a malformed parameter', async () => {
    const rec = recordingLog()
    const sdk = fakeSsmSdk({ [LWA_PARAM_NAME]: lwaJson(), [SKILL_PARAM_NAME]: skillJson() })
    const aws = createAwsClients({ loadSdk: sdk.loadSdk })
    const env = { LWA_PARAM: LWA_PARAM_NAME, SKILL_PARAM: SKILL_PARAM_NAME }
    const secrets = createSecretSource({ env, readParameter: (name) => aws.readParameter(name) })
    let now = T0
    let rotated = false
    const w = world({
      lwa: (form) => {
        const expected = rotated ? LWA_SECRET_ROTATED : LWA_SECRET
        if (form.get('client_secret') !== expected)
          return response(401, { error: 'invalid_client' })
        return form.get('grant_type') === 'authorization_code'
          ? response(200, {
              access_token: 'AT-from-code',
              refresh_token: 'RT-user',
              expires_in: 3600,
            })
          : response(200, { access_token: 'AT-after-rotation', expires_in: 3600 })
      },
      hub: () => response(200, { ok: true }),
    })
    const { handler, delivered } = await linkedHub({
      fetch: w.fetch,
      secrets,
      log: rec.log,
      now: () => now,
    })
    const cred = String(delivered.brokerCredential)

    // Rotation: LWA rejects the cached value, the Lambda re-reads SSM at once.
    rotated = true
    sdk.values[LWA_PARAM_NAME] = lwaJson(LWA_SECRET_ROTATED)
    now = T0 + 4_000_000
    const res = await handler(urlEvent('/broker/token', { bearer: cred }))
    expect(bodyOf(res).accessToken).toBe('AT-after-rotation')

    // A malformed parameter (a bare secret instead of the JSON pair) fails loudly
    // without echoing what it read.
    sdk.values[LWA_PARAM_NAME] = LWA_SECRET_ROTATED
    secrets.invalidate('lwa')
    now = T0 + 8_000_000
    await handler(urlEvent('/broker/token', { bearer: cred }))

    expect(sdk.commands.every((c) => c.input.WithDecryption === true)).toBe(true)
    const text = JSON.stringify(rec.lines)
    expect(rec.lines.length).toBeGreaterThan(0)
    for (const needle of [
      LWA_SECRET,
      LWA_SECRET_ROTATED,
      SKILL_SECRET,
      'RT-user',
      cred.split('.')[2] ?? 'x',
    ]) {
      expect(text).not.toContain(needle)
    }
  })
})

// ── Store ────────────────────────────────────────────────────────────

describe('DynamoDB token store', () => {
  it('marshals and unmarshals every field', () => {
    const item: LinkItem = {
      linkId: 'L',
      secretHash: 'h',
      status: 'active',
      refreshToken: 'r',
      accessToken: 'a',
      accessExpiresAt: 5,
      hubUrl: HUB,
      origin: 'migration',
      createdAt: 1,
      lastUsedAt: 2,
      ttl: 3,
      version: 4,
    }
    expect(store.unmarshal(store.marshal(item))).toEqual(item)
  })

  it('makes every write conditional and maps a lost race to false', async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = []
    const ddb = store.createDynamoTokenStore({
      tableName: 'camstack-alexa-tokens',
      send: async (name, input) => {
        sent.push({ name, input })
        if (input.ConditionExpression === 'version = :v') {
          const err = new Error('lost')
          err.name = 'ConditionalCheckFailedException'
          throw err
        }
        return {}
      },
    })
    await ddb.create({ linkId: 'L', version: 1 } as LinkItem)
    expect(await ddb.replace({ linkId: 'L', version: 2 } as LinkItem, 1)).toBe(false)
    expect(sent.map((s) => s.input.ConditionExpression)).toEqual([
      'attribute_not_exists(linkId)',
      'version = :v',
    ])
    expect(sent.every((s) => s.input.TableName === 'camstack-alexa-tokens')).toBe(true)
  })
})

// ── Credentials ──────────────────────────────────────────────────────

describe('broker credential', () => {
  it('stores only a hash, and verifies the secret half against it', () => {
    const m = broker.mintCredential(seqRandom)
    const parsed = broker.parseCredential(m.credential)
    expect(parsed?.linkId).toBe(m.linkId)
    expect(m.credential).not.toContain(m.secretHash)
    expect(broker.secretMatches(parsed?.secret ?? '', m.secretHash)).toBe(true)
    expect(broker.secretMatches(`${parsed?.secret ?? ''}x`, m.secretHash)).toBe(false)
  })

  it('refuses malformed credentials', () => {
    for (const bad of [
      '',
      'csb1.a.b',
      'xyz.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      null,
    ]) {
      expect(broker.parseCredential(bad)).toBeNull()
    }
  })
})

// ── AcceptGrant ──────────────────────────────────────────────────────

describe('AcceptGrant via the broker', () => {
  it('exchanges the code HERE and gives the hub a credential, never the refresh token', async () => {
    const { memory, w, delivered } = await linkedHub()

    const lwaCall = w.calls.find((c) => c.url.startsWith('https://api.amazon.com'))
    const form = new URLSearchParams(lwaCall?.init.body ?? '')
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('client_secret')).toBe(LWA_SECRET)
    expect(form.get('redirect_uri')).toBe(`${BROKER_URL}/token`)

    expect(delivered.brokerUrl).toBe(BROKER_URL)
    expect(delivered.lwaAccessToken).toBe('AT-from-code')
    expect(String(delivered.brokerCredential)).toMatch(/^csb1\./)

    const hubCalls = w.calls.filter((c) => c.url.startsWith(HUB))
    for (const c of hubCalls) {
      expect(c.init.body).not.toContain('RT-user')
      expect(c.init.body).not.toContain(LWA_SECRET)
      expect(JSON.stringify(c.init.headers)).not.toContain(LWA_SECRET)
    }
    expect(hubCalls[0]?.init.headers?.authorization).toBe(`Bearer ${GRANTEE}`)

    const [item] = [...memory.items.values()]
    expect(item?.status).toBe('active')
    expect(item?.refreshToken).toBe('RT-user')
    expect(item?.hubUrl).toBe(HUB)
  })

  it('falls back to the legacy hand-off for a hub without the broker route', async () => {
    let legacyBody: Record<string, unknown> | null = null
    const w = world({
      hub: (path, init) => {
        if (path === '/addon/export-alexa/oauth/lwa-tokens') {
          legacyBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>
          return response(200, { ok: true })
        }
        return response(404, { error: 'Not found' })
      },
    })
    const { handler, memory } = makeHandler({ fetch: w.fetch })
    const res = await handler(acceptGrantEvent())
    expect(eventName(res)).toBe('AcceptGrant.Response')
    expect(legacyBody).toMatchObject({ lwaAccessToken: 'AT-from-code', lwaRefreshToken: 'RT-user' })
    expect(memory.items.size).toBe(0)
  })

  it('refuses an old hub once the fallback is switched off — and leaks nothing to it', async () => {
    const w = world({ hub: () => response(404, { error: 'Not found' }) })
    const { handler, memory } = makeHandler({ fetch: w.fetch, env: { LEGACY_HUB_FALLBACK: '0' } })
    const res = await handler(acceptGrantEvent())
    expect(eventName(res)).toBe('ErrorResponse')
    expect(w.calls.some((c) => c.url.endsWith('/oauth/lwa-tokens'))).toBe(false)
    expect(memory.items.size).toBe(0)
  })

  it('leaves no item behind when the hub rejects the link', async () => {
    const w = world({ hub: () => response(401, { error: 'unauthorized' }) })
    const { handler, memory } = makeHandler({ fetch: w.fetch })
    const res = await handler(acceptGrantEvent())
    expect(eventName(res)).toBe('ErrorResponse')
    expect(memory.items.size).toBe(0)
  })

  it('without TOKENS_TABLE behaves exactly as before D753 (env secrets, legacy hand-off)', async () => {
    const w = world({})
    const handler = lambda.createHandler({
      env: {
        LAMBDA_REDIRECT_URI: `${BROKER_URL}/token`,
        LWA_CLIENT_ID: LWA_ID,
        LWA_CLIENT_SECRET: LWA_SECRET,
      },
      fetch: w.fetch,
      log: recordingLog().log,
    })
    const res = await handler(acceptGrantEvent())
    expect(eventName(res)).toBe('AcceptGrant.Response')
    expect(w.calls.map((c) => c.url)).toEqual([
      'https://api.amazon.com/auth/o2/token',
      `${HUB}/addon/export-alexa/oauth/lwa-tokens`,
    ])
  })
})

// ── /broker/token ────────────────────────────────────────────────────

describe('/broker/token', () => {
  it('serves the cached access token without calling LWA while it has life left', async () => {
    const { handler, w, delivered } = await linkedHub()
    const before = w.calls.length
    const res = await handler(
      urlEvent('/broker/token', { bearer: String(delivered.brokerCredential) }),
    )
    expect(res.statusCode).toBe(200)
    expect(bodyOf(res)).toEqual({ accessToken: 'AT-from-code', expiresAt: T0 + 3_600_000 })
    expect(w.calls.length).toBe(before)
  })

  it('refreshes near expiry with the skill secret and persists the new token', async () => {
    let now = T0
    const { handler, memory, w, delivered } = await linkedHub({ now: () => now })
    now = T0 + 3_600_000 - 60_000
    const res = await handler(
      urlEvent('/broker/token', { bearer: String(delivered.brokerCredential) }),
    )
    expect(bodyOf(res).accessToken).toBe('AT-refreshed-1')
    const refresh = w.calls.at(-1)
    const form = new URLSearchParams(refresh?.init.body ?? '')
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('RT-user')
    const [item] = [...memory.items.values()]
    expect(item?.accessToken).toBe('AT-refreshed-1')
    expect(item?.refreshToken).toBe('RT-user')
  })

  it('answers a wrong secret and an unknown link identically', async () => {
    const { handler, delivered } = await linkedHub()
    const cred = String(delivered.brokerCredential)
    const wrongSecret = `${cred.slice(0, -4)}AAAA`
    const unknownLink = broker.mintCredential(seqRandom).credential
    const a = await handler(urlEvent('/broker/token', { bearer: wrongSecret }))
    const b = await handler(urlEvent('/broker/token', { bearer: unknownLink }))
    expect(a.statusCode).toBe(401)
    expect(a.body).toBe(b.body)
  })

  it('removes the link and answers 410 when Amazon revoked the grant', async () => {
    let now = T0
    const { handler, memory, delivered } = await linkedHub({ now: () => now })
    const [item] = [...memory.items.values()]
    if (!item) throw new Error('no item')
    memory.items.set(item.linkId, { ...item, refreshToken: 'RT-revoked' })
    now = T0 + 4_000_000
    const res = await handler(
      urlEvent('/broker/token', { bearer: String(delivered.brokerCredential) }),
    )
    expect(res.statusCode).toBe(410)
    expect(bodyOf(res).error).toBe('grant_revoked')
    expect(memory.items.size).toBe(0)
  })

  it('serves the winner of a concurrent refresh instead of clobbering it', async () => {
    let now = T0
    const { handler, memory, delivered } = await linkedHub({ now: () => now })
    now = T0 + 4_000_000
    const original = memory.replace.bind(memory)
    memory.replace = async (item, expected) => {
      // Another invocation refreshed first.
      const cur = memory.items.get(item.linkId)
      if (cur) {
        memory.items.set(item.linkId, {
          ...cur,
          accessToken: 'AT-winner',
          accessExpiresAt: now + 3_600_000,
          version: cur.version + 1,
        })
      }
      return original(item, expected)
    }
    const res = await handler(
      urlEvent('/broker/token', { bearer: String(delivered.brokerCredential) }),
    )
    expect(bodyOf(res).accessToken).toBe('AT-winner')
  })

  it('re-reads a rotated LWA secret on invalid_client and retries once', async () => {
    const ssm = ssmSecrets({ lwa: lwaJson(), skill: skillJson() })
    let now = T0
    let rotated = false
    const w = world({
      lwa: (form) => {
        const expected = rotated ? LWA_SECRET_ROTATED : LWA_SECRET
        if (form.get('client_secret') !== expected)
          return response(401, { error: 'invalid_client' })
        return form.get('grant_type') === 'authorization_code'
          ? response(200, {
              access_token: 'AT-from-code',
              refresh_token: 'RT-user',
              expires_in: 3600,
            })
          : response(200, { access_token: 'AT-after-rotation', expires_in: 3600 })
      },
      hub: () => response(200, { ok: true }),
    })
    const { handler, delivered } = await linkedHub({
      fetch: w.fetch,
      secrets: ssm.secrets,
      now: () => now,
    })
    rotated = true
    ssm.set('lwa', lwaJson(LWA_SECRET_ROTATED))
    now = T0 + 4_000_000
    const res = await handler(
      urlEvent('/broker/token', { bearer: String(delivered.brokerCredential) }),
    )
    expect(bodyOf(res).accessToken).toBe('AT-after-rotation')
  })
})

// ── migrate / rotate / revoke ────────────────────────────────────────

describe('/broker/migrate', () => {
  it('turns a live pre-D753 refresh token into a link the hub can use', async () => {
    const w = world({})
    const { handler, memory } = makeHandler({ fetch: w.fetch })
    const res = await handler(
      urlEvent('/broker/migrate', { body: { refreshToken: 'RT-old', hubUrl: HUB } }),
    )
    expect(res.statusCode).toBe(200)
    const out = bodyOf(res)
    expect(out.brokerUrl).toBe(BROKER_URL)
    expect(out.accessToken).toBe('AT-refreshed-1')
    const [item] = [...memory.items.values()]
    expect(item).toMatchObject({ status: 'active', origin: 'migration', refreshToken: 'RT-old' })

    const tok = await handler(urlEvent('/broker/token', { bearer: String(out.brokerCredential) }))
    expect(tok.statusCode).toBe(200)
  })

  it('refuses a token that is not a live grant of this skill', async () => {
    const { handler, memory } = makeHandler({ fetch: world({}).fetch })
    const res = await handler(urlEvent('/broker/migrate', { body: { refreshToken: 'RT-revoked' } }))
    expect(res.statusCode).toBe(400)
    expect(memory.items.size).toBe(0)
  })

  it('can be switched off', async () => {
    const { handler } = makeHandler({ fetch: world({}).fetch, env: { ALLOW_MIGRATION: '0' } })
    const res = await handler(urlEvent('/broker/migrate', { body: { refreshToken: 'RT-old' } }))
    expect(res.statusCode).toBe(403)
  })
})

describe('/broker/rotate and /broker/revoke', () => {
  it('rotation invalidates the old credential and validates the new one', async () => {
    const { handler, delivered } = await linkedHub()
    const old = String(delivered.brokerCredential)
    const rot = await handler(urlEvent('/broker/rotate', { bearer: old }))
    const fresh = String(bodyOf(rot).brokerCredential)
    expect(fresh).not.toBe(old)
    expect((await handler(urlEvent('/broker/token', { bearer: old }))).statusCode).toBe(401)
    expect((await handler(urlEvent('/broker/token', { bearer: fresh }))).statusCode).toBe(200)
  })

  it('revocation deletes the link', async () => {
    const { handler, memory, delivered } = await linkedHub()
    const cred = String(delivered.brokerCredential)
    expect((await handler(urlEvent('/broker/revoke', { bearer: cred }))).statusCode).toBe(200)
    expect(memory.items.size).toBe(0)
    expect((await handler(urlEvent('/broker/token', { bearer: cred }))).statusCode).toBe(401)
  })

  it('answers 503 when the broker is not configured', async () => {
    const handler = lambda.createHandler({
      env: {},
      fetch: world({}).fetch,
      store: null,
      log: recordingLog().log,
    })
    const res = await handler(urlEvent('/broker/token', { bearer: 'x' }))
    expect(res.statusCode).toBe(503)
  })
})

// ── /token (account linking) and directive forwarding ────────────────

describe('account-linking /token', () => {
  function tokenEvent(secret: string) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: jwtWith({ hubUrl: HUB }),
      client_id: SKILL_ID,
      client_secret: secret,
    })
    return {
      rawPath: '/token',
      requestContext: { http: { method: 'POST' } },
      headers: {},
      body: form.toString(),
      isBase64Encoded: false,
    }
  }

  it('checks the client secret from Parameter Store, accepting the previous one mid-rotation', async () => {
    const ssm = ssmSecrets({
      lwa: lwaJson(),
      skill: skillJson({ previousClientSecret: SKILL_SECRET_PREV }),
    })
    const { handler } = makeHandler({ fetch: world({}).fetch, secrets: ssm.secrets })
    expect((await handler(tokenEvent(SKILL_SECRET))).statusCode).toBe(200)
    expect((await handler(tokenEvent(SKILL_SECRET_PREV))).statusCode).toBe(200)
    expect((await handler(tokenEvent('wrong'))).statusCode).toBe(401)
  })
})

describe('directive forwarding', () => {
  const directive = {
    directive: {
      header: { namespace: 'Alexa', name: 'ReportState', messageId: 'm2', payloadVersion: '3' },
      endpoint: { scope: { type: 'BearerToken', token: GRANTEE }, endpointId: '1' },
      payload: {},
    },
  }

  it('advertises the broker to the hub only when the broker is configured', async () => {
    const on = world({ hub: () => response(200, { event: {} }) })
    await makeHandler({ fetch: on.fetch }).handler(directive)
    expect(on.calls[0]?.init.headers?.[lambda.BROKER_HEADER]).toBe(BROKER_URL)

    const off = world({ hub: () => response(200, { event: {} }) })
    await makeHandler({ fetch: off.fetch, store: null }).handler(directive)
    expect(off.calls[0]?.init.headers?.[lambda.BROKER_HEADER]).toBeUndefined()
  })
})

// ── Logs ─────────────────────────────────────────────────────────────

describe('logging', () => {
  it('never writes a secret, token or credential to the log', async () => {
    const rec = recordingLog()
    let now = T0
    const { handler, delivered } = await linkedHub({ log: rec.log, now: () => now })
    now = T0 + 4_000_000
    const cred = String(delivered.brokerCredential)
    await handler(urlEvent('/broker/token', { bearer: cred }))
    await handler(urlEvent('/broker/rotate', { bearer: cred }))
    await handler(urlEvent('/broker/migrate', { body: { refreshToken: 'RT-old' } }))
    const text = JSON.stringify(rec.lines)
    expect(rec.lines.length).toBeGreaterThan(0)
    for (const needle of [LWA_SECRET, 'RT-user', 'RT-old', 'AT-', cred.split('.')[2] ?? 'x']) {
      expect(text).not.toContain(needle)
    }
  })
})
