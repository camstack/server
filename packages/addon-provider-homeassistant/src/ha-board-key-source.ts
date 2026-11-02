/**
 * `board-key-source` for Home Assistant: reads an ESPHome board's API
 * encryption key from the ESPHome Builder add-on that runs inside HA.
 *
 * The path reuses what the broker already holds, the long-lived token on the
 * WebSocket, and opens no port and asks for no second credential:
 *
 *   1. `supervisor/api GET /discovery`   -> the add-on that announced `esphome`
 *   2. `supervisor/api GET /addons/<slug>/info` -> its `ingress_url`
 *   3. `supervisor/api POST /ingress/session` (admin only) -> a session
 *   4. `GET <ha><ingress_url>devices`, cookie `ingress_session` -> the boards
 *   5. `GET <ha><ingress_url>json-config?configuration=<x>.yaml` -> the key
 *
 * **What crosses.** The builder's `json-config` body carries EVERY value the
 * YAML secrets file resolves, the Wi-Fi passphrase included. It is parsed in
 * memory straight into a schema that names only `api.encryption.key`; Zod
 * drops every other field at the parse, so the rest never reaches a variable,
 * a return value or a log line. No body is ever logged, only a reason.
 */
import {
  errMsg,
  type BoardKeyBoard,
  type BoardKeyFailureReason,
  type BoardKeyListResult,
  type BoardKeyResult,
  type BoardKeySource,
  type IBoardKeySourceProvider,
  type IScopedLogger,
} from '@camstack/types'
import { z } from 'zod'

/** One HA connection, as this source needs it. */
export interface BoardKeyHaBroker {
  readonly id: string
  readonly name: string
  /** `null` for a supervisor-token broker: it has no address of its own. */
  readonly baseUrl: string | null
  send(message: { readonly type: string } & Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface BoardKeyBrokers {
  list(): readonly BoardKeyHaBroker[]
}

/** The slice of `fetch` the ingress reads use. */
export interface BoardKeyHttpResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}
export type BoardKeyHttp = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<BoardKeyHttpResponse>

export interface HaBoardKeySourceDeps {
  readonly brokers: BoardKeyBrokers
  readonly http: BoardKeyHttp
  readonly logger: IScopedLogger
}

const INGRESS_PREFIX = '/api/hassio_ingress/'
const ESPHOME_SERVICE = 'esphome'

const DiscoverySchema = z.object({
  discovery: z.array(z.object({ addon: z.string(), service: z.string() })),
})
const AddonInfoSchema = z.object({ ingress_url: z.string().nullable().optional() })
const SessionSchema = z.object({ session: z.string().min(1) })
const DevicesSchema = z.object({
  configured: z.array(
    z.object({
      name: z.string(),
      configuration: z.string(),
      address: z.string().nullable().optional(),
    }),
  ),
})
/** The ONLY part of `json-config` that is read; every other field is dropped by the parse. */
const KeyConfigSchema = z.object({
  api: z.object({ encryption: z.object({ key: z.string().min(1) }).optional() }).optional(),
})

const ADMIN_CODES: ReadonlySet<string> = new Set(['unauthorized', 'forbidden', 'not_admin'])

class SourceFailure extends Error {
  constructor(
    readonly reason: BoardKeyFailureReason,
    readonly detail?: string,
  ) {
    super(reason)
  }
}

function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code: unknown = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : null
}

interface IngressAccess {
  readonly root: string
  readonly cookie: string
}

export class HaBoardKeySource {
  constructor(private readonly deps: HaBoardKeySourceDeps) {}

  listSources(): readonly BoardKeySource[] {
    return this.deps.brokers.list().map((b) => ({ sourceId: b.id, name: b.name }))
  }

  async listBoards(sourceId: string): Promise<BoardKeyListResult> {
    try {
      const access = await this.openIngress(sourceId)
      const raw = await this.getJson(access, 'devices')
      const parsed = DevicesSchema.safeParse(raw)
      if (!parsed.success) throw new SourceFailure('unreadable-config', 'unexpected devices reply')
      const boards: BoardKeyBoard[] = parsed.data.configured.map((d) => ({
        configuration: d.configuration,
        name: d.name,
        address: d.address ?? null,
      }))
      return { ok: true, boards }
    } catch (err: unknown) {
      return this.fail(sourceId, 'listBoards', err)
    }
  }

