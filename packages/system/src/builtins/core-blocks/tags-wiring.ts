/**
 * Builds the `tags` cap provider (D1054) over the stores core-blocks owns and the
 * device manager and the notification rules (over `ctx.api`, never a copy of
 * their data).
 */
import {
  type AddonApi,
  type IScopedLogger,
  type NcTaggedRuleKind,
  NcTaggedRuleKindSchema,
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
  /** A spec swaps the rule owner; production reads the notification rules over `api`. */
  readonly notificationRules?: TagOwnerPort
}

function coreBlocksPort(blocks: () => CoreBlockStore): TagOwnerPort {
  return {
    list: async () =>
      blocks()
        .list()
        .map((b) => ({ id: b.id, tags: b.tags ?? [] })),
    setTags: async (id, tags) => {
      await blocks().setTags(id, tags)
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

function needApi(api: () => AddonApi | undefined): AddonApi {
  const current = api()
  if (current === undefined) throw new Error('[tags] the cluster API is not available yet')
  return current
}

/**
 * A notification rule's owner-port id is `<kind>:<ruleId>`: event rules,
 * summaries, timelapses and calendar-events rules live in separate stores, so
 * the write must name which one.
 */
export function ruleTagOwnerId(kind: NcTaggedRuleKind, ruleId: string): string {
  return `${kind}:${ruleId}`
}

export function parseRuleTagOwnerId(id: string): { kind: NcTaggedRuleKind; ruleId: string } {
  const sep = id.indexOf(':')
  const kind = NcTaggedRuleKindSchema.safeParse(sep < 0 ? '' : id.slice(0, sep))
  if (!kind.success) throw new Error(`[tags] not a notification-rule owner id: ${id}`)
  return { kind: kind.data, ruleId: id.slice(sep + 1) }
}

function notificationRulesPort(api: () => AddonApi | undefined): TagOwnerPort {
  return {
    // Every rule KIND carries tags (D1054): one read covers all four stores.
    list: async () => {
      const { rules } = await needApi(api).notificationRules.listRuleTags.query({})
      return rules.map((r) => ({ id: ruleTagOwnerId(r.kind, r.ruleId), tags: r.tags }))
    },
    // Only the tags: never a whole-rule update, which a stale copy would clobber.
    setTags: async (id, tags) => {
      const { kind, ruleId } = parseRuleTagOwnerId(id)
      await needApi(api).notificationRules.setRuleTags.mutate({ kind, ruleId, tags })
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
      notificationRules: deps.notificationRules ?? notificationRulesPort(deps.api),
    },
    styles: records.kind(coreBlocksRecordKinds['tag-styles']),
    logger: deps.logger,
  })
}
