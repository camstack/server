/**
 * Pure helpers for the Notification Rules page (slices D1 + D2).
 *
 * The page (`NotificationRules.tsx`) mirrors the CRUD state machine of the
 * notification-targets editor; these helpers keep the value-shaping logic
 * (delivery labels, empty-form seed, form ↔ `NcRuleInput` assembly, condition
 * pruning) pure and unit-testable, exactly like `notification-targets.helpers.ts`.
 *
 * D1 owned the rule SCAFFOLD (name, enabled, delivery/trigger kind, targets,
 * priority, media policy, title/body template). D2 layers the catalog-driven
 * CONDITION surface on top: the form now carries `conditions` + `schedule`
 * (authored from the `getConditionCatalog` descriptors) and per-target
 * `params`. The builder emits only condition keys the operator actually
 * touched (absent = unrestricted), strips conditions that do not apply to the
 * current trigger, and preserves untouched fields (throttle, per-target
 * params) across an edit.
 */

// The implementation lives in four modules (review M7); this file is the
// barrel every existing import goes through.
export * from './rule-form-parsers'
export * from './rule-form-state'
export * from './rule-form-save'
export * from './rule-form-tabs'
