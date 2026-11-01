/**
 * The typed port a `procedure` migration uses to move a provider's old hub DEVICE into
 * an INTEGRATION (D987, generalised from the Reolink hub migration, D985). It is the
 * shape of the work, not an implementation: each provider binds it to its own kernel
 * services, and a spec binds it to an in-memory fake.
 *
 * The steps a procedure takes through it, each one safe to observe already done:
 *
 *   1. `listIntegrations` / `createIntegration` — reuse the integration whose
 *      `originStableId` names this hub, else create it with the connection as
 *      settings and the password through the keychain (`secretKeys`).
 *   2. `setIntegrationId` / `persistConfig` — re-stamp every child with the
 *      integration id, keeping its `deviceId` and `stableId` (history and
 *      automations follow the id), and make its persisted blob restorable alone.
 *   3. `createGateway` — the sibling Gateway device of the integration.
 *   4. `removeDevice` — retire the hub by tombstone, only after `childIdsOf` shows no
 *      child still parented under it (removing a parent cascades).
 *
 * A locked secret is never read as an empty password and no replacement is minted.
 */
import type { IScopedLogger } from '../interfaces/logging.js'

export interface MigrationIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
  readonly originStableId?: string | undefined
}

export interface CreateMigrationIntegrationInput {
  readonly addonId: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
  /** The stableId of the hub device it replaces: how a rerun finds it. */
  readonly originStableId: string
  readonly settings: Readonly<Record<string, unknown>>
  /** Keys of `settings` that are secrets and go through the keychain. */
  readonly secretKeys: readonly string[]
}

export interface IntegrationMigrationPorts {
  readonly addonId: string
  readonly logger: IScopedLogger
  listIntegrations(): Promise<readonly MigrationIntegration[]>
  createIntegration(input: CreateMigrationIntegrationInput): Promise<{ readonly id: string }>
  setIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** Overwrite a device's persisted blob so it restores on its own. */
  persistConfig(stableId: string, config: Record<string, unknown>): Promise<void>
  /** The ids of the devices still parented under `parentDeviceId`, read from the store. */
  childIdsOf(parentDeviceId: number): Promise<readonly number[]>
  /** The sibling Gateway of an integration (a parent of nothing, next to the children). */
  createGateway(input: {
    readonly integrationId: string
    readonly name: string
  }): Promise<{ readonly deviceId: number }>
  /** Retire a device: removes it and writes the tombstone (D865), without cascading. */
  removeDevice(deviceId: number): Promise<void>
}
