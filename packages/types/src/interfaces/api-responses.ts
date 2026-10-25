/**
 * Named return types for tRPC router procedures.
 *
 * These types replace inline object shapes in router handlers,
 * giving clients first-class types without `ReturnType<...>` workarounds.
 */

import type { Integration } from './integration-registry.js'
import type { AddonDeclaration } from './addon.js'
import type { PackageUpdate } from './api-shared.js'

// ---------------------------------------------------------------------------
// HIGH PRIORITY — eliminates client `as unknown as` casts
// ---------------------------------------------------------------------------

/** Sub-process entry within ProcessTreeEntry */
export interface SubProcessEntry {
  readonly pid: number
  readonly name: string
  readonly command: string
  readonly state: 'running' | 'stopped' | 'crashed'
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
}

/** Return shape of `agent.processTree` procedure */
export interface ProcessTreeEntry {
  readonly id: string
  readonly name: string
  readonly pid: number
  readonly state: 'running'
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly memoryMB: number
  readonly isHub: boolean
  readonly platform: string
  readonly arch: string
  readonly host: string
  readonly capabilities: readonly string[]
  readonly installedAddons: readonly string[]
  readonly pythonRuntimes: readonly string[]
  readonly connectedSince: number
  readonly subProcesses: readonly SubProcessEntry[]
}

/** Return shape of `users.create` — UserRecord without passwordHash */
export interface SafeUser {
  readonly id: string
  readonly username: string
  readonly isAdmin: boolean
  readonly allowedProviders: string[] | '*'
  readonly allowedDevices: Record<string, string[] | '*'>
  /**
   * Granted scopes — empty for admins (who bypass the check anyway) and
   * for non-admins until an admin assigns scopes via `setUserScopes`.
   * Wire-side default `[]` from the Zod schema.
   */
  readonly scopes: readonly import('../schemas/auth-records.js').UserScope[]
  /**
   * True iff a confirmed TOTP enrollment exists for this user — surfaced
   * by `listUsers` so the admin UI can render the "Remove 2FA" action
   * conditionally. Mirrors `UserSummarySchema.totpEnabled`.
   */
  readonly totpEnabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

// ---------------------------------------------------------------------------
// MEDIUM PRIORITY
// ---------------------------------------------------------------------------

/** Return shape of `addons.list` procedure — delegated to addonRegistry.listAllAddons() */
export interface AddonListItem {
  readonly manifest: AddonDeclaration & {
    readonly packageName: string
    readonly packageVersion: string
    readonly packageDisplayName?: string
    readonly protected?: boolean
    readonly removable?: boolean
  }
  readonly declaration?: AddonDeclaration
  readonly source: 'core' | 'installed'
  readonly installSource?: 'npm' | 'local' | 'upload'
  readonly process?: {
    readonly pid?: number
    readonly mode: 'forked' | 'in-process'
    readonly state: string
  }
  /**
   * True when `applyUpdate` last ran for this package and a pre-update
   * backup is still on disk (post-update health-check hasn't cleared
   * it yet, or the user hasn't called `clearBackup`). Drives the
   * Rollback button visibility in admin-ui's AddonCard.
   */
  readonly hasBackup?: boolean
}

/** Return shape of `addons.listUpdates` — alias for PackageUpdate from api-shared */
export type AddonUpdateEntry = PackageUpdate

/** Return shape of `integrations.list` / `integrations.get` procedure */
export type IntegrationWithState = Integration & {
  readonly processState: string
}

/** Return shape of `integrations.getAvailableTypes` procedure */
export interface IntegrationTypeInfo {
  readonly addonId: string
  readonly name: string
  readonly description: string
  readonly iconUrl: string | null
  readonly color: string
  readonly instanceMode: 'unique' | 'multiple'
  /**
   * Integration wizard `mode` — how the Add-Integration flow behaves:
   * `'standalone'` (create immediately → add devices, no config),
   * `'account'` (config step), or `'broker'` (broker step). Derived by
   * `getAvailableTypes` when the manifest omits an explicit `mode`.
   */
  readonly mode: 'standalone' | 'account' | 'broker'
  readonly discoveryMode: string
  readonly existingInstances: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly canAdd: boolean
}

/** Return shape of `auth.login` procedure */
export interface LoginResponse {
  readonly token: string
  readonly user: {
    readonly id: string
    readonly username: string
    readonly isAdmin: boolean
  }
}
