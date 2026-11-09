/**
 * A real records engine on in-memory SQLite, with the notification kinds declared, bound the way the
 * owner binds them: the ports the `pipeline-analytics` catalogue reads and writes for the
 * notification templates, plus the settings ports a test supplies.
 */
import { RecordsEngine } from '@camstack/server/system'
import { createRecordsAccess, type RecordsAccess, type RecordsTransport } from '@camstack/types'
import Database from 'better-sqlite3'
import { ncRecordKinds } from '../../../notification-center/record-kinds.js'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDetectionVerdictLedger } from '../../../notification-center/detection-verdict-ledger.js'
import { ncDurableRecordKinds } from '../../../notification-center/nc-durable-record-kinds.js'
import type {
  NcRuleActionsMigrationPorts,
  NcTemplateMigrationPorts,
  RetrainVerdictFramePorts,
} from '../../index.js'

const OWNER = 'pipeline-analytics'

function engineTransport(engine: RecordsEngine): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly owner: string } =>
    Object.assign({}, input, { owner: OWNER })
  return {
    declareKinds: (i) => engine.declareKinds(as(i)),
    get: (i) => engine.get(as(i)),
    getMany: (i) => engine.getMany(as(i)),
    secretRefs: (i) => engine.secretRefs(as(i)),
    put: (i) => engine.put(as(i)),
    putMany: (i) => engine.putMany(as(i)),
    patch: (i) => engine.patch(as(i)),
    delete: (i) => engine.delete(as(i)),
    deleteMany: (i) => engine.deleteMany(as(i)),
    query: (i) => engine.query(as(i)),
    count: (i) => engine.count(as(i)),
    histogram: (i) => engine.histogram(as(i)),
    aggregate: (i) => engine.aggregate(as(i)),
    deleteWhere: (i) => engine.deleteWhere(as(i)),
    transact: (i) => engine.transact(as(i)),
    deleteDevice: (i) => engine.deleteDevice(as(i)),
    allocateId: (i) => engine.allocateId(as(i)),
  }
}

export interface NcWorld {
  readonly records: RecordsAccess
  /** The template kinds, plus a real verdict ledger and retrain ports that find nothing to do. */
  readonly ncPorts: NcTemplateMigrationPorts & RetrainVerdictFramePorts & NcRuleActionsMigrationPorts
}

export async function makeNcWorld(): Promise<NcWorld> {
  const engine = new RecordsEngine(new Database(':memory:'), {
    databaseId: 'settings',
    logger: makeSilentLogger(),
  })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: engineTransport(engine),
    secrets: null,
  })
  await records.declare(ncRecordKinds)
  await records.declare({ 'detection-verdicts': ncDurableRecordKinds['detection-verdicts'] })
  return {
    records,
    ncPorts: {
      rules: records.kind(ncRecordKinds['rules']),
      timelapseRules: records.kind(ncRecordKinds['timelapse-rules']),
      texts: records.kind(ncRecordKinds.texts),
      legacySequences: records.kind(ncRecordKinds.sequences),
      // Specs that do not run the Actions migration never reach the Actions cap.
      actions: {
        list: async () => [],
        create: async () => {
          throw new Error('the Actions cap is not wired in this world')
        },
      },
      verdicts: new NcDetectionVerdictLedger({ records, logger: makeSilentLogger() }),
      resolveTrackAlias: async () => null,
      listStagedTracks: async () => [],
      copyBestFrame: async () => ({ ok: false as const, reason: 'not-wired' }),
      logger: makeSilentLogger(),
    },
  }
}
