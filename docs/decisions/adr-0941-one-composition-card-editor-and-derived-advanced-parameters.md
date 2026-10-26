---
id: D941
title: One composition card editor and derived advanced parameters
status: accepted (derived advanced parameters superseded by D944)
date: 2026-10-25
supersedes:
applies-to:
  - packages/types/src/composition/cards/**
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/capabilities/customize-catalog.ts
  - packages/types/src/capabilities/battery.cap.ts
  - packages/types/src/capabilities/running-state.cap.ts
  - packages/types/src/capabilities/temperature-sensor.cap.ts
  - packages/types/src/capabilities/humidity-sensor.cap.ts
  - packages/types/src/capabilities/ambient-light-sensor.cap.ts
  - packages/types/src/capabilities/power-meter.cap.ts
  - packages/types/src/capabilities/switch.cap.ts
  - packages/types/src/capabilities/binary.cap.ts
  - scripts/lib/customize-declaration.ts
  - scripts/lib/customize-project.ts
  - scripts/generate-customize-catalog.ts
  - packages/types/src/generated/customize-catalog.ts
  - packages/types/src/composition/cards/classify-field.ts
  - packages/types/src/composition/cards/convert-unit.ts
  - packages/addon-admin-ui/src/components/device/customize/override-row/OverrideFieldRow.tsx
  - packages/addon-admin-ui/src/components/device/customize/override-row/ConvertUnitDialog.tsx
  - packages/addon-admin-ui/src/components/device/customize/override-row/merge-override.ts
---

## Context

D936 introduced cap-declared Customize targets and a catalog projection. Operators still had a separate composition wizard and an Advanced modal. Stored compositions mix pulse/scalar decodable features with irreducible formulas and multi-source aggregates. Advanced settings were ad hoc per cap with no shared eligibility rules.

## Decision

A customization and a composed device are the same composition block and open in ONE card editor. Each field entry is "from a device", a formula, or — on a numeric field whose unit meta has another unit in the same dimension — "convert unit". Convert unit stores the same `convert(v, from, to)` expression the composer already evaluates, plus the cap's companion `unit` constant when that field is the cap's primary numeric field. A formula may bind `v` to this device's own native value of the field (the old script over `v`). A formula the scalar/pulse/keyed decoder does not reproduce stays a formula on that cap's card; an untouched editor save is byte-identical. There is no free composition editor, no Advanced modal, and no separate Numeric transforms card. Advanced parameters use the same row: current value, no override or the entry, and + Add override. No free text input.

Advanced parameters are not a second editor. A cap opts in on its customize declaration with `advanced: 'derive'` or an explicit path list. Derivation is one filter for every cap: booleans, string enums, numbers that declare a unit, and strings whose schema max is at most 80 characters. Always excluded: `lastFetchedAt`, ids, nested objects and arrays, config and secret fields, paths the card already owns, and `*At` timestamps unless the cap declares that path as an event timestamp (and a path the card owns is still excluded). No opt-in means nothing from that cap. A cap may opt in with `advanced: 'derive'` and no card targets: the derived rows show on an existing device's Advanced section, and a composed device keeps the generic fields card. A declared card target is what replaces that card. Codegen writes the list into `CAP_CUSTOMIZE_CATALOG`. The customize-declaration guard refuses a wildcard, a path that is not in the schema, a path the filter excludes, and a declaration that has neither targets nor `advanced: 'derive'`.

This amends D936 (the declaration is still the contract). D676 still holds: the tab stores nothing.

[D944](adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md) removes derived advanced parameters, the Advanced section, and `apply` other than `add`. The one card editor, convert unit, and a formula over this device's own value stay. Unit meta for a composed-device row is `CAP_RUNTIME_FIELD_UNITS`, not an override list.

## Consequences

Phase 1 adds the card model, derivation, catalog projection, and guards only. Caps that want advanced fields must opt in and satisfy the filter. Explicit path lists cannot name bookkeeping or card-owned paths. The admin UI is the same override row on a card and under Advanced: from a device, formula (including this device's native value), and convert unit.

## Enforcement

`packages/types` specs for card round-trip and `deriveAdvancedParameters`; `scripts/check-customize-declaration.ts` and `scripts/__tests__/check-customize-declaration.spec.ts` for declaration violations; `scripts/generate-customize-catalog.ts` for catalog emission.
