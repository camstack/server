/**
 * Slot bindings and named templates move onto the device-template engine
 * (D987, D1021/D1025, BYS #450 P5).
 *
 * Before: a slot's source was a clock, the latest recognition, one device field or a
 * named template of `{alias.value}` tokens, shaped by per-binding `displayUnit`,
 * `maxDecimals` and `valueMap` and a `${value}` wrapper. After: a slot is `none`, a
 * literal, or a pointer to a NAMED TEMPLATE whose text is one device-template string.
 *
 *  - every old named template keeps its id and name; its parser and bindings become `text`;
 *  - every slot whose source was a clock, a recognition or a device field gets a generated
 *    named template (one per distinct text, shared by the slots that need it) and points at it;
 *  - `template` / `maxDecimals` / `valueMap` leave the slot (folded into the text);
 *  - `deviceId` omitted ("this camera") becomes `camera`, so a copied slot still follows the
 *    camera it is copied to; another device is written by its alias.
 *
 * Idempotent: a row already in the new shape has nothing to rewrite, so a rerun plans no edit.
 * A read that fails throws and nothing is written. The engine snapshots before applying.
 */
import {
  type MigrationEdit,
  type MigrationPlan,
  OSD_TEMPLATE_TEXT_MAX,
  preconditionOf,
} from '@camstack/types'
import {
  clockExpression,
  convertParser,
  escapeLiteral,
  type ExpressionParts,
  expressionParts,
  fieldRef,
  foldWrapper,
  type LegacyNamedTemplate,
  LegacyNamedTemplateSchema,
  LegacySlotBindingSchema,
  LegacyClockSourceSchema,
  LegacyDeviceStateSourceSchema,
  LegacyRecognitionSourceSchema,
  LegacyStaticSourceSchema,
  LegacyTemplateSourceSchema,
  recognitionExpression,
  sliceUnitOf,
  sliceValueAt,
} from './legacy-expression.js'

export const OSD_MANAGER_ID = 'osd-manager'
export const OSD_BINDINGS_FIELD = 'slotBindings'
export const OSD_TEMPLATES_FIELD = 'namedTemplates'
export const BINDINGS_TO_TEMPLATES_MIGRATION_ID = 'osd-manager/2026-11-10-bindings-to-templates'

const SETTINGS_TABLE = 'addon-settings'
const DEVICE_SETTINGS_TABLE = 'addon-device-settings'
/** Longest literal a `static` source keeps (the live schema's bound). */
const STATIC_TEXT_MAX = 64

export interface BindingsToTemplatesPorts {
  /** The addon's cluster rows as stored, for each of `keys` that has one. Throws when unreadable. */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Every device id that has a per-device settings blob. Throws when unreadable. */
  listDeviceIds(): Promise<readonly number[]>
  /** The per-device rows of `field` that exist, by device id. Throws when unreadable. */
  readDeviceField(
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>>
  /** `deviceId` → the alias a template names it by (devices without one are absent). */
  readAliases(): Promise<ReadonlyMap<number, string>>
  /** One capability's current state slice on a device; `undefined` when it has none. */
  readSlice(deviceId: number, capName: string): Promise<unknown>
  /** One line for the operator: a conversion that could not be exact. */
  note(message: string, deviceId?: number): void
}

interface Generated {
  readonly id: string
  readonly name: string
  readonly text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function summaryOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return `Migrated: ${flat}`.slice(0, 64)
}

/** A short stable id for a text (FNV-1a, 64 bit as two 32-bit halves): the same text is the same template. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

function generatedFor(text: string): Generated {
  const digest = fingerprint(text)
  return { id: `migrated-${digest}`, name: summaryOf(text), text }
}

function assertFits(text: string, where: string): string {
  if (text.length > OSD_TEMPLATE_TEXT_MAX) {
    throw new Error(
      `${OSD_MANAGER_ID}: ${where} converts to ${text.length} characters, over the ${OSD_TEMPLATE_TEXT_MAX} a template holds`,
    )
  }
  return text
}

function isLegacyNamedTemplate(row: unknown): boolean {
  return isRecord(row) && ('parser' in row || 'bindings' in row) && !('text' in row)
}

const RETIRED_SLOT_FIELDS = ['template', 'maxDecimals', 'valueMap'] as const
const RETIRED_SOURCE_KINDS: readonly string[] = ['clock', 'latest-recognition', 'device-state']

function isLegacySlot(row: unknown): boolean {
  if (!isRecord(row)) return false
  if (RETIRED_SLOT_FIELDS.some((field) => field in row)) return true
  const source = row['source']
  return isRecord(source) && RETIRED_SOURCE_KINDS.includes(String(source['kind']))
}

class Converter {
  readonly generated = new Map<string, Generated>()
  constructor(
    private readonly ports: BindingsToTemplatesPorts,
    private readonly aliases: ReadonlyMap<number, string>,
  ) {}

  private aliasFor(deviceId: number, cameraId: number | null): string {
    if (cameraId !== null && deviceId === cameraId) return 'camera'
    const alias = this.aliases.get(deviceId)
    if (alias !== undefined) return alias
    this.ports.note(
      `device ${deviceId} has no alias; its values will read as unavailable until it has one`,
    )
    return `device_${deviceId}`
  }

  /** The two halves of one device field as the old tokens printed them. */
  private async partsOf(input: {
    readonly deviceId: number
    readonly cameraId: number | null
    readonly capName: string
    readonly valuePath: string
    readonly displayUnit: string | undefined
    readonly maxDecimals: number
    readonly valueMap: Readonly<Record<string, string>> | undefined
  }): Promise<ExpressionParts> {
    const slice = await this.ports.readSlice(input.deviceId, input.capName)
    return expressionParts({
      ref: fieldRef(this.aliasFor(input.deviceId, input.cameraId), input.capName, input.valuePath),
      displayUnit: input.displayUnit,
      maxDecimals: input.maxDecimals,
      valueMap: input.valueMap,
      sample: {
        raw: sliceValueAt(slice, input.valuePath),
        sliceUnit: sliceUnitOf(slice, input.valuePath),
      },
    })
  }

