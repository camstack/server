/**
 * The fault leaves: a device's WHOLE fault list, not only its principal code.
 *
 * `error` publishes `{ active, code, faults[] }`; the principal is the first of
 * `faults`, and a provider that raises several faults at once would be missed
 * by a comparison on `code` alone. A fault leaf reads the list and, when a
 * provider publishes no list, falls back to the principal `code`.
 *
 * Two leaves share one shape: `device-fault-raised` is an EVENT (a matching
 * fault BECOMES active, once per appearance) and `device-fault-is` is a STATE
 * (a matching fault is active now). An empty `codes` list means any fault.
 *
 * A reading is UNKNOWN (`undefined`) whenever the provider has not said whether
 * a fault is active (`active` not a boolean) or the read failed: unknown never
 * matches and never fires, and an unknown reading changes nothing (D49, D315).
 */
import { z } from 'zod'

/** The part of a fault leaf both kinds share. */
export const FAULT_LEAF_CODES_MAX = 64

export const FaultCodesSchema = z.array(z.string().min(1)).max(FAULT_LEAF_CODES_MAX)

/** What a device reports as faulty right now. */
export interface FaultReading {
  readonly active: boolean
  /** Every active fault's code; empty when none, or when the provider names none. */
  readonly codes: readonly string[]
}

function codeOf(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const code: unknown = Reflect.get(entry, 'code')
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * The fault reading off the three `error` fields. `undefined` is UNKNOWN:
 * `active` is `null`/absent (nothing read yet), which must never look like "no
 * fault".
 */
export function readFault(
  active: unknown,
  code: unknown,
  faults: unknown,
): FaultReading | undefined {
  if (typeof active !== 'boolean') return undefined
  if (!active) return { active: false, codes: [] }
  if (Array.isArray(faults)) {
    const codes: string[] = []
    for (const entry of faults) {
      const c = codeOf(entry)
      if (c !== undefined) codes.push(c)
    }
    return { active: true, codes }
  }
  return { active: true, codes: typeof code === 'string' && code.length > 0 ? [code] : [] }
}

/** The active codes the leaf wants (all of them when it wants any). */
export function matchedFaultCodes(
  reading: FaultReading,
  wanted: readonly string[],
): readonly string[] {
  if (!reading.active) return []
  return wanted.length === 0 ? reading.codes : reading.codes.filter((c) => wanted.includes(c))
}

/** Is a fault the leaf wants active? "Any fault" is satisfied by an active fault that names no code too. */
export function faultMatches(reading: FaultReading, wanted: readonly string[]): boolean {
  if (!reading.active) return false
  return wanted.length === 0 || matchedFaultCodes(reading, wanted).length > 0
}

/** "any fault" / `fault "a" or "b"`, for traces and logs. */
export function describeWantedFaults(wanted: readonly string[]): string {
  return wanted.length === 0 ? 'any fault' : `fault ${wanted.map((c) => `"${c}"`).join(' or ')}`
}

/** One appearance of a wanted fault. */
export interface FaultRaise {
  /** The first newly raised wanted code (`''` for an "any fault" that names none). */
  readonly code: string
  readonly codes: readonly string[]
}

/**
 * Fires ONCE when a wanted fault appears. The first good reading only seeds
 * what is already raised (a restart is not a transition); an unknown reading
 * changes nothing; a fault that stays raised never fires again, and one that
 * clears and returns fires again.
 */
export class FaultRaisedWatch {
  private seen: ReadonlySet<string> | undefined
  private anyUnnamed: boolean | undefined

  constructor(private readonly wanted: readonly string[]) {}

  observe(reading: FaultReading | undefined): FaultRaise | undefined {
    if (reading === undefined) return undefined
    const now = new Set(matchedFaultCodes(reading, this.wanted))
    const unnamed = this.wanted.length === 0 && reading.active && reading.codes.length === 0
    const before = this.seen
    const unnamedBefore = this.anyUnnamed
    this.seen = now
    this.anyUnnamed = unnamed
    if (before === undefined) return undefined
    const fresh = [...now].filter((c) => !before.has(c))
    if (fresh.length > 0) return { code: fresh[0] ?? '', codes: fresh }
    if (unnamed && unnamedBefore !== true) return { code: '', codes: [] }
    return undefined
  }
}
