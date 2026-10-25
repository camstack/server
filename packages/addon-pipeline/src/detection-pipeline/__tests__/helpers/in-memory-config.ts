/**
 * In-memory addon settings store for E2E tests — no DB backend needed.
 */
export class InMemorySettingsStore {
  private data: Record<string, unknown> = {}

  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }

  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}
