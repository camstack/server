/**
 * The row model of the instances table, pure: which providers of a function cap
 * become instance rows and which stay fixed rows, which providers can create an instance, the
 * three-state answer of the queries behind it, and the patch an edit sends.
 *
 * An unanswered query is never an empty answer (D315): `deriveState` is `pending` until every
 * query has answered, so the caller shows "nothing here" only from `ready`.
 */
import {
  kindServesCap,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
  type IntegrationInstanceKind,
  type IntegrationInstanceMode,
} from '@camstack/types'
import type { ConfigUISchema } from '../../types/config-ui'

/** One provider of the function cap (`log-destination`, `smtp-provider`). */
export interface FunctionProvider {
  readonly addonId: string
  readonly isActive: boolean
}

/** What one `integration-instances` provider answered: its description and its records. */
export interface HolderData {
  readonly addonId: string
  readonly description: IntegrationInstanceDescription
  readonly instances: readonly IntegrationInstance[]
}

export interface InstanceRow {
  readonly kind: 'instance'
  readonly key: string
  readonly addonId: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly configured: boolean
  /** The row's own switch; an off row is quiet, not broken (D62). */
  readonly enabled: boolean
  readonly status: IntegrationInstance['status']
  readonly canTest: boolean
  /** The instance's kind when the provider has kinds; `kindLabel` is what the table shows. */
  readonly kindId?: string
  readonly kindLabel?: string
  /** The kind's own icon, when it declares one (else the Kind cell shows the addon's). */
  readonly kindIconUrl?: string
  /** Epoch ms of the last probe behind `status`. */
  readonly lastCheckedAt?: number
  /** The kind's interactive link / unlink paths (may carry `{{brokerId}}`). */
  readonly connectPath?: string
  readonly disconnectPath?: string
  /**
   * The owning addon's process state when `addons.list` ANSWERED that it is not running
   * (`crashed`, `failed`, `stopped` ...). The hub refuses the switch then, so it is drawn
   * disabled with the reason. Absent when running or not known.
   */
  readonly notRunning?: string
}

export interface FixedRow {
  readonly kind: 'fixed'
  readonly key: string
  readonly addonId: string
  readonly providerName: string
  readonly name: string
  readonly description: string
  readonly isActive: boolean
}

export type PanelRow = InstanceRow | FixedRow

export interface BuildRowsInput {
  readonly functionProviders: readonly FunctionProvider[]
  readonly holders: readonly HolderData[]
  readonly displayNames: ReadonlyMap<string, string>
  readonly descriptions: ReadonlyMap<string, string>
  /** addonId -> process state, for the addons known NOT to be running ({@link notRunningAddons}). */
  readonly notRunning?: ReadonlyMap<string, string>
}

/** Instance rows for providers that hold records, fixed rows for the rest, in provider order. */
export function buildRows(input: BuildRowsInput): readonly PanelRow[] {
  const holderById = new Map(input.holders.map((h) => [h.addonId, h]))
  const rows: PanelRow[] = []
  for (const provider of input.functionProviders) {
    const providerName = input.displayNames.get(provider.addonId) ?? provider.addonId
    const holder = holderById.get(provider.addonId)
    if (holder === undefined) {
      rows.push({
        kind: 'fixed',
        key: `fixed:${provider.addonId}`,
        addonId: provider.addonId,
        providerName,
        name: providerName,
        description: input.descriptions.get(provider.addonId) ?? '',
        isActive: provider.isActive,
      })
      continue
    }
    const notRunning = input.notRunning?.get(provider.addonId)
    for (const instance of holder.instances) {
      const kind = findKind(holder.description, instance.kind)
      rows.push({
        kind: 'instance',
        key: `${provider.addonId}:${instance.id}`,
        addonId: provider.addonId,
        providerName,
        id: instance.id,
        name: instance.name,
        configured: instance.configured,
        enabled: instance.enabled ?? true,
        status: instance.status,
        canTest: kind?.canTest ?? holder.description.canTest,
        ...(instance.kind !== undefined ? { kindId: instance.kind } : {}),
        ...(instance.kind !== undefined ? { kindLabel: kind?.label ?? instance.kind } : {}),
        ...(kind?.iconUrl !== undefined ? { kindIconUrl: kind.iconUrl } : {}),
        ...(instance.lastCheckedAt !== undefined ? { lastCheckedAt: instance.lastCheckedAt } : {}),
        ...(kind?.connectPath !== undefined ? { connectPath: kind.connectPath } : {}),
        ...(kind?.disconnectPath !== undefined ? { disconnectPath: kind.disconnectPath } : {}),
        ...(notRunning !== undefined ? { notRunning } : {}),
      })
    }
  }
  return rows
}

