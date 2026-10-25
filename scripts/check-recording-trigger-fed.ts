#!/usr/bin/env tsx
/**
 * Trigger-fed guard (Traccia 0, D62) — every key of `RecordingTriggersSchema`
 * must have an `onTrigger(...)` call site that actually feeds it, or be
 * DECLARED as an exception in `UNFED_TRIGGER_KEYS` with a reason.
 *
 * ## The failure this closes
 *
 * `audioThresholdDbfs` shipped, was authorized by the UI, was read by every
 * pure decision function in `band-decision.ts`
 * (`eventsBandCanEverDemand`/`eventsBandDemanded`/`segmentRetainedForEvents`/
 * `segmentMissedByMs`/`eventsWindowCloseMs`) — and was fed by NOBODY. The
 * only `onTrigger` call site in production passed `'motion'`
 * (`recorder/addon/index.ts:1239`), and `subscribeEventCapture` exposed only
 * `onMotion`. A band listening SOLELY to audio passed
 * `eventsBandCanEverDemand` (the field was merely `!== undefined`) and never
 * recorded a single frame, forever, with no log line — the D62 shape, a
 * switch that writes a store nobody reads. `audioThresholdDbfs` is now fed
 * (`RecordingController.onAudioLevel`), but the plan this guard belongs to
 * adds TWO more trigger sources (object-detection, sensor) on top of this
 * same schema, and this is the guard that stops either from shipping as a
 * fourth dead knob.
 *
 * ## What it checks
 *
 * For every key of `RecordingTriggersSchema.shape`:
 *   - skip it if it is declared in `UNFED_TRIGGER_KEYS` (a dated, reasoned
 *     exception — see that constant's doc comment);
 *   - otherwise it must have an entry in `TRIGGER_KEY_TO_SOURCE_KIND` (the map
 *     from wire key to the internal `TriggerSource.kind` it feeds);
 *   - AND the recorder source tree (`packages/addon-pipeline/src/recorder/**`,
 *     excluding `__tests__`) must contain an actual `onTrigger(` call site
 *     constructing a source of that kind — i.e. production code, not a test
 *     fixture pretending to be one.
 *
 * ## Why a text scan and not a type-level check
 *
 * `TriggerSource` is a DISCRIMINATED OBJECT union since Traccia A1
 * (`{ kind: 'object', macroClass }`, `{ kind: 'sensor', sourceDeviceId }`), so
 * the scan matches the discriminant AT the call site — `onTrigger(deviceId,
 * { kind: 'object', … }, atMs)` — not a bare string argument. A type-level
 * exhaustiveness check on the union would prove every VARIANT is handled
 * somewhere in the type, not that any handler is reachable from an event a
 * device actually emits — which is exactly the gap `audioThresholdDbfs`
 * exploited: the type
 * checked, the reason a band could not record was a missing runtime call, not
 * a missing type. Same rationale as `check-recorded-still-off-delivery-path.ts`:
 * an import (here, a call site) is present or absent, no judgement, no false
 * positives — and a guard with false positives gets deleted.
 *
 * Usage: npx tsx scripts/check-recording-trigger-fed.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  RecordingConfigSchema,
  RecordingTriggersSchema,
} from '../packages/types/src/interfaces/recording-config.ts'
import {
  TRIGGER_KEY_TO_SOURCE_KIND,
  UNFED_TRIGGER_KEYS,
} from '../packages/addon-pipeline/src/recorder/addon/band-decision.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const RECORDER_SRC = path.join(ROOT, 'packages/addon-pipeline/src/recorder')

interface Failure {
  readonly key: string
  readonly reason: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

/** Does the recorder PRODUCTION source contain an `onTrigger(...)` call site
 *  building a `TriggerSource` of this `kind`? Comments are stripped first so a
 *  docblock example (e.g. this very file's) cannot fake a feed.
 *
 *  The argument is an OBJECT since Traccia A1, so the scan looks for the
 *  discriminant inside the call — `onTrigger(deviceId, { kind: 'object', … }`.
 *  `[^)]*` cannot cross a closing paren, so a `kind:` belonging to some other
 *  call further down the file cannot be borrowed by this one. */
function hasCallSite(corpus: string, kind: string): boolean {
  // `onSignalLevel` is the LEVEL feed (`RecordingTriggers.deviceSignal`): the
  // same discriminant at the call site, a hold/release instead of a timestamp.
  const pattern = new RegExp(`on(?:Trigger|SignalLevel)\\([^)]*kind:\\s*['"]${kind}['"]`)
  return pattern.test(corpus)
}

function main(): void {
  const files: string[] = []
  sourceFiles(RECORDER_SRC, files)
  if (files.length === 0) {
    console.error(
      '\x1b[31m✘ no recorder source files found — RECORDER_SRC has moved, fix this guard rather than deleting it\x1b[0m',
    )
    process.exit(1)
  }
  const corpus = files
    .map((file) => fs.readFileSync(file, 'utf8'))
    .map((src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '))
    .join('\n')

  const failures: Failure[] = []
  // Every authored key that CLAIMS a trigger source: the band trigger keys,
  // plus the whole-config ones (`deviceDecision` since D380 — a MODE is exactly
  // as able to ship as a dead knob as a trigger key was, and it would have lost
  // this coverage the moment it stopped being one).
  const configKeys = Object.keys(RecordingConfigSchema.shape).filter(
    (key) => TRIGGER_KEY_TO_SOURCE_KIND[key] !== undefined,
  )
  const keys = [...Object.keys(RecordingTriggersSchema.shape), ...configKeys]
  for (const key of keys) {
    if (UNFED_TRIGGER_KEYS.has(key)) continue
    const kind = TRIGGER_KEY_TO_SOURCE_KIND[key]
    if (kind === undefined) {
      failures.push({
        key,
        reason:
          'no TriggerSource.kind declared for it in TRIGGER_KEY_TO_SOURCE_KIND (band-decision.ts) — ' +
          'declare the mapping, or list the key in UNFED_TRIGGER_KEYS with a reason',
      })
      continue
    }
    if (!hasCallSite(corpus, kind)) {
      failures.push({
        key,
        reason:
          `TRIGGER_KEY_TO_SOURCE_KIND maps it to kind '${kind}', but no production ` +
          `onTrigger(…, { kind: '${kind}', … }, …) call site exists under ` +
          `${path.relative(ROOT, RECORDER_SRC)}/** — write the feed, ` +
          'or declare the key in UNFED_TRIGGER_KEYS with a reason',
      })
    }
  }

  if (failures.length === 0) {
    console.log(`\x1b[32m  ✔ every recording trigger key is fed (${keys.length} checked)\x1b[0m`)
    return
  }
  console.error(`\x1b[31m✘ ${failures.length} trigger key(s) declared but not fed\x1b[0m:`)
  for (const f of failures) {
    console.error(`    ${f.key}: ${f.reason}`)
  }
  console.error(
    '    → a band that listens ONLY to an unfed trigger key passes eventsBandCanEverDemand',
  )
  console.error(
    '      and never records, forever, with no log line. This is D62 (audioThresholdDbfs,',
  )
  console.error('      2026-08-26) — do not ship a second one.')
  process.exit(1)
}

main()
