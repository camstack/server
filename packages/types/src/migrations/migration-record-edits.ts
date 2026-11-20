/**
 * Builders for the record and device edits of a `plan` migration (D987 M3, planning#584).
 *
 * A record edit is checked by the kind's own Zod schema HERE (`parseRecordBody`, the
 * check `ctx.records` runs before every write) and by the records engine's rules when the
 * file applies it inside the migration's transaction — the same two layers as a normal
 * write, and no third. A kind with secret fields is refused: its values live in the
 * keychain, which cannot join a SQLite transaction.
 */
import type { z } from 'zod'
import { InvalidRecordError } from '../records/errors.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import { parseRecordBody } from '../records/records-access.js'
import { type MigrationEdit, preconditionOf } from './migration.js'

export type UpsertRecordEdit = Extract<MigrationEdit, { readonly op: 'upsertRecord' }>
export type DeleteRecordEdit = Extract<MigrationEdit, { readonly op: 'deleteRecord' }>
export type RekeyDeviceEdit = Extract<MigrationEdit, { readonly op: 'rekeyDevice' }>
export type TombstoneDeviceEdit = Extract<MigrationEdit, { readonly op: 'tombstoneDevice' }>

/** What a plan read of a device's identity; the precondition of a re-key or a tombstone. */
export interface MigrationDeviceIdentity {
  readonly addonId: string
  readonly stableId: string
}

export interface RecordUpsertEditInput<S extends z.ZodType> {
  /** The addon that owns the kind (an addon plan may name only itself). */
  readonly owner: string
  readonly kind: DefinedRecordKind<S>
  readonly id: string
  readonly deviceId?: number
  readonly at?: number
  readonly data: z.input<S>
  /** The stored body the plan read (`null`: it read no row). Omit only for a key the plan knows is new. */
  readonly read?: Readonly<Record<string, unknown>> | null
}

export interface RecordDeleteEditInput {
  readonly owner: string
  readonly kind: Pick<DefinedRecordKind, 'name' | 'declaration'>
  readonly id: string
  /** The stored body the plan read. */
  readonly read: Readonly<Record<string, unknown>> | null
}

function refuseSecrets(kind: Pick<DefinedRecordKind, 'name' | 'declaration'>): void {
  if (kind.declaration.secretPaths.length > 0) {
    throw new InvalidRecordError(
      `${kind.name}: a kind with secret fields cannot be written by a migration plan (the keychain is outside its transaction); use a procedure`,
    )
  }
}

/** An `upsertRecord` edit whose body the kind's schema accepted. */
export function recordUpsertEdit<S extends z.ZodType>(
  input: RecordUpsertEditInput<S>,
): UpsertRecordEdit {
  refuseSecrets(input.kind)
  const value = parseRecordBody(input.kind, input.id, input.data)
  return {
    op: 'upsertRecord',
    owner: input.owner,
    kind: input.kind.name,
    recordKey: input.id,
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    ...(input.at === undefined ? {} : { at: input.at }),
    value,
    ...(input.read === undefined ? {} : { precondition: preconditionOf(input.read) }),
  }
}

/** A `deleteRecord` edit. */
export function recordDeleteEdit(input: RecordDeleteEditInput): DeleteRecordEdit {
  refuseSecrets(input.kind)
  return {
    op: 'deleteRecord',
    owner: input.owner,
    kind: input.kind.name,
    recordKey: input.id,
    precondition: preconditionOf(input.read),
  }
}

/** The precondition of a device edit: the identity the plan read. */
export function deviceIdentityPrecondition(identity: MigrationDeviceIdentity): string {
  return preconditionOf({ addonId: identity.addonId, stableId: identity.stableId })
}

/** A `rekeyDevice` edit: same `deviceId`, new `(addonId, stableId)`. */
export function rekeyDeviceEdit(
  deviceId: number,
  read: MigrationDeviceIdentity,
  next: MigrationDeviceIdentity,
): RekeyDeviceEdit {
  return {
    op: 'rekeyDevice',
    deviceId,
    addonId: next.addonId,
    stableId: next.stableId,
    precondition: deviceIdentityPrecondition(read),
  }
}

/** A `tombstoneDevice` edit (D865). */
export function tombstoneDeviceEdit(
  deviceId: number,
  read: MigrationDeviceIdentity,
): TombstoneDeviceEdit {
  return { op: 'tombstoneDevice', deviceId, precondition: deviceIdentityPrecondition(read) }
}
