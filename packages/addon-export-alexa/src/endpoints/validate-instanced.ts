/**
 * Amazon's rules for the INSTANCED interfaces' extra fields (D869), the ones a
 * Range / Mode controller declares beyond the basics `validate-endpoint.ts`
 * already checks: `capabilityResources` names, `configuration`, `semantics`.
 *
 * Sources: developer.amazon.com device-apis: alexa-rangecontroller,
 * alexa-modecontroller, alexa-discovery-objects (capabilityResources,
 * semantics), the Alexa global-assets list (`Alexa.Setting.*`, `Alexa.Value.*`,
 * `Alexa.Unit.*`). A violation here makes Alexa reject the endpoint (and with
 * it every sibling in the same report), so the validator withholds it.
 */
import { z } from 'zod'
import type { AlexaCapability } from './types.js'

/** A global asset id: Alexa localizes it into the account's language. */
const ASSET_ID_PATTERN = /^Alexa\.(Setting|Value|DeviceName)\.[A-Za-z0-9]+$/
const LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/
const UNIT_PATTERN = /^Alexa\.Unit\.[A-Za-z0-9.]+$/
const MAX_TEXT_NAME = 64

/** Semantic actions this skill may map. */
const SEMANTIC_ACTIONS = new Set([
  'Alexa.Actions.Open',
  'Alexa.Actions.Close',
  'Alexa.Actions.Raise',
  'Alexa.Actions.Lower',
])
/** Semantic states this skill may map. */
const SEMANTIC_STATES = new Set(['Alexa.States.Open', 'Alexa.States.Closed'])

const RANGE_DIRECTIVES = new Set(['SetRangeValue', 'AdjustRangeValue'])
const MODE_DIRECTIVES = new Set(['SetMode', 'AdjustMode'])

type Push = (rule: string) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const FriendlyNamesSchema = z
  .array(
    z.discriminatedUnion('@type', [
      z.object({ '@type': z.literal('asset'), value: z.object({ assetId: z.string() }) }),
      z.object({
        '@type': z.literal('text'),
        value: z.object({ text: z.string(), locale: z.string() }),
      }),
    ]),
  )
  .min(1)

/** `capabilityResources` / `modeResources` friendly names: assets or texts. */
export function validateFriendlyNames(names: unknown, label: string, push: Push): void {
  const parsed = FriendlyNamesSchema.safeParse(names)
  if (!parsed.success) {
    push(`${label}.friendlyNames is required: a list of asset / text names`)
    return
  }
  for (const name of parsed.data) {
    if (name['@type'] === 'asset') {
      if (!ASSET_ID_PATTERN.test(name.value.assetId)) {
        push(`${label}: assetId ${name.value.assetId} is not an Alexa global asset`)
      }
      continue
    }
    if (name.value.text.trim().length === 0 || name.value.text.length > MAX_TEXT_NAME) {
      push(`${label}: a text friendly name must be 1-${MAX_TEXT_NAME} characters`)
    }
    if (!LOCALE_PATTERN.test(name.value.locale)) {
      push(`${label}: locale ${name.value.locale} is not a language-COUNTRY code`)
    }
  }
}

function supportedRange(c: AlexaCapability): { min: number; max: number } | null {
  const range = c.configuration?.['supportedRange']
  if (!isRecord(range)) return null
  const min = num(range['minimumValue'])
  const max = num(range['maximumValue'])
  const precision = num(range['precision'])
  if (min === null || max === null || precision === null) return null
  if (min >= max || precision <= 0) return null
  return { min, max }
}

function validateActionMappings(
  c: AlexaCapability,
  mappings: unknown,
  allowedDirectives: ReadonlySet<string>,
  push: Push,
  validMode: (mode: unknown) => boolean,
): void {
  if (!Array.isArray(mappings)) {
    push('semantics.actionMappings must be a list')
    return
  }
  const mapped = new Set<string>()
  for (const entry of mappings) {
    if (!isRecord(entry) || entry['@type'] !== 'ActionsToDirective') {
      push('semantics.actionMappings entry must be an ActionsToDirective')
      continue
    }
    const actions = entry['actions']
    if (!Array.isArray(actions) || actions.length === 0) {
      push('semantics.actionMappings entry needs at least one action')
    } else {
      for (const action of actions) {
        if (typeof action !== 'string' || !SEMANTIC_ACTIONS.has(action)) {
          push(`semantics action ${String(action)} is not a documented Alexa action`)
        } else if (mapped.has(action)) {
          push(`semantics action ${action} is mapped twice`)
        } else {
          mapped.add(action)
        }
      }
    }
    const directive = entry['directive']
    const name = isRecord(directive) ? directive['name'] : undefined
    const payload = isRecord(directive) ? directive['payload'] : undefined
    if (typeof name !== 'string' || !allowedDirectives.has(name) || !isRecord(payload)) {
      push(`semantics directive ${String(name)} is not valid for ${c.interface}`)
      continue
    }
    if (name === 'SetRangeValue') {
      const range = supportedRange(c)
      const value = num(payload['rangeValue'])
      if (value === null || (range !== null && (value < range.min || value > range.max))) {
        push('semantics SetRangeValue rangeValue must be inside supportedRange')
      }
    }
    if (name === 'AdjustRangeValue') {
      if (num(payload['rangeValueDelta']) === null) {
        push('semantics AdjustRangeValue needs a numeric rangeValueDelta')
      }
      if (typeof payload['rangeValueDeltaDefault'] !== 'boolean') {
        push('semantics AdjustRangeValue needs a boolean rangeValueDeltaDefault')
      }
    }
    if (name === 'SetMode' && !validMode(payload['mode'])) {
      push('semantics SetMode mode must be one of supportedModes')
    }
  }
}

