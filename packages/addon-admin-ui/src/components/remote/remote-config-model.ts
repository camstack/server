/**
 * The pure model of the Remote Customize extension's editor (D964): the roles a
 * device's remote can bind, the binding edits, and the SmartIR import. The
 * config shape is `RemoteConfig` from `@camstack/types`; every function returns
 * a new config. A SmartIR file is parsed here, in the browser, with the one
 * parser (`parseSmartIr` then `smartIrDraft`) — the file is never stored and the
 * server never receives it.
 */
import {
  customKeyOfRole,
  customRole,
  flipperIrDraft,
  IrCodecError,
  type IrNativeFormat,
  type IrPayload,
  isRemoteWidgetRole,
  parseFlipperIr,
  parseSmartIr,
  type RemoteBinding,
  type RemoteBindingAction,
  type RemoteConfig,
  RemoteConfigSchema,
  type RemoteCustomButton,
  type RemoteIrSource,
  type RemoteLayoutPayload,
  type RemoteSource,
  type RemoteSourceKind,
  type SmartIrDraft,
  type SmartIrSkipped,
  smartIrDraft,
  toTimings,
} from '@camstack/types'
import { humanRole } from '@camstack/ui-library'

export const IR_CAP = 'ir-transmitter'
export const IR_SEND = 'send'

export interface BindableRole {
  readonly role: string
  /** What the operator calls a custom button; absent for a known role. */
  readonly name: string | null
  readonly custom: boolean
  /** The layout draws a button for it. */
  readonly inLayout: boolean
}

/**
 * Every role the editor lists: the ones the chosen layout draws first, then the
 * custom buttons the config knows, then any other bound role (a binding whose
 * button the layout no longer has is still reachable and still editable).
 */
export function bindableRoles(
  layout: RemoteLayoutPayload | null,
  config: RemoteConfig,
): readonly BindableRole[] {
  const names = new Map(config.customButtons.map((b) => [customRole(b.key), b.name]))
  const labels = new Map<string, string>()
  for (const b of layout?.buttons ?? []) {
    if (b.label !== undefined && !labels.has(b.role)) labels.set(b.role, b.label)
  }
  const seen = new Set<string>()
  const out: BindableRole[] = []
  const push = (role: string, inLayout: boolean): void => {
    if (seen.has(role) || isRemoteWidgetRole(role)) return
    seen.add(role)
    const custom = customKeyOfRole(role) !== null
    out.push({
      role,
      custom,
      inLayout,
      name: custom ? (names.get(role) ?? labels.get(role) ?? humanRole(role)) : null,
    })
  }
  for (const b of layout?.buttons ?? []) push(b.role, true)
  for (const role of names.keys()) push(role, false)
  for (const role of Object.keys(config.bindings)) push(role, false)
  return out
}

/** A custom button the layout draws must have an entry in `customButtons` once it is bound. */
function withCustomEntry(config: RemoteConfig, role: string, fallbackName: string): RemoteConfig {
  const key = customKeyOfRole(role)
  if (key === null || config.customButtons.some((b) => b.key === key)) return config
  const entry: RemoteCustomButton = { key, name: fallbackName }
  return { ...config, customButtons: [...config.customButtons, entry] }
}

export function setBinding(
  config: RemoteConfig,
  role: string,
  action: RemoteBindingAction,
  customName: string = humanRole(role),
): RemoteConfig {
  const next: RemoteConfig = {
    ...config,
    bindings: { ...config.bindings, [role]: { action } },
  }
  return withCustomEntry(next, role, customName)
}

export function clearBinding(config: RemoteConfig, role: string): RemoteConfig {
  const rest = Object.fromEntries(Object.entries(config.bindings).filter(([r]) => r !== role))
  const key = customKeyOfRole(role)
  return {
    ...config,
    bindings: rest,
    // A custom button nothing binds and no layout draws leaves with its binding.
    customButtons:
      key === null ? config.customButtons : config.customButtons.filter((b) => b.key !== key),
  }
}

/** An action the schema will accept: a device, a cap and a method. */
export function isCompleteAction(action: RemoteBindingAction): boolean {
  return action.deviceId > 0 && action.cap !== '' && action.method !== ''
}

export const BLANK_ACTION: RemoteBindingAction = { kind: 'cap', deviceId: 0, cap: '', method: '' }

