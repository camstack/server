/**
 * The Echo targets as records: one `notify-alexa-echo` record per target (an instance of the function
 * cap `notification-output`), the id the one a notification rule names. The records are the one source:
 * the controller reads them on every use and writes only the row it changes.
 */
import {
  type IScopedLogger,
  type LegacyTargets,
  NotificationTargetStore,
  type NotificationTargetInstancesSpec,
  type NotificationTargetStoreOptions,
  notificationTargetKinds,
  type RecordsAccess,
  type Target,
} from '@camstack/types'
import { type AlexaEchoTarget, alexaEchoTargetSchema, readEchoTargets } from '../config.js'
import type { EchoRecordPorts, EchoSettingPorts } from '../migrations/echo-targets-to-records.js'
import type { EchoDndRecordPorts } from '../migrations/strip-echo-target-respect-dnd.js'
import type { PositionalRecordsDoor } from '../migrations/records-door.js'
import { alexaTargetKind, type SpeakBrokerView, validateEchoTarget } from './provider.js'
import { ALEXA_SPEAK_ADDON_ID } from './constants.js'

export const alexaNotifyRecordKinds = notificationTargetKinds([alexaTargetKind()])

export type EchoTargetStore = NotificationTargetStore

export function echoTargetStoreOver(
  records: Pick<RecordsAccess, 'kind'>,
  options: NotificationTargetStoreOptions = {},
): EchoTargetStore {
  return NotificationTargetStore.of(
    records,
    ALEXA_SPEAK_ADDON_ID,
    alexaNotifyRecordKinds,
    [alexaTargetKind()],
    options,
  )
}

/** The `echoTargets` setting as the legacy source: a row the migration left there is still served. */
export function legacyEchoTargetsOver(
  setting: Pick<EchoSettingPorts, 'readRows' | 'writeRows'>,
): LegacyTargets {
  return {
    list: async () =>
      readEchoTargets({ echoTargets: await setting.readRows() }).map((row) => ({
        id: row.id,
        name: row.name,
        kind: alexaTargetKind().kind,
        enabled: row.enabled,
        config: {
          ...(row.brokerId.length > 0 ? { brokerId: row.brokerId } : {}),
          echoId: row.echoId,
        },
      })),
    delete: async (id) => {
      const rows = await setting.readRows()
      const rest = rows.filter((row) => {
        const parsed = alexaEchoTargetSchema.safeParse(row)
        return !(parsed.success && parsed.data.id === id)
      })
      if (rest.length !== rows.length) await setting.writeRows(rest)
    },
  }
}

/** The row a stored target is for the settings page: the account link is '' until one is chosen. */
export function echoRowOf(target: Target): AlexaEchoTarget {
  return {
    id: target.id,
    name: target.name,
    enabled: target.enabled,
    brokerId: typeof target.config['brokerId'] === 'string' ? target.config['brokerId'] : '',
    echoId: typeof target.config['echoId'] === 'string' ? target.config['echoId'] : '',
  }
}

/** More Echo targets than any account holds: the migrations read them in one page. */
const ECHO_RECORDS_MAX = 1000

/** The migrations' ports over the `notify-alexa-echo` record kind. */
export function echoRecordPortsOver(
  records: PositionalRecordsDoor,
  logger: Pick<IScopedLogger, 'warn'>,
): EchoRecordPorts & EchoDndRecordPorts {
  const [kind] = Object.values(alexaNotifyRecordKinds)
  if (kind === undefined)
    throw new Error('import-alexa: the Echo target record kind is not declared')
  const handle = records.kind(kind)
  return {
    readEchoRecord: async (id) => (await handle.getResolved(id))?.data ?? null,
    writeEchoRecord: async (id, body) => {
      await handle.put({ id, data: body })
    },
    dropEchoRecord: async (id) => {
      await handle.delete(id)
    },
    listEchoRecords: async () => (await handle.query({ limit: ECHO_RECORDS_MAX })).records,
    replaceEchoRecord: async (id, data) => {
      await handle.put({ id, data: { ...data } })
    },
    echoDndStripped: (changed) => {
      logger.warn(
        'Echo targets lost their Do Not Disturb switch; the priority decides now (wasOff: a normal notification is now quiet in DND)',
        { meta: { targets: changed } },
      )
    },
    echoSkipped: (row) => {
      logger.warn('Echo target left in the echoTargets setting; it keeps being served', {
        meta: { targetId: row.id, reason: row.reason },
      })
    },
  }
}

/** The slice of the speech controller the Echo probe asks. */
export interface EchoProbeSource {
  readonly provider: {
    probeTargetConfig(input: {
      readonly kind: string
      readonly config: Readonly<Record<string, unknown>>
    }): ReturnType<NonNullable<NotificationTargetInstancesSpec['probe']>>
  }
}

/**
 * The Echo instance's test: the old probe (is the Amazon account of the target signed in on its
 * broker?) as the tri-state of `testInstance`. Speech not running yet answers `inconclusive` through
 * the same mapping (a failure with no HTTP status), never `unsupported`.
 */
export function echoTargetProbe(
  speak: () => EchoProbeSource | null,
): NonNullable<NotificationTargetInstancesSpec['probe']> {
  return async (input) => {
    const source = speak()
    if (source === null) {
      return {
        ok: false,
        resolvedUrl: 'alexa://session',
        error: 'Echo speech is not running',
      }
    }
    return source.provider.probeTargetConfig({
      kind: input.kind,
      config: input.config,
    })
  }
}

/**
 * The Echo instance's save-time rule over the accounts now (D1013): the check the removed
 * `upsertTarget` made, on the instance door. Speech not started yet has no account to name, so the
 * write is refused with the reason, never accepted blind.
 */
export function echoTargetValidator(
  brokers: () => readonly SpeakBrokerView[] | null,
): NonNullable<NotificationTargetInstancesSpec['validate']> {
  return ({ config }) => validateEchoTarget(brokers() ?? [], config)
}
