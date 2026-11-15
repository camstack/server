/**
 * Builds the `tags` cap provider (D1054) over the stores core-blocks owns and the
 * device manager (over `ctx.api`, never a copy of its data).
 */
import {
  type AddonApi,
  type IScopedLogger,
  normalizeTags,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { ActionsStore } from './actions-store.js'
import type { CoreBlockStore } from './core-block-store.js'
import { coreBlocksRecordKinds, type TemplateRowBody } from './record-kinds.js'
import { SchedulersStore } from './scheduler/scheduler-store.js'
import { type TagOwnerPort, type TagOwnerRecord, TagsService } from './tags-service.js'

export interface TagsRuntimeDeps {
  readonly records: RecordsAccess
  readonly blocks: () => CoreBlockStore
  readonly api: () => AddonApi | undefined
  readonly logger: IScopedLogger
  /** A spec swaps the device owner; production reads the device manager over `api`. */
  readonly devices?: TagOwnerPort
}

function coreBlocksPort(blocks: () => CoreBlockStore): TagOwnerPort {
  return {
    list: async () =>
      blocks()
        .list()
        .map((b) => ({ id: b.id, tags: b.tags ?? [] })),
    setTags: async (id, tags) => {
      await blocks().update(id, { tags })
    },
  }
}

function schedulersPort(store: SchedulersStore): TagOwnerPort {
  return {
    list: async () => (await store.list()).map((s) => ({ id: s.id, tags: s.tags ?? [] })),
    setTags: (id, tags) => store.setTags(id, tags),
  }
}

function actionsPort(store: ActionsStore): TagOwnerPort {
  return {
    list: async () => (await store.list()).map((a) => ({ id: a.id, tags: a.tags ?? [] })),
    setTags: (id, tags) => store.setTags(id, tags),
  }
}

function templatesPort(templates: RecordKindHandle<TemplateRowBody>): TagOwnerPort {
  return {
    list: async () => {
      const out: TagOwnerRecord[] = []
      let cursor: string | undefined
      do {
        const page = await templates.query(cursor === undefined ? {} : { cursor })
        for (const row of page.records) out.push({ id: row.id, tags: row.data.tags ?? [] })
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return out
    },
    setTags: async (id, tags) => {
      const row = await templates.get(id)
      if (row === null) throw new Error(`no template "${id}"`)
      const { tags: _previous, ...rest } = row.data
      const normalized = normalizeTags(tags)
      await templates.put({
        id,
        data: normalized.length === 0 ? rest : { ...rest, tags: normalized },
      })
    },
  }
}

function devicesPort(api: () => AddonApi | undefined): TagOwnerPort {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) throw new Error('[tags] the cluster API is not available yet')
    return current
  }
  return {
    list: async () => {
      const rows = await need().deviceManager.listAll.query({ projection: 'slim' })
      return rows.map((d) => ({ id: String(d.id), tags: d.tags ?? [] }))
    },
    setTags: async (id, tags) => {
      await need().deviceManager.setTags.mutate({ deviceId: Number(id), tags })
    },
  }
}

export function buildTagsService(deps: TagsRuntimeDeps): TagsService {
  const { records } = deps
  return new TagsService({
    owners: {
      coreBlocks: coreBlocksPort(deps.blocks),
      schedulers: schedulersPort(
        new SchedulersStore({
          schedulers: records.kind(coreBlocksRecordKinds.schedulers),
          state: records.kind(coreBlocksRecordKinds['scheduler-state']),
        }),
      ),
      templates: templatesPort(records.kind(coreBlocksRecordKinds.templates)),
      actions: actionsPort(
        new ActionsStore({
          actions: records.kind(coreBlocksRecordKinds.actions),
          links: records.kind(coreBlocksRecordKinds['action-links']),
        }),
      ),
      devices: deps.devices ?? devicesPort(deps.api),
    },
    styles: records.kind(coreBlocksRecordKinds['tag-styles']),
    logger: deps.logger,
  })
}
