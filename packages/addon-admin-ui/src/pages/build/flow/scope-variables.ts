/**
 * The variables a step can name, by where the run came from.
 *
 * An action's variables are the ones it declares. An automation's are the ones
 * the event rows of its `when` tree put in the run's bag, named by
 * `triggerVariablesOf` in `@camstack/types`; an event that provides none
 * offers none (the "{x}" button stays hidden rather than guess).
 */

import { type ActionVariable, type AutomationWhen, triggerVariablesOf } from '@camstack/types'
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

/**
 * Variables every event row of the tree provides (the intersection by name).
 * The list is `triggerVariablesOf` — the one the generated block also uses —
 * so a variable the run holds is a variable offered here.
 */
export function whenScopeVariables(when: AutomationWhen, t: TFunction): readonly ScopeVariable[] {
  return triggerVariablesOf(when).map((v) => ({
    name: v.name,
    hint: t(`flow.scope.${v.hintKey ?? v.name}`, v.description),
  }))
}
