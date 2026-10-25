---
id: D921
title: A person is an admin or a viewer, and a viewer is its devices and its named features
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/auth/viewer-access.ts
  - packages/types/src/schemas/device-selector.ts
  - server/backend/src/api/trpc/scope-access.ts
  - server/backend/src/api/trpc/principal-authorization.ts
  - server/backend/src/api/trpc/trpc.middleware.ts
  - scripts/check-method-roles.ts
  - scripts/check-viewer-calls-allowed.ts
---

## Context

A household member was refused the siren of a camera she could see (D918).
Fixing that one method showed how the access model works for a person:
- seven kinds of grant row;
- three verbs;
- four selector kinds;
- a per-grant `includeLinked` switch;
- five presets and three roles;
- a per-method tier that decides everything before the grants are read.

The operator could not tell from the Users page what a person could do, and
neither could the person. The operator's decision was to keep two roles, admin
and viewer:
- a **viewer** has every API a normal user of the viewer app needs;
- on the devices an admin lists, as a whitelist (`*` by default) minus a
  blacklist;
- plus named features an admin toggles one at a time;
- anything else is admin.

Names in events stay visible to anyone who can see the events.

Two things had to keep working unchanged:
- the integrations (Home Assistant, Alexa and Google hold capability rows such
  as `category:device [view,create]`, share links hold a `share-view` grant);
- every existing user, whose grants the product must not migrate (D900).

## Decision

**A method has one role for a viewer:** `public`, `viewer`, `admin` or
`feature:<id>`.
- It is resolved by `resolveMethodRole`, in this order:
  1. the method's own `role` in its `*.cap.ts`;
  2. the cap's `role`;
  3. derived: `public` stays public, `admin` stays admin, a `protected` method
     of a DEVICE cap is `viewer`, a `protected` method of a SYSTEM cap is
     `admin`.
- A system method joins the viewer baseline only by an explicit
  `role: 'viewer'`, because it reaches the whole installation.
- Codegen writes the role into `METHOD_ACCESS_MAP[path].role`, the one table
  the matcher reads.

**A viewer is one grant row in the person's scopes:**
`{ type: 'viewer', allow: '*' | number[], block: number[], features }`.
- A set holding it is decided by it ALONE. Another row beside it never widens
  it.
- `checkScopeAccess` admits a call when the viewer holds the method's role and
  every device the call names is admitted.
- A device is admitted by `allow` minus `block`, through itself or any
  ancestor, so a camera's children follow it in both lists.
- Unknown parentage fails closed:
  - under `'*'` such a device is admitted only while `block` is empty;
  - under a list, only if the list names the device itself.
- The enumeration projection, the event firehose and share-link minting follow
  the viewer row automatically, because they ask the same matcher.
- `adminProcedure` lets a viewer through only on a method whose role is a
  feature it holds.

**Features are a catalog that grows one entry at a time**
(`VIEWER_FEATURES` in `viewer-access.ts`). Seeded with the four whose viewer
sections already exist and were admin-only:

| Feature | Unlocks |
|---|---|
| `face-assignment` | `faceGallery.*`, except the reads that name a face in an event |
| `plate-assignment` | `plateGallery.*`, except the read that names a plate in an event |
| `retrain` | the retrain staging methods; the corpus export and archive stay admin |
| `scenes` | `sceneMonitor.*` |

Names in events are shown to anyone who can see the event. So
`faceGallery.getFaceByTrack`, `faceGallery.listIdentities` and
`plateGallery.getPlateByTrack` are viewer baseline, bounded by the device
lists where they name a device.

**Adding a feature** is the whole procedure:
1. Add one catalog entry.
2. Put `role: { feature: '<id>' }` on the methods it unlocks, at cap or method
   level.
3. Run `npm run codegen` and `npx tsx scripts/check-method-roles.ts --update`.
4. Map the viewer section's files in `scripts/check-viewer-calls-allowed.ts`.

**Integrations and legacy users are untouched.** A grant set without a viewer
row is decided by the pre-D921 matcher, byte for byte. That covers:
- every existing user, until the operator converts them offline (below);
- the HA, Alexa and Google links;
- share links;
- tokens.

