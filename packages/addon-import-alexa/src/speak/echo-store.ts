/**
 * The Echo targets as records: one `notify-alexa-echo` record per target (an instance of the function
 * cap `notification-output`), the id the one a notification rule names. The controller keeps its own
 * rows in memory; this file is how they load from and persist to the records.
 */
import {
  NotificationTargetStore,
  notificationTargetKinds,
  type RecordsAccess,
  type Target,
} from '@camstack/types'
import type { AlexaEchoTarget } from '../config.js'
import type { EchoRecordPorts } from '../migrations/echo-targets-to-records.js'
import { alexaTargetKind } from './provider.js'
import { ALEXA_SPEAK_ADDON_ID } from './constants.js'

export const alexaNotifyRecordKinds = notificationTargetKinds([alexaTargetKind()])

export type EchoTargetStore = NotificationTargetStore

export function echoTargetStoreOver(records: Pick<RecordsAccess, 'kind'>): EchoTargetStore {
  return NotificationTargetStore.of(records, ALEXA_SPEAK_ADDON_ID, alexaNotifyRecordKinds, [
    alexaTargetKind(),
  ])
}

/** The row a stored target is for the controller: the account link is '' until one is chosen. */
export function echoRowOf(target: Target): AlexaEchoTarget {
  return {
    id: target.id,
    name: target.name,
    enabled: target.enabled,
    brokerId: typeof target.config['brokerId'] === 'string' ? target.config['brokerId'] : '',
    echoId: typeof target.config['echoId'] === 'string' ? target.config['echoId'] : '',
    respectDnd: target.config['respectDnd'] !== false,
  }
}

function targetOfRow(row: AlexaEchoTarget): Target {
  return {
    id: row.id,
    name: row.name,
    kind: alexaTargetKind().kind,
    addonId: ALEXA_SPEAK_ADDON_ID,
    enabled: row.enabled,
    config: {
      ...(row.brokerId.length > 0 ? { brokerId: row.brokerId } : {}),
      echoId: row.echoId,
      respectDnd: row.respectDnd,
    },
  }
}

/** Make the records say `next`: a row that changed is written, a row that went is deleted. */
export async function persistEchoRows(
  store: EchoTargetStore,
  next: readonly AlexaEchoTarget[],
): Promise<void> {
  const stored = new Map((await store.list()).map((target) => [target.id, echoRowOf(target)]))
  for (const row of next) {
    const before = stored.get(row.id)
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(row)) {
      await store.upsert(targetOfRow(row))
    }
  }
  const keep = new Set(next.map((row) => row.id))
  for (const id of stored.keys()) {
    if (!keep.has(id)) await store.delete(id)
  }
}

/** The migration's ports over the `notify-alexa-echo` record kind. */
export function echoRecordPortsOver(records: Pick<RecordsAccess, 'kind'>): EchoRecordPorts {
  const handle = echoTargetStoreOver(records).handlesByKind().get(alexaTargetKind().kind)
  if (handle === undefined)
    throw new Error('import-alexa: the Echo target record kind is not declared')
  return {
    readEchoRecord: async (id) => (await handle.getResolved(id))?.data ?? null,
    writeEchoRecord: async (id, body) => {
      await handle.put({ id, data: body })
    },
    dropEchoRecord: async (id) => {
      await handle.delete(id)
    },
  }
}
