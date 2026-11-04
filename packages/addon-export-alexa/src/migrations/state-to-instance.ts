/**
 * The skill's hidden state moves into the `skill-state` record (planning#422). What ONE skill told
 * Alexa and what its Lambda holds (the ingress token, the vision namespace, the mirrors of the
 * last push) was addon-wide settings keys; a second skill needs its own. Two migrations, in order:
 *
 *  7. `moveStateToInstance` (procedure): the legacy keys become the `skill-state` record of the
 *     default instance (`export-alexa`). The record is read BACK (the ingress token resolved from
 *     the keychain) and must equal what the settings carried BEFORE this reports `done`; an
 *     existing record is never overwritten. The default instance row itself is adopted here when
 *     the addon holds state but no `skills` row, so an installation that ran on defaults keeps
 *     serving under the same id.
 *  8. `planDropMovedState` (plan): the ingress token's keychain entry is released and the moved keys
 *     are deleted, and only while the record is confirmed to hold what they carried. A failed read
 *     of the record or of the settings keeps every legacy key.
 *
 * After 8 no runtime code reads these keys from the addon settings.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import {
  AccountVisibilityMapSchema,
  ALEXA_INSTANCE_ID,
  type AlexaSkillBody,
  DetectionClassesMapSchema,
  EMPTY_SKILL_STATE,
  ExportedEndpointsMapSchema,
  ExportedSignaturesMapSchema,
  MOVED_STATE_KEYS,
  type SkillStateBody,
} from '../skill-records.js'
import {
  ADDON_SETTINGS_TABLE,
  type AlexaMigrationLog,
  canonical,
  skillBodyFrom,
} from './settings-to-records.js'

export interface MoveStatePorts extends AlexaMigrationLog {
  /** The stored settings, secrets resolved. Throws when the ingress token cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The `skills` record's presence (the default instance). */
  hasSkill(): Promise<boolean>
  /** Put the default `skills` record with `ifRev: 0`; `exists` when one is already there. */
  putSkill(body: AlexaSkillBody): Promise<'created' | 'exists'>
  /** Put the `skill-state` record with `ifRev: 0`; `exists` when one is already there. */
  putState(body: SkillStateBody): Promise<'created' | 'exists'>
  /** The `skill-state` record, the ingress token resolved; null when absent. Throws when unreadable. */
  readState(): Promise<SkillStateBody | null>
}

export interface DropMovedStatePorts extends AlexaMigrationLog {
  /** The addon's stored settings as written, unparsed (markers unresolved). */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
  /** The stored settings, secrets resolved. Throws when the ingress token cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  hasSkill(): Promise<boolean>
  hasInstanceRecords(): Promise<boolean>
  readState(): Promise<SkillStateBody | null>
  /** Release the ingress token's keychain entry and remove its key from the settings. */
  clearIngressTokenSecret(): Promise<void>
}

const STATE_NAME = EMPTY_SKILL_STATE.name

function textOf(stored: Readonly<Record<string, unknown>>, key: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value : ''
}

/** The record body the legacy keys describe; a missing or malformed key takes the empty value. */
export function stateBodyFrom(stored: Readonly<Record<string, unknown>>): SkillStateBody {
  const token = textOf(stored, 'ingressToken')
  const classes = DetectionClassesMapSchema.safeParse(stored['detectionClasses'])
  const visibility = AccountVisibilityMapSchema.safeParse(stored['accountVisibility'])
  const endpoints = ExportedEndpointsMapSchema.safeParse(stored['exportedEndpoints'])
  const signatures = ExportedSignaturesMapSchema.safeParse(stored['exportedSignatures'])
  return {
    name: STATE_NAME,
    ...(token === '' ? {} : { ingressToken: token }),
    visionNamespace: textOf(stored, 'visionNamespace'),
    detectionClasses: classes.success ? classes.data : {},
    accountVisibility: visibility.success ? visibility.data : {},
    exportedEndpoints: endpoints.success ? endpoints.data : {},
    exportedSignatures: signatures.success ? signatures.data : {},
    advertisedBrokerUrl: textOf(stored, 'advertisedBrokerUrl'),
    lwaClientId: textOf(stored, 'lwaClientId'),
  }
}

function carriesState(stored: Readonly<Record<string, unknown>>): boolean {
  return MOVED_STATE_KEYS.some((key) => key in stored)
}

export async function moveStateToInstance(
  ports: MoveStatePorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  if (!carriesState(stored)) return { outcome: 'already-done', summary: { moved: false } }
  // Every pre-multi hub ran ONE skill and minted its ingress token at first boot (the Lambda may
  // hold it), so state without a `skills` row means the default instance not yet seeded: adopt it.
  const hasSkill = await ports.hasSkill()
  if (!hasSkill) await ports.putSkill(skillBodyFrom(stored))
  const body = stateBodyFrom(stored)
  const put = await ports.putState(body)
  const held = await ports.readState()
  if (held === null) throw new Error('the Alexa skill state record cannot be read back')
  if (put === 'exists') {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  // The credential and the identifiers must read back exactly: the Lambda holds the token.
  if (canonical(held) !== canonical(body)) {
    ports.warn(
      'Alexa migration: the skill-state record does not hold what the settings carried; the legacy keys are kept',
    )
    throw new Error('the Alexa skill state record does not match the legacy settings')
  }
  return { outcome: 'done', summary: { moved: true, hadToken: body.ingressToken !== undefined } }
}

const rowId = (key: string): string => `${ALEXA_INSTANCE_ID}.${key}`

export async function planDropMovedState(ports: DropMovedStatePorts): Promise<MigrationPlan> {
  const raw = await ports.readRawStored()
  if (!carriesState(raw)) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`Alexa migration: the legacy state keys are kept: ${reason}`)
    throw new Error(`the legacy Alexa state keys are not deleted: ${reason}`)
  }
  const instance = (await ports.hasSkill()) || (await ports.hasInstanceRecords())
  if (instance) {
    const held = await ports.readState()
    if (held === null) return refuse('no Alexa skill state record exists')
    // POSITIVE proof only, from the settings with the credential resolved.
    const legacy = stateBodyFrom(await ports.readStored())
    if (legacy.ingressToken !== undefined && legacy.ingressToken !== held.ingressToken) {
      return refuse('the record does not hold the ingress token the settings carried')
    }
    if (legacy.visionNamespace !== '' && legacy.visionNamespace !== held.visionNamespace) {
      return refuse('the record does not hold the vision namespace the settings carried')
    }
    const lacks = (
      mine: Readonly<Record<string, unknown>>,
      theirs: Readonly<Record<string, unknown>>,
    ) => Object.keys(mine).some((key) => !(key in theirs))
    if (
      lacks(legacy.exportedEndpoints, held.exportedEndpoints) ||
      lacks(legacy.exportedSignatures, held.exportedSignatures) ||
      lacks(legacy.detectionClasses, held.detectionClasses) ||
      lacks(legacy.accountVisibility, held.accountVisibility)
    ) {
      return refuse('the record lacks entries the settings carried')
    }
  }
  // The credential's keychain entry goes with its key; the plan then deletes what is left.
  if ('ingressToken' in raw) await ports.clearIngressTokenSecret()
  const left = await ports.readRawStored()
  const present = MOVED_STATE_KEYS.filter((key) => key in left)
  if (present.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: ALEXA_INSTANCE_ID, key, value: left[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
