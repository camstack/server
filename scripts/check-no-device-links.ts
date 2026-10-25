#!/usr/bin/env tsx
/**
 * Wiring stays deleted — a cross-device derivation produces a DEVICE, never a
 * field on somebody else's device.
 *
 * ## What was deleted, and why it must not grow back
 *
 * `deviceLinks` let an operator copy one device's status field onto another
 * device's cap field: four source kinds, three transforms, a cycle guard, a
 * read-time overlay in the cap mount, a push re-emit walk in the state mirror,
 * and a FIFTH binding kind (`linked`) that existed only so a cap built entirely
 * from links would still render a panel.
 *
 * It worked. It was deleted on 2026-08-08 anyway, on a measurement — **0 links
 * across 302 devices**, a month after the UI shipped — and on four structural
 * reasons no polish fixes:
 *
 * 1. **No identity.** A wired value's only handle was
 *    `(targetDeviceId, cap, fieldPath)` on someone else's device. It could not
 *    be named, exported, gated or muted — and it made a second authority write
 *    a field the provider owns, the field-level form of the sin D62 bans at
 *    feature level.
 * 2. **Status only.** A mirrored switch showed its state and could not be
 *    switched. Half a device, permanently.
 * 3. **It cost the kernel a concept** — the fifth binding kind and the
 *    virtual-binding path, for one feature.
 * 4. **Expressiveness dead end.** Every real request past the expression engine
 *    (edge, debounce, for-duration, "and then call this") was a step toward a
 *    second language living in a device-meta blob.
 *
 * The replacement is a composed device: its caps are NATIVE to it, so it has a
 * name, an on/off authority, bindings, and it reaches HomeKit / Alexa / HA-MQTT
 * / the NC with no exporter change.
 *
 * ## What this checks
 *
 * 1. No source file declares a `deviceLinks` field or a `DeviceLink*` type.
 * 2. Nothing references the deleted machinery by name
 *    ({@link DELETED_SYMBOLS}) — a resurrected `resolveLinkedStatus` is the
 *    shape this is really guarding against.
 * 3. `DeviceBindingEntry.kind` does not regrow a `'linked'` member.
 *
 * Comments and this file are exempt: the design record must be able to NAME the
 * thing it deleted. Only declarations and imports count.
 *
 * Usage: tsx scripts/check-no-device-links.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Symbols of the deleted mechanism. A reference to any of them is a rebuild. */
const DELETED_SYMBOLS: readonly string[] = [
  'resolveLinkedStatus',
  'setDeviceLinks',
  'mergeLinkedStatus',
  'findDeviceLinkCycle',
  'buildLinkIndexes',
  'rebuildLinkDependents',
  'devicesWithLinks',
  'linkDependents',
  'snapshotForDeviceOverlayed',
  'allSnapshotsOverlayed',
  'overlayedSlice',
  'buildBatteryLinks',
  'persistBatteryLinks',
]

/**
 * The binding-kind union. `'linked'` was its fifth member.
 *
 * Matched on the declaration line only — `kind: 'native' | 'wrapped'` — so a
 * consumer comparing against a string it received is untouched.
 */
const BINDING_KIND_DECL = /kind:\s*(?:'native'|'wrapped'|'linked')(?:\s*\|\s*'[a-z]+')*/

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'assets') {
        continue
      }
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

function allSources(): readonly string[] {
  const files: string[] = []
  for (const root of ['packages', 'server', 'scripts']) sourceFiles(path.join(ROOT, root), files)
  return files.filter(
    (f) =>
      !f.includes(`${path.sep}generated${path.sep}`) &&
      path.basename(f) !== 'check-no-device-links.ts' &&
      // The boot migration DELETES the retired key, so it must be able to name it.
      path.basename(f) !== 'retired-settings-keys.ts' &&
      path.basename(f) !== 'retired-settings-keys.spec.ts',
  )
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

/** Strip line and block comments so prose can name what code may not. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function main(): void {
  const problems: Problem[] = []
  for (const file of allSources()) {
    const relative = rel(file)
    const code = codeOnly(fs.readFileSync(file, 'utf-8'))

    if (/\bdeviceLinks\s*[?:]/.test(code)) {
      problems.push({
        where: relative,
        what: 'declares a `deviceLinks` field',
        fix: 'a cross-device derivation produces a DEVICE (a block that declares one and registers its caps natively), not a field written onto someone else’s cap',
      })
    }
    const typeMatch = /\b(?:interface|type)\s+(DeviceLink[A-Za-z]*)\b/.exec(code)
    if (typeMatch) {
      problems.push({
        where: relative,
        what: `declares \`${typeMatch[1]}\``,
        fix: 'the expression engine and its binding shapes survive in `packages/types/src/expression/` — reuse `ExpressionSource` / `ExpressionBindingSource` instead of reintroducing a link type',
      })
    }
    for (const symbol of DELETED_SYMBOLS) {
      if (!new RegExp(`\\b${symbol}\\b`).test(code)) continue
      problems.push({
        where: relative,
        what: `references \`${symbol}\` — deleted with wiring on 2026-08-08`,
        fix: 'do not rebuild the overlay. If a value must come from another device, declare a composed device that reads it and owns its own caps',
      })
    }
    if (relative === 'packages/types/src/device/device-binding.ts' && /'linked'/.test(code)) {
      problems.push({
        where: relative,
        what: "`DeviceBindingEntry.kind` regrew a `'linked'` member",
        fix: 'a composed device’s caps are NATIVE to it — there is nothing to synthesize out of nowhere, so there is no fifth binding kind',
      })
    }
    if (relative === 'packages/types/src/device/device-binding.ts') {
      const decl = BINDING_KIND_DECL.exec(code)
      if (decl && decl[0].includes("'linked'")) {
        problems.push({
          where: relative,
          what: 'the binding-kind union lists `linked`',
          fix: "the union is `'native' | 'wrapped'`",
        })
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} device-link resurrection(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: wiring gave a derived value no identity and a second writer of a field the provider owns.',
    )
    process.exit(1)
  }
  console.log('  ✔ device-link wiring stays deleted')
}

main()
