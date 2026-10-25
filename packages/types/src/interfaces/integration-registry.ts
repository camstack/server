/** Persisted integration (provider instance) */
export interface Integration {
  readonly id: string // "int_001" progressive
  readonly addonId: string // "provider-rtsp"
  readonly name: string
  readonly enabled: boolean
  readonly info: Readonly<Record<string, unknown>> // { icon, color, discoveryMode, ... }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input for creating an integration */
export interface CreateIntegrationInput {
  readonly addonId: string
  readonly name: string
  readonly enabled?: boolean
  readonly info?: Record<string, unknown>
  readonly settings?: Record<string, unknown>
}

/**
 * The integration store.
 *
 * It carried a device half until 2026-08-19 — `createDevice`, `listCameras`,
 * `setDeviceSetting` and a `dev_NNNN` id-space — declared on this interface,
 * implemented over two SQLite tables, wrapped by the visibility filter, and
 * called by nothing. Both tables held 0 rows against 974 live devices. The
 * device authority is the `device-manager` capability
 * ([D183](../../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md));
 * this interface is integrations only, and adding a device method back means
 * creating a second authority.
 */
export interface IIntegrationRegistry {
  // Integrations
  createIntegration(input: CreateIntegrationInput): Promise<Integration>
  getIntegration(id: string): Promise<Integration | null>
  getIntegrationByAddonId(addonId: string): Promise<Integration | null>
  listIntegrations(): Promise<readonly Integration[]>
  updateIntegration(
    id: string,
    updates: Partial<Pick<Integration, 'name' | 'enabled' | 'info'>>,
  ): Promise<Integration | null>
  deleteIntegration(id: string): Promise<boolean>

  // Integration settings
  getIntegrationSettings(integrationId: string): Promise<Record<string, unknown>>
  setIntegrationSetting(integrationId: string, key: string, value: unknown): Promise<void>
  setIntegrationSettings(integrationId: string, settings: Record<string, unknown>): Promise<void>
}
