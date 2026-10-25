/**
 * A records world for specs (D881): the REAL engine behind the REAL provider,
 * two files (settings, events) in memory, and a transport that states the
 * caller the way a hub in-process builtin does. Nothing is faked between
 * `ctx.records` and SQLite except the file threads.
 */
import Database from 'better-sqlite3'
import {
  createRecordsAccess,
  createSecretsAccess,
  type DataStoreDatabase,
  type IRecordsProvider,
  type RecordsAccess,
  type RecordsTransport,
  type KeychainResolveEntry,
  type KeychainResolveResult,
  type KeychainTransport,
} from '@camstack/types'
import { RecordsEngine } from '../../records/records-engine.js'
import { RecordsProvider } from '../../records/records-provider.js'
import type { PlacementRouter } from '../../placement-router.js'
import { silentLogger } from './records-harness.js'

export class FakeFile {
  readonly db: Database.Database = new Database(':memory:')
  readonly engine: RecordsEngine
  constructor(readonly databaseId: DataStoreDatabase) {
    this.engine = new RecordsEngine(this.db, { databaseId, logger: silentLogger() })
  }
  records(op: string, input: unknown): Promise<unknown> {
    const fn: unknown = Reflect.get(this.engine, op)
    if (typeof fn !== 'function') throw new Error(`no op ${op}`)
    return Reflect.apply(fn, this.engine, [input])
  }
}

export interface RecordsWorld {
  readonly provider: RecordsProvider
  readonly settings: FakeFile
  readonly events: FakeFile
  /** The in-process transport of `owner`: the caller is stated. */
  transportFor(owner: string): RecordsTransport
}

export function makeRecordsWorld(): RecordsWorld {
  const settings = new FakeFile('settings')
  const events = new FakeFile('events')
  const router = {
    openFiles: () => [settings, events],
    recordsFileFor: async (id: DataStoreDatabase) => (id === 'events' ? events : settings),
  }
  // The provider needs only these two members of the router and of a file.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a two-method stand-in for the router in a spec
  const provider = new RecordsProvider(router as unknown as PlacementRouter, silentLogger())
  const as = <I extends object>(owner: string, input: I): I & { readonly callerAddonId: string } =>
    Object.assign({}, input, { callerAddonId: owner })
  const transportFor = (owner: string): RecordsTransport => {
    const p: IRecordsProvider = provider
    return {
      declareKinds: (i) => p.declareKinds(as(owner, i)),
      get: (i) => p.get(as(owner, i)),
      getMany: (i) => p.getMany(as(owner, i)),
      secretRefs: (i) => p.secretRefs(as(owner, i)),
      put: (i) => p.put(as(owner, i)),
      putMany: (i) => p.putMany(as(owner, i)),
      patch: (i) => p.patch(as(owner, i)),
      delete: (i) => p.delete(as(owner, i)),
      deleteMany: (i) => p.deleteMany(as(owner, i)),
      query: (i) => p.query(as(owner, i)),
      count: (i) => p.count(as(owner, i)),
      histogram: (i) => p.histogram(as(owner, i)),
      aggregate: (i) => p.aggregate(as(owner, i)),
      deleteWhere: (i) => p.deleteWhere(as(owner, i)),
      transact: (i) => p.transact(as(owner, i)),
      deleteDevice: (i) => p.deleteDevice(as(owner, i)),
      allocateId: (i) => p.allocateId(as(owner, i)),
    }
  }
  return { provider, settings, events, transportFor }
}

/** Hub-style `ctx.records` for a spec owner (in-memory engine, real provider). */
export async function makeRecordsAccessForOwner(
  owner: string,
  secrets: KeychainTransport | null = null,
): Promise<RecordsAccess> {
  const world = makeRecordsWorld()
  await world.provider.init()
  return createRecordsAccess({
    owner,
    transport: world.transportFor(owner),
    secrets: secrets === null ? null : createSecretsAccess({ owner, transport: secrets }),
  })
}

/** An in-memory keychain with a lock switch, speaking the transport `ctx.secrets` speaks. */
export interface FakeKeychain extends KeychainTransport {
  readonly values: Map<string, string>
  locked: boolean
  /** Every ref ever put, so a spec can prove a value was written before its row. */
  readonly puts: string[]
}

export function makeFakeKeychain(): FakeKeychain {
  const kc: FakeKeychain = {
    values: new Map(),
    locked: false,
    puts: [],
    async put(input) {
      if (kc.locked) throw new Error('keychain is locked (key-missing)')
      kc.puts.push(input.ref)
      kc.values.set(input.ref, input.value)
      return { ref: input.ref, version: 1 }
    },
    async resolve(input): Promise<KeychainResolveResult> {
      const out: Record<string, KeychainResolveEntry> = {}
      for (const ref of input.refs) {
        const value = kc.values.get(ref)
        out[ref] = kc.locked
          ? { kind: 'unavailable', reason: 'key-missing' }
          : value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value, version: 1 }
      }
      return out
    },
    async delete(input) {
      let deleted = 0
      for (const ref of input.refs) if (kc.values.delete(ref)) deleted += 1
      return { deleted }
    },
    async getState() {
      return kc.locked ? { state: 'locked', reason: 'key-missing' } : { state: 'ready' }
    },
  }
  return kc
}
