---
id: D614
title: A Dahua recording trigger is a BITFIELD, a bit with no name is an unreadable window, and a setConfig may name one config table
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-amcrest/src/recording-onboard-mapping.ts
---

## Context

The operator asked for Amcrest to get the same camera-side recording section
Reolink and Hikvision already have — *"possiamo iniziare gia' a configurare
amcrest per lo stesso come reolink nelle settings"* [can we already start configuring amcrest in the same way as reolink in the settings] — having just fitted the
memory card the camera had been missing.

D608 built `recording-onboard` as the UNION of both vendors and D610 fixed how a
write to it is refused and verified. Adding a third provider needed no change to
either: the cap's field set, its refusal vocabulary and its `getOptions`
envelope all carried Dahua without amendment, and `npm run codegen` produced no
drift. What needed measuring was the firmware.

Measured live on 2026-09-23 against device 3836 (IP4M-1041B, firmware
`2.800.1ENN001.0.R, build:2024-10-29`), every write restored byte-identical and
verified with `cmp` across all six config blocks touched:

| fact | what the camera answered |
| --- | --- |
| transport | `storageDevice.cgi?action=getDeviceAllInfo` → **200** with the same rows RPC2's `storage.getDeviceAllInfo` serves. The cap needs no RPC2 session at all. (`storageDevice.cgi?action=getCaps` IS 501.) |
| storage | one volume: `Name /dev/mmc0`, `State Success`, `Path /mnt/sd`, `TotalBytes 134202327040.000000`, `UsedBytes 345309184`, `Type ReadWrite`, `IsError false` |
| schedule | `Record[0].TimeSection[row][slot]` = `"<mask> HH:MM:SS-HH:MM:SS"`, **eight** rows × six slots |
| mask on 3836 | `393222` = `0x60006` — bits 1, 2, **17** and **18**. Bit 0 (continuous) CLEAR: this camera records on EVENTS |
| limits | `recordManager.cgi?action=getCaps` → `MaxPreRecordTime 5`, `PacketLengthRange 1..20`, `SupportHoliday true`; `eventManager.cgi?action=getCaps` → `RecordLatch 10..300` |
| pre / post / segment | `Record[0].PreRecord`, `MotionDetect[0].EventHandler.RecordLatch`, `MediaGlobal.PacketLength` |
| master switch | `RecordMode[0].Mode` (0 auto / 1 manual / 2 off) **and** `Record[0].Enable` — both must be on |
| overwrite | `MediaGlobal.OverWrite` **and** `StorageGroup[0].OverWrite`, and they are INDEPENDENT |

Four write measurements changed the design rather than decorating it.

**A `setConfig` naming two config tables answers `200 OK` and applies only the
first.** `MediaGlobal.PacketLength=6&Record[0].PreRecord=4` → `200 OK`,
PacketLength 6, PreRecord unchanged at 5. With the operands swapped, PreRecord
changed and PacketLength did not. Within ONE table the write is atomic: two keys
both land, and one bad key rejects the pair with a body of `Error` under HTTP
200. This is D610's "200 and discards" in a shape neither earlier vendor had —
the drop is not per field, it is per TABLE, and the status code never mentions
it.

**The camera enforces its own stated limits only sometimes.**
`Record[0].PreRecord=99` (caps say max 5) → HTTP 400, refused. But
`MediaGlobal.PacketLength=99` (caps say 1..20) and
`MotionDetect[0].EventHandler.RecordLatch=999` (caps say 10..300) were both
answered `200 OK` and **stored**. A `TimeSection` mask of `2147483647` was
stored too. So on this firmware the refusal before the wire is not belt and
braces — for two of three numeric fields it is the only thing there.

**`TimeSection` has eight rows, and row 7 is the HOLIDAY row.**
`SupportHoliday=true`, and on 3836 that row carries its own mask (`6`) while the
seven weekday rows carry `393222`. The cap's `RecordWindow` has a `day` of 0..6
and no holiday.

**Bits 17 and 18 have no name this repo can defend.** They are real, they are
set on every weekday row, and the obvious reading — two IVS or smart-motion
kinds — is a guess. The camera's own web UI would settle it and is a minified
seajs bundle that does not yield the enum; the decisive experiment (set one bit
alone and observe which event starts a recording) costs hours on live hardware.

## Decision

