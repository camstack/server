#!/usr/bin/env tsx
/**
 * Intercom rate-conversion wiring — the seam a unit test cannot reach.
 *
 * ## What this guards
 *
 * `TalkPcmTranscoder` is unit-tested hard (it owns the feed, so those tests
 * assert on what reaches the camera transport). What no unit test can assert
 * is that the two PROVIDERS actually route through it, because constructing a
 * `HikvisionCamera` / `ReolinkCamera` means constructing the whole
 * `DeviceContext` — the sibling specs in both packages take the same view.
 *
 * The wiring is exactly where the original defect lived: the drop branch was
 * duplicated word-for-word in two 4 000-line camera files, and the copy is how
 * it stayed identical and unnoticed. So this checks the three points a
 * regression would touch, per provider:
 *
 *   1. The drop message is GONE. A file that still says "PCM-only resample not
 *      implemented" has an unconverted path, whatever else it also does.
 *   2. `startTalkSession` builds a `TalkPcmTranscoder` for the session.
 *   3. `endTalkSession` closes it. A codec session that outlives its talk
 *      session is the leak `opusDecode` already had a teardown for.
 *
 * It also holds the two copies of the transcoder itself byte-identical. Addons
 * never import each other (`ctx.api` is the only cross-addon layer), so the
 * file is duplicated per package the way `IntercomAudioCodecApi` and the two
 * intercom orchestrators already are. Duplication is the accepted cost here;
 * DIVERGENCE is not, and it is what actually bites — the drop branch proved it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** The phrase that means a raw-PCM frame is being thrown away for its rate. */
const DROP_MARKER = 'PCM-only resample not implemented'

interface ProviderUnderGuard {
  readonly label: string
  /** The camera file that registers the `intercom` cap. */
  readonly camera: string
  /** That package's copy of the transcoder. */
  readonly transcoder: string
}

const PROVIDERS: readonly ProviderUnderGuard[] = [
  {
    label: 'hikvision',
    camera: 'packages/addon-provider-hikvision/src/hikvision-camera.ts',
    transcoder: 'packages/addon-provider-hikvision/src/intercom/talk-pcm-transcoder.ts',
  },
  {
    label: 'reolink',
    camera: 'packages/addon-provider-reolink/src/reolink-camera.ts',
    transcoder: 'packages/addon-provider-reolink/src/talk-pcm-transcoder.ts',
  },
]

const errors: string[] = []

function read(rel: string): string {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) {
    errors.push(`missing file: ${rel}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

/** Brace-matched body of a named property of the `intercom` cap provider. */
function capMethodBody(source: string, method: string, rel: string): string {
  const start = source.indexOf(`${method}: async (`)
  if (start === -1) {
    errors.push(`${rel}: no \`${method}\` on the intercom provider`)
    return ''
  }
  const open = source.indexOf('{', source.indexOf('=>', start))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  errors.push(`${rel}: \`${method}\` body is not closed`)
  return ''
}

for (const provider of PROVIDERS) {
  const camera = read(provider.camera)
  if (camera === '') continue

  // 1 — the drop is gone.
  if (camera.includes(DROP_MARKER)) {
    errors.push(
      `${provider.camera}: still carries the rate-mismatch DROP ("${DROP_MARKER}"). ` +
        'A raw-PCM frame at the wrong rate must be converted through the ' +
        '`audio-codec` cap, or refused with a reason — never dropped silently.',
    )
  }

  // 2 — a transcoder is built with the talk session.
  const start = capMethodBody(camera, 'startTalkSession', provider.camera)
  if (start !== '' && !start.includes('new TalkPcmTranscoder(')) {
    errors.push(
      `${provider.camera}: \`startTalkSession\` does not build a TalkPcmTranscoder — ` +
        'the raw-PCM path has no rate conversion.',
    )
  }

  // 3 — and it dies with the talk session.
  const end = capMethodBody(camera, 'endTalkSession', provider.camera)
  if (end !== '' && !end.includes('pcmTranscode.close()')) {
    errors.push(
      `${provider.camera}: \`endTalkSession\` does not close the PCM transcoder — ` +
        'its `audio-codec` session outlives the talk session that owns it.',
    )
  }
}

// 4 — the two copies have not drifted.
const copies = PROVIDERS.map((p) => ({ label: p.transcoder, source: read(p.transcoder) }))
const [first, second] = copies
if (first !== undefined && second !== undefined && first.source !== '' && second.source !== '') {
  if (first.source !== second.source) {
    errors.push(
      `TalkPcmTranscoder has DRIFTED between packages:\n  ${first.label}\n  ${second.label}\n` +
        'Addons never import each other, so the file is duplicated — keep the copies identical.',
    )
  }
}

if (errors.length > 0) {
  console.error('✖ intercom rate-refusal guard failed:\n')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('✓ both intercom providers convert raw PCM by rate, and tear the session down')