function validateStateMappings(
  c: AlexaCapability,
  mappings: unknown,
  push: Push,
  validMode: (mode: unknown) => boolean,
): void {
  if (!Array.isArray(mappings)) {
    push('semantics.stateMappings must be a list')
    return
  }
  const range = supportedRange(c)
  for (const entry of mappings) {
    if (!isRecord(entry)) {
      push('semantics.stateMappings entry must be an object')
      continue
    }
    const states = entry['states']
    if (!Array.isArray(states) || states.length === 0) {
      push('semantics.stateMappings entry needs at least one state')
    } else {
      for (const state of states) {
        if (typeof state !== 'string' || !SEMANTIC_STATES.has(state)) {
          push(`semantics state ${String(state)} is not a documented Alexa state`)
        }
      }
    }
    if (entry['@type'] === 'StatesToValue') {
      const value = entry['value']
      const ok =
        c.interface === 'Alexa.ModeController'
          ? validMode(value)
          : range !== null && typeof value === 'number' && value >= range.min && value <= range.max
      if (!ok) push('semantics StatesToValue value is outside the declared range / modes')
    } else if (entry['@type'] === 'StatesToRange') {
      const r = entry['range']
      const lo = isRecord(r) ? num(r['minimumValue']) : null
      const hi = isRecord(r) ? num(r['maximumValue']) : null
      if (
        c.interface !== 'Alexa.RangeController' ||
        lo === null ||
        hi === null ||
        lo > hi ||
        (range !== null && (lo < range.min || hi > range.max))
      ) {
        push('semantics StatesToRange range must sit inside supportedRange')
      }
    } else {
      push('semantics.stateMappings entry must be StatesToValue or StatesToRange')
    }
  }
}

/** `capabilityResources` + (range or mode) specifics + semantics. */
export function validateInstanced(c: AlexaCapability, push: Push): void {
  const isRange = c.interface === 'Alexa.RangeController'
  const isMode = c.interface === 'Alexa.ModeController'
  if (!isRange && !isMode) return
  validateFriendlyNames(c.capabilityResources?.friendlyNames, 'capabilityResources', push)

  const expected = isRange ? 'rangeValue' : 'mode'
  const supported = c.properties?.supported ?? []
  if (supported.length !== 1 || supported[0]?.name !== expected) {
    push(`properties.supported must be exactly [${expected}]`)
  }

  let modeValues: ReadonlySet<string> = new Set()
  if (isRange) {
    if (supportedRange(c) === null) {
      push(
        'configuration.supportedRange needs numeric minimumValue < maximumValue and precision > 0',
      )
    }
    const unit = c.configuration?.['unitOfMeasure']
    if (unit !== undefined && (typeof unit !== 'string' || !UNIT_PATTERN.test(unit))) {
      push('configuration.unitOfMeasure must be an Alexa.Unit.* value')
    }
  } else {
    if (typeof c.configuration?.['ordered'] !== 'boolean') {
      push('configuration.ordered must be a boolean')
    }
    const modes = c.configuration?.['supportedModes']
    if (Array.isArray(modes)) {
      const values: string[] = []
      for (const mode of modes) {
        if (!isRecord(mode)) continue
        values.push(String(mode['value']))
        const resources = mode['modeResources']
        const names = isRecord(resources) ? resources['friendlyNames'] : undefined
        validateFriendlyNames(names, `mode ${String(mode['value'])} modeResources`, push)
      }
      modeValues = new Set(values)
    }
  }

  if (c.semantics === undefined) return
  const validMode = (mode: unknown): boolean => typeof mode === 'string' && modeValues.has(mode)
  if (c.semantics.actionMappings !== undefined) {
    validateActionMappings(
      c,
      c.semantics.actionMappings,
      isRange ? RANGE_DIRECTIVES : MODE_DIRECTIVES,
      push,
      validMode,
    )
  }
  if (c.semantics.stateMappings !== undefined) {
    validateStateMappings(c, c.semantics.stateMappings, push, validMode)
  }
}