  async namedTemplate(
    row: LegacyNamedTemplate,
  ): Promise<{ id: string; name: string; text: string }> {
    const parts = new Map<string, ExpressionParts>()
    for (const binding of row.bindings) {
      parts.set(
        binding.alias,
        await this.partsOf({
          deviceId: binding.pick.deviceId,
          cameraId: null,
          capName: binding.capName,
          valuePath: binding.valuePath,
          displayUnit: binding.displayUnit,
          maxDecimals: binding.maxDecimals,
          valueMap: binding.valueMap,
        }),
      )
    }
    const text = convertParser(row.parser, (alias) => parts.get(alias))
    return { id: row.id, name: row.name, text: assertFits(text, `template "${row.name}"`) }
  }

  /** A slot's source as new-shape source; generates a named template when the text needs one. */
  async source(
    cameraId: number,
    slot: ReturnType<typeof LegacySlotBindingSchema.parse>,
  ): Promise<{ kind: string; [key: string]: unknown }> {
    const wrapper = slot.template ?? '${value}'
    const maxDecimals = slot.maxDecimals ?? 1
    const asTemplate = (text: string): { kind: 'template'; templateId: string } => {
      const made = generatedFor(assertFits(text, `slot of device ${cameraId}`))
      this.generated.set(made.id, made)
      return { kind: 'template', templateId: made.id }
    }

    const device = LegacyDeviceStateSourceSchema.safeParse(slot.source)
    if (device.success) {
      const parts = await this.partsOf({
        deviceId: device.data.deviceId ?? cameraId,
        cameraId,
        capName: device.data.capName,
        valuePath: device.data.valuePath,
        displayUnit: device.data.displayUnit,
        maxDecimals,
        valueMap: slot.valueMap,
      })
      return asTemplate(foldWrapper(wrapper, parts))
    }
    const clock = LegacyClockSourceSchema.safeParse(slot.source)
    if (clock.success) {
      if (clock.data.timezone !== undefined) {
        this.ports.note(
          `the clock of a slot used the zone ${clock.data.timezone}; the template clock uses the server's zone`,
          cameraId,
        )
      }
      return asTemplate(
        foldWrapper(wrapper, { value: clockExpression(clock.data.pattern), unit: '' }),
      )
    }
    const recognition = LegacyRecognitionSourceSchema.safeParse(slot.source)
    if (recognition.success) {
      return asTemplate(
        foldWrapper(wrapper, {
          value: recognitionExpression(recognition.data.recognition),
          unit: '',
        }),
      )
    }
    const named = LegacyTemplateSourceSchema.safeParse(slot.source)
    if (named.success) return { kind: 'template', templateId: named.data.templateId }
    const literal = LegacyStaticSourceSchema.safeParse(slot.source)
    if (literal.success) {
      const mapped = slot.valueMap?.[literal.data.text] ?? literal.data.text
      const folded = wrapper.replaceAll('${value}', mapped).replaceAll('${unit}', '').trim()
      if (folded.length <= STATIC_TEXT_MAX) return { kind: 'static', text: folded }
      return asTemplate(escapeLiteral(folded))
    }
    return slot.source
  }
}

