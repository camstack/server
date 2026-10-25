#!/usr/bin/env tsx
/**
 * D42 guard — the viewer has ONE recorded surface: the WebRTC track.
 *
 * Live, recorded playback and scrub are the same media track with a moving
 * source pointer (`TimelineSession` server-side, `RecordedTrackSession`
 * client-side). The failure class this construction removed — an open-but-mute
 * second surface needing a liveness proof, and a choreography of overlays and
 * deferred go-lives between two engines — reappears the moment any embed page
 * grows a client-side recorded DECODE tier again. Three deployed pull-model
 * attempts (sweep, push-as-a-tier, corrected choreography) each failed the
 * operator's field test before D42; this guard keeps the fourth from shipping
 * by accident.
 *
 * Rule: no file under the embed's `src/pages/` or `src/components/` may
 * reference a client recorded playback engine — the deleted module names, or a
 * client-side recorded audio scheduler. The byte-range scrub FALLBACK (keyframe
 * stills while no session exists) is allowed by name and remains D41's ladder.
 *
 * ## Where the surface lives, and why this guard CRASHED
 *
 * It was pinned to `packages/addon-pipeline/embed/**`, which no longer exists:
 * the embed moved into the viewer (`camstack/embed/`, a submodule) and the
 * Pipeline addon has no embed source or route any more. `readdirSync` on the
 * old path threw ENOENT, so the guard did not report a violation — it took the
 * whole CI guards step down with a stack trace, every run, for as long as CI
 * was disabled and nobody saw it.
 *
 * ## The submodule, stated plainly
 *
 * `ci.yml` checks out WITHOUT `submodules`, so on CI `camstack/` is empty and
 * this guard has nothing to read. It therefore reports SKIPPED, loudly, with
 * the reason — it does not pass quietly, because a guard that cannot see its
 * subject and says "OK" is how D42 regresses unnoticed, and it does not fail
 * either, because an unchecked-out submodule is not a D42 violation.
 * **To make this guard mean anything in CI, the checkout needs
 * `submodules: true`.** Until then it is a local/pre-commit guard.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOTS = ['camstack/embed/src/pages', 'camstack/embed/src/components']

/** Module names of the removed client recorded engine — must never return. */
const FORBIDDEN = [
  'webcodecs-playback-tier',
  'playback-engine',
  'video-pipeline',
  'audio-pipeline',
  'frame-ring',
  'playback-clock',
  'byte-range-loader',
]

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry)) yield p
  }
}

const present = ROOTS.filter((r) => existsSync(r))
if (present.length === 0) {
  console.log(
    'check-single-recorded-surface: SKIPPED — the viewer embed is not checked out ' +
      `(none of ${ROOTS.join(', ')} exists). This guard needs \`submodules: true\` on ` +
      'the CI checkout to mean anything; it is not asserting D42 right now.',
  )
  process.exit(0)
}

const offenders: string[] = []
for (const root of present) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    for (const name of FORBIDDEN) {
      if (src.includes(`/${name}`) || src.includes(`'${name}'`)) {
        offenders.push(`${file}: references ${name}`)
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('D42 violation — a second recorded surface is creeping back into the viewer:')
  for (const line of offenders) console.error(`  ${line}`)
  console.error(
    'Recorded playback and scrub ride the WebRTC track (RecordedTrackSession); ' +
      'the only client fallback is the byte-range scrub ladder. See docs/decisions/adr-0042.md.',
  )
  process.exit(1)
}
console.log('check-single-recorded-surface: OK')
