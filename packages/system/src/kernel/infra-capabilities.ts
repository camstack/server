// packages/kernel/src/infra-capabilities.ts

export interface InfraCapability {
  /** Capability name */
  readonly name: string
  /** If true, boot aborts when this capability's addon fails to initialize */
  readonly required: boolean
}

/**
 * Infrastructure capabilities that must boot before all other addons.
 * Enabled in Phase 1 of the boot sequence. Order matters: storage before logging.
 */
export const INFRA_CAPABILITIES: readonly InfraCapability[] = [
  // `storage-provider` is the concrete backend (filesystem-storage / S3 /
  // sftp …) — it MUST register before the `storage` orchestrator so the
  // orchestrator's first-boot seeding picks it up and creates the
  // default locations (`addons-data:default`, `models:default`, …) that
  // every downstream infra addon (sqlite-settings, recordings, …) relies
  // on. Boots in the same Phase 1 batch.
  { name: 'storage-provider', required: true },
  // `data-store-provider` is the concrete data engine (sqlite-settings
  // today). It must register BEFORE `storage`, because the orchestrator
  // that owns `storage` also owns the `settings-store` door in front of
  // this engine (D44) and reads its own location table through it. The
  // engine has no dependency of its own — it resolves its file path from
  // `ctx.dataDir` precisely so it can boot this early.
  { name: 'data-store-provider', required: true },
  { name: 'storage', required: true },
  // Served by storage-orchestrator, which the `storage` entry above
  // already booted. Kept in the list so a deployment missing the door
  // fails here, loudly, instead of at the first addon that reads config.
  { name: 'settings-store', required: true },
  // The keychain (D787) sits right behind the settings door it persists
  // through, and BEFORE any forked addon spawns: an addon's first
  // `resolveConfig` resolves its secret markers here. Not required: a hub
  // whose keychain cannot boot still comes up — every secret then resolves
  // `unavailable`, which each owner reports, rather than taking the whole
  // system down with it.
  { name: 'keychain', required: false },
  { name: 'log-destination', required: false },
  { name: 'metrics-provider', required: false },
  // platform-probe runs on every node (hub + agents) and feeds inference
  // addons with hardware + scored-backend data via a singleton cap.
  { name: 'platform-probe', required: false },
] as const

const infraNames = new Set(INFRA_CAPABILITIES.map((c) => c.name))

/** Check if a capability name is an infrastructure capability */
export function isInfraCapability(name: string): boolean {
  return infraNames.has(name)
}
