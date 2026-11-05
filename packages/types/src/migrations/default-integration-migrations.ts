/**
 * The two migrations of a device addon whose integrations hold NO settings of their own
 * (planning#416, S-A): every integration becomes a record of the addon's own kind with a name and
 * nothing else (D985, the default integration is an instance with an empty body), then the devices
 * that carry no `integrationId` are claimed to the addon's default integration.
 *
 *  1. `rows-to-record` (block-owner): `moveIntegrationRowsToRecords` over the hub API. Rows an
 *     addon of this shape does not own (a key nothing reads) are named in a warning, by key, and
 *     dropped with the rows once the record is read back.
 *  2. `claim-devices` (tolerate): `claimDevicesToDefaultIntegration`; with no integration to claim
 *     to it fails and is retried on the next boot.
 *
 * Both run in the addon process through the hub API (`ctx.api`). The leftover rows are read
 * through the migration-only door, which answers empty once the store is gone.
 */
import { z } from 'zod'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordsAccess } from '../records/records-access.js'
import { type AddonMigration, type AddonProcedureMigration } from './addon-migration.js'
import {
  type ClaimDevice,
  type ClaimDevicesPorts,
  claimDevicesToDefaultIntegration,
} from './claim-devices-to-default-integration.js'
import {
  type IntegrationRowsApi,
  integrationRowsPortsOverApi,
} from './integration-rows-api-ports.js'
import {
  type IntegrationRowsPorts,
  moveIntegrationRowsToRecords,
} from './integration-rows-to-record.js'

export type DefaultIntegrationPorts = IntegrationRowsPorts & ClaimDevicesPorts

/** The slice of the hub API (`ctx.api`) the two migrations need, as plain calls. */
export interface DefaultIntegrationApi extends IntegrationRowsApi {
  listDevices(addonId: string): Promise<readonly ClaimDevice[]>
  readDeviceHasConfig(deviceId: number): Promise<boolean>
  setDeviceIntegrationId(deviceId: number, integrationId: string): Promise<void>
  readDeviceIntegrationId(deviceId: number): Promise<string | null>
}

export function defaultIntegrationPortsOver(deps: {
  readonly api: DefaultIntegrationApi
  /** The addon's records door and the kind its integrations are records of. */
  readonly records: Pick<RecordsAccess, 'kind'>
  readonly kind: DefinedRecordKind
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
  readonly warnDevice: (message: string, deviceId: number) => void
  /** The owning addon's keychain handle. The door returns markers; this resolves them. */
  readonly secrets?: SecretsAccess | null
}): DefaultIntegrationPorts {
  const rows = integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    // The move reads and writes the body as it is stored, so the handle takes any object.
    records: deps.records.kind({
      name: deps.kind.name,
      declaration: deps.kind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
  return {
    ...rows,
    ...claimDevicesPortsOver({ api: deps.api, info: deps.info, warnDevice: deps.warnDevice }),
  }
}

/** The hub side of the device claim, over `ctx.api`. */
export function claimDevicesPortsOver(deps: {
  readonly api: Pick<
    DefaultIntegrationApi,
    | 'list'
    | 'listDevices'
    | 'readDeviceHasConfig'
    | 'setDeviceIntegrationId'
    | 'readDeviceIntegrationId'
  >
  readonly info: (message: string) => void
  readonly warnDevice: (message: string, deviceId: number) => void
}): ClaimDevicesPorts {
  return {
    listIntegrations: async (addonId) =>
      (await deps.api.list())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name, info: i.info ?? {} })),
    listDevices: (addonId) => deps.api.listDevices(addonId),
    hasConfig: (deviceId) => deps.api.readDeviceHasConfig(deviceId),
    setIntegrationId: (deviceId, integrationId) =>
      deps.api.setDeviceIntegrationId(deviceId, integrationId),
    readIntegrationId: (deviceId) => deps.api.readDeviceIntegrationId(deviceId),
    info: deps.info,
    warnDevice: deps.warnDevice,
  }
}

export interface DefaultIntegrationMigrationIds {
  readonly rowsToRecord: string
  readonly claimDevices: string
}

export function defaultIntegrationMigrationIds(
  addonId: string,
  date: string,
): DefaultIntegrationMigrationIds {
  return {
    rowsToRecord: `${addonId}/${date}-integration-rows-to-record`,
    claimDevices: `${addonId}/${date}-claim-devices-to-default-integration`,
  }
}

const FIXTURE_MARK = 'a legacy setting key the migration does not know'

/**
 * The device claim alone, for an addon that keeps its integration settings where they are for now
 * (its own wave moves them) but whose persisted devices must name their default integration.
 */
