import type { RemoteMigrationPorts } from '../remote-config-migrations.js'
import type { TagIdsPorts } from '../tag-ids.js'
import type { TagsAsRecordsPorts } from '../tags-as-records.js'

/** For a spec of a block migration: there is no stored remote, template or tag to touch. */
export const NO_REMOTE_PORTS: RemoteMigrationPorts &
  Omit<TagIdsPorts & TagsAsRecordsPorts, 'info' | 'warn'> = {
  listStoredRemotes: async () => [],
  replaceStoredRemote: async () => undefined,
  listTemplateRows: async () => [],
  replaceTemplateRow: async () => undefined,
  warnCollision: () => undefined,
  listTaggedRows: async () => [],
  writeTagIds: async () => undefined,
  localNames: async () => [],
  externalNames: async () => [],
  listStyles: async () => [],
  existingTagIds: async () => new Set(),
  createTag: async () => undefined,
  deleteStyle: async () => undefined,
}
