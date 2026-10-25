---
id: D610
title: A camera that answers 200 and discards is refused before the wire and verified after it
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/recording-onboard-mapping.ts
  - packages/system/src/builtins/device-manager/recording-onboard-config-schema.ts
---

## Context

D608 made `recording-onboard` the one cap both vendors answer, and shipped the
Reolink half **read-only** with one reason: `@apocaliss92/nodelink-js` had a
reader for every field and a writer for none, and an unverified write onto a
camera's recording configuration is the change that looks fine in a green suite
and loses footage on the hardware.

Writing them turned out to be the easy part. Measured live on 2026-09-22 (E1
Outdoor PoE v3.1.0.5223, E1 Outdoor Pro v3.1.0.5714, Home Hub v3.3.0.456, every
write restored byte-identical):

- `cycle` 7, outside the camera's own `<cyclelist>` — **200, then discarded**.
- `preRecordTime` 9999 — **200, then discarded**.
- A 167-character weekly mask, and a `<type>bogus</type>` row — **200, then
  discarded**.
- One document carrying an invalid `Normal` mask and a valid `MD` mask applied
  `MD` and dropped `Normal`. **The drop is per field and per row: a write here
  is not atomic.**

Hikvision is the same defect wearing a different hat: `PUT
PreRecordTimeSeconds: 8` answered `200 / statusCode 1 / OK` and stored **5** —
neither the asked value nor the previous one (D608).

Two vendor traps also refused to fit a `{min,max,step}`. Reolink's
`preRecordTime` is **a boolean in seconds' clothing**: `0` is off, and `5`, `15`
and `30` all read back as `10`, identically on both firmwares — a slider would
move and change nothing. And `<timeList>` is **advisory**: a Home Hub offering
`8,15,30` accepted and applied `20`, so refusing against that list would block a
value the firmware honours, while `<cyclelist>` IS enforced and refusing against
it is correct.

The cap had grown `preRecordSecAllowed` / `postRecordSecAllowed` for exactly
this, and the one thing that renders the form read only `*Range`. The sets were
declared by two providers and rendered by nobody — a fix nothing executes.

## Decision

A write to a camera setting is **refused before the wire against what the camera
itself stated**, and **verified after it by re-reading**; success is the
read-back agreeing, never the absence of a thrown error. A field is reported
writable only from the camera's own statement of what it accepts — a limit
CamStack failed to read is not a limit of none, and closes the control. Where
the accepted values are a SET they are declared as one (`*Allowed`), the form
renders a select from it, and the set beats a range wherever both exist. An
advisory list is not a refusal reason: it constrains nothing and the read-back
diff reports what the camera dropped. A read that MERGED rows the write cannot
un-merge reports the field unwritable, by name — a Reolink storing three
line-crossing rules under one trigger cannot be written by trigger alone without
overwriting all three.

## Consequences

- Every write path in this cap costs an extra read. Accepted: the alternative is
  reporting success for a value the camera never took.
- A partial write is a real outcome and is reported as one — the cfg half may
  land while the schedule half does not. The error names each field the camera
  kept, and the slice is refreshed either way, so the UI shows what is really
  there rather than what was asked.
- A camera CamStack has not read yet reports every field readable: false,
  writable: false, with "has not read this camera yet" — not-yet-known must not
  look like unsupported (D315).
- `REOLINK_PRE_RECORD_ON_SECONDS` duplicates `DEFAULT_PRE_RECORD_SECONDS` in
  `@apocaliss92/nodelink-js`. If the two drift, the form offers a number the
  library does not write — the exact substitution this record exists to stop.

## Enforcement

Tests, in three places, each proved live by disarming it and watching it go red:

- `recording-onboard-mapping.spec.ts` — writability from the camera's statement,
  the merged-row refusal on 618's real fixture, the missing-limits closure, and
  the patch → two-documents translation (including the all-zero row for a
  trigger the operator removed, and never inventing a row the camera lacks).
- `recording-onboard-config-schema.spec.ts` — the set beats the range, the
  sentinel is named rather than printed, whole minutes read as minutes, and a
  stored value outside the camera's own offer survives.
- `@apocaliss92/nodelink-js` `record-config.test.ts` — the `allApplied` contract
  itself.

No guard script. The thing a guard would have to check — that a provider does
not report writable what it cannot verify — is not visible in the syntax.