/** The transmitter an infrared binding sends through, or null for any other action. */
export function transmitterOf(binding: RemoteBinding): number | null {
  const { action } = binding
  return action.cap === IR_CAP && action.method === IR_SEND ? action.deviceId : null
}

/** The same infrared binding sent through another transmitter — the per-command override. */
export function withTransmitter(binding: RemoteBinding, deviceId: number): RemoteBinding {
  return { action: { ...binding.action, deviceId } }
}

export interface SaveCheck {
  /** Roles whose binding is not finished (no device, cap or method). */
  readonly incomplete: readonly string[]
  /** The config to send, or null while a binding is unfinished or the schema refuses it. */
  readonly config: RemoteConfig | null
}

export function checkForSave(config: RemoteConfig): SaveCheck {
  const incomplete = Object.entries(config.bindings)
    .filter(([, binding]) => !isCompleteAction(binding.action))
    .map(([role]) => role)
  if (incomplete.length > 0) return { incomplete, config: null }
  const parsed = RemoteConfigSchema.safeParse(config)
  return { incomplete, config: parsed.success ? parsed.data : null }
}

export type SmartIrImport =
  | {
      readonly status: 'ok'
      readonly draft: SmartIrDraft
      /** How many roles the file fills. */
      readonly bound: number
      readonly skipped: readonly SmartIrSkipped[]
    }
  | { readonly status: 'refused'; readonly reason: 'no-transmitter' | 'not-json' | 'not-smartir' }

/** Parse a pasted or uploaded SmartIR file into a draft; nothing is stored. */
export function importSmartIr(text: string, transmitterDeviceId: number | null): SmartIrImport {
  if (transmitterDeviceId === null || transmitterDeviceId <= 0) {
    return { status: 'refused', reason: 'no-transmitter' }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { status: 'refused', reason: 'not-json' }
  }
  try {
    const parsed = parseSmartIr(document)
    const draft = smartIrDraft(parsed.table, { transmitterDeviceId })
    const skipped = [
      ...parsed.skipped.map((s): SmartIrSkipped => ({ name: s.name, reason: s.reason })),
      ...draft.skipped,
    ]
    return { status: 'ok', draft, bound: Object.keys(draft.bindings).length, skipped }
  } catch (err: unknown) {
    if (err instanceof IrCodecError) return { status: 'refused', reason: 'not-smartir' }
    throw err
  }
}

export type FlipperIrImport =
  | Extract<SmartIrImport, { status: 'ok' }>
  | { readonly status: 'refused'; readonly reason: 'no-transmitter' | 'not-flipper' }

/** Parse a Flipper-IRDB `.ir` file into a draft; nothing is stored. */
export function importFlipperIr(text: string, transmitterDeviceId: number | null): FlipperIrImport {
  if (transmitterDeviceId === null || transmitterDeviceId <= 0) {
    return { status: 'refused', reason: 'no-transmitter' }
  }
  try {
    const draft = flipperIrDraft(parseFlipperIr(text), { transmitterDeviceId })
    return {
      status: 'ok',
      draft,
      bound: Object.keys(draft.bindings).length,
      skipped: draft.skipped,
    }
  } catch (err: unknown) {
    if (err instanceof IrCodecError) return { status: 'refused', reason: 'not-flipper' }
    throw err
  }
}

/**
 * Fill the config with an import. A role the file fills takes the file's
 * binding; a role it does not fill keeps what it had. Custom buttons merge by
 * key.
 */
export function applyDraft(config: RemoteConfig, draft: SmartIrDraft): RemoteConfig {
  const known = new Set(config.customButtons.map((b) => b.key))
  return {
    ...config,
    bindings: { ...config.bindings, ...draft.bindings },
    customButtons: [
      ...config.customButtons,
      ...draft.customButtons.filter((b) => !known.has(b.key)),
    ],
  }
}

// ---------------------------------------------------------------------------
// Sources (planning#460): the list a media player's source picker offers. Every
// rule lives in `RemoteConfigSchema`; the editor never restates one — it builds
// the config the operator is asking for, parses the WHOLE config and shows the
// schema's own issues next to the field they name.
// ---------------------------------------------------------------------------

/** How an infrared code is held: signed microseconds, Pronto hex words, or a device-native code. */
export type IrCodeEncoding = 'raw' | 'pronto' | 'native'

