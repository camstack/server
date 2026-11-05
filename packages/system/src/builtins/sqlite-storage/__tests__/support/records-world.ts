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

/** The in-process transport of `owner` over a provider: the caller is stated, never claimed. */
export function stampedRecordsTransport(
  provider: IRecordsProvider,
  owner: string,
): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly callerAddonId: string } =>
    Object.assign({}, input, { callerAddonId: owner })
  return {
    declareKinds: (i) => provider.declareKinds(as(i)),
    get: (i) => provider.get(as(i)),
    getMany: (i) => provider.getMany(as(i)),
    secretRefs: (i) => provider.secretRefs(as(i)),
    put: (i) => provider.put(as(i)),
    putMany: (i) => provider.putMany(as(i)),
    patch: (i) => provider.patch(as(i)),
    delete: (i) => provider.delete(as(i)),
    deleteMany: (i) => provider.deleteMany(as(i)),
    query: (i) => provider.query(as(i)),
    count: (i) => provider.count(as(i)),
    histogram: (i) => provider.histogram(as(i)),
    aggregate: (i) => provider.aggregate(as(i)),
    deleteWhere: (i) => provider.deleteWhere(as(i)),
    transact: (i) => provider.transact(as(i)),
    deleteDevice: (i) => provider.deleteDevice(as(i)),
    allocateId: (i) => provider.allocateId(as(i)),
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
  const transportFor = (owner: string): RecordsTransport => stampedRecordsTransport(provider, owner)
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
