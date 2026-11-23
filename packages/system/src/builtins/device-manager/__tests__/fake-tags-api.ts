/**
 * An in-memory stand-in for the two `tags` cap calls the device manager makes
 * (D1089): `listTags` and `ensureTag`. Ids are minted the way the real service
 * mints them — opaque, new per tag — and the same name always answers the same
 * tag. One instance survives a spec's "reboot" so the ids stay resolvable.
 */
import { entityNameKey, newEntityId, type TagRecord } from '@camstack/types'

export interface FakeTagsApi {
  readonly listTags: { query: (input: Record<string, never>) => Promise<TagRecord[]> }
  readonly ensureTag: { mutate: (input: { name: string }) => Promise<TagRecord> }
}

export function makeFakeTagsApi(): FakeTagsApi {
  const byKey = new Map<string, TagRecord>()
  return {
    listTags: { query: async () => [...byKey.values()] },
    ensureTag: {
      mutate: async ({ name }) => {
        const key = entityNameKey(name)
        const existing = byKey.get(key)
        if (existing !== undefined) return existing
        const created: TagRecord = { id: newEntityId('tag'), name: name.trim() }
        byKey.set(key, created)
        return created
      },
    },
  }
}
