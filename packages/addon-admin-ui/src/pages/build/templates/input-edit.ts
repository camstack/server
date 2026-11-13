/**
 * Edits of one declared input (#527), kind by kind: a label, required or
 * optional, bounds, a default, the options of a select, the filter of a device
 * input, the device an event or action reads. An empty value removes the field,
 * so the saved input never carries a blank bound the schema would refuse.
 */
import type { TemplateInput } from '@camstack/types'

type Scalar = Exclude<TemplateInput, { kind: 'group' }>

export interface InputPatch {
  readonly label?: string
  readonly optional?: boolean
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly default?: number | string | boolean | undefined
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly capability?: string
  readonly role?: string
  readonly deviceInput?: string
}

const has = (patch: InputPatch, key: keyof InputPatch): boolean => key in patch

function withOptional(input: Scalar, patch: InputPatch): { readonly optional?: true } {
  if (!has(patch, 'optional')) return input.optional === true ? { optional: true } : {}
  return patch.optional === true ? { optional: true } : {}
}

function pick<T>(
  patch: InputPatch,
  key: keyof InputPatch,
  current: T | undefined,
  narrow: (v: unknown) => T | undefined,
): T | undefined {
  return has(patch, key) ? narrow(patch[key]) : current
}

const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined
const asBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

export function patchInput(input: Scalar, patch: InputPatch): TemplateInput {
  const label = patch.label ?? input.label
  const base = { key: input.key, label, ...withOptional(input, patch) }
  const description = input.description === undefined ? {} : { description: input.description }
  switch (input.kind) {
    case 'number':
    case 'duration': {
      const min = pick(patch, 'min', input.min, asNumber)
      const max = pick(patch, 'max', input.max, asNumber)
      const def = pick(patch, 'default', input.default, asNumber)
      return {
        kind: input.kind,
        ...base,
        ...description,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(def === undefined ? {} : { default: def }),
      }
    }
    case 'text': {
      const def = pick(patch, 'default', input.default, asString)
      return {
        kind: 'text',
        ...base,
        ...description,
        ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
        ...(def === undefined ? {} : { default: def }),
      }
    }
    case 'boolean': {
      const def = pick(patch, 'default', input.default, asBoolean)
      return {
        kind: 'boolean',
        ...base,
        ...description,
        ...(def === undefined ? {} : { default: def }),
      }
    }
    case 'select': {
      const options =
        patch.options === undefined || patch.options.length === 0
          ? input.options
          : [...patch.options]
      const def = pick(patch, 'default', input.default, asString)
      return {
        kind: 'select',
        ...base,
        ...description,
        options,
        ...(def === undefined ? {} : { default: def }),
      }
    }
    case 'device': {
      const capability = has(patch, 'capability')
        ? asString(patch.capability)
        : input.filter?.capability
      const role = has(patch, 'role') ? asString(patch.role) : input.filter?.role
      const filter = {
        ...(capability === undefined ? {} : { capability }),
        ...(role === undefined ? {} : { role }),
      }
      return {
        kind: 'device',
        ...base,
        ...description,
        ...(input.multiple === true ? { multiple: true as const } : {}),
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      }
    }
    case 'event':
      return {
        kind: 'event',
        ...base,
        ...description,
        deviceInput: patch.deviceInput ?? input.deviceInput,
      }
    case 'action': {
      const deviceInput = has(patch, 'deviceInput')
        ? asString(patch.deviceInput)
        : input.deviceInput
      return {
        kind: 'action',
        ...base,
        ...description,
        ...(deviceInput === undefined ? {} : { deviceInput }),
      }
    }
  }
}

/** `value = label` per line. */
export function optionsToText(
  options: readonly { readonly value: string; readonly label: string }[],
): string {
  return options.map((o) => `${o.value} = ${o.label}`).join('\n')
}

export function optionsFromText(
  text: string,
): readonly { readonly value: string; readonly label: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.indexOf('=')
      const value = (at < 0 ? line : line.slice(0, at)).trim()
      const label = (at < 0 ? line : line.slice(at + 1)).trim()
      return { value, label: label === '' ? value : label }
    })
    .filter((o) => o.value !== '')
}
