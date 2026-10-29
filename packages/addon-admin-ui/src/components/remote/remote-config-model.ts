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
  IrCodecError,
  parseSmartIr,
  type RemoteBinding,
  type RemoteBindingAction,
  type RemoteConfig,
  RemoteConfigSchema,
  type RemoteCustomButton,
  type RemoteLayoutPayload,
  smartIrDraft,
  type SmartIrDraft,
  type SmartIrSkipped,
} from '@camstack/types'
import { humanRole } from './layout-model'

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
    if (seen.has(role)) return
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

/**
 * Fill the config with an import. A role the file fills takes the file's
 * binding; a role it does not fill keeps what it had. Custom buttons merge by
 * key, and the file's power mode replaces the current one.
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
    power: { mode: draft.power.mode },
  }
}
