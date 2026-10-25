import type { RecordsAccess } from '@camstack/types'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import { BIRTH_DECISION_LEDGER_COLLECTION } from './birth-decision-ledger-store.js'
import { DEBUG_NOTE_ARCHIVE_COLLECTION } from './debug-note-archive-store.js'
import { AUDIO_EVENTS_COLLECTION, MOTION_EVENTS_COLLECTION } from './event-store.js'
import {
  type EventLedgerBodyDerivation,
  EventLedgerCollection,
  type EventLedgerLegacyAtField,
} from './event-ledger-collection.js'
import { FACES_COLLECTION } from './face-store.js'
import { deriveFaceRecognized } from './face-recognized.js'
import {
  IDENTITIES_COLLECTION,
  IDENTITY_SAMPLES_COLLECTION,
  VEHICLES_COLLECTION,
  VEHICLE_SAMPLES_COLLECTION,
} from './pa-collection-names.js'
import { OPS_LOG_COLLECTION } from './ops-log-store.js'
import { PLATES_COLLECTION } from './plate-store.js'
import { SENSOR_EVENTS_COLLECTION } from './sensor-event-store.js'
import { RETRAIN_ANNOTATIONS_COLLECTION } from '../retrain/retrain-annotation-store.js'
import {
  RETRAIN_COLLECTION_FRAMES_COLLECTION,
  RETRAIN_COLLECTIONS_COLLECTION,
} from '../retrain/retrain-collection-store.js'
import { RETRAIN_FRAMES_COLLECTION } from '../retrain/retrain-frame-store.js'
import { TRACK_ALIASES_COLLECTION } from './track-alias-store.js'
import { TRACK_PURITY_COLLECTION, TRACK_RELATIONS_COLLECTION } from './track-relations-store.js'
import { TRACKING_TAPES_COLLECTION } from './tracking-tape-index-store.js'

/** What a ledger is wired from: `ctx.records`, present on every node. */
export interface EventLedgerWiringDeps {
  readonly records: Pick<RecordsAccess, 'kind' | 'transact'>
}

interface WireLedgerOpts {
  readonly collection: string
  readonly kindName: keyof typeof pipelineAnalyticsRecordKinds
  readonly autoIntegerId?: boolean
  readonly legacyAtField?: EventLedgerLegacyAtField
  readonly deviceIdMode?: 'required' | 'optional'
  readonly deriveBody?: EventLedgerBodyDerivation
}

function wireLedger(deps: EventLedgerWiringDeps, opts: WireLedgerOpts): EventLedgerCollection {
  return EventLedgerCollection.create({
    collection: opts.collection,
    kindName: opts.kindName,
    definition: pipelineAnalyticsRecordKinds[opts.kindName],
    autoIntegerId: opts.autoIntegerId ?? false,
    legacyAtField: opts.legacyAtField,
    deviceIdMode: opts.deviceIdMode,
    records: deps.records,
    ...(opts.deriveBody !== undefined ? { deriveBody: opts.deriveBody } : {}),
  })
}

export function wireMotionEventLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: MOTION_EVENTS_COLLECTION,
    kindName: 'motion-events',
    autoIntegerId: true,
  })
}

export function wireAudioEventLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: AUDIO_EVENTS_COLLECTION,
    kindName: 'audio-events',
    autoIntegerId: true,
  })
}

export function wireSensorEventLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, { collection: SENSOR_EVENTS_COLLECTION, kindName: 'sensor-events' })
}

export function wireFaceLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: FACES_COLLECTION,
    kindName: 'faces',
    deriveBody: deriveFaceRecognized,
  })
}

export function wireIdentityLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: IDENTITIES_COLLECTION,
    kindName: 'identities',
    legacyAtField: 'createdAt',
    deviceIdMode: 'optional',
  })
}

export function wireIdentitySampleLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: IDENTITY_SAMPLES_COLLECTION,
    kindName: 'identity-samples',
    legacyAtField: 'addedAt',
    deviceIdMode: 'optional',
  })
}

export function wireVehicleLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: VEHICLES_COLLECTION,
    kindName: 'vehicles',
    legacyAtField: 'createdAt',
    deviceIdMode: 'optional',
  })
}

export function wireVehicleSampleLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: VEHICLE_SAMPLES_COLLECTION,
    kindName: 'vehicle-samples',
    legacyAtField: 'addedAt',
    deviceIdMode: 'optional',
  })
}

export function wirePlateLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, { collection: PLATES_COLLECTION, kindName: 'plates' })
}

export function wireTrackAliasLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, { collection: TRACK_ALIASES_COLLECTION, kindName: 'track-aliases' })
}

export function wireTrackPurityLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: TRACK_PURITY_COLLECTION,
    kindName: 'track-purity',
    legacyAtField: 'updatedAt',
  })
}

export function wireTrackRelationsLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: TRACK_RELATIONS_COLLECTION,
    kindName: 'track-relations',
    legacyAtField: 'updatedAt',
  })
}

export function wireTrackingTapeLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: TRACKING_TAPES_COLLECTION,
    kindName: 'tracking-tapes',
    legacyAtField: 'createdAt',
  })
}

export function wireBirthDecisionLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: BIRTH_DECISION_LEDGER_COLLECTION,
    kindName: 'birth-decision-ledger',
    legacyAtField: 'at',
  })
}

export function wireDebugNoteArchiveLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: DEBUG_NOTE_ARCHIVE_COLLECTION,
    kindName: 'debug-note-archive',
    legacyAtField: 'archivedAt',
  })
}

export function wireOpsLogLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: OPS_LOG_COLLECTION,
    kindName: 'ops-log',
    legacyAtField: 'at',
    deviceIdMode: 'optional',
  })
}

export function wireRetrainFrameLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: RETRAIN_FRAMES_COLLECTION,
    kindName: 'retrain-frames',
    legacyAtField: 'copiedAt',
  })
}

export function wireRetrainAnnotationLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: RETRAIN_ANNOTATIONS_COLLECTION,
    kindName: 'retrain-annotations',
    legacyAtField: 'createdAt',
  })
}

export function wireRetrainCollectionLedger(deps: EventLedgerWiringDeps): EventLedgerCollection {
  return wireLedger(deps, {
    collection: RETRAIN_COLLECTIONS_COLLECTION,
    kindName: 'retrain-collections',
    legacyAtField: 'createdAt',
    deviceIdMode: 'optional',
  })
}

export function wireRetrainCollectionFrameLedger(
  deps: EventLedgerWiringDeps,
): EventLedgerCollection {
  return wireLedger(deps, {
    collection: RETRAIN_COLLECTION_FRAMES_COLLECTION,
    kindName: 'retrain-collection-frames',
    legacyAtField: 'addedAt',
  })
}
