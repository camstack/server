/**
 * The `template` cap (D963): the generic store of named, reusable operator
 * data. A record is `{ id, kind, name, payload }`; this service validates a
 * payload against its KIND's schema (`checkTemplatePayload`) and nothing else —
 * it does not know what a remote is.
 *
 * A delete asks the {@link TemplateUsage} port who still points at the record
 * and refuses with the devices named (typed `in-use`), so a button grid cannot
 * vanish under a device that draws from it.
 */
import { randomUUID } from 'node:crypto'
import {
  checkTemplatePayload,
  type IScopedLogger,
  type ITemplateProvider,
  type RecordKindHandle,
  type TemplateRecord,
  type TemplateUser,
} from '@camstack/types'
import type { TemplateRowBody } from './record-kinds.js'

/** Who still uses a template — answered by whoever owns the pointers. */
export interface TemplateUsage {
  devicesUsing(templateId: string): Promise<readonly TemplateUser[]>
}

export interface TemplatesServiceDeps {
  readonly templates: RecordKindHandle<TemplateRowBody>
  readonly usage: TemplateUsage
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

function recordOf(id: string, body: TemplateRowBody): TemplateRecord {
  return {
    id,
    kind: body.kind,
    name: body.name,
    payload: body.payload,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}

export class TemplatesService implements ITemplateProvider {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: TemplatesServiceDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
  }

  readonly list: ITemplateProvider['list'] = async ({ kind }) => {
    const out: TemplateRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.deps.templates.query({
        ...(kind === undefined ? {} : { where: { kind } }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of page.records) out.push(recordOf(row.id, row.data))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return out
  }

  readonly get: ITemplateProvider['get'] = async ({ id }) => {
    const row = await this.deps.templates.get(id)
    return row === null ? null : recordOf(row.id, row.data)
  }

  readonly create: ITemplateProvider['create'] = async ({ kind, name, payload }) => {
    const checked = checkTemplatePayload(kind, payload)
    if (!checked.ok) {
      this.deps.logger.warn('template: a payload its kind does not accept was refused', {
        meta: { kind, detail: checked.detail },
      })
      return { status: 'refused', reason: 'invalid-payload', detail: checked.detail }
    }
    const at = this.now()
    const body: TemplateRowBody = {
      kind,
      name,
      payload: checked.payload,
      createdAt: at,
      updatedAt: at,
    }
    const id = this.newId()
    await this.deps.templates.put({ id, data: body })
    return { status: 'saved', template: recordOf(id, body) }
  }

  readonly update: ITemplateProvider['update'] = async ({ id, name, payload }) => {
    const existing = await this.deps.templates.get(id)
    if (existing === null) {
      return { status: 'refused', reason: 'not-found', detail: `no template "${id}"` }
    }
    let nextPayload = existing.data.payload
    if (payload !== undefined) {
      const checked = checkTemplatePayload(existing.data.kind, payload)
      if (!checked.ok) {
        this.deps.logger.warn('template: a payload its kind does not accept was refused', {
          meta: { id, kind: existing.data.kind, detail: checked.detail },
        })
        return { status: 'refused', reason: 'invalid-payload', detail: checked.detail }
      }
      nextPayload = checked.payload
    }
    const body: TemplateRowBody = {
      kind: existing.data.kind,
      name: name ?? existing.data.name,
      payload: nextPayload,
      createdAt: existing.data.createdAt,
      updatedAt: this.now(),
    }
    await this.deps.templates.put({ id, data: body })
    return { status: 'saved', template: recordOf(id, body) }
  }

  readonly delete: ITemplateProvider['delete'] = async ({ id }) => {
    const existing = await this.deps.templates.get(id)
    if (existing === null) return { status: 'not-found' }
    const [first, ...rest] = await this.deps.usage.devicesUsing(id)
    if (first !== undefined) {
      this.deps.logger.info('template: delete refused, devices still use it', {
        meta: { id, devices: rest.length + 1 },
      })
      return { status: 'in-use', devices: [first, ...rest] }
    }
    await this.deps.templates.delete(id)
    return { status: 'deleted' }
  }
}
