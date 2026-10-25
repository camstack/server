/**
 * The adapter registry (D869): the ONE list Discovery, ReportState,
 * ChangeReport, the reconcile, the directive router and the validator read.
 * Adding a cap to Alexa is adding its adapter here — in order: the first
 * adapter with a category decides the endpoint's display category.
 */
import type { AlexaCapability, AlexaDisplayCategory } from '../types.js'
import { climateAdapter } from './climate.js'
import { contactAdapter } from './contact.js'
import { coverAdapter } from './cover.js'
import { humidityAdapter } from './humidity.js'
import { lockAdapter } from './lock.js'
import { motionAdapter } from './motion.js'
import { presenceAdapter } from './presence.js'
import { BASE, HEALTH } from './shared.js'
import { switchAdapter } from './switch.js'
import { temperatureAdapter } from './temperature.js'
import type {
  AdapterDevice,
  AdapterDirectiveContext,
  AdapterDirective,
  GenericAdapter,
  GenericProperty,
  PropertyShaping,
} from './types.js'

export type {
  AdapterDevice,
  AdapterDirective,
  AdapterDirectiveContext,
  GenericAdapter,
  GenericProperty,
  PropertyShaping,
}

export const GENERIC_ADAPTERS: readonly GenericAdapter[] = [
  lockAdapter,
  contactAdapter,
  motionAdapter,
  presenceAdapter,
  // Before temperature and switch: a thermostat is a THERMOSTAT (not a bare
  // sensor), and its PowerController directives are tried before the switch's.
  climateAdapter,
  temperatureAdapter,
  humidityAdapter,
  switchAdapter,
  coverAdapter,
]

/** The caps a generic endpoint reads, in the order ReportState asks them. */
export const GENERIC_STATE_CAPS: readonly string[] = [
  ...new Set(GENERIC_ADAPTERS.flatMap((a) => a.stateCaps)),
]

/** The adapter whose properties a state cap feeds. */
export function adapterForStateCap(capName: string): GenericAdapter | undefined {
  return GENERIC_ADAPTERS.find((a) => a.stateCaps.includes(capName))
}

/** The Alexa properties one cap slice sets ([] = unknown cap or unusable slice). */
export function genericPropertiesFor(capName: string, slice: unknown): readonly GenericProperty[] {
  return adapterForStateCap(capName)?.properties(capName, slice) ?? []
}

/** The shaping one property of a state cap is reported under, or null. */
export function shapingFor(capName: string, property: GenericProperty): PropertyShaping | null {
  return adapterForStateCap(capName)?.shaping(property) ?? null
}

/** The caps whose slice discovery must read to shape this device. */
export function discoveryReadCaps(capNames: readonly string[]): readonly string[] {
  return [
    ...new Set(
      GENERIC_ADAPTERS.filter((a) => capNames.includes(a.cap)).flatMap((a) => a.discoveryReads),
    ),
  ]
}

/** Every directive an adapter declares for `Namespace/Name`, in registry order. */
export function genericDirectives(key: string): readonly AdapterDirective[] {
  return GENERIC_ADAPTERS.flatMap((a) => a.directives.filter((d) => d.key === key))
}

/** A directive an adapter handles on a generic endpoint, by `Namespace/Name`
 *  (the first declared; use `genericDirectives` where two caps share a key). */
export function genericDirective(key: string): AdapterDirective | undefined {
  return genericDirectives(key)[0]
}

/**
 * The directive that serves this endpoint: of the adapters declaring the key,
 * in registry order, the first that claims it (two caps may answer one key -
 * power on a switch and on a thermostat). Null = nobody claims it.
 */
export async function resolveGenericDirective(
  context: AdapterDirectiveContext,
): Promise<AdapterDirective | null> {
  const key = `${context.header.namespace}/${context.header.name}`
  for (const directive of genericDirectives(key)) {
    if (directive.claims === undefined || (await directive.claims(context))) return directive
  }
  return null
}

/** Every directive key the registry handles. */
export const GENERIC_DIRECTIVE_KEYS: readonly string[] = [
  ...new Set(GENERIC_ADAPTERS.flatMap((a) => a.directives.map((d) => d.key))),
]

/** The directive keys that need the device online. */
export const GENERIC_REACHABLE_DIRECTIVE_KEYS: readonly string[] = [
  ...new Set(
    GENERIC_ADAPTERS.flatMap((a) =>
      a.directives.filter((d) => d.needsReachableDevice).map((d) => d.key),
    ),
  ),
]

export type GenericPlan =
  | {
      readonly kind: 'publish'
      readonly capabilities: readonly AlexaCapability[]
      readonly category: AlexaDisplayCategory
    }
  /** The device has caps Alexa could carry, but they are deliberately withheld. */
  | { readonly kind: 'skip'; readonly reasons: readonly string[] }
  /** None of the device's caps has an adapter. */
  | { readonly kind: 'none' }

function capabilityKey(c: AlexaCapability): string {
  return c.instance === undefined ? c.interface : `${c.interface}#${c.instance}`
}

/** What a device becomes, folding every applicable adapter in registry order. */
export function planGenericDevice(device: AdapterDevice): GenericPlan {
  const capabilities: AlexaCapability[] = [BASE]
  const seen = new Set<string>()
  const reasons: string[] = []
  let category: AlexaDisplayCategory | null = null
  for (const adapter of GENERIC_ADAPTERS) {
    if (!device.capNames.includes(adapter.cap)) continue
    const description = adapter.describe(device)
    if (description === null) continue
    if (description.kind === 'skip') {
      reasons.push(description.reason)
      continue
    }
    for (const capability of description.capabilities) {
      // `motion` and `presence` both map to MotionSensor: one declaration.
      const key = capabilityKey(capability)
      if (seen.has(key)) continue
      seen.add(key)
      capabilities.push(capability)
    }
    category ??= description.category
  }
  if (category === null) return reasons.length > 0 ? { kind: 'skip', reasons } : { kind: 'none' }
  capabilities.push(HEALTH)
  return { kind: 'publish', capabilities, category }
}
