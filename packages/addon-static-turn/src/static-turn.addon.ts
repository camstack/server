/**
 * Static TURN/STUN provider: points CamStack at a self-hosted coturn (or any static TURN server).
 *
 * Every server is a `servers` record (D985, D996), reachable through the `integration-instances`
 * cap and edited on the TURN Servers page. The broker aggregates this alongside any other
 * `turn-provider` (e.g. cloudflare-turn) and sends the ICE servers to both the hub and the
 * browser. The old single-server settings were moved into a record by `./migrations`.
 */
import { randomUUID } from 'node:crypto'
import {
  BaseAddon,
  type ConfigUISchema,
  type InferProvider,
  type ProviderRegistration,
  RecordIntegrationInstances,
  RevConflictError,
  defineAddonMigrations,
  integrationInstancesCapability,
  isSecretMarker,
  turnProviderCapability,
} from '@camstack/types'
import {
  ADDON_MIGRATIONS,
  type TurnCataloguePorts,
  type TurnRecordState,
} from './migrations/index.js'
import {
  TURN_DEFAULT_BODY,
  type TurnServerBody,
  parseTurnUrls,
  staticTurnServersKind,
} from './turn-record-kinds.js'

/** The addon keeps no setting of its own: the servers are records. */
export type StaticTurnConfig = Readonly<Record<string, unknown>>

type TurnProvider = InferProvider<typeof turnProviderCapability>
type TurnServerEntry = Awaited<ReturnType<TurnProvider['getTurnServers']>>[number]

const SERVER_LIST_MAX = 200

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Servers are not registry rows: the addon mints their ids. */
function mintServerId(): string {
  return `turn-${randomUUID().slice(0, 8)}`
}

export class StaticTurnAddon extends BaseAddon<StaticTurnConfig> {
  private instances: RecordIntegrationInstances<TurnServerBody> | null = null
  /** The servers being served, by record id: only enabled, configured ones. */
  private readonly served = new Map<string, TurnServerEntry>()
  private secretsWarned = false

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('static-turn needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({ servers: staticTurnServersKind })
    this.instances = new RecordIntegrationInstances(records, staticTurnServersKind, {
      description: { role: 'services', instanceMode: 'multiple', kind: 'servers', canTest: false },
      formSchema: () => this.serverForm(),
      initialBody: (name) => ({ ...TURN_DEFAULT_BODY, name }),
      configured: (body) => parseTurnUrls(body.urls).length > 0,
      onChanged: async (id) => {
        await this.refreshOne(id)
      },
    })
    // The addon moves the old settings first, then serves the servers.
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    await this.refreshAll()

    const provider: TurnProvider = {
      getTurnServers: async () => [...this.served.values()],
    }
    this.ctx.logger.info('Static TURN initialized', {
      meta: { serverCount: this.served.size },
    })
    return [
      { capability: turnProviderCapability, provider },
      { capability: integrationInstancesCapability, provider: this.instances.toProvider() },
    ]
  }

  protected async onShutdown(): Promise<void> {
    this.served.clear()
  }

  /** Re-read every server record and serve exactly those. */
  private async refreshAll(): Promise<void> {
    if (this.instances === null) return
    let all: Awaited<ReturnType<RecordIntegrationInstances<TurnServerBody>['listResolved']>>
    try {
      all = await this.instances.listResolved()
    } catch (err: unknown) {
      // A failed read changes nothing: the addon keeps the servers it has.
      this.ctx.logger.warn('static-turn: the server records could not be read', {
        meta: { error: errMsg(err) },
        tags: { topic: 'static-turn', phase: 'records-read-failed' },
      })
      return
    }
    for (const row of all) this.applyRow(row.id, row.body, row.enabled, row.secrets)
    const live = new Set(all.map((row) => row.id))
    for (const id of this.served.keys()) if (!live.has(id)) this.served.delete(id)
  }

  /** Re-read ONE server after a create / update / delete / switch. */
  private async refreshOne(id: string): Promise<void> {
    if (this.instances === null) return
    try {
      const row = await this.instances.readResolved(id)
      if (row === null) this.served.delete(id)
      else this.applyRow(row.id, row.body, row.enabled, row.secrets)
    } catch (err: unknown) {
      this.ctx.logger.warn('static-turn: a server record could not be read', {
        meta: { error: errMsg(err), integrationId: id },
        tags: { topic: 'static-turn', phase: 'records-read-failed' },
      })
    }
  }

