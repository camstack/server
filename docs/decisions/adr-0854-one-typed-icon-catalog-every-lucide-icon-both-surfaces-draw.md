---
id: D854
title: One typed icon catalog - every lucide icon both surfaces can draw, picked and stored by key everywhere
status: accepted
date: 2026-10-15
supersedes: D598
applies-to:
  - packages/types/src/device/icon-catalog.ts
  - packages/types/src/device/icon-catalog.generated.ts
  - packages/types/src/device/icon-synonyms.ts
  - packages/types/src/device/location-icon.ts
  - scripts/generate-icon-catalog.ts
  - scripts/check-icon-catalog.ts
  - packages/ui-library/src/composites/icon-glyphs.ts
  - packages/ui-library/src/composites/icon-picker.tsx
---

## Context

An operator picks an icon in admin-ui and the viewer draws it. Two surfaces,
two icon modules (`lucide-react` on the web, `lucide-react-native` on the
phone), so the icon travels as a STRING KEY and each surface owns its glyph
table. [D511](adr-0511-a-location-icon-is-a-closed-vocabulary-keyed-on-the-folded-label.md)
fixed that for twenty room icons; [D598](adr-0598-one-icon-vocabulary-in-types-two-glyph-tables-one-picker.md)
widened it to one curated vocabulary of 157 keys in five groups. By October
there were still FOUR statements of "the icons": the 157-key display vocabulary,
the 20-id location subset (a `z.enum`, reused by site zones), ui-library's
`DISPLAY_ICON_REGISTRY` and the viewer's accessory list with its hand-written
per-icon import file. Every one was a hand-kept list, every new room or device
type needed a framework change to add a picture, and the curated set was the
operator's complaint: "why can I not pick the telescope".

Measured on 2026-10-15: `lucide-react@0.576` has 1,950 icon modules (1,702
canonical, the rest old spellings), `lucide-react-native@1.24` has 1,747, and
1,684 ids are drawable by both. The curated 157 were 9 % of that.

What did not work, tried while building this:

- **A `z.enum` of the catalog in the cap schemas.** `docs/reference/api.md`
  inlines every enum literal at every use; four icon fields would have added
  ~120 KB of literals (1,684 x 4) to a generated page.
- **A dynamic `import('lucide-react')` for the long tail.** Every static import
  of a lucide icon also resolves to that barrel, so the bundler treats it as
  shared and hoisted all ~1,700 icons into an INITIAL chunk (+484 KB raw,
  measured). Lazy only works through a module nothing static reaches.
- **One chunk per icon (`lucide-react/dynamic`).** Lazy, but ~1,950 files in the
  admin bundle for a picker that wants ~70 of them at a time.

## Decision

There is ONE icon list: the catalog in `@camstack/types`
(`device/icon-catalog.ts`). Its keys are every lucide id drawable by BOTH
`lucide-react` and the viewer's `lucide-react-native`, generated locally by
`scripts/generate-icon-catalog.ts` into the committed
`icon-catalog.generated.ts` (CI never regenerates it: the viewer is a submodule).
Tags and categories come from lucide's own metadata at the tag equal to the
installed `lucide-react` version (`icons/<id>.json`); the Italian and English
room words live in a hand-kept overlay (`icon-synonyms.ts`) merged into the same
entries for search. A device's display override, a role default, a location, a
site zone, an `icon` settings field and a viewer accessory all store a catalog
key and nothing else.

Spellings that a lucide package still accepts (`home` for `house`) and this
repo's own legacy ones (`gauge2`) RESOLVE (`canonicalIconKey`) so no stored value
goes stale, but they are never offered. Wire schemas use `IconKeySchema`, a
`z.custom<IconKey>` that checks membership without enumerating the literals.

No second list may exist: a glyph table is typed `Partial<Record<IconKey, ...>>`
(a cache, not a vocabulary), and the web table is a small synchronous set plus
one lazily imported module of lucide's per-icon index, which no static import
reaches.

## Consequences

- Every value accepted before is still accepted: no migration. A spec pins the
  157 retired display keys and 20 retired location ids against the catalog.
- `display.icon` on a device and the role default keep `z.string()` on the wire:
  a READ must tolerate a stale stored value, and a strict output schema would
  fail a whole device list on one hand-edited row. They are resolved through
  `canonicalIconKey` when drawn, and written only by the picker.
- `@camstack/types` carries ~200 KB of generated source (45 KB gzip) in the
  admin initial bundle, measured +155 KB raw / +43 KB gzip on the initial JS.
  The tags are the bulk and only search needs them; splitting them behind an
  async search index is the follow-up if that cost matters.
- The viewer must migrate to the catalog (its hand-written icon list, accessory
  keys and `LOCATION_ICON_GLYPHS` go) and map `ICON_VIEWER_MODULES` where its
  module name differs from the key.
- A lucide upgrade on either side means regenerating and committing the file;
  `check-icon-catalog` fails when the committed versions drift from what is
  installed.
- Retired exports: `DISPLAY_ICON_*`, `DisplayIcon*`, `displayIconEntry`,
  `displayIconsInGroup`, `isDisplayIconKey`, `resolveDisplayIconKey`,
  `searchDisplayIcons`, `LOCATION_ICON_IDS`, `LocationIconId`,
  `LocationIconIdSchema`, `resolveLocationIcon`, ui-library's
  `DISPLAY_ICON_REGISTRY`.

## Enforcement

`scripts/check-icon-catalog.ts` (pre-commit, and the on-demand Checks static
job): fails when the committed catalog records other lucide versions than the
installed ones, when a key or alias cannot be drawn by the installed
`lucide-react` (and by `lucide-react-native` when the viewer is on disk), and
when anything under `packages/**` declares a second icon vocabulary
(`*_ICON_IDS`, `*_ICON_KEYS`, a union of icon-name literals). Specs:
`icon-catalog.spec.ts` (superset, aliases, Italian search),
`icon-glyphs.test.ts` (every key resolves to a glyph),
`icon-picker.test.tsx` (one virtualised view, clear tile survives search),
`icon-catalog-decode.spec.ts` (the device-manager decoders accept every old
value).
