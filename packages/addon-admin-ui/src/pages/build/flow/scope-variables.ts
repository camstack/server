/**
 * The variables a step can name, by where the run came from.
 *
 * An action's variables are the ones it declares. An automation's are the ones
 * the event rows of its `when` tree put in the run's bag — `DetectionVars` and `StationaryVars` in
 * `@camstack/types`. The runtime does not export that list as data, so the
 * names are repeated here, one place; an event whose vars are not listed
 * offers none (the "{x}" button stays hidden rather than guess).
 */

import {
  type ActionVariable,
  type AutomationEventLeaf,
  type AutomationWhen,
  forEachLeaf,
  isEventLeaf,
} from '@camstack/types'
import type { TFunction } from 'i18next'
import type { ScopeVariable } from './ArgField'

export function actionScopeVariables(
  variables: readonly ActionVariable[],
  t: TFunction,
): readonly ScopeVariable[] {
  return variables.map((v) => ({
    name: v.name,
    hint: v.label ?? t(`flow.scope.type_${v.type}`, v.type),
  }))
}

function detectionVars(t: TFunction): readonly ScopeVariable[] {
  return [
    { name: 'deviceId', hint: t('flow.scope.deviceId', 'the camera that saw it') },
    { name: 'className', hint: t('flow.scope.className', 'what it saw') },
    { name: 'trackId', hint: t('flow.scope.trackId', 'the track') },
    { name: 'score', hint: t('flow.scope.score', 'how sure the detector was') },
  ]
}

function stationaryVars(t: TFunction): readonly ScopeVariable[] {
  return [
    { name: 'deviceId', hint: t('flow.scope.deviceId', 'the camera that saw it') },
    { name: 'className', hint: t('flow.scope.className', 'what it saw') },
    { name: 'phase', hint: t('flow.scope.phase', 'appeared or departed') },
    { name: 'entryId', hint: t('flow.scope.entryId', 'the stopped object') },
  ]
}

/** The event rows of a `when` tree, in tree order. */
function eventLeavesOf(when: AutomationWhen): readonly AutomationEventLeaf[] {
  const found: AutomationEventLeaf[] = []
  forEachLeaf(when, (leaf) => {
    if (isEventLeaf(leaf)) found.push(leaf)
  })
  return found
}

/** Variables every event row of the tree provides (the intersection by name). */
export function whenScopeVariables(when: AutomationWhen, t: TFunction): readonly ScopeVariable[] {
  const events = eventLeavesOf(when)
  if (events.length === 0) return []
  const perEvent = events.map((leaf): readonly ScopeVariable[] => {
    if (leaf.kind === 'detection') return detectionVars(t)
    if (leaf.kind === 'stationary') return stationaryVars(t)
    return []
  })
  const [first, ...rest] = perEvent
  if (first === undefined) return []
  return first.filter((v) => rest.every((other) => other.some((o) => o.name === v.name)))
}