/** A process state that says the addon CAN answer, or that nobody knows (D315): never a refusal. */
const NOT_A_STOP = new Set(['running', 'unknown'])

/**
 * True when a process state says the addon is NOT running. Only an answered state counts: an
 * absent one, or `unknown`, is not known to be stopped (D315).
 */
export function isStoppedProcessState(state: string | undefined): boolean {
  return state !== undefined && !NOT_A_STOP.has(state)
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * The addons `addons.list` answered are NOT running, with their process state: their
 * `integration-instances` switch has nobody to reach and the hub refuses it. Only an answered
 * `process.state` counts - an addon without one, or `unknown`, is not known to be stopped.
 */
export function notRunningAddons(addons: readonly unknown[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const addon of addons) {
    const id = fieldOf(fieldOf(addon, 'manifest'), 'id')
    const state = fieldOf(fieldOf(addon, 'process'), 'state')
    if (typeof id !== 'string' || typeof state !== 'string') continue
    if (isStoppedProcessState(state)) out.set(id, state)
  }
  return out
}

/**
 * addonId -> the name a provider row shows, read from what `addons.list` answered. The ADDON's own
 * `name` wins over the package's `packageDisplayName`: one package ships several addons, and two
 * rows of one table under the same package name could not be told apart.
 */
export function providerNamesByAddon(addons: readonly unknown[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const addon of addons) {
    const manifest = fieldOf(addon, 'manifest')
    const id = fieldOf(manifest, 'id')
    if (typeof id !== 'string' || id.length === 0) continue
    const name = fieldOf(manifest, 'name')
    const packageName = fieldOf(manifest, 'packageDisplayName')
    out.set(
      id,
      typeof name === 'string' ? name : typeof packageName === 'string' ? packageName : id,
    )
  }
  return out
}

/** addonId -> manifest description, so an addon describes itself. */
export function addonDescriptions(addons: readonly unknown[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const addon of addons) {
    const manifest = fieldOf(addon, 'manifest')
    const id = fieldOf(manifest, 'id')
    const description = fieldOf(manifest, 'description')
    if (typeof id !== 'string' || typeof description !== 'string') continue
    if (description.length > 0) out.set(id, description)
  }
  return out
}

/** The kind a record names, among the kinds its provider declared. */
export function findKind(
  description: IntegrationInstanceDescription,
  kindId: string | undefined,
): IntegrationInstanceKind | undefined {
  return kindId === undefined ? undefined : description.kinds?.find((k) => k.id === kindId)
}

/**
 * The description narrowed to the kinds a page section configures (D1013): those whose
 * `functionCap` is the section's. A description with no kinds serves every section it appears in.
 * Null when it declares kinds and none belongs to the section.
 */
export function sectionDescription(
  description: IntegrationInstanceDescription,
  functionCap: string,
  kindId?: string,
): IntegrationInstanceDescription | null {
  const kinds = description.kinds
  if (kinds === undefined || kinds.length === 0) return description
  // A named kind is kept when it serves the cap at all (a Google account created from a mail
  // sender picker); the section itself lists only the kinds whose function the cap is.
  const own = kinds.filter((k) =>
    kindId === undefined
      ? k.functionCap === functionCap
      : k.id === kindId && kindServesCap(k, functionCap),
  )
  return own.length === 0 ? null : { ...description, kinds: own }
}

/**
 * A holder as one section sees it: the narrowed description and only the instances of its kinds.
 * Null when the provider has nothing in this section.
 */
export function sectionHolder(holder: HolderData, functionCap: string): HolderData | null {
  const description = sectionDescription(holder.description, functionCap)
  if (description === null) return null
  const kinds = description.kinds
  if (holder.description.kinds === undefined || kinds === undefined) return holder
  const ids = new Set(kinds.map((k) => k.id))
  return {
    ...holder,
    description,
    instances: holder.instances.filter((i) => i.kind === undefined || ids.has(i.kind)),
  }
}

/** Whether Add must ask which kind: only when the provider offers a real choice. */
export function needsKindPicker(description: IntegrationInstanceDescription): boolean {
  return (description.kinds?.length ?? 0) > 1
}

/**
 * What a new record is called: the provider's name, or the kind's label when the provider offers
 * several kinds and so does not say what is being added.
 */
export function createLabel(
  description: IntegrationInstanceDescription,
  kind: IntegrationInstanceKind | undefined,
  providerName: string,
): string {
  return needsKindPicker(description) && kind !== undefined ? kind.label : providerName
}

/** The word a status badge shows: the provider's own label, else the state. */
export function statusText(status: NonNullable<IntegrationInstance['status']>): string {
  return status.label !== undefined && status.label.length > 0 ? status.label : status.state
}

export interface ProviderChip {
  readonly addonId: string
  readonly name: string
}

/** The distinct providers among the rows, in row order — the activity panel's chips. */
export function providersOf(rows: readonly PanelRow[]): readonly ProviderChip[] {
  const seen = new Set<string>()
  const chips: ProviderChip[] = []
  for (const row of rows) {
    if (seen.has(row.addonId)) continue
    seen.add(row.addonId)
    chips.push({ addonId: row.addonId, name: row.providerName })
  }
  return chips
}

/** The health of one row or of a provider's rows; a hollow dot is `unknown`. */
export type InstanceHealth = 'ok' | 'off' | 'error' | 'unknown'

const HEALTH_SEVERITY: Readonly<Record<InstanceHealth, number>> = {
  error: 3,
  unknown: 2,
  ok: 1,
  off: 0,
}

/** A switched-off row is quiet (D62); otherwise its own status, else configured or not. */
export function rowHealth(row: InstanceRow): InstanceHealth {
  if (!row.enabled) return 'off'
  if (row.status !== undefined) return row.status.state
  return row.configured ? 'ok' : 'unknown'
}

/** The worst of several rows; no rows at all is `unknown`, never a healthy-looking `ok`. */
export function worstHealth(rows: readonly InstanceRow[]): InstanceHealth {
  let worst: InstanceHealth | null = null
  for (const row of rows) {
    const health = rowHealth(row)
    if (worst === null || HEALTH_SEVERITY[health] > HEALTH_SEVERITY[worst]) worst = health
  }
  return worst ?? 'unknown'
}

/** One sub-header pill: a provider of the function cap, with its row count and a status dot. */
export interface InstancePill {
  readonly addonId: string
  readonly name: string
  readonly count: number
  readonly health: InstanceHealth
}

/**
 * A pill for EVERY provider of the function cap, in provider order. A record holder shows its
 * instance count and the worst row status (no record is `unknown`); a fixed-row provider counts
 * its one row and takes its dot from the registry switch (active is `ok`, otherwise `off`).
 */
export function providerPills(
  functionProviders: readonly FunctionProvider[],
  rows: readonly PanelRow[],
  displayNames: ReadonlyMap<string, string>,
): readonly InstancePill[] {
  return functionProviders.map((provider) => {
    const name = displayNames.get(provider.addonId) ?? provider.addonId
    const own = rows.filter((row) => row.addonId === provider.addonId)
    const instances = own.filter((row): row is InstanceRow => row.kind === 'instance')
    const fixed = own.find((row): row is FixedRow => row.kind === 'fixed')
    if (fixed !== undefined) {
      return {
        addonId: provider.addonId,
        name,
        count: 1,
        health: fixed.isActive ? 'ok' : 'off',
      }
    }
    return {
      addonId: provider.addonId,
      name,
      count: instances.length,
      health: worstHealth(instances),
    }
  })
}

/** The rows a pill selects; `null` is the "All" pill. */
export function filterRows(rows: readonly PanelRow[], addonId: string | null): readonly PanelRow[] {
  return addonId === null ? rows : rows.filter((row) => row.addonId === addonId)
}

/**
 * Providers the operator can create an instance in: a `multiple` provider ALWAYS, however many
 * rows it holds; a `single` one only while it has none.
 */
export function creatableProviders(holders: readonly HolderData[]): readonly HolderData[] {
  return holders.filter(
    (h) => h.description.instanceMode === 'multiple' || h.instances.length === 0,
  )
}

/** One thing Add can create: a kind of a provider, or a provider that has no kinds. */
export interface CreatableKind {
  readonly addonId: string
  /** The kind the editor opens on; absent for a provider without kinds. */
  readonly kind?: string
  readonly label: string
  readonly providerName: string
  readonly iconUrl?: string
}

/**
 * Every kind Add can create across the creatable providers, in provider order: one entry per kind
 * of the section (a provider without kinds is one entry). Add opens the editor straight away when
 * there is one, else the chooser lists them all, each with its icon. Kind VALUES are data.
 */
export function creatableKinds(
  holders: readonly HolderData[],
  nameOf: (addonId: string) => string,
): readonly CreatableKind[] {
  return holders.flatMap((holder): readonly CreatableKind[] => {
    const providerName = nameOf(holder.addonId)
    const kinds = holder.description.kinds ?? []
    if (kinds.length === 0) return [{ addonId: holder.addonId, label: providerName, providerName }]
    return kinds.map((k) => ({
      addonId: holder.addonId,
      kind: k.id,
      label: k.label,
      providerName,
      ...(k.iconUrl !== undefined ? { iconUrl: k.iconUrl } : {}),
    }))
  })
}

export type PanelState = 'pending' | 'error' | 'ready'

export interface QueryFlags {
  readonly isPending: boolean
  readonly isError: boolean
}

/** `error` wins over `pending`; `ready` only when every query answered. */
export function deriveState(queries: readonly QueryFlags[]): PanelState {
  if (queries.some((q) => q.isError)) return 'error'
  if (queries.some((q) => q.isPending)) return 'pending'
  return 'ready'
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false
  }
  return true
}

