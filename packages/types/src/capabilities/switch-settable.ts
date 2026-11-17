/**
 * Whether a switch can be set (D1058), schema-free so the addon runner can import it from
 * `@camstack/types/addon` without loading the capability schema graph (D28).
 */
/** The read that decides whether a switch is offered on/off (`offeredWhen` of its actions). */
export const SWITCH_SETTABLE_GATE = { method: 'getOptions', field: 'supportsSetState' } as const

/**
 * The predicate the on/off surfaces apply to a raw answer: true only when `answer` — what the switch's
 * `getOptions` returned — says `supportsSetState: false`. `undefined` (no provider method, a
 * failed or pending read) and any other shape are false: unknown keeps on/off (D315).
 */
export function switchRefusesSetState(answer: unknown): boolean {
  if (typeof answer !== 'object' || answer === null) return false
  return Reflect.get(answer, SWITCH_SETTABLE_GATE.field) === false
}
