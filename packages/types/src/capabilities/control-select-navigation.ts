/**
 * Generic stepping math for a `control` cap of `kind: 'select'` — `next` /
 * `previous` / `first` / `last`, computed ONCE here on top of the option
 * list + the current value, so every select provider (HA, Dreame, Tuya, …)
 * shares the same semantics instead of re-deriving it in its own device
 * class (issue #544).
 *
 * Pure (`resolveSelectStep`): no I/O, no device calls — trivially testable
 * and the single source of truth the discriminating specs pin. The provider
 * wiring (`selectNavigationMethods`) layers it on top of the TWO methods
 * every `control` provider already has (`getStatus`, `setValue`), so a
 * select-kind provider adds one spread instead of its own copy of the math.
 */
import type { ControlStatus } from './control.cap.js'
import type { controlCapability } from './control.cap.js'
import type { InferNativeProvider } from './capability-definition.js'

export type SelectStepDirection = 'next' | 'previous' | 'first' | 'last'

/**
 * Resolve the option a step lands on, given the select's current option
 * list and value.
 *
 * - `first` / `last` ignore `current` entirely — they only need a non-empty
 *   option list.
 * - `next` / `previous` walk from `current`'s index. Past either end:
 *   `cycle: true` wraps to the other end (HA `select_next` / `select_previous`
 *   default); `cycle: false` STOPS — returns `null`, a no-op the caller must
 *   not mistake for an error.
 *
 * Throws when the list is empty (nothing to select) or — for `next` /
 * `previous` only — when `current` is not one of `options` (there is no
 * index to step from; `first` / `last` never throw this one).
 */
export function resolveSelectStep(
  options: readonly string[],
  current: string,
  direction: SelectStepDirection,
  cycle: boolean,
): string | null {
  if (options.length === 0) {
    throw new Error('control: cannot step a select with no options')
  }
  if (direction === 'first') return options[0] ?? null
  if (direction === 'last') return options[options.length - 1] ?? null
  const index = options.indexOf(current)
  if (index === -1) {
    throw new Error(`control: current value "${current}" is not one of the select's options`)
  }
  const raw = index + (direction === 'next' ? 1 : -1)
  if (raw >= 0 && raw < options.length) return options[raw] ?? null
  if (!cycle) return null
  return options[((raw % options.length) + options.length) % options.length] ?? null
}

/**
 * The four native methods {@link selectNavigationMethods} answers — `Required`
 * because the cap declares them `providerOptional` (so a non-select control
 * can omit them), but this helper always returns every one.
 */
type SelectNavigationNativeMethods = Required<
  Pick<InferNativeProvider<typeof controlCapability>, 'next' | 'previous' | 'first' | 'last'>
>

/**
 * The generic `next` / `previous` / `first` / `last` native-provider
 * implementation. A select-kind `control` provider calls this with its OWN
 * `getStatus` / `setValue` (every provider already has both) instead of
 * re-implementing the stepping math:
 *
 * ```ts
 * const provider: InferNativeProvider<typeof controlCapability> = {
 *   getStatus,
 *   setValue,
 *   ...selectNavigationMethods(getStatus, (value) => setValue({ control: { kind: 'select', value } })),
 * }
 * ```
 *
 * Throws when `getStatus` answers a non-`select` slice — that is a provider
 * wiring mistake (only select-kind providers should spread this in), never a
 * runtime condition a script should handle.
 */
export function selectNavigationMethods(
  getStatus: () => Promise<ControlStatus>,
  setValue: (value: string) => Promise<void>,
): SelectNavigationNativeMethods {
  const step = async (direction: SelectStepDirection, cycle: boolean): Promise<void> => {
    const status = await getStatus()
    // `ControlStatus` is a flat object, not a TS discriminated union — the
    // `typeof` check (not just `kind`) is what narrows `value` to `string`,
    // same idiom as `hero-contributions-sensors.ts`.
    if (status.kind !== 'select' || typeof status.value !== 'string') {
      throw new Error(`control.${direction}: not a select control (kind=${status.kind})`)
    }
    const target = resolveSelectStep(status.options, status.value, direction, cycle)
    if (target === null) return
    await setValue(target)
  }
  return {
    next: ({ cycle }) => step('next', cycle),
    previous: ({ cycle }) => step('previous', cycle),
    first: () => step('first', true),
    last: () => step('last', true),
  }
}
