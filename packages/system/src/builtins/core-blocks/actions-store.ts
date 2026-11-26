/**
 * Durable storage for the actions the operator authors here (`internal:<uuid>`)
 * and for the links between cameras and actions.
 *
 * Both are `core-blocks` record kinds. An action declared by an addon is NOT
 * stored: the `actions` surface asks the `action-source` providers live (D3).
 *
 * @durable class=config owner=core-blocks
 *   write="the operator creates / edits / deletes an internal action, or picks a camera's links"
 *   retention="operator delete only; a camera's links go with the camera (deviceRemoval 'delete')"
 */
import { randomUUID } from 'node:crypto'
import {
  type ActionEntry,
  type ActionInput,
  ActionError,
  canonicalStoredStepTargets,
  CORE_BLOCKS_ADDON_ID,
  IDLE_ACTION_STATUS,
  internalActionId,
  isInternalActionId,
  normalizeTags,
  INTERNAL_ACTION_PREFIX,
  StaleStampError,
  type IScopedLogger,
  type RecordKindHandle,
} from '@camstack/types'
import { KeyedSerialiser } from '../shared/serialise-per-key.js'
import { type ActionLinksRowBody, type ActionRowBody, ActionRowBodySchema } from './record-kinds.js'

export interface ActionsStoreOptions {
  readonly actions: RecordKindHandle<ActionRowBody>
  readonly links: RecordKindHandle<ActionLinksRowBody>
  readonly logger?: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

/** The stored `tags` of a write: normalised, and absent when there are none. */
function tagsBody(tags: readonly string[] | undefined): { tags?: string[] } {
  const normalized = normalizeTags(tags ?? [])
  return normalized.length === 0 ? {} : { tags: normalized }
}

function uuidOf(actionId: string): string {
  return actionId.slice(INTERNAL_ACTION_PREFIX.length)
}

export class ActionsStore {
  private readonly actions: RecordKindHandle<ActionRowBody>
  private readonly links: RecordKindHandle<ActionLinksRowBody>
  private readonly logger: IScopedLogger | undefined
  private readonly now: () => number
  private readonly serial = new KeyedSerialiser()
  private readonly newId: () => string