/** What the add / edit dialog holds: every field of every kind, so a kind switch loses nothing. */
export interface SourceDraft {
  readonly kind: RemoteSourceKind
  readonly name: string
  /** The channel number, as typed (`digits`). */
  readonly number: string
  /** The roles pressed in order (`sequence`). */
  readonly steps: readonly string[]
  /** The transmitter the code goes through (`ir`); null = the remote's default emitter. */
  readonly transmitterId: number | null
  /** How `code` is written (`ir`). */
  readonly encoding: IrCodeEncoding
  /** The format of a device-native code (`ir`, native). */
  readonly nativeFormat: IrNativeFormat
  /** The code as typed (`ir`): marks and spaces in µs, Pronto hex words, or a native code. */
  readonly code: string
  /** The carrier in kHz as typed (`ir`, raw); empty leaves it to the transmitter. */
  readonly carrierKhz: string
}

export const BLANK_SOURCE_DRAFT: SourceDraft = {
  kind: 'digits',
  name: '',
  number: '',
  steps: [],
  transmitterId: null,
  encoding: 'raw',
  nativeFormat: 'tuya',
  code: '',
  carrierKhz: '',
}

export function draftOfSource(source: RemoteSource): SourceDraft {
  switch (source.kind) {
    case 'digits':
      return { ...BLANK_SOURCE_DRAFT, kind: 'digits', name: source.name, number: source.number }
    case 'sequence':
      return { ...BLANK_SOURCE_DRAFT, kind: 'sequence', name: source.name, steps: source.steps }
    case 'ir':
      return {
        ...BLANK_SOURCE_DRAFT,
        kind: 'ir',
        name: source.name,
        transmitterId: source.transmitterId ?? null,
        ...(source.payload.kind === 'pronto'
          ? { encoding: 'pronto', code: source.payload.code }
          : source.payload.kind === 'native'
            ? { encoding: 'native', nativeFormat: source.payload.format, code: source.payload.code }
            : {
                encoding: 'raw',
                code: source.payload.timings.join(', '),
                carrierKhz:
                  source.payload.settings?.carrierHz === undefined
                    ? ''
                    : String(source.payload.settings.carrierHz / 1000),
              }),
      }
  }
}

/**
 * The typed code as a payload. Nothing is judged here: a token that is not a
 * number, a mark where a space belongs or a carrier that is not a number all
 * reach the schema, which names the `payload` field.
 */
function irPayloadOf(draft: SourceDraft): IrPayload {
  if (draft.encoding === 'pronto') return { kind: 'pronto', code: draft.code.trim() }
  if (draft.encoding === 'native') {
    return { kind: 'native', format: draft.nativeFormat, code: draft.code.trim() }
  }
  const timings = draft.code
    .replace(/[[\]]/g, ' ')
    .split(/[\s,]+/)
    .filter((token) => token !== '')
    .map(Number)
  const carrier = draft.carrierKhz.trim()
  return carrier === ''
    ? { kind: 'raw', timings }
    : { kind: 'raw', timings, settings: { carrierHz: Math.round(Number(carrier) * 1000) } }
}

export interface IrSourceSummary {
  readonly encoding: IrCodeEncoding
  /** Pulses the code resolves to, or null when the transmitter could not send it. */
  readonly pulses: number | null
  readonly carrierKhz: number | null
}

/** What the sources list says of an infrared code, read from the code itself. */
export function irSourceSummary(source: RemoteIrSource): IrSourceSummary {
  const encoding: IrCodeEncoding = source.payload.kind
  try {
    const { timings, settings } = toTimings(source.payload)
    return {
      encoding,
      pulses: timings.length,
      carrierKhz: settings.carrierHz === undefined ? null : settings.carrierHz / 1000,
    }
  } catch (err: unknown) {
    if (err instanceof IrCodecError) return { encoding, pulses: null, carrierKhz: null }
    throw err
  }
}

/** The roles a sequence may press: the ones with a binding, never an unbound role. */
export function boundStepRoles(config: RemoteConfig): readonly string[] {
  return Object.keys(config.bindings)
}

const SOURCE_ID_MAX = 48

/** A lowercase slug of the name that no other source of the config already uses. */
export function newSourceId(config: RemoteConfig, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SOURCE_ID_MAX - 4)
    .replace(/-+$/g, '')
  const base = slug === '' ? 'source' : slug
  const taken = new Set(config.sources.map((s) => s.id))
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

