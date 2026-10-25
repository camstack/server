/**
 * The wire of `ctx.records` for an addon that runs in a forked runner or on an
 * agent (D881): every call is a cap call on `ctx.api.records`, and the parent
 * (or, on an agent, the agent and then `$hub-cap-fwd`) STAMPS who is calling
 * from the connection the call arrived on. The input carries no identity, so
 * there is nothing here an addon could change to read another addon's kind.
 */
import type { AddonApi, RecordsTransport } from '@camstack/types'

export function recordsTransportOf(api: AddonApi): RecordsTransport {
  const r = api.records
  return {
    declareKinds: (input) => r.declareKinds.mutate(input),
    get: (input) => r.get.query(input),
    getMany: (input) => r.getMany.query(input),
    secretRefs: (input) => r.secretRefs.query(input),
    put: (input) => r.put.mutate(input),
    putMany: (input) => r.putMany.mutate(input),
    patch: (input) => r.patch.mutate(input),
    delete: (input) => r.delete.mutate(input),
    deleteMany: (input) => r.deleteMany.mutate(input),
    query: (input) => r.query.query(input),
    count: (input) => r.count.query(input),
    histogram: (input) => r.histogram.query(input),
    aggregate: (input) => r.aggregate.query(input),
    deleteWhere: (input) => r.deleteWhere.mutate(input),
    transact: (input) => r.transact.mutate(input),
    deleteDevice: (input) => r.deleteDevice.mutate(input),
    allocateId: (input) => r.allocateId.mutate(input),
  }
}
