---
title: addon-waste-collections — package notes
covers:
  - packages/addon-waste-collections/**
---

# addon-waste-collections — package notes

Waste collection schedules via the vendored HACS
`waste_collection_schedule` Python core (full source catalog). Each configured
source becomes one `calendar-source` calendar (all-day events). See [D827](../decisions/adr-0827-waste-schedules-use-vendored-hacs-python-core-full-catalog.md).

## Layout

| Path | Role |
| --- | --- |
| `python/vendor/waste_collection_schedule/` | HACS core (MIT), no HA layer |
| `python/fetch_source.py` | stdin JSON → stdout collections |
| `python/requirements.txt` | pip deps installed before `onInitialize` |
| `src/catalog.json` | addon-local codegen: modules + country → service + inferred fields |
| `gen-catalog.ts` (removed) | regenerate catalog from `source/*.py`, README, `EXTRA_INFO` / `__init__` |

## Operator setup

1. Install / deploy the addon on the hub (needs embedded Python).
2. Connectivity → Calendars → waste-collections → **Settings**: Add source.
   Pick **Country** → **Service** (e.g. Germany → AWA/ZEW); the form shows
   only that service’s fields (`ort`, `strasse`, …). Storage is still
   `module` + `argsJson` under the hood. CRUD via custom actions
   (`listCountries` / `listServices` / `serviceFormSchema` / `createSource`…).
3. **Fetch now** (same Settings Refresh section) or wait for the daily refresh.
4. Open System → Calendars — events appear under
   `waste-collections:<id>`.

## Refreshing the vendor

1. Sparse-clone / copy upstream
   `custom_components/waste_collection_schedule/waste_collection_schedule/`
   (exclude `test/` / `wizard/`) into `python/vendor/waste_collection_schedule/`.
2. Refresh `python/vendor/LICENSE` and `README-sources.md` if country hints
   should stay accurate.
3. Align `python/requirements.txt` with upstream `manifest.json` requirements.
4. `npx tsx packages/addon-waste-collections/scripts/gen-catalog.ts`.
5. Run the package tests — `catalog.spec.ts` fails if the catalog drifts.

## Traps

- Missing Python → empty calendars + warn; do not crash-loop.
- A failed fetch keeps the prior cache for that source and logs the error
  (never silent `[]` from the bridge on failure).
- `argsJson` must be a JSON **object**; arrays/scalars throw on fetch.
