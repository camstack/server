/**
 * The `template` cap (D963): the generic store of named, reusable operator
 * data. A record is `{ id, kind, name, payload }`; this service validates a
 * payload against its KIND's schema (`checkTemplatePayload`) and nothing else —
 * it does not know what a remote is.
 *
 * A delete asks the {@link TemplateUsage} port who still points at the record
 * and refuses with the devices and automations named (typed `in-use`), so a
 * button grid cannot vanish under a device that draws from it, nor an automation
 * template under the automations made from it.
 *
 * Saving an `automation` template re-expands every automation made from it
 * (#527) through the {@link AutomationTemplateInstances} port.
 */
import { randomUUID } from 'node:crypto'
import {
  AutomationTemplatePayloadSchema,
  BUILTIN_AUTOMATION_TEMPLATES,
  builtinAutomationTemplate,
  checkTemplatePayload,
  isBuiltinTemplateId,
  type BuiltinAutomationTemplate,
  type IScopedLogger,
  type ITemplateProvider,
  type RecordKindHandle,
  type TemplateRecord,
  type TemplateUser,
} from '@camstack/types'
import type { AutomationTemplateInstances } from './automation-template-instances.js'
import type { TemplateRowBody } from './record-kinds.js'

/** Who still uses a template — answered by whoever owns the pointers. */
export interface TemplateUsage {
  devicesUsing(templateId: string): Promise<readonly TemplateUser[]>
}

export interface TemplatesServiceDeps {
  readonly templates: RecordKindHandle<TemplateRowBody>
  readonly usage: TemplateUsage
  /** The automations made from a template; absent where no block store runs. */
  readonly automations?: AutomationTemplateInstances
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

/** A shipped template as a record: read-only, timeless. */
function builtinRecordOf(template: BuiltinAutomationTemplate): TemplateRecord {
  return {
    id: template.id,
    kind: 'automation',
    name: template.name,
    payload: template.payload,
    createdAt: 0,
    updatedAt: 0,
    builtIn: true,
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
    if (kind === undefined || kind === 'automation') {
      out.push(...BUILTIN_AUTOMATION_TEMPLATES.map(builtinRecordOf))
    }
    return out
  }

  readonly get: ITemplateProvider['get'] = async ({ id }) => {
    const builtin = builtinAutomationTemplate(id)
    if (builtin !== undefined) return builtinRecordOf(builtin)
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
    if (isBuiltinTemplateId(id)) {
      return { status: 'refused', reason: 'read-only', detail: `"${id}" ships with CamStack` }
    }
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
    if (payload !== undefined) await this.reexpandInstances(id, body)
    return { status: 'saved', template: recordOf(id, body) }
  }

  /**
   * The shipped templates change only with a release: their instances are
   * re-expanded once per start, and an instance whose code comes out the same
   * is not saved (no restart).
   */
  async reexpandBuiltinInstances(): Promise<void> {
    if (this.deps.automations === undefined) return
    for (const template of BUILTIN_AUTOMATION_TEMPLATES) {
      await this.deps.automations.reexpand(template.id, template.payload)
    }
  }

  /** A changed automation template reaches every automation made from it. */
  private async reexpandInstances(id: string, body: TemplateRowBody): Promise<void> {
    if (body.kind !== 'automation' || this.deps.automations === undefined) return
    const parsed = AutomationTemplatePayloadSchema.safeParse(body.payload)
    if (!parsed.success) return
    await this.deps.automations.reexpand(id, parsed.data)
  }

  readonly delete: ITemplateProvider['delete'] = async ({ id }) => {
    if (isBuiltinTemplateId(id)) return { status: 'read-only' }
    const existing = await this.deps.templates.get(id)
    if (existing === null) return { status: 'not-found' }
    const devices = await this.deps.usage.devicesUsing(id)
    const automations = (await this.deps.automations?.using(id)) ?? []
    if (devices.length > 0 || automations.length > 0) {
      this.deps.logger.info('template: delete refused, something still uses it', {
        meta: { id, devices: devices.length, automations: automations.length },
      })
      return { status: 'in-use', devices: [...devices], automations: [...automations] }
    }
    await this.deps.templates.delete(id)
    return { status: 'deleted' }
  }
}