  private applyRow(
    id: string,
    body: TurnServerBody,
    enabled: boolean,
    secrets: 'resolved' | 'unavailable',
  ): void {
    if (secrets === 'unavailable') {
      // A locked keychain is a failed read of the credential: keep the server as it is rather
      // than serve it with an empty one (D49). Warned once per lock.
      if (!this.secretsWarned) {
        this.secretsWarned = true
        this.ctx.logger.warn(
          'static-turn: the keychain is locked; servers keep their previous entry',
          {
            tags: { topic: 'static-turn', phase: 'keychain-locked' },
          },
        )
      }
      if (this.served.has(id)) return
      // Never served without the credential it needs: nothing until the keychain answers.
      if (body.username.trim().length > 0) return
    } else {
      this.secretsWarned = false
    }
    const urls = parseTurnUrls(body.urls)
    if (!enabled || urls.length === 0) {
      this.served.delete(id)
      return
    }
    const username = body.username.trim()
    const credential = (body.credential ?? '').trim()
    this.served.set(id, {
      urls,
      ...(username.length > 0 ? { username } : {}),
      ...(credential.length > 0 ? { credential } : {}),
    })
  }

  /** The ports of the connection migrations: the old settings in, the record out. */
  private migrationPorts(): TurnCataloguePorts {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(staticTurnServersKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A credential that is still a marker was not resolved: abort before anything is written.
        if (isSecretMarker(stored['credential'])) {
          throw new Error('the old TURN credential could not be resolved')
        }
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      findServerId: async () => (await this.firstServerId()) ?? null,
      readRecord: async (id: string): Promise<TurnRecordState | null> => {
        const row = await handle.getResolved(id)
        if (row === null) return null
        return { urls: row.data.urls, hasCredential: (row.data.credential ?? '').length > 0 }
      },
      ensureServerId: async () => (await this.firstServerId()) ?? mintServerId(),
      putRecord: async (id: string, body: TurnServerBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(id)) !== null) return 'exists'
        try {
          await handle.put({ id, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      clearOldCredential: async () => {
        await this.clearSecrets(['credential'])
      },
    }
  }

  /** The id of the first server record; undefined when none. */
  private async firstServerId(): Promise<string | undefined> {
    const records = this.ctx.records
    if (records === undefined) return undefined
    const page = await records.kind(staticTurnServersKind).query({ limit: SERVER_LIST_MAX })
    return page.records[0]?.id
  }

  // ── Instance form ─────────────────────────────────────────────────

  private serverForm(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'turn',
          title: 'TURN / STUN server',
          titleKey: 'static-turn:globalSettings.s_turn.title',
          description:
            'Self-hosted (coturn) or any static TURN/STUN server. CamStack sends these ICE servers to both the hub and the browser so WebRTC can traverse NAT/CGNAT.',
          descriptionKey: 'static-turn:globalSettings.s_turn.description',
          fields: [
            {
              type: 'info' as const,
              key: 'help',
              label: 'How to fill',
              labelKey: 'static-turn:globalSettings.s_turn.help.label',
              format: 'html' as const,
              variant: 'info' as const,
              content:
                '<ul>' +
                '<li><strong>URLs</strong>: one per line or comma-separated, e.g. ' +
                '<code>turn:&lt;public-ip&gt;:3478?transport=udp</code> and optionally ' +
                '<code>stun:&lt;public-ip&gt;:3478</code>.</li>' +
                '<li><strong>Username / Credential</strong>: the coturn long-term user ' +
                '(<code>user=NAME:PASS</code> + <code>lt-cred-mech</code> in turnserver.conf).</li>' +
                '<li>The TURN host must be reachable from the public internet: ' +
                'port-forward UDP 3478 + the relay range (e.g. 49152–49200) and set ' +
                '<code>external-ip</code> in coturn to your public IP.</li>' +
                '</ul>',
            },
            {
              type: 'text',
              key: 'urls',
              label: 'TURN / STUN URLs',
              labelKey: 'static-turn:globalSettings.s_turn.urls.label',
              description: 'One per line or comma-separated.',
              descriptionKey: 'static-turn:globalSettings.s_turn.urls.description',
              placeholder: 'turn:88.153.65.170:3478?transport=udp, stun:88.153.65.170:3478',
              required: true,
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'static-turn:globalSettings.s_turn.username.label',
              description: 'coturn long-term-credential username.',
              descriptionKey: 'static-turn:globalSettings.s_turn.username.description',
              placeholder: 'camstack',
            },
            {
              type: 'password',
              key: 'credential',
              label: 'Credential / password',
              labelKey: 'static-turn:globalSettings.s_turn.credential.label',
              description: 'coturn long-term-credential password.',
              descriptionKey: 'static-turn:globalSettings.s_turn.credential.description',
              showToggle: true,
            },
          ],
        },
      ],
    })
  }
}

export default StaticTurnAddon
