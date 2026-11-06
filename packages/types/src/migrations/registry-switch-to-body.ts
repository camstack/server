/**
 * The one-switch migration (epic #440, step 3). An integration's on/off state used to live in the
 * registry's `enabled` column for a device addon; it now lives only in the instance record's
 * body (`enabled`, D1007 superseded). This moves a registry `enabled = false` into the body, once.
 *
 * For every registry row of the addon that is OFF:
 *  - no record under its id: the record is created from `initialBody(name)` with `enabled: false`
 *    (a default integration that never had settings, Reolink's among them);
 *  - a record whose body states no `enabled`: `enabled: false` is written into it;
 *  - a record that already states `enabled` (either way) is the newer truth and is left alone.
 * A row that is ON writes nothing: an absent field reads as on. A rerun finds every off row with
 * a stated switch and does nothing, so nothing switched off comes back on and nothing switched on
 * goes off. The registry column itself is neither read afterwards nor written; its drop is step 5.
 *
 * It runs in the addon process, BEFORE the addon registers its `integration-instances` provider,
 * which is also why `integrations.list` still answers the stored column at that point.
 */
import { z } from 'zod'
import { SWITCH_KEY } from '../addon/record-integration-instances.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { AddonProcedureMigration } from './addon-migration.js'
import type { IntegrationRowsApi } from './integration-rows-api-ports.js'
import type { MigrationProcedureResult } from './migration.js'

/** A registry row of the addon with its stored switch. */
export interface SwitchRow {
  readonly id: string
  readonly name: string
  /** False when the registry holds the integration off. */
  readonly enabled: boolean
}

export interface RegistrySwitchPorts {
  listIntegrations(addonId: string): Promise<readonly SwitchRow[]>
  /** The record body under `id`; null when there is none. */
  readBody(id: string): Promise<Readonly<Record<string, unknown>> | null>
  /** Put a new record with `ifRev: 0`; `exists` when one appeared meanwhile. */
  createRecord(id: string, body: Readonly<Record<string, unknown>>): Promise<'created' | 'exists'>
  /** Write `enabled: false` into the existing record. */
  switchOff(id: string): Promise<void>
}

export function registrySwitchToBodyId(addonId: string, date: string): string {
  return `${addonId}/${date}-registry-switch-to-body`
}

export async function moveRegistrySwitchToBody(
  ports: RegistrySwitchPorts,
  spec: {
    readonly addonId: string
    initialBody(name: string): Readonly<Record<string, unknown>>
  },
): Promise<MigrationProcedureResult> {
  const rows = await ports.listIntegrations(spec.addonId)
  let created = 0
  let switched = 0
  let kept = 0
  for (const row of rows) {
    if (row.enabled) continue
    const body = await ports.readBody(row.id)
    if (body === null) {
      const put = await ports.createRecord(row.id, {
        ...spec.initialBody(row.name),
        [SWITCH_KEY]: false,
      })
      if (put === 'created') created += 1
      else kept += 1
      continue
    }
    if (SWITCH_KEY in body) {
      kept += 1
      continue
    }
    await ports.switchOff(row.id)
    switched += 1
  }
  const summary = {
    integrations: rows.length,
    off: rows.filter((r) => !r.enabled).length,
    created,
    switched,
    kept,
  }
  return created === 0 && switched === 0
    ? { outcome: 'already-done', summary }
    : { outcome: 'done', summary }
}

/** A migration entry: an addon states its kind and how a new body starts, nothing else. */
export function registrySwitchToBodyMigration(spec: {
  readonly addonId: string
  /** `yyyy-mm-dd` of the migration id. */
  readonly date: string
  /** Position in the addon's catalogue; it runs after the rows-to-record moves. */
  readonly seq: number
  readonly initialBody: (name: string) => Readonly<Record<string, unknown>>
}): AddonProcedureMigration<RegistrySwitchPorts> {
  return {
    meta: {
      id: registrySwitchToBodyId(spec.addonId, spec.date),
      owner: spec.addonId,
      level: 'addon-state',
      seq: spec.seq,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // Fail closed: a body without `enabled` reads as ON, so an addon whose switch did not move
      // would bring a registry-disabled instance up. `block-owner` keeps the addon from
      // initialising until the move applied (migrations.retry, then a restart).
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the registry enabled flag of every switched-off integration into its instance record body, creating the record when there is none',
      fixtureMark: 'enabled',
    },
    procedure: (ports) =>
      moveRegistrySwitchToBody(ports, {
        addonId: spec.addonId,
        initialBody: spec.initialBody,
      }),
  }
}

/** The record calls the ports make on the addon's kind; a records handle satisfies it as it is. */
export interface SwitchRecordHandle<T> {
  get(id: string): Promise<{ readonly data: T } | null>
  put(
    input: { readonly id: string; readonly data: T },
    opts?: { readonly ifRev?: number },
  ): Promise<unknown>
  patch(id: string, patch: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface SwitchRecordsDoor {
  kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): SwitchRecordHandle<z.infer<S>>
}

/** The hub and records sides of {@link registrySwitchToBodyMigration}. */
export function registrySwitchPortsOver(deps: {
  readonly api: Pick<IntegrationRowsApi, 'list'>
  readonly records: SwitchRecordsDoor
  readonly kind: DefinedRecordKind
}): RegistrySwitchPorts {
  const handle = deps.records.kind({
    name: deps.kind.name,
    declaration: deps.kind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  return {
    listIntegrations: async (addonId) =>
      (await deps.api.list())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name, enabled: i.enabled !== false })),
    readBody: async (id) => (await handle.get(id))?.data ?? null,
    createRecord: async (id, body) => {
      if ((await handle.get(id)) !== null) return 'exists'
      await handle.put({ id, data: body }, { ifRev: 0 })
      return 'created'
    },
    switchOff: async (id) => {
      await handle.patch(id, { [SWITCH_KEY]: false })
    },
  }
}
