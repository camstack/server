/**
 * The switch comes back to the registry (D1066), the reverse of {@link registrySwitchToBodyMigration}.
 * An instance's on/off state lived in its record body (`enabled`, D1007 superseded by D1015); the hub
 * registry row, keyed by (addon, integration id) like a device, is now the only stored switch.
 *
 * For every record of the addon's kind:
 *  - the state is the body's `enabled` (absent means on). When the registry row of that id disagrees,
 *    the BODY wins: it was the only live copy while the body held the switch, and the registry
 *    column of a migrated row was never read;
 *  - a record with no registry row gets one (a services instance, under its addon-minted id);
 *  - the key is then removed from the body, so no second copy remains.
 * A rerun finds no body that states `enabled` and writes nothing. The registry write goes first, so
 * a crash between the two steps repeats the pair (idempotent) and never loses a switched-off state.
 *
 * It runs in the addon process, after {@link registrySwitchToBodyMigration}, BEFORE the addon
 * registers its provider.
 */
import { z } from 'zod'
import { SWITCH_KEY } from '../addon/record-integration-instances.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { AddonProcedureMigration } from './addon-migration.js'
import type { MigrationProcedureResult } from './migration.js'
import { registrySwitchToBodyId } from './registry-switch-to-body.js'

/** One record of the addon with the switch its body stated. */
export interface BodySwitchRow {
  readonly id: string
  readonly name: string
  /** The body's `enabled`; absent in the body reads as on. */
  readonly enabled: boolean
  /** True when the body carries the key (so it must be stripped). */
  readonly stated: boolean
}

export interface BodySwitchAdoption {
  readonly created: number
  readonly updated: number
  readonly skipped: number
}

export interface BodySwitchPorts {
  /** Every record of the addon's kind. */
  listRecords(): Promise<readonly BodySwitchRow[]>
  /** Put the states into the registry rows (creating the absent ones). */
  adoptRows(
    addonId: string,
    rows: readonly {
      readonly id: string
      readonly name: string
      readonly enabled: boolean
      readonly stated: boolean
    }[],
  ): Promise<BodySwitchAdoption>
  /** Remove the switch key from the record body. */
  stripSwitch(id: string): Promise<void>
}

export function bodySwitchToRegistryId(addonId: string, date: string, kindName: string): string {
  return `${addonId}/${date}-body-switch-to-registry-${kindName}`
}

export async function moveBodySwitchToRegistry(
  ports: BodySwitchPorts,
  spec: { readonly addonId: string },
): Promise<MigrationProcedureResult> {
  const records = await ports.listRecords()
  const stated = records.filter((r) => r.stated)
  const adopted: BodySwitchAdoption =
    records.length === 0
      ? { created: 0, updated: 0, skipped: 0 }
      : await ports.adoptRows(
          spec.addonId,
          records.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, stated: r.stated })),
        )
  for (const row of stated) await ports.stripSwitch(row.id)
  const summary = {
    records: records.length,
    stripped: stated.length,
    rowsCreated: adopted.created,
    rowsCorrected: adopted.updated,
    skipped: adopted.skipped,
  }
  return stated.length === 0 && adopted.created === 0 && adopted.updated === 0
    ? { outcome: 'already-done', summary }
    : { outcome: 'done', summary }
}

/** A migration entry: an addon states its kind, nothing else. */
export function bodySwitchToRegistryMigration(spec: {
  readonly addonId: string
  /** `yyyy-mm-dd` of the migration id. */
  readonly date: string
  /** Position in the addon's catalogue; after the registry-to-body move. */
  readonly seq: number
  /** The record kind this entry moves: one entry per instance kind of the addon. */
  readonly kindName: string
  /** The date of the registry-to-body migration it follows, when the addon ran that one. */
  readonly followsDate?: string
}): AddonProcedureMigration<BodySwitchPorts> {
  return {
    meta: {
      id: bodySwitchToRegistryId(spec.addonId, spec.date, spec.kindName),
      owner: spec.addonId,
      level: 'addon-state',
      seq: spec.seq,
      dependsOn:
        spec.followsDate === undefined
          ? []
          : [registrySwitchToBodyId(spec.addonId, spec.followsDate)],
      store: 'settings',
      scope: 'cluster',
      // Fail closed: a body that still carries `enabled: false` while the registry says on would
      // bring a switched-off instance up. `block-owner` keeps the addon from initialising until the
      // move applied (migrations.retry, then a restart).
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the switch of every instance record back to its registry row (creating the row of a services instance) and remove it from the body',
      fixtureMark: 'enabled',
    },
    procedure: (ports) => moveBodySwitchToRegistry(ports, { addonId: spec.addonId }),
  }
}

/** The record calls the ports make on the addon's kind. */
export interface BodySwitchRecordHandle<T> {
  query(q: { readonly limit?: number }): Promise<{
    readonly records: readonly {
      readonly id: string
      readonly rev: number
      readonly data: T
    }[]
  }>
  get(id: string): Promise<{ readonly rev: number; readonly data: T } | null>
  put(
    input: { readonly id: string; readonly data: T },
    opts?: { readonly ifRev?: number },
  ): Promise<unknown>
}

export interface BodySwitchRecordsDoor {
  kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): BodySwitchRecordHandle<z.infer<S>>
}

export function bodySwitchPortsOver(deps: {
  readonly records: BodySwitchRecordsDoor
  readonly kind: DefinedRecordKind
  readonly nameField: string
  readonly adopt: BodySwitchPorts['adoptRows']
}): BodySwitchPorts {
  const handle = deps.records.kind({
    name: deps.kind.name,
    declaration: deps.kind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  return {
    listRecords: async () => {
      const page = await handle.query({ limit: 1000 })
      return page.records.map((r) => {
        const name = r.data[deps.nameField]
        return {
          id: r.id,
          name: typeof name === 'string' ? name : r.id,
          enabled: r.data[SWITCH_KEY] !== false,
          stated: SWITCH_KEY in r.data,
        }
      })
    },
    adoptRows: deps.adopt,
    stripSwitch: async (id) => {
      const row = await handle.get(id)
      if (row === null || !(SWITCH_KEY in row.data)) return
      const { [SWITCH_KEY]: _dropped, ...rest } = row.data
      await handle.put({ id, data: rest }, { ifRev: row.rev })
    },
  }
}