  async getBoardKey(sourceId: string, configuration: string): Promise<BoardKeyResult> {
    try {
      const access = await this.openIngress(sourceId)
      const raw = await this.getJson(
        access,
        `json-config?configuration=${encodeURIComponent(configuration)}`,
        configuration,
      )
      const parsed = KeyConfigSchema.safeParse(raw)
      if (!parsed.success) throw new SourceFailure('unreadable-config')
      const key = parsed.data.api?.encryption?.key
      if (key === undefined) throw new SourceFailure('no-encryption-key')
      return { ok: true, key }
    } catch (err: unknown) {
      return this.fail(sourceId, 'getBoardKey', err)
    }
  }

  private fail(
    sourceId: string,
    op: string,
    err: unknown,
  ): { ok: false; reason: BoardKeyFailureReason; detail?: string } {
    const failure =
      err instanceof SourceFailure ? err : new SourceFailure('unreachable', errMsg(err))
    // The reason is the whole story: no body, no key, no URL with a token in it.
    this.deps.logger.warn(`board-key-source ${op} refused`, {
      meta: { sourceId, reason: failure.reason },
    })
    return failure.detail === undefined
      ? { ok: false, reason: failure.reason }
      : { ok: false, reason: failure.reason, detail: failure.detail }
  }

  private async supervisor(
    broker: BoardKeyHaBroker,
    endpoint: string,
    method: 'get' | 'post',
  ): Promise<unknown> {
    try {
      return await broker.send({ type: 'supervisor/api', endpoint, method })
    } catch (err: unknown) {
      const code = errorCode(err)
      if (code !== null && ADMIN_CODES.has(code)) {
        throw new SourceFailure('not-admin', 'the Home Assistant token is not an administrator')
      }
      throw new SourceFailure('unreachable', errMsg(err))
    }
  }

  private async openIngress(sourceId: string): Promise<IngressAccess> {
    const broker = this.deps.brokers.list().find((b) => b.id === sourceId)
    if (broker === undefined) throw new SourceFailure('unknown-source')
    if (broker.baseUrl === null) {
      throw new SourceFailure('no-ingress-url', 'this broker has no address of its own')
    }
    const discovery = DiscoverySchema.safeParse(await this.supervisor(broker, '/discovery', 'get'))
    const slug = discovery.success
      ? discovery.data.discovery.find((d) => d.service === ESPHOME_SERVICE)?.addon
      : undefined
    if (slug === undefined) throw new SourceFailure('no-builder')
    const info = AddonInfoSchema.safeParse(
      await this.supervisor(broker, `/addons/${encodeURIComponent(slug)}/info`, 'get'),
    )
    const ingressUrl = info.success ? info.data.ingress_url : undefined
    if (typeof ingressUrl !== 'string' || !ingressUrl.startsWith(INGRESS_PREFIX)) {
      throw new SourceFailure('no-ingress-url')
    }
    const session = SessionSchema.safeParse(
      await this.supervisor(broker, '/ingress/session', 'post'),
    )
    if (!session.success) throw new SourceFailure('not-admin', 'no ingress session was granted')
    const base = broker.baseUrl.replace(/\/+$/, '')
    const path = ingressUrl.endsWith('/') ? ingressUrl : `${ingressUrl}/`
    return { root: `${base}${path}`, cookie: `ingress_session=${session.data.session}` }
  }

  private async getJson(
    access: IngressAccess,
    relative: string,
    configuration?: string,
  ): Promise<unknown> {
    let response: BoardKeyHttpResponse
    try {
      response = await this.deps.http(`${access.root}${relative}`, {
        headers: { Cookie: access.cookie, Accept: 'application/json' },
      })
    } catch (err: unknown) {
      throw new SourceFailure('unreachable', errMsg(err))
    }
    if (response.status === 404 && configuration !== undefined) {
      throw new SourceFailure('unknown-board', configuration)
    }
    if (response.status === 401 || response.status === 403) {
      throw new SourceFailure('not-admin', `the builder answered ${response.status}`)
    }
    if (!response.ok)
      throw new SourceFailure('unreachable', `the builder answered ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new SourceFailure('unreadable-config')
    }
  }
}

/** The cap provider over a {@link HaBoardKeySource}. */
export function createHaBoardKeyProvider(source: HaBoardKeySource): IBoardKeySourceProvider {
  return {
    listSources: async () => source.listSources(),
    listBoards: (input) => source.listBoards(input.sourceId),
    getBoardKey: (input) => source.getBoardKey(input.sourceId, input.configuration),
  }
}
