---
id: D1025
title: A device template in a consumer's text is resolved at run time by the one hub renderer, inside the caller's scope
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/types/src/automation/step-runner.ts
  - packages/system/src/builtins/device-manager/device-template/template-host.ts
  - packages/system/src/builtins/device-manager/device-template-actions.ts
  - packages/system/src/builtins/core-blocks/device-template-door.ts
  - packages/addon-post-analysis/src/notification-center/device-template-pass.ts
---

## Context

D1021 gave the grammar, the aliases and the budgeted renderer. Four consumers
now carry text an operator writes: an action step's string args (actions, the
scheduler, fan presets, generated automation blocks) and a notification rule's
title and body. Each could have grown its own render call and its own copy of
device state; two of them also take values from callers who are not admins.

## Decision

1. **One door.** A consumer renders only through `device-manager.renderDeviceTemplates`
   (admin cap, mesh principal in-process). The host fills a `ConditionMirror`
   with the slices the named devices hold now and renders with the P1 renderer.
   No consumer keeps a renderer or a state copy.
2. **Render before substitution.** Action args render with `{{vars.x}}` slots and NC
   with `{{var}}` placeholders set aside, then restored: a variable's value
   (a name, a label, a non-admin caller's variable) is data, never template source.
3. **Unknown prints `—`; the reason is kept.** An action step records
   `templates: ["ref: reason"]` in its trace; NC logs the reason with
   `tags: { deviceId }`.
4. **A refusal is typed and bounded.** An action step fails with
   `[reason]` (`StepTemplateError`) and dispatches nothing, never throwing past
   `runSteps`; an NC rule falls back to the catalog sentence and logs why, so a
   template never costs the notification.
5. **Scope.** `actions.run` by a non-admin is refused with `template-scope` when
   a template names a device other than the one the scope gate proved
   (D356); the host re-checks at render time (`out-of-scope`). Saving a
   template is admin-only at every save door (actions, scheduler, fan presets,
   NC rules); the proof is that those caps are `auth: 'admin'`.

## Consequences

- The cap change needs `@camstack/system` force-published.
- A non-admin run can read only its own camera's values; widening needs a
  scope grant the provider does not have yet.
- NC's `{{var}}` pass runs after the device pass, so a device value containing
  `{{name}}` text is substituted from the notification variables.

## Enforcement

Specs per consumer, each failing with the wiring removed: `step-runner.spec.ts`,
`actions-service.spec.ts`, `scheduler-engine.spec.ts`, `fan-presets-service.spec.ts`,
`generated-block.spec.ts`, `dispatcher-device-templates.spec.ts`,
`template-host.spec.ts`.
