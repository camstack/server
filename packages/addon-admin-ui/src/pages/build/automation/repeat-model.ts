/**
 * The pure edits of a `repeat` step: which form its loop takes, and the
 * numbers that bound it. Every form the editor produces is already bounded.
 */
import {
  type AutomationRepeatLoop,
  type AutomationRepeatStep,
  type AutomationWhen,
  REPEAT_COUNT_MAX,
  REPEAT_ITERATIONS_MAX,
  WAIT_MAX_SECONDS,
} from '@camstack/types'

export type LoopBy = AutomationRepeatLoop['by']

export const LOOP_FORMS: readonly LoopBy[] = ['count', 'while', 'until', 'forEach']

const DEFAULT_COUNT = 2
const DEFAULT_MAX_ITERATIONS = 10
const EMPTY_TREE: AutomationWhen = { kind: 'all', children: [] }

export function isLoopBy(text: string): text is LoopBy {
  return text === 'count' || text === 'while' || text === 'until' || text === 'forEach'
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(max, Math.max(1, Math.round(value)))
}

export function clampCount(value: number): number {
  return clamp(value, REPEAT_COUNT_MAX)
}

export function clampIterations(value: number): number {
  return clamp(value, REPEAT_ITERATIONS_MAX)
}

/** A fresh loop of one form. A loop on a condition starts with its maximum set. */
export function loopFor(by: LoopBy): AutomationRepeatLoop {
  switch (by) {
    case 'count':
      return { by, count: DEFAULT_COUNT }
    case 'while':
    case 'until':
      return { by, when: EMPTY_TREE, maxIterations: DEFAULT_MAX_ITERATIONS }
    case 'forEach':
      return { by, target: { kind: 'devices', ids: [] } }
  }
}

/** The pause between two iterations of a loop on a condition; `null` removes it. */
export function setLoopWait(
  loop: AutomationRepeatLoop,
  seconds: number | null,
): AutomationRepeatLoop {
  if (loop.by !== 'while' && loop.by !== 'until') return loop
  const { waitS: _waitS, ...rest } = loop
  return seconds === null ? rest : { ...rest, waitS: clamp(seconds, WAIT_MAX_SECONDS) }
}

export function newRepeat(): AutomationRepeatStep {
  return { kind: 'repeat', loop: loopFor('count'), steps: [] }
}
