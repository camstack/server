---
title: Addon custom actions and operator buttons
last-verified: 2026-09-11
---

# Custom actions, and the buttons that call them

A **custom action** is an addon-owned RPC that rides the generic
`addons.custom` bridge instead of a capability. Use one when the operation
belongs to exactly one addon and no other addon will ever implement it —
"rebuild my index", "verify my token". A capability is for a contract several
addons implement; an action is for a button.

The payoff is that the settings form already knows how to render a button for
one, so an addon gets an operator surface without a bespoke admin page.

## The three files

```ts
// 1. the catalog — one module, exported as a LITERAL
export const embeddingActions = defineCustomActions({
  'embedding.rebuild': customAction(InputSchema, OutputSchema, { auth: 'admin' }),
})

// 2. the entry module MUST export the union under `customActions`
export const customActions = { ...ncActions, ...embeddingActions }

// 3. onInitialize returns the catalog AND its handlers
return {
  providers,
  customActions: { ...ncActions, ...embeddingActions },
  actionHandlers: { ...ncHandlers, ...embeddingHandlers },
}
```

`defineCustomActions` is the identity function — it exists for inference only,
so spreading two catalogs together is safe.

## The trap: there are TWO registration paths

This is the part that costs hours, because the symptom is identical either way
— `addon 'x' has no custom action 'y'`, a 404, with the code visibly present in
the built bundle.

| Addon runs | Registered from | Code path |
| --- | --- | --- |
| **in-process** | `AddonInitResult.customActions` returned by `onInitialize` | `addon-registry.service.ts`, the `initResult?.customActions` branch of the boot init loop |
| **forked** | `AddonInitResult.customActions` returned by `onInitialize` **in the runner**, described in the runner's post-init register frame (`RegisterMessage.customActions`, schemas stripped) | runner: `addon-runner.ts` post-init `refreshChildCaps`; hub: `applyChildCustomActions` in `addon-registry.service.ts` |

Both paths read the SAME source — what `onInitialize` returns. Until
[D444](../decisions/adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md)
the forked path read the entry module's `customActions` NAMED export by
evaluating the whole bundle inside hub-main; the named export is still the
convention (step 2 above) but nothing in the hub reads it any more. Which path
an `any-node` addon takes today is not a property of the source — check it:

```bash
node scripts/hub/hub.mjs GET addons.list '{}' | python3 -c "…m.get('process')"
# → {"pid": 7, "mode": "in-process", "state": "running"}
```

For a forked addon the catalog appears in the hub's registry only once the
runner's init loop has finished — the hub log line is `UDS child custom-action
catalogs applied`, one per child, naming which hosted addons registered how
many actions and which declared none. Validation of a forked action's input
and output happens in the RUNNER (`child-addon-call-dispatch.ts`); the hub's
copy of the catalog has passthrough schemas, so a schema error arrives as the
runner's refusal (`custom action "x" rejected its input — …`), not as a
`BAD_REQUEST` from the hub.

## Verifying a new action actually landed

A `camstack deploy` reporting success is not evidence. Neither is the version
in `addons.list` — it is recorded at INSTALL time and does not track a
redeploy: a hub was observed reporting `manifest 1.2.40 | package 1.2.42` after
a clean redeploy onto a freshly restarted hub.

The discriminating checks, in order:

1. **Is the built bundle right?** Import it and read the export:
   ```bash
   node -e "import('./packages/<pkg>/dist/<entry>.js').then(m =>
     console.log(Object.keys(m.customActions ?? {})))"
   ```
2. **Is the PUBLISHED bundle right?** `npm pack <pkg>@<version>`, then grep the
   extracted `dist/`. A published tarball can differ from your working tree.
3. **Is the running code new?** Call a cap method whose RETURN SHAPE changed.
   This is the only cheap way to tell "the runtime has my code" from "the
   runtime has my code but did not register it".
4. **Compare an old action against the new one.** If a pre-existing action in
   the same catalog answers and the new one 404s, the module is loaded and the
   problem is registration — not staleness, not the deploy.

## `addons.custom` envelope

The bridge requires an `input` field **even for input-less actions**. Omitting
it fails envelope validation BEFORE the action lookup, so a missing action can
present as a Zod error about `input` rather than a 404. Always send
`"input": {}`.

**Therefore: never declare an action with `z.void()` input.** The envelope
insists on `{}` and a `z.void()` schema rejects it, so the action resolves and
can never be called — by the bridge or by the button. Use `z.object({})`.

The two errors are worth telling apart:

| Message | Meaning |
| --- | --- |
| `has no custom action 'x'` | not registered — wrong copy, or the catalog was not populated on the path this addon actually uses |
| `expected void, received object` | registered and reachable; the SCHEMA is wrong |

## Rendering a button

`ConfigAddonActionButtonField` (see `packages/types/src/interfaces/config-ui.ts`)
is declared inside a normal settings section:

```ts
{
  type: 'addon-action-button',
  key: 'rebuildButton',
  label: 'Rebuild index',
  addonId: 'pipeline-analytics',
  action: 'embedding.rebuild',
  buttonLabel: 'Rebuild',
  variant: 'primary',            // 'default' | 'primary' | 'danger'
  paramsFromForm: { cropMargin: 'rebuildCropMargin' },
  paramsStatic: { square: true },
  successMessage: 'Started — {started}',
  confirmMessage: 'Are you sure?',   // required for anything destructive
}
```

`paramsFromForm` maps a sibling form field into the action input, which is how
a button becomes tunable without a code change — put the knob next to the
button and let the operator try values.

## Rules learned the hard way

- **A long action must not block.** Return `{started, alreadyRunning}` and
  expose a separate status action. A pass that takes minutes will time the
  client out while the work continues server-side: no result AND no way to know
  it is still running. Log progress periodically as well.
- **Refuse a concurrent start; clear `running` on failure.** A job that dies
  leaving its flag set locks out every future request until a restart.
- **A destructive action needs `variant: 'danger'` and a `confirmMessage` that
  states what cannot be undone.** `embedding.wipe` destroyed a live 8,686-row
  index when it was called casually as a route-liveness probe. Never use a
  destructive action to check whether a route exists — call the read-only one.
- **Never probe with a mutation.** Use the status action.
- **Declare `auth` on every action that changes or reveals an integration.**
  The default is `protected` — any authenticated user. The Alexa export ran
  for months with "rotate ingress token" (whose response carried the new
  secret), "unlink the Amazon account" and "purge endpoints" callable by a
  viewer ([D768](../decisions/adr-0768-an-alexa-status-read-carries-no-secret-and-every-alexa-action-is-admin-only.md)).
  A secret is never part of a status read; reveal it through an admin action
  rendered as an `addon-action-button` with a `successMessage` (the plain
  `button` discards the result).
