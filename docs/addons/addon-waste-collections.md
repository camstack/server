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
2. Each source is an `integration-instances` instance of kind `waste-source`
   (function cap `calendar-source`), one `waste-source` record each. Add one
   by picking a **Country**, then a **Service** (the create form shows that
   country's services); the edit form is the fields of that service
   (`ort`, `strasse`, …). A credential argument (`password`, `api_key`,
   `token`, …) is a keychain marker bound to the row (D880). **Test** runs one
   fetch: `validated` with collections, `rejected` when the provider refuses
   the arguments, `inconclusive` for a timeout, a missing Python or an empty
   answer. The custom actions that served the old page are gone; `fetchNow`,
   `listCountries` and `listServices` remain (the last two feed the form's
   Country → Service pickers).
3. **Fetch now** is a button on the source's row in System → Calendars (the
   `fetchNow` action for that source), or wait for the daily refresh.
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
- Sources kept in the old `sources` setting (typed `args`, or a free `argsJson`
  object string) are copied into records once at startup by the migration
  `waste-collections/2026-11-06-sources-from-settings-and-argsjson` (D987); an
  existing record is never overwritten and the setting itself is left in place.