## Consequences

- A viewer reaches about 320 methods:
  - every protected device read and actuation;
  - 24 system methods the viewer app calls: device lists and bindings, live
    viewer counts, TURN servers, recording availability, exports;
  - the addon custom-action dispatcher, whose per-action auth still applies.

  It loses the protected SYSTEM methods only the admin UI uses (`alerts.*`,
  `addons.list`, the per-addon settings reads, …).
- Not reached by a viewer, even though they are device-scope:
  - motion-detection's pipeline-internal methods;
  - `ptzAutotrack.setSettings`.
- A gallery method that names no device is not cut by the device lists.
  Every viewer reads the identity names (`faceGallery.listIdentities`), and a
  viewer granted `face-assignment` curates every identity.
- A token carrying a viewer row dies when the admin edits that viewer's grant:
  it is kept only while the subject holds the identical row, never re-shaped.
- `auth.me` and `auth.previewScope` report `role: 'admin' | 'viewer' | 'scoped'`
  and the viewer's `features`. `scoped` is a legacy set not yet converted.
- **Existing users are converted offline, once, by the operator.** There is no
  migration code in the product (D900):
  - `isAdmin` stays admin;
  - any other grant set becomes `{ type: 'viewer', allow, block: [], features: [] }`;
  - `allow` is `'*'` for a `selector.kind: 'all'` or `category:device` grant,
    and otherwise the ids the old selector resolves to today;
  - children need not be listed: they follow their parent.

  The step is printed per user and confirmed before `setUserScopes` writes it.
- The admin UI's role modal and the viewer app's feature-gated sections are
  separate work. Until then the Users page shows a viewer row as no grant.

## Amended 2026-10-24

The operator's reading of the grant, after using the modal:

- **One list, one mode.** "All devices except…" (the default) stores
  `allow: '*'`, `block: <picked ids>`. Nothing picked is every device. "Only
  these devices…" stores `allow: <picked ids>`, `block: []`, and an empty list
  cannot be saved. Switching mode keeps the picked ids.
- A stored row that is both an allow list and a non-empty block is not a mode.
  The UI reads it as "only" with `allow` minus `block`.
- **Legacy person rows are refused, not converted.** There is still no
  migration (D900). `userManagement.setUserScopes` accepts `[]` (an admin) or
  exactly one viewer row, and refuses any other row with
  `auth.person-scopes-refused`. At request time a non-admin person is decided
  by its viewer row alone; a non-admin person with no viewer row is denied
  every labelled method and that refusal is logged once (`tags: { userId }`).
  The pre-D921 matcher is no longer on the person path.
- **API tokens are unchanged.** A minted token and an account link still carry
  `device` / `category` / `capability` / `addon` rows, and the matcher still
  decides those principals by those rows. Share links are unchanged.

This replaces two earlier statements. In **Decision**, "a grant set without a
viewer row is decided by the pre-D921 matcher" now covers tokens and account
links only, not people. In **Consequences**, there is no offline conversion
step: a stored person grant that is not a viewer row simply reaches nothing
until an admin saves a viewer row, and `auth.me`'s `scoped` role is that case.

## Enforcement

- `scripts/check-method-roles.ts` (pre-commit on a cap change, and the Checks
  workflow) refuses:
  - an unknown role or feature;
  - a catalog feature no method carries;
  - a credential, account or installation method a viewer could reach;
  - an actuation method a viewer could not reach;
  - a cap-level `role: 'viewer'`;
  - drift against `scripts/method-role-baseline.json`.
- `scripts/check-viewer-calls-allowed.ts` refuses a call the viewer app makes,
  from a baseline or feature section, that a viewer would be refused there.
  It reads the viewer checkout; the submodule is absent in CI, where it says so.
- Specs:
  - `viewer-access.spec.ts` (types and backend): the matcher matrix.
  - `viewer-features.router.spec.ts`: features through the admin tier.
  - `integration-principals-reach.spec.ts`: each integration still reaches what
    it calls.

  Each was run red with its gate removed.