/** The on/off switch is stored in the record body beside the form values; it is not a form field. */
const SWITCH_BODY_KEY = 'enabled'

/**
 * The values a record's form starts from: its `formValues` without the switch, which the record
 * body shares and only the row's On control writes (`setInstanceEnabled`). A form that has a
 * field of its own named like the switch keeps it.
 */
export function formStartValues(
  formValues: Readonly<Record<string, unknown>>,
  schema?: ConfigUISchema,
): Record<string, unknown> {
  const owned = schema?.sections.some((section) =>
    section.fields.some((field) => field.key === SWITCH_BODY_KEY),
  )
  if (owned === true) return { ...formValues }
  return Object.fromEntries(Object.entries(formValues).filter(([key]) => key !== SWITCH_BODY_KEY))
}

/**
 * The patch of an edit: only the keys that differ from the stored values. A secret left alone
 * still holds its stored view, so it is equal and omitted; a typed or cleared one differs.
 */
export function diffInstanceValues(
  stored: Readonly<Record<string, unknown>>,
  edited: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(edited)) {
    if (value === undefined) continue
    if (!valuesEqual(stored[key], value)) patch[key] = value
  }
  return patch
}

/**
 * What a sign-in started from an open form must carry: the stored record overlaid with the
 * edits. The patch of an edit (`diffInstanceValues`) omits whatever the operator left alone, so
 * a sign-in that sent it would lose the region the record already holds and the provider would
 * fall back to its own default. A secret still holds its stored view, which a provider ignores.
 */
