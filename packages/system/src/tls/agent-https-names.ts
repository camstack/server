/**
 * Which names the hub has certified to which agent (D856): the memory behind "a name
 * already certified to another node is never signed again". Hub only.
 */
import type { CollectionColumn, RecordKindHandle, SettingsStoreClient } from '@camstack/types'
import type { AgentHttpsNameBody } from '../builtins/system-config/record-kinds.js'
import { systemConfigRecordKinds } from '../builtins/system-config/record-kinds.js'

export const AGENT_HTTPS_NAMES_COLLECTION = 'agent_https_names'

export const AGENT_HTTPS_NAMES_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'names', type: 'JSON' as const, notNull: true },
  { name: 'issuedAt', type: 'INTEGER' as const, notNull: true },
]

export interface AgentHttpsNamesDeps {
  readonly agentHttpsNamesKind: RecordKindHandle<AgentHttpsNameBody>
  readonly legacyStore?: SettingsStoreClient
}

export class AgentHttpsNames {
  private readonly byNode = new Map<string, readonly string[]>()
  private readonly kind: RecordKindHandle<AgentHttpsNameBody> | null
  private readonly store: SettingsStoreClient | null

  constructor(deps: SettingsStoreClient | AgentHttpsNamesDeps) {
    if ('agentHttpsNamesKind' in deps) {
      this.kind = deps.agentHttpsNamesKind
      this.store = deps.legacyStore ?? null
    } else {
      this.kind = null
      this.store = deps
    }
  }

  async load(): Promise<void> {
    const kind = this.kind
    if (kind !== null) {
      const page = await kind.query({ limit: 10_000 })
      for (const row of page.records) {
        this.byNode.set(
          row.id,
          row.data.names.map((n) => n.toLowerCase()),
        )
      }
      return
    }
    const rows = await this.store!.query.query({ collection: AGENT_HTTPS_NAMES_COLLECTION })
    for (const row of rows) {
      const names: unknown = row.data['names']
      if (Array.isArray(names)) {
        this.byNode.set(
          row.id,
          names.filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase()),
        )
      }
    }
  }

  namesOf(nodeId: string): readonly string[] | null {
    return this.byNode.get(nodeId) ?? null
  }

  takenByOthers(nodeId: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const [id, names] of this.byNode) {
      if (id === nodeId) continue
      for (const n of names) out.add(n)
    }
    return out
  }

  async release(nodeId: string): Promise<boolean> {
    if (!this.byNode.delete(nodeId)) return false
    const kind = this.kind
    if (kind !== null) {
      await kind.delete(nodeId)
      return true
    }
    await this.store!.delete.mutate({ collection: AGENT_HTTPS_NAMES_COLLECTION, key: nodeId })
    return true
  }

  async record(nodeId: string, names: readonly string[]): Promise<void> {
    const lowered = names.map((n) => n.toLowerCase())
    const existed = this.byNode.has(nodeId)
    this.byNode.set(nodeId, lowered)
    const issuedAt = Date.now()
    const body: AgentHttpsNameBody = { names: lowered, issuedAt }
    const kind = this.kind
    if (kind !== null) {
      const parsed = systemConfigRecordKinds['agent-https-names'].schema.safeParse(body)
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id: nodeId, data: parsed.data })
      return
    }
    const data = { names: lowered, issuedAt }
    if (existed) {
      await this.store!.update.mutate({
        collection: AGENT_HTTPS_NAMES_COLLECTION,
        id: nodeId,
        data,
      })
    } else {
      await this.store!.insert.mutate({
        collection: AGENT_HTTPS_NAMES_COLLECTION,
        record: { id: nodeId, data },
      })
    }
  }
}

const SLOT = Symbol.for('camstack.agent-https.names')

export function setProcessAgentHttpsNames(names: AgentHttpsNames | null): void {
  if (names === null) Reflect.deleteProperty(globalThis, SLOT)
  else Reflect.set(globalThis, SLOT, names)
}

export function getProcessAgentHttpsNames(): AgentHttpsNames | null {
  const value: unknown = Reflect.get(globalThis, SLOT)
  return value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'takenByOthers') === 'function'
    ? (value as AgentHttpsNames)
    : null
}
