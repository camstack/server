---
id: D526
title: A GENERIC capability's device-page section is derived; an OWNED capability declares its own
status: accepted
date: 2026-09-17
supersedes:
covers:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/motion-zones.cap.ts
  - packages/types/src/capabilities/privacy-mask.cap.ts
  - packages/types/src/capabilities/ptz.cap.ts
  - packages/types/src/capabilities/ptz-autotrack.cap.ts
  - packages/types/src/capabilities/navigation.cap.ts
  - packages/types/src/capabilities/consumables.cap.ts
  - packages/types/src/capabilities/camera-grid-layout.cap.ts
  - packages/system/src/builtins/device-manager/device-aggregation.ts
  - packages/addon-pipeline/src/recorder/recording-device-settings.ts
---

## Context

A widget on a device's page can be declared two ways, and the repo uses both.

- **`deviceConfig.ui = { kind: 'widget', … }` on the capability.** The framework
  derives the section: `deriveDeviceConfigContribution` builds it out of the
  binding entry alone, with no provider call at all. The addon gets no say in
  `tab` / `order`, and the section is emitted for every device the cap is bound
  to. (D14.)
- **`exposesDeviceSettings: true` on the capability + the provider returns a
  `ConfigUISchema` from `getDeviceSettingsContribution`.** The addon owns the
  section id, `tab`, `location` and `order`, and can DECLINE for a device by
  returning `null`. `recording` and `camera-grid-layout` do this.

This session opened with an instruction to convert all six remaining
`deviceConfig.ui` widgets — `motion-zones`, `privacy-mask`, `ptz`,
`ptz-autotrack`, `navigation`, `consumables` — to the second shape, on the
reasoning that "the addon should declare its own widget, like any other
setting". **That reasoning is a mechanism, not a rule, and it gave the wrong
answer for all six.** It was retracted twice while the work was still being
traced, which is why the code in this change is unmodified and the record is the
deliverable.

What the first framing missed is what the device page actually asks.
`getDeviceAggregate` is binding-driven (D12): for each `(cap, provider)` bound
to the device it resolves the contribution with
`registry.getProviderByAddon(entry.capName, entry.providerAddonId)` — the
ADDON-registered provider, never `getProviderForDevice`. So an
`exposesDeviceSettings` section has to be written by an addon, once per addon
that implements the cap. Count who implements each:

| capability | implementing addons |
| --- | --- |
| `ptz` | 4 — amcrest, hikvision, onvif, reolink |
| `motion-zones` | 3 — amcrest, hikvision, reolink |
| `privacy-mask` | 3 — amcrest, hikvision, reolink |
| `ptz-autotrack` | 2 — hikvision, reolink |
| `navigation` | 1 — dreame |
| `consumables` | 1 — dreame (two device classes) |

For the first four, "the addon declares its own section" has no referent: WHICH
addon? Each vendor would hand-write the same section, two to four times, and
they diverge at the first one somebody edits. That is exactly what D14 exists to
prevent, and D14 is right.

**The provider count is not the rule either — it gives the wrong answer for the
dreame pair.** Both would pass a count of one and both still belong on the
derived side:

- `consumables` proves it in the code. It declares `status.empty` and
  `status.itemArray`, the device-link synthesize markers, and
  `device-aggregation.ts` names the case out loud: "the FIRST link to a
  synthesize-only cap (consumables on an HA vacuum) can be authored before any
  binding exists". Its owner set is OPEN by construction — a device with
  consumables links and no native provider builds its status from `empty`, and
  no dreame-registered provider could ever answer `getDeviceSettingsContribution`
  for that device. Converting it would make the panel vanish exactly where the
  framework intends it to appear: the same regression as the vendor caps,
  arriving through links instead of drivers.
- `navigation` has one implementer today (`DreameCameraDevice`) and nothing
  about the cap is dreame-specific. Another robot vendor implements it without
  touching it. "One provider today" is a fact about the fleet, not about the
  capability.

## Decision

**A capability's device-page section is derived by the framework when the
capability is GENERIC, and declared by the addon when the capability is OWNED.
The question is not how many providers exist today — it is "would another vendor
implement this capability without changing it".**

- **Generic / system capability** — vendor-agnostic, activated for whoever
  declares it. `ptz`, `motion-zones`, `privacy-mask`, `ptz-autotrack`,
  `navigation`, `consumables`. Declare the widget with `deviceConfig.ui`; the
  framework emits the structural section and the widget self-persists through
  the cap's own mutations. One section, N vendors, nothing to diverge.