async function convertedBindings(
  converter: Converter,
  cameraId: number,
  stored: unknown,
): Promise<Record<string, unknown> | null> {
  if (!isRecord(stored)) return null
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [slotId, row] of Object.entries(stored)) {
    if (!isLegacySlot(row)) {
      next[slotId] = row
      continue
    }
    changed = true
    const slot = LegacySlotBindingSchema.parse(row)
    next[slotId] = {
      enabled: slot.enabled,
      source: await converter.source(cameraId, slot),
      ...(slot.schedule !== undefined ? { schedule: slot.schedule } : {}),
      ...(slot.conditions !== undefined ? { conditions: slot.conditions } : {}),
    }
  }
  return changed ? next : null
}

export async function planBindingsToTemplates(
  ports: BindingsToTemplatesPorts,
): Promise<MigrationPlan> {
  const stored = await ports.readStored([OSD_TEMPLATES_FIELD])
  const aliases = await ports.readAliases()
  const converter = new Converter(ports, aliases)

  const storedTemplates = stored[OSD_TEMPLATES_FIELD]
  const oldTemplates = Array.isArray(storedTemplates) ? storedTemplates : []
  const rewrittenTemplates: unknown[] = []
  let templatesChanged = false
  for (const row of oldTemplates) {
    if (!isLegacyNamedTemplate(row)) {
      rewrittenTemplates.push(row)
      continue
    }
    templatesChanged = true
    rewrittenTemplates.push(await converter.namedTemplate(LegacyNamedTemplateSchema.parse(row)))
  }

  const deviceIds = await ports.listDeviceIds()
  const bindingRows =
    deviceIds.length === 0
      ? new Map<number, unknown>()
      : await ports.readDeviceField(deviceIds, OSD_BINDINGS_FIELD)
  const deviceEdits: MigrationEdit[] = []
  for (const [deviceId, value] of bindingRows) {
    const next = await convertedBindings(converter, deviceId, value)
    if (next === null) continue
    const rowId = `${OSD_MANAGER_ID}:${deviceId}.${OSD_BINDINGS_FIELD}`
    const row = (v: unknown): Record<string, unknown> => ({
      addonId: OSD_MANAGER_ID,
      deviceId: String(deviceId),
      key: OSD_BINDINGS_FIELD,
      value: v,
    })
    deviceEdits.push({
      op: 'setKeys',
      scope: DEVICE_SETTINGS_TABLE,
      values: { [rowId]: row(next) },
      precondition: preconditionOf({ [rowId]: row(value) }),
    })
  }

  const taken = new Set(
    rewrittenTemplates.flatMap((t) =>
      isRecord(t) && typeof t['id'] === 'string' ? [t['id']] : [],
    ),
  )
  const added = [...converter.generated.values()].filter((g) => !taken.has(g.id))
  if (!templatesChanged && added.length === 0) return { edits: deviceEdits }

  const rowId = `${OSD_MANAGER_ID}.${OSD_TEMPLATES_FIELD}`
  const clusterRow = (v: unknown): Record<string, unknown> => ({
    addonId: OSD_MANAGER_ID,
    key: OSD_TEMPLATES_FIELD,
    value: v,
  })
  const final = [
    ...rewrittenTemplates,
    ...added.map((g) => ({ id: g.id, name: g.name, text: g.text })),
  ]
  const cluster: MigrationEdit = {
    op: 'setKeys',
    scope: SETTINGS_TABLE,
    values: { [rowId]: clusterRow(final) },
    precondition: preconditionOf({
      [rowId]: OSD_TEMPLATES_FIELD in stored ? clusterRow(storedTemplates) : null,
    }),
  }
  return { edits: [cluster, ...deviceEdits] }
}
