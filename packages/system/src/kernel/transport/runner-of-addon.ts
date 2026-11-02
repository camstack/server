/**
 * The agent's runner -> addons map, filled where a spawn plan computes each addon's runner id
 * (`resolveRunnerId`) and read by the agent's `LocalChildRegistry` to verify which addon a grouped
 * runner acts for. An addon never planned here resolves to itself, as on the hub.
 */
export class RunnerOfAddon {
  private readonly byAddon = new Map<string, string>()

  /** Remember the plan and hand the runner id back, so the call site stays one expression. */
  record(addonId: string, runnerId: string): string {
    this.byAddon.set(addonId, runnerId)
    return runnerId
  }

  resolve = (addonId: string): string => this.byAddon.get(addonId) ?? addonId
}
