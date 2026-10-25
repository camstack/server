---
id: D598
title: One icon vocabulary in types, two glyph tables, one picker
status: superseded
superseded-by: D854
date: 2026-09-22
supersedes:
applies-to:
---

## Context

An operator picks an icon in admin-ui — per device, per role default, per room
— and the viewer draws it. The two cannot share a component: admin-ui is React
DOM over `lucide-react`, the viewer is React Native over a hand-maintained
per-icon allowlist (`src/lib/icons.ts`, because that package's barrel is 47 %
of the app's modules). `location-icon.ts` had already worked this out for the
twenty room icons and written down why.

By 2026-09-22 there were **four** lists claiming to be the same thing:
ui-library's `DISPLAY_ICON_REGISTRY` (155 keys), the viewer's
`ACCESSORY_ICON_KEYS` (33), `LOCATION_ICON_IDS` (20) and the viewer's copy of
the role glyphs. They had already diverged in both directions:

- 122 keys admin-ui offered that the phone could not draw. Picking one saved a
  value and changed nothing visible — the operator reads that as "my change
  did nothing", not as a missing glyph.
- `toggle-right` the viewer drew and the registry had never heard of, though it
  is what its `switch` device type resolves to, so operators have it persisted.
- `briefcase` and `route`, which a ROOM could wear and a device could not.

And two pickers, one per vocabulary, identical apart from the list they walked
— only one of them i18n'd. At 56 glyphs in a flat grid that was tolerable. At
157 it is not: a picker that only lets the operator hunt is a picker they stop
using.

## Decision

The vocabulary is ONE list, in `@camstack/types`: keys, groups, bilingual
search synonyms and the ranking function. It contains no React, no lucide and
no glyph, because that is the only kind of thing the two surfaces can share.
Each surface keeps a glyph TABLE keyed by it, and each table must cover the
vocabulary EXACTLY — a key with no glyph is a tile that draws nothing; a glyph
with no key is unreachable and unsearchable.

`LOCATION_ICON_IDS` is a subset of it, not a second vocabulary.

A key that is a deprecated spelling of another (`gauge2` → `gauge`) declares
`aliasOf`. It keeps RESOLVING, because rows have it persisted, and it is never
OFFERED, because a second identical tile lets an operator newly choose the
spelling we are retiring.

One `IconPicker` in ui-library serves every admin-ui surface. The glyph table,
every string and the write are props: the control owns the popover, the
grouped grid and the search, and nothing else.

## Consequences

- Search is the feature, not a decoration. The keys are English lucide ids and
  always will be — they name the DRAWING, checkable against a package — so an
  operator typing "tapparella" reaches nothing without synonyms. Every entry
  carries the words somebody would actually type, in both languages, including
  the wrong-but-obvious ones. Accents are stripped, because an Italian
  keyboard produces them and the lists are spelled without.
- A caller with translations this module cannot see passes `extraWords`; they
  score exactly like a synonym. The room picker feeds its room labels through
  it, so "kitchen" reaches `utensils`.
- The clear tile is never filtered by the query. It is the only way back from a
  glyph picked by accident.
- Clearing is not one thing: it means "inherit" on a device and "none" on a
  room, so the tile's glyph is a prop. The device picker shows what will be
  inherited; the room picker shows `Ban`, because showing the fallback pin
  would be indistinguishable from picking the pin.
- Adding a key now costs three edits — the vocabulary and both glyph tables.
  That friction is the point; it is the only thing that keeps the surfaces
  honest.

## Enforcement

- `scripts/check-icon-vocabulary-in-sync.ts`, in pre-commit and CI: diffs the <!-- drift-ok -->
  viewer's copy against the vocabulary in BOTH directions and names the keys.
  It SKIPS with its own line when the `camstack/` submodule is absent — "I
  could not look" and "I looked and it was fine" are different answers (D315),
  and reading the submodule unconditionally once killed the entire pre-commit
  hook (see `check-container-priority-in-sync.ts`).
- ui-library's `device-meta.test.ts` pins that `DISPLAY_ICON_REGISTRY` covers
  the vocabulary exactly, both directions, and that no key an operator may
  have persisted stops resolving.
- `display-icon-vocabulary.spec.ts` pins the vocabulary's own shape (no
  duplicate key, every key kebab-case, groups partition it, every entry has a
  synonym, aliases point at a real non-alias) and the search's behaviour.
- `icon-picker.test.tsx` pins the control is wired to that search, that an
  undrawable key loses its tile AND its group header, and that the clear tile
  survives every query.