export function claimDevicesMigration(spec: {
  readonly addonId: string
  readonly date: string
  readonly seq: number
  readonly dependsOn: readonly string[]
  readonly eligible?: (integration: { readonly info: Readonly<Record<string, unknown>> }) => boolean
}): AddonProcedureMigration<ClaimDevicesPorts> {
  return {
    meta: {
      id: defaultIntegrationMigrationIds(spec.addonId, spec.date).claimDevices,
      owner: spec.addonId,
      level: 'addon-state',
      seq: spec.seq,
      dependsOn: [...spec.dependsOn],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        "Claim the persisted devices that carry no integration to the addon's default integration, keeping their device and stable ids",
      fixtureMark: 'a device config field the claim does not know',
    },
    procedure: (ports) =>
      claimDevicesToDefaultIntegration(ports, {
        addonId: spec.addonId,
        ...(spec.eligible !== undefined ? { eligible: spec.eligible } : {}),
      }),
  }
}

export function defaultIntegrationMigrations(spec: {
  readonly addonId: string
  /** `yyyy-mm-dd` of the migration ids. */
  readonly date: string
  /** The first `seq` of the pair; the addon's own earlier migrations come before. */
  readonly seq?: number
  /** Which integrations can be the default (see `claimDevicesToDefaultIntegration`). */
  readonly eligible?: (integration: { readonly info: Readonly<Record<string, unknown>> }) => boolean
}): readonly AddonMigration<DefaultIntegrationPorts>[] {
  const ids = defaultIntegrationMigrationIds(spec.addonId, spec.date)
  const seq = spec.seq ?? 1
  const rows: AddonProcedureMigration<DefaultIntegrationPorts> = {
    meta: {
      id: ids.rowsToRecord,
      owner: spec.addonId,
      level: 'addon-state',
      seq,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every integration of the addon into a typed instance record keyed by its registry id, then clear the legacy integration settings rows',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: spec.addonId,
        secretPaths: [],
        bodyFrom: (values, log, integration) => {
          const left = Object.keys(values)
          if (left.length > 0) {
            log.warn(
              `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${left.join(', ')}`,
            )
          }
          return { name: integration.name }
        },
      }),
  }
  const claim = claimDevicesMigration({
    addonId: spec.addonId,
    date: spec.date,
    seq: seq + 1,
    dependsOn: [ids.rowsToRecord],
    ...(spec.eligible !== undefined ? { eligible: spec.eligible } : {}),
  })
  return [rows, claim]
}

/** The calls of `ctx.api` the migrations make; a tRPC client satisfies it as it is. */
export interface DefaultIntegrationHubApi {
  readonly integrations: {
    readonly list: {
      query(): Promise<
        readonly {
          readonly id: string
          readonly addonId: string
          readonly name: string
          readonly info?: Readonly<Record<string, unknown>> | null | undefined
        }[]
      >
    }
  }
  readonly migrations: {
    readonly readLegacyIntegrationRows: {
      query(input: { integrationId: string }): Promise<Readonly<Record<string, unknown>>>
    }
    readonly clearLegacyIntegrationRows: {
      mutate(input: { integrationId: string }): Promise<unknown>
    }
  }
  readonly deviceManager: {
    readonly listAll: {
      query(input: { addonId: string; projection: 'slim' }): Promise<readonly ClaimDevice[]>
    }
    readonly setIntegrationId: {
      mutate(input: { deviceId: number; integrationId: string }): Promise<unknown>
    }
    readonly getDevice: {
      query(input: { deviceId: number }): Promise<{
        readonly integrationId?: string | null | undefined
        readonly config?: Readonly<Record<string, unknown>> | undefined
      } | null>
    }
  }
}

export function defaultIntegrationApiOver(api: DefaultIntegrationHubApi): DefaultIntegrationApi {
  return {
    list: () => api.integrations.list.query(),
    readLegacyIntegrationRows: (input) => api.migrations.readLegacyIntegrationRows.query(input),
    clearLegacyIntegrationRows: (input) => api.migrations.clearLegacyIntegrationRows.mutate(input),
    listDevices: (addonId) => api.deviceManager.listAll.query({ addonId, projection: 'slim' }),
    setDeviceIntegrationId: async (deviceId, integrationId) => {
      await api.deviceManager.setIntegrationId.mutate({
        deviceId,
        integrationId,
      })
    },
    readDeviceHasConfig: async (deviceId) =>
      Object.keys((await api.deviceManager.getDevice.query({ deviceId }))?.config ?? {}).length > 0,
    readDeviceIntegrationId: async (deviceId) =>
      (await api.deviceManager.getDevice.query({ deviceId }))?.integrationId ?? null,
  }
}
