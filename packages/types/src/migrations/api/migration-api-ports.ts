/**
 * Ports built over {@link MigrationApiV1}, for the migrations every device addon shares
 * (planning#447). A catalogue's ports are built from the migration API and from nothing
 * else, so an old catalogue keeps working when the hub API it was written against moves.
 *
 * Each `...DepsOver(api)` returns the dependencies the existing port builders take
 * (`defaultIntegrationPortsOver`, `integrationRowsPortsOver`, the addons' `*RowsPorts`),
 * so a call site reads `xRowsPorts({ ...rowsDepsOver(api), kind })`.
 */
import type { KeychainResolveResult } from '../../capabilities/keychain.cap.js'
import type { DefaultIntegrationApi } from '../default-integration-migrations.js'
import type { IntegrationRowsApi, RowsRecordsDoor } from '../integration-rows-api-ports.js'
import type { MigrationApiV1 } from './migration-api.v1.js'

/** The keychain handle of the migration API: resolve and delete, owner-scoped by the transport. */
export interface MigrationSecretsDoor {
  resolve(refs: readonly string[]): Promise<KeychainResolveResult>
  delete(refs: readonly string[]): Promise<number>
}

export function secretsOverMigrationApi(api: MigrationApiV1): MigrationSecretsDoor {
  return {
    resolve: async (refs) => {
      const { values } = await api.secrets.resolve({ refs: [...refs] })
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = values[ref]
        out[ref] =
          value === null || value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value, version: 0 }
      }
      return out
    },
    delete: async (refs) => (await api.secrets.delete({ refs: [...refs] })).deleted,
  }
}

/** `ctx.records` as the migration API offers it: bind a kind, read and write by id. */
export function recordsOverMigrationApi(api: MigrationApiV1): RowsRecordsDoor {
  return {
    kind: (definition) => {
      const handle = api.records.kind(definition)
      return {
        get: (id) => handle.get({ id }),
        getResolved: (id) => handle.getResolved({ id }),
        put: (input, opts) =>
          handle.put({ ...input, ...(opts?.ifRev === undefined ? {} : { ifRev: opts.ifRev }) }),
        delete: (id) => handle.delete({ id }),
      }
    },
  }
}

function integrationRowsApiOver(api: MigrationApiV1): IntegrationRowsApi {
  return {
    list: async () => (await api.integrations.list({})).integrations,
    readLegacyIntegrationRows: (input) => api.legacyRows.read(input),
    clearLegacyIntegrationRows: (input) => api.legacyRows.clear(input),
  }
}

function warnOver(api: MigrationApiV1): (message: string) => void {
  return (message) => {
    void api.log.warn({ message })
  }
}

/** What the rows-to-records move needs, over the migration API. */
export function rowsDepsOver(api: MigrationApiV1) {
  return {
    api: integrationRowsApiOver(api),
    records: recordsOverMigrationApi(api),
    secrets: secretsOverMigrationApi(api),
    warn: warnOver(api),
  }
}

function defaultIntegrationApiOver(api: MigrationApiV1): DefaultIntegrationApi {
  return {
    ...integrationRowsApiOver(api),
    listDevices: async (addonId) => (await api.devices.list({ addonId })).devices,
    readDeviceHasConfig: async (deviceId) =>
      (await api.devices.get({ deviceId }))?.hasConfig ?? false,
    setDeviceIntegrationId: async (deviceId, integrationId) => {
      await api.devices.setIntegrationId({ deviceId, integrationId })
    },
    readDeviceIntegrationId: async (deviceId) =>
      (await api.devices.get({ deviceId }))?.integrationId ?? null,
  }
}

/** What the rows-to-records move and the device claim need, over the migration API. */
export function defaultIntegrationDepsOver(api: MigrationApiV1) {
  return {
    ...rowsDepsOver(api),
    api: defaultIntegrationApiOver(api),
    info: (message: string): void => {
      void api.log.info({ message })
    },
    warnDevice: (message: string, deviceId: number): void => {
      void api.log.warn({ message, tags: { deviceId } })
    },
  }
}