  constructor(options: ActionsStoreOptions) {
    this.actions = options.actions
    this.links = options.links
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  private static entryOf(id: string, body: ActionRowBody): ActionEntry {
    return {
      id: internalActionId(id),
      name: body.name,
      addonId: CORE_BLOCKS_ADDON_ID,
      source: 'internal',
      readOnly: false,
      steps: body.steps,
      ...(body.variables === undefined ? {} : { variables: body.variables }),
      ...(body.minDelaySec === undefined || body.minDelaySec === 0
        ? {}
        : { minDelaySec: body.minDelaySec }),
      ...(body.tags === undefined || body.tags.length === 0 ? {} : { tags: body.tags }),
      status: IDLE_ACTION_STATUS,
    }
  }

  /**
   * A stored row is served only while it still parses. A row written under an
   * older step shape (a `cap` step, from before steps were stored by action id)
   * is skipped and logged, so it cannot break the list or reach a run; it stays
   * on disk until the operator saves the action again from the editor, which
   * overwrites it without reading its steps (`update`).
   */
  private readable(id: string, data: unknown): ActionEntry | null {
    const parsed = ActionRowBodySchema.safeParse(withCanonicalStepTargets(data))
    if (parsed.success) return ActionsStore.entryOf(id, parsed.data)
    this.logger?.warn('internal action skipped — its stored body no longer parses; save it again', {
      meta: {
        actionId: internalActionId(id),
        reason: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      },
    })
    return null
  }

  async list(): Promise<ActionEntry[]> {
    const out: ActionEntry[] = []
    let cursor: string | undefined
    do {
      const page = await this.actions.query({ ...(cursor === undefined ? {} : { cursor }) })
      for (const row of page.records) {
        const entry = this.readable(row.id, row.data)
        if (entry !== null) out.push(entry)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return out
  }

  async get(actionId: string): Promise<ActionEntry | null> {
    if (!isInternalActionId(actionId)) return null
    const row = await this.actions.get(uuidOf(actionId))
    return row === null ? null : this.readable(row.id, row.data)
  }

  /** Whether a row is stored under this id, readable or not. */
  async exists(actionId: string): Promise<boolean> {
    if (!isInternalActionId(actionId)) return false
    return (await this.actions.get(uuidOf(actionId))) !== null
  }

  async create(input: ActionInput): Promise<ActionEntry> {
    const id = this.newId()
    const at = this.now()
    const body: ActionRowBody = {
      name: input.name,
      steps: input.steps,
      ...(input.variables === undefined ? {} : { variables: input.variables }),
      ...(input.minDelaySec === undefined || input.minDelaySec === 0
        ? {}
        : { minDelaySec: input.minDelaySec }),
      ...tagsBody(input.tags),
      createdAt: at,
      updatedAt: at,
    }
    await this.actions.put({ id, data: body })
    return ActionsStore.entryOf(id, body)
  }

  async update(actionId: string, input: ActionInput): Promise<ActionEntry> {
    const existing = isInternalActionId(actionId) ? await this.actions.get(uuidOf(actionId)) : null
    if (existing === null) throw new ActionError('not-found', `no internal action "${actionId}"`)
    const body: ActionRowBody = {
      name: input.name,
      steps: input.steps,
      ...(input.variables === undefined ? {} : { variables: input.variables }),
      ...(input.minDelaySec === undefined || input.minDelaySec === 0
        ? {}
        : { minDelaySec: input.minDelaySec }),
      ...tagsBody(input.tags),
      createdAt: existing.data.createdAt,
      updatedAt: this.now(),
    }
    await this.actions.put({ id: existing.id, data: body })
    return ActionsStore.entryOf(existing.id, body)
  }

  /** Replace the tags of an internal action; its steps and `updatedAt` are left as they are. */
  async setTags(actionId: string, tags: readonly string[]): Promise<void> {
    const existing = isInternalActionId(actionId) ? await this.actions.get(uuidOf(actionId)) : null
    if (existing === null) throw new ActionError('not-found', `no internal action "${actionId}"`)
    const { tags: _previous, ...rest } = existing.data
    await this.actions.put({ id: existing.id, data: { ...rest, ...tagsBody(tags) } })
  }

  /** Replace the tag ids of an internal action (D1089); everything else is left as it is. */
  async setTagIds(actionId: string, tagIds: readonly string[]): Promise<void> {
    const existing = isInternalActionId(actionId) ? await this.actions.get(uuidOf(actionId)) : null
    if (existing === null) throw new ActionError('not-found', `no internal action "${actionId}"`)
    const { tagIds: _previous, ...rest } = existing.data
    const unique = [...new Set(tagIds)]
    await this.actions.put({
      id: existing.id,
      data: unique.length === 0 ? rest : { ...rest, tagIds: unique },
    })
  }

  async delete(actionId: string): Promise<boolean> {
    if (!isInternalActionId(actionId)) return false
    return this.actions.delete(uuidOf(actionId))
  }

  /** The action ids a camera links (possibly dangling: the caller joins them with the live list). */
  async linksOf(deviceId: number): Promise<readonly string[]> {
    const row = await this.links.get(String(deviceId))
    return row === null ? [] : row.data.actionIds
  }

  /** The camera's links with the stamp a save must carry (D1098): 0 when nothing was written. */
  async linksStateOf(
    deviceId: number,
  ): Promise<{ readonly actionIds: readonly string[]; readonly updatedAt: number }> {
    const row = await this.links.get(String(deviceId))
    return row === null
      ? { actionIds: [], updatedAt: 0 }
      : { actionIds: row.data.actionIds, updatedAt: row.data.updatedAt ?? 0 }
  }

  /**
   * Drop `actionId` from every camera that links it. The camera keeps its row, empty, so its stamp
   * only ever moves forward. Each camera is read again under its own serialisation, so a save of
   * that camera's links in flight is not overwritten by the page this scan read earlier.
   */
  async unlinkAction(actionId: string): Promise<number> {
    let touched = 0
    let cursor: string | undefined
    do {
      const page = await this.links.query({ ...(cursor === undefined ? {} : { cursor }) })
      for (const listed of page.records) {
        if (!listed.data.actionIds.includes(actionId)) continue
        const changed = await this.serial.run(`links:${listed.id}`, async () => {
          const row = await this.links.get(listed.id)
          if (row === null || !row.data.actionIds.includes(actionId)) return false
          await this.links.put({
            id: row.id,
            ...(row.deviceId === null ? {} : { deviceId: row.deviceId }),
            data: {
              actionIds: row.data.actionIds.filter((id) => id !== actionId),
              updatedAt: nextStamp(row.data.updatedAt ?? 0, this.now()),
            },
          })
          return true
        })
        if (changed) touched += 1
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return touched
  }

  /**
   * Replace a camera's links. The save carries the stamp it read (D1098): links changed since
   * are refused by name. Read, check and write are one serialised step per camera, so two saves
   * that read the same stamp cannot both pass. An empty list keeps its row, so the stamp survives.
   */
  async setLinks(
    deviceId: number,
    actionIds: readonly string[],
    expectedUpdatedAt: number,
  ): Promise<{ readonly actionIds: readonly string[]; readonly updatedAt: number }> {
    return this.serial.run(`links:${deviceId}`, async () => {
      const stored = (await this.linksStateOf(deviceId)).updatedAt
      if (stored !== expectedUpdatedAt) {
        throw new StaleStampError(
          `the action links of device ${deviceId}`,
          stored,
          expectedUpdatedAt,
        )
      }
      const unique = [...new Set(actionIds)]
      const updatedAt = nextStamp(stored, this.now())
      await this.links.put({
        id: String(deviceId),
        deviceId,
        data: { actionIds: unique, updatedAt },
      })
      return { actionIds: unique, updatedAt }
    })
  }
}

/** A stored row with any retired device type (D1033) in its step targets rewritten to its canonical one. */
function withCanonicalStepTargets(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const steps = Reflect.get(data, 'steps')
  return steps === undefined ? data : { ...data, steps: canonicalStoredStepTargets(steps) }
}

/** The stamp of a write: strictly above the stored one, so two writes in one millisecond differ. */
function nextStamp(stored: number, now: number): number {
  return Math.max(stored + 1, now)
}