export function effectiveInstanceValues(
  stored: Readonly<Record<string, unknown>>,
  edited: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const effective: Record<string, unknown> = { ...stored }
  for (const [key, value] of Object.entries(edited)) {
    if (value !== undefined) effective[key] = value
  }
  return effective
}

/**
 * Whether the UI proposes the id of a new instance. Not when the provider mints its own
 * (`mintsId`), and not for a kind that brings devices: the hub mints that id with the integration
 * row and refuses any other (`instance-lifecycle.ts`). A kind without a role takes the provider's.
 */
export function uiProposesInstanceId(
  description: IntegrationInstanceDescription,
  kind: IntegrationInstanceKind | undefined,
): boolean {
  if (description.mintsId === true) return false
  return (kind?.role ?? description.role) !== 'devices'
}

/** A single-instance addon names its record after itself; a multi one gets an opaque id. */
export function mintInstanceId(
  mode: IntegrationInstanceMode,
  addonId: string,
  randomHex8: () => string,
): string {
  return mode === 'single' ? addonId : `inst-${randomHex8()}`
}

/** 8 lowercase hex characters from the platform's random source. */
export function randomHex8(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** What an open dialog names: a record, a record about to be created, or a fixed row's settings. */
export type EditRef =
  | { readonly kind: 'instance'; readonly addonId: string; readonly id: string }
  | { readonly kind: 'create'; readonly addonId: string; readonly kindId?: string }
  | { readonly kind: 'fixed'; readonly addonId: string }

const CREATE_MARK = '+'

/**
 * The one URL value of an open dialog. `addonId:id` is a record, `addonId:+` a new one,
 * `addonId:+kind` a new one of a kind already chosen, and a bare `addonId` a fixed row. An id is
 * only unique inside its provider, so the addon travels with it.
 */
export function formatEditRef(addonId: string, id?: string | null, kindId?: string): string {
  if (id === undefined) return addonId
  if (id === null) return `${addonId}:${CREATE_MARK}${kindId ?? ''}`
  return `${addonId}:${id}`
}

export function parseEditRef(raw: string): EditRef {
  const at = raw.indexOf(':')
  if (at < 0) return { kind: 'fixed', addonId: raw }
  const addonId = raw.slice(0, at)
  const rest = raw.slice(at + 1)
  if (!rest.startsWith(CREATE_MARK)) return { kind: 'instance', addonId, id: rest }
  const kindId = rest.slice(CREATE_MARK.length)
  return kindId === '' ? { kind: 'create', addonId } : { kind: 'create', addonId, kindId }
}

export interface PinningTarget {
  readonly name: string
  readonly formValues: Readonly<Record<string, unknown>>
}

/** The email target field that links the instance sending its mail (`notifiers` `sendWith`). */
const SENDER_LINK_KEY = 'sendWith'

/** Names of the notification targets that send with one instance: the delete warning and the row hint. */
export function targetsPinning(
  targets: readonly PinningTarget[],
  instanceId: string,
): readonly string[] {
  return targets.filter((t) => t.formValues[SENDER_LINK_KEY] === instanceId).map((t) => t.name)
}

/**
 * An id the operator types when a record is created (a provider's immutable, human-chosen key:
 * a login method's slug). The caller declares it per kind; the editor validates it live and
 * sends it as `createInstance.id`. It cannot be changed afterwards.
 */
export interface TypedIdRule {
  readonly pattern: RegExp
}

/** The id shape the server's instance records accept from an operator: a short lowercase slug. */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The rule for the kind being created, or undefined when the kind mints its own id. */
export type TypedIdRuleFor = (kindId: string | undefined) => TypedIdRule | undefined

/** `empty` is not an error (nothing typed yet) but blocks Create; `invalid` is shown to the operator. */
export function checkTypedId(rule: TypedIdRule, typed: string): 'ok' | 'empty' | 'invalid' {
  if (typed === '') return 'empty'
  return rule.pattern.test(typed) ? 'ok' : 'invalid'
}