- **Owned capability** — one addon implements it AND that addon owns the device.
  `recording` (generic as a concept; the recorder is its only implementer, and
  nothing else will record) and `camera-grid-layout` (nothing else declares a
  composite camera). Set `exposesDeviceSettings: true` and return the section
  from `getDeviceSettingsContribution`: the addon picks section id, `tab`,
  `location` and `order`, and can return `null` to decline per device.

`recording` is the example worth remembering, because it looks generic and is
not: "record this camera" sounds like something several addons could offer, and
only one ever does.

**`deviceConfig.ui` is not a legacy shape to migrate away from.** It is correct
for the majority. Of the eight device-page widgets, six are generic and stay
derived; `recording` was always owned; the only one that was on the wrong side
was `camera-grid-layout`, converted on 2026-09-19.

## Consequences

- **A derived section cannot fail; a declared one can.** The derived path builds
  the section from the binding entry with no call. The declared path is a call
  to the owning addon — frequently cross-process — under
  `CONTRIBUTION_BUDGET_MS` (1 500 ms, `contribution-cache.ts`), whose failure
  the aggregation logs as "device contribution unavailable — the panel is
  missing this section". For a widget that stores no values and makes no
  per-device decision, that trades a guaranteed render for a fallible one. Pay
  it only where the refusal or the placement is actually worth something.
- **An owned `deviceNative` cap registers the contribution TWICE, from one
  builder** — established 2026-09-17 by two live failures, not by reading.
  This record first said an addon-level wrapper was required (reasoned from
  `getProviderByAddon`); the first correction said the native provider was
  required instead (reasoned from `child-cap-dispatch`). Both halves are true
  and neither is sufficient:
  - the device page resolves the contribution with
    `registry.getProviderByAddon(capName, entry.providerAddonId)`, which reads
    the addon-level map only. With the native provider alone the aggregate for
    device 4581 carried 30 sections, ours absent, and no log line anywhere.
  - a direct cap call carries a `deviceId`, so `child-cap-dispatch` resolves the
    DEVICE-scoped provider and throws when the method is missing there. With the
    wrapper alone the hub answered HTTP 500.

  So: build the provider once (`grid-layout-native-provider.ts`), hand it to
  `registerNativeCap` AND return it from `onInitialize`. Type it
  `InferProvider<typeof fooCapability>` — `exposesDeviceSettings` widens that
  one and not `InferNativeProvider`, and a native registration accepts a
  superset. `getDeviceSettingsContribution` must return the WIRE shape — run the
  schema through `hydrateSchema(schema, {})`; a widget stores no values.
- **Placement is only partly addon-owned, either way.** A `topTab` section's tab
  must name an id in `WELL_KNOWN_TAB_MAP`
  (`packages/types/src/interfaces/config-ui.ts`) or the device page renders the
  raw tab id as its label. `navigation` and `consumables` already have entries
  there, and their label, icon and position in the tab bar are a
  `@camstack/types` constant. So the placement changes that are most likely to
  be asked for still cost a framework publish, whichever mechanism declares the
  section — which shrinks the "the addon owns its placement" gain to section
  order within the tab.
- **A refusal needs an HONEST signal, and `getOptions()` is not one.** The
  tempting refusal for `ptz` is `getOptions().hasPan/hasTilt/hasZoom`. It is a
  live device read, and every driver's failure path returns all three `false`:
  `amcrest-camera.ts` returns its `cold` descriptor when `getPtzCaps()` comes
  back `null`, and hikvision and reolink do the same. A failed probe is then
  indistinguishable from "no motors", and the panel disappears from a real PTZ
  camera whose CGI hiccupped. Not-yet-known must never look like
  not-installed (D315), and a measurement that failed is not zero (D393). The
  honest gate for these caps already exists and is not a refusal at all: the
  drivers register the native cap only when the probe says there are motors, so
  the BINDING is the gate.

## Enforcement

Nothing automated on the rule itself — review only, and that is worth writing
down. A guard can check the mechanical half (`deviceConfig` and
`exposesDeviceSettings` are already mutually exclusive in the type, and
`scripts/` could assert an `exposesDeviceSettings` cap has an addon-level
provider registered), but no script can know whether a capability is generic.

What is enforceable is that the answer be written down: a capability that
declares a device-page widget states, in its own doc comment, which side of this
line it is on and why. `camera-grid-layout` and `recording` do; the six generic
caps should say so too the next time one of them is touched.
