import type { RemoteMigrationPorts } from '../remote-config-migrations.js'

/** For a spec of a block migration: there is no stored remote or template to touch. */
export const NO_REMOTE_PORTS: RemoteMigrationPorts = {
  listStoredRemotes: async () => [],
  replaceStoredRemote: async () => undefined,
  listTemplateRows: async () => [],
  replaceTemplateRow: async () => undefined,
  warnCollision: () => undefined,
}
