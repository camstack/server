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
  CORE_BLOCKS_ADDON_ID,
  IDLE_ACTION_STATUS,
  internalActionId,
  isInternalActionId,
  INTERNAL_ACTION_PREFIX,
  type IScopedLogger,
  type RecordKindHandle,
} from '@camstack/types'
import { type ActionLinksRowBody, type ActionRowBody, ActionRowBodySchema } from './record-kinds.js'

export interface ActionsStoreOptions {
  readonly actions: RecordKindHandle<ActionRowBody>
  readonly links: RecordKindHandle<ActionLinksRowBody>
  readonly logger?: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

function uuidOf(actionId: string): string {
  return actionId.slice(INTERNAL_ACTION_PREFIX.length)
}

export class ActionsStore {
  private readonly actions: RecordKindHandle<ActionRowBody>
  private readonly links: RecordKindHandle<ActionLinksRowBody>
  private readonly logger: IScopedLogger | undefined
  private readonly now: () => number
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
    const parsed = ActionRowBodySchema.safeParse(data)
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
      createdAt: existing.data.createdAt,
      updatedAt: this.now(),
    }
    await this.actions.put({ id: existing.id, data: body })
    return ActionsStore.entryOf(existing.id, body)
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

  /** Drop `actionId` from every camera that links it; a camera left with none loses its row. */
  async unlinkAction(actionId: string): Promise<number> {
    let touched = 0
    let cursor: string | undefined
    do {
      const page = await this.links.query({ ...(cursor === undefined ? {} : { cursor }) })
      for (const row of page.records) {
        if (!row.data.actionIds.includes(actionId)) continue
        const rest = row.data.actionIds.filter((id) => id !== actionId)
        if (rest.length === 0) await this.links.delete(row.id)
        else
          await this.links.put({
            id: row.id,
            ...(row.deviceId === null ? {} : { deviceId: row.deviceId }),
            data: { actionIds: rest },
          })
        touched += 1
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return touched
  }

  async setLinks(deviceId: number, actionIds: readonly string[]): Promise<readonly string[]> {
    const unique = [...new Set(actionIds)]
    if (unique.length === 0) {
      await this.links.delete(String(deviceId))
      return []
    }
    await this.links.put({ id: String(deviceId), deviceId, data: { actionIds: unique } })
    return unique
  }
}