**A Dahua `TimeSection` mask is a SET of triggers, read bit by bit, and a bit
this repo cannot NAME is an unreadable window — counted, never guessed and never
dropped.** One slot becomes one `RecordWindow` per named bit; every unnamed bit,
every slot that will not parse, and every bit of the holiday row increments
`unreadableWindows`, which closes the schedule for writing by name (D391). Only
bits 0, 1 and 2 — `continuous`, `motion`, `alarmInput` — are named.

**A `configManager.cgi?action=setConfig` request names exactly ONE config
table.** A cap patch becomes one request per table, in order, each verified by
re-reading the key it wrote and comparing it to what was asked; success is the
read-back agreeing, and the body — never the status code — decides whether the
request itself was taken.

**Where the firmware holds one cap field in two independent places, the READ is
their agreement and the WRITE sets both.** `overwriteWhenFull` is
`MediaGlobal.OverWrite` and `StorageGroup[<ReadWrite>].OverWrite`; equal → that
value, different → `null`, which renders as "the camera did not say" rather than
a winner picked by CamStack. `enabled` is the conjunction of `RecordMode.Mode`
and `Record.Enable`, because either one off means nothing is recorded.

## Consequences

- **The schedule on 3836 is reported READ-ONLY today**, with 14 windows shown
  and 16 unreadable. That is the honest state, not a gap: two of its four
  triggers cannot be named, and writing the set back would delete them. The
  scalars — master switch, overwrite, pre-record, post-record, segment length —
  are all writable. To lift the schedule, name bits 17 and 18 in
  `TRIGGER_BY_BIT` and nothing else changes.
- **Day 0 is Sunday.** The Dahua CGI specification says so and every Dahua UI
  renders Sunday-first, but all seven weekday rows on 3836 are identical, so the
  assumption is unfalsifiable from this camera — exactly D608's position on
  Reolink's mask. `weekdayRowsAreUniform` names the case. To settle it: set one
  weekday only from the Amcrest app and re-read `Record`.
- **A write costs one request per table plus one full re-read.** Accepted: the
  alternative is reporting success for a table the camera never applied.
- **A schedule write rewrites every weekday slot and never the holiday row.** A
  day the new set does not mention is written back as `0 00:00:00-23:59:59` or
  the camera keeps recording on a day the operator just cleared; the holiday row
  is left alone because the cap cannot show it and must not delete it.
- **A day may hold six recording periods.** More than that cannot be written, so
  it is refused by name before the wire — `describeOnboardRefusal` has no way to
  express a per-day slot budget, and this is the one refusal that lives in the
  provider rather than the shared vocabulary.
- **Post-record is per EVENT HANDLER on Dahua**, not per channel. 3836 exposes
  exactly one (`MotionDetect[0]`; `SmartMotionDetect`, `AlarmLocal`,
  `VideoBlind` and `VideoLoss` all answer HTTP 400, and its single
  `VideoAnalyseRule` carries no `EventHandler`). Where several exist and
  disagree there is no single number, so the field reports `null` and says why
  rather than electing one handler's value.
- **`recordingToNowhere` gates on coverage, not on named windows.** A camera
  whose every trigger bit is unnameable is still recording, and gating on
  `windows.length` would hide the defect on exactly the camera that has it.
- **No videoclips.** This record covers settings only.

## Enforcement

- `packages/addon-provider-amcrest/src/__tests__/recording-onboard-mapping.spec.ts`
  — 53 tests against VERBATIM camera bytes in `__tests__/fixtures/` (the eight
  tables 3836 served on 2026-09-23, copied unedited).
- Twenty load-bearing gates were each verified by removing it, confirming RED,
  restoring byte-identically (`cmp`) and confirming GREEN, from a verified-green
  baseline, in the foreground. Failure counts: unnamed bit counted 4; holiday
  row counted 2; unparseable slot counted 1; `recordingToNowhere` on coverage 1;
  failed byte read null 1; two overwrite authorities 1; `enabled` conjunction 1;
  missing limits close the field 1; post-record disagreement 1; schedule closed
  while partly unread 2; `23:59:59` is 1440 2; unrepresentable seconds refused
  1; holiday row never written 2; overwrite written to both 2; `manual`
  preserved 1; per-day slot budget refused 1; triggers merge into one slot 1;
  row 0 is Sunday 2; `IsError` beats `Success` 1; no usable volume is `absent`
  2.
- Not enforced by a guard: that a future Dahua field is not added to an existing
  table's request when it belongs to another table. The cross-table drop is
  invisible in the syntax — the request is well-formed and the camera says `OK`.
  `AmcrestCgiClient.setConfig`'s doc comment carries the measurement; review
  only.