function sourceOfDraft(draft: SourceDraft, id: string): RemoteSource {
  switch (draft.kind) {
    case 'digits':
      return { id, kind: 'digits', name: draft.name, number: draft.number }
    case 'sequence':
      return { id, kind: 'sequence', name: draft.name, steps: [...draft.steps] }
    case 'ir':
      return {
        id,
        kind: 'ir',
        name: draft.name,
        ...(draft.transmitterId === null ? {} : { transmitterId: draft.transmitterId }),
        payload: irPayloadOf(draft),
      }
  }
}

/**
 * The config with the draft added (`id` null: a new source at the end, its id a
 * slug of the name) or replacing the source with that id. An id never changes
 * on rename. The result is NOT validated; `draftIssues` and `checkForSave` do.
 */
export function upsertSource(
  config: RemoteConfig,
  draft: SourceDraft,
  id: string | null,
): RemoteConfig {
  if (id === null) {
    const added = sourceOfDraft(draft, newSourceId(config, draft.name))
    return { ...config, sources: [...config.sources, added] }
  }
  return {
    ...config,
    sources: config.sources.map((s) => (s.id === id ? sourceOfDraft(draft, id) : s)),
  }
}

export function deleteSource(config: RemoteConfig, id: string): RemoteConfig {
  return { ...config, sources: config.sources.filter((s) => s.id !== id) }
}

/** Move a source one place up (`-1`) or down (`1`); the ends stay put. */
export function moveSource(config: RemoteConfig, id: string, delta: -1 | 1): RemoteConfig {
  const from = config.sources.findIndex((s) => s.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= config.sources.length) return config
  const next = [...config.sources]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return config
  next.splice(to, 0, moved)
  return { ...config, sources: next }
}

export function setStepDelay(config: RemoteConfig, stepDelayMs: number): RemoteConfig {
  return { ...config, stepDelayMs }
}

export type SourceField = 'id' | 'name' | 'number' | 'steps' | 'kind' | 'transmitterId' | 'payload'

export interface SourceIssue {
  readonly field: SourceField
  /** The Zod issue code (`custom`, `too_small`, `invalid_format`, …). */
  readonly code: string
  /** The schema's own message; shown as is for a `custom` rule. */
  readonly message: string
}

export interface SourceIssues {
  /** Issues per source index. */
  readonly bySource: ReadonlyMap<number, readonly SourceIssue[]>
  /** An issue on `stepDelayMs`, or null. */
  readonly stepDelay: SourceIssue | null
}

const SOURCE_FIELDS: readonly SourceField[] = [
  'id',
  'name',
  'number',
  'steps',
  'kind',
  'transmitterId',
  'payload',
]

function isSourceField(value: unknown): value is SourceField {
  return SOURCE_FIELDS.some((f) => f === value)
}

/** Parse the whole config and keep the issues that name a source or the step delay. */
export function sourceIssues(config: RemoteConfig): SourceIssues {
  const parsed = RemoteConfigSchema.safeParse(config)
  const bySource = new Map<number, SourceIssue[]>()
  let stepDelay: SourceIssue | null = null
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, index, field] = issue.path
      if (head === 'stepDelayMs') {
        stepDelay = { field: 'kind', code: issue.code, message: issue.message }
      } else if (head === 'sources' && typeof index === 'number') {
        // A step issue deeper in the array (`steps`, 3) still belongs to `steps`.
        const named = isSourceField(field) ? field : 'kind'
        const list = bySource.get(index) ?? []
        list.push({ field: named, code: issue.code, message: issue.message })
        bySource.set(index, list)
      }
    }
  }
  return { bySource, stepDelay }
}

/** The issues the schema raises for the source this draft would add or replace. */
export function draftIssues(
  config: RemoteConfig,
  draft: SourceDraft,
  id: string | null,
): readonly SourceIssue[] {
  const next = upsertSource(config, draft, id)
  const index = id === null ? next.sources.length - 1 : next.sources.findIndex((s) => s.id === id)
  const schemaIssues = sourceIssues(next).bySource.get(index) ?? []
  // The schema accepts a source with no emitter (the default may arrive later); the
  // editor does not offer to save one that could not be sent today.
  if (draft.kind === 'ir' && draft.transmitterId === null && config.defaultTransmitterId === null) {
    return [
      ...schemaIssues,
      {
        field: 'transmitterId',
        code: 'no_emitter',
        message: 'Pick an emitter: the remote has no default one',
      },
    ]
  }
  return schemaIssues
}
