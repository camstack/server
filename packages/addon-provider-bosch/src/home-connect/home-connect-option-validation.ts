import type { HomeConnectDescriptionStore } from './home-connect-description-store.js'

export type WritableValue = string | number | boolean

/** A step grid tolerance: `0.1 + 0.2`-style float noise must not reject a valid step. */
const STEP_EPSILON = 1e-9

/**
 * Check a write against what the appliance's own description allows, and answer
 * the feature key to write. Throws an error that says WHY — a value the appliance
 * would refuse (or worse, clamp) never leaves this process unexplained.
 *
 * The description is the authority: the entity must be listed, a setting or option,
 * writable, available now, and the value inside its declared range / on its step /
 * among its members.
 */
export function assertWritable(
  description: HomeConnectDescriptionStore | null,
  key: string,
  value: WritableValue,
): string {
  if (description === null || description.state === 'missing') {
    throw new Error(`Cannot set ${key}: the appliance description is not loaded`)
  }
  const entity = description.entityByName(key)
  if (entity === undefined) throw new Error(`${key} is not in this appliance's description`)
  if (entity.kind !== 'option' && entity.kind !== 'setting') {
    throw new Error(`${key} is a ${entity.kind}, not a setting or option`)
  }
  if (entity.access !== 'readWrite' && entity.access !== 'writeOnly') {
    throw new Error(`${key} is not writable (access: ${entity.access ?? 'unknown'})`)
  }
  if (entity.available === false) throw new Error(`${key} is not available right now`)
  if (entity.enumeration !== undefined) {
    const members = Object.values(entity.enumeration)
    if (typeof value !== 'string' || !members.includes(value)) {
      throw new Error(`${key} accepts ${members.join(' | ')}, not ${String(value)}`)
    }
    return key
  }
  if (typeof value === 'number') {
    assertNumberInRange(key, value, entity.min, entity.max, entity.stepSize)
  } else if (entity.valueType === 'number') {
    throw new Error(`${key} takes a number, not ${typeof value}`)
  } else if (entity.valueType === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${key} takes true or false, not ${typeof value}`)
  }
  return key
}

function assertNumberInRange(
  key: string,
  value: number,
  min: number | undefined,
  max: number | undefined,
  step: number | undefined,
): void {
  if (!Number.isFinite(value)) throw new Error(`${key} needs a finite number`)
  if (min !== undefined && value < min) throw new Error(`${key} must be at least ${min}`)
  if (max !== undefined && value > max) throw new Error(`${key} must be at most ${max}`)
  if (step !== undefined && step > 0) {
    const origin = min ?? 0
    const steps = (value - origin) / step
    if (Math.abs(steps - Math.round(steps)) > STEP_EPSILON) {
      throw new Error(
        `${key} must be a multiple of ${step}${origin !== 0 ? ` from ${origin}` : ''}`,
      )
    }
  }
}

/** The program must be listed and currently offered. */
export function assertProgramAvailable(
  description: HomeConnectDescriptionStore | null,
  program: string,
): void {
  if (description === null || description.state === 'missing') {
    throw new Error('Cannot pick a program: the appliance description is not loaded')
  }
  const listed = description.programs().some((p) => p.uid === program)
  if (!listed) throw new Error(`${program} is not a program of this appliance`)
  if (description.entityByName(program)?.available === false) {
    throw new Error(`${program} is not available right now`)
  }
}

/**
 * A program started with options: each must be one the program lists, offered in
 * that program (not marked unavailable there), and valid as a write.
 */
export function assertProgramOptions(
  description: HomeConnectDescriptionStore | null,
  program: string,
  options: Readonly<Record<string, WritableValue>>,
): void {
  const entries = Object.entries(options)
  if (entries.length === 0) return
  const listed = description?.programs().find((p) => p.uid === program)?.options ?? []
  for (const [key, value] of entries) {
    const ref = listed.find((o) => o.key === key)
    if (ref === undefined) throw new Error(`${key} is not an option of ${program}`)
    if (ref.available === false || ref.access === 'read' || ref.access === 'readStatic') {
      throw new Error(`${key} cannot be set for ${program}`)
    }
    assertWritable(description, key, value)
  }
}
