#!/usr/bin/env tsx
/**
 * There is ONE prebuffer configuration, and it lives in one file.
 *
 * ## The failure this catches
 *
 * Six names meant three things (D381). `preBufferEnabled` + `preBufferSec` kept
 * a source warm, `detectionPreRollMs` + `recordingPreRollMs` sized the history a
 * joiner is handed, and `RecordingBand.preBufferSec` restated the second pair in
 * the recorder's own units with an invariant ("never narrower than the ring")
 * the operator had to maintain by hand.
 *
 * The cost was measurable and it was measured. On the live hub, every warm
 * stream reported `preBufferSec: 10` and `preBufferMs: 0`: the seconds knob
 * sized an Annex-B ring that is never fed for an RTP source, so ten configured
 * seconds retained nothing at all — while the history that DID exist was sized
 * by two other numbers on a different settings screen. Three of the six knobs
 * could not agree about one camera because nothing required them to.
 *
 * The remedy is structural: `packages/addon-pipeline/src/stream-broker/prebuffer.ts`
 * is the only module allowed to define a prebuffer/pre-roll DURATION or a
 * warm-hold FLAG, and the broker is the only subsystem allowed to resolve one.
 * A rule nothing checks has already been broken somewhere, so this is the check.
 *
 * ## What it checks
 *
 * 1. No source file outside {@link DURATION_OWNERS} DECLARES an identifier
 *    matching {@link RETIRED_DECLARATIONS} — the shapes a second knob takes: a
 *    `preRollMs`-family field, a `resolve*PreRoll*` function, a
 *    `DEFAULT_*PRE_ROLL*` / `*_PRE_ROLL_MAX_*` constant.
 * 2. The retired capability/config KEYS (`recordingPreRollMs`,
 *    `detectionPreRollMs`) appear in no settings schema field key.
 * 3. `preBufferSec` does not reappear in the RECORDER or in the recording
 *    settings forms — the two subtrees the band-level duplicate lived in.
 *
 * Every check is a literal match on a declaration site — present or absent,
 * never a judgement call. Comments and doc prose are exempt: a record that
 * EXPLAINS the retired names is the point, and forbidding the words would make
 * this file illegal too.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')

/**
 * The only files that may define a prebuffer duration, a warm-hold flag, or the
 * migration off the retired ones.
 *
 * `pre-roll.ts` survives because what is left in it is MECHANISM — the keyframe
 * selection, the byte budget, the span bound — none of which is a configuration.
 * It is on this list so the mechanism can keep naming the window it cuts.
 */
const DURATION_OWNERS: readonly string[] = [
  'packages/addon-pipeline/src/stream-broker/prebuffer.ts',
  'packages/addon-pipeline/src/stream-broker/prebuffer-migration.ts',
  'packages/addon-pipeline/src/stream-broker/pre-roll.ts',
]

/**
 * Declaration shapes a SECOND knob would take. Matched at a declaration site
 * (`const X =`, `function X(`, `X:` in an interface or a zod object), never in
 * prose.
 */
const RETIRED_DECLARATIONS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'a resolver for a pre-roll duration',
    pattern: /(?:export\s+)?function\s+resolve\w*PreRoll\w*\s*\(/,
  },
  {
    // A DURATION, which is what D381/D382 are about — so the name must end in
    // the repo's millisecond suffix. Without that anchor the pattern also
    // matched `DEFAULT_MAX_PRE_ROLL_QUEUE_DEPTH`, which is a count of FRAMES
    // in one camera's lane (`runner.ts`), not a second opinion about how much
    // history exists. It went red on 2026-09-09 for exactly that, and a guard
    // that fails on a different unit teaches people to stop reading it.
    name: 'a default or ceiling constant for a pre-roll duration',
    pattern:
      /(?:export\s+)?const\s+(?:DEFAULT_\w*PRE_ROLL\w*_MS|\w*PRE_ROLL_(?:MAX|MIN)\w*_MS)\s*[:=]/,
  },
  {
    name: 'a per-consumer pre-roll field',
    pattern: /^\s*(?:readonly\s+)?(?:detection|recording)PreRollMs\??\s*[:?]/m,
  },
]

/**
 * The only file that may declare what a CONSUMER asks for (D382).
 *
 * The ask is not the retention — the prebuffer still decides how much history
 * exists — but it is the same class of number, and scattering it is the same
 * failure one layer down: a request constant in the recorder and another in the
 * runner is two places to disagree about one camera. It lives with the path
 * grammar that carries it, where writer and reader are already pinned together.
 */
const REQUEST_OWNER = 'packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts'

/** A pre-roll REQUEST constant, wherever somebody declares one. */
const REQUEST_DECLARATION = /(?:export\s+)?const\s+\w*PRE_ROLL_REQUEST\w*\s*[:=]/

/**
 * A dial helper called with ONE argument — an intent declared without an
 * amount.
 *
 * TypeScript already refuses it, which is the real guard; this catches the
 * shape returning through a re-export, a `.js` consumer or a future overload
 * with an optional second parameter. Absence of an amount used to mean the
 * whole retained window, so the failure mode of a silent default here is a
 * consumer served seconds of backlog it never asked for — measured on every
 * detection dial on the fleet between D381 and D382.
 */
const IMPLICIT_ASK = /with(?:Detection|Recording)Intent\(\s*[^,()]*\)/

/** Settings/field KEYS that named a second knob on a screen. */
const RETIRED_FIELD_KEYS: readonly string[] = [
  "key: 'preRollMs'",
  "key: 'recordingPreRollMs'",
  '`preRollMs:${',
  '`recordingPreRollMs:${',
]

/**
 * Subtrees where the word `preBufferSec` may not appear at all.
 *
 * The RECORDER and the recording settings forms: those are the two places the
 * band-level duplicate lived. Everywhere else the identifier is the broker
 * REPORTING what it holds (`BrokerStats.preBufferSec`), which is an
 * observation, not a second place to set the number — forbidding it there would
 * be forbidding the telemetry that makes the one knob checkable.
 */
const NO_BAND_PREBUFFER_SUBTREES: readonly string[] = [
  'packages/addon-pipeline/src/recorder/',
  'packages/ui-library/src/composites/cap-settings/',
]

function sourceFiles(): readonly string[] {
  return globSync('packages/*/src/**/*.{ts,tsx}', { cwd: ROOT })
    .filter((f) => !f.includes('/__tests__/'))
    .filter((f) => !f.includes('/dist/'))
}

/** Strip line and block comments so prose about the retired names is exempt. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function main(): void {
  const violations: string[] = []
  for (const file of sourceFiles()) {
    const rel = relative('.', file)
    const code = withoutComments(readFileSync(join(ROOT, file), 'utf8'))

    if (!DURATION_OWNERS.includes(file)) {
      for (const { name, pattern } of RETIRED_DECLARATIONS) {
        if (pattern.test(code)) {
          violations.push(
            `${rel}: declares ${name}. There is ONE prebuffer (D381) and it is configured in ` +
              `packages/addon-pipeline/src/stream-broker/prebuffer.ts. A consumer that needs ` +
              `history ASKS for it on its dial and is capped by what the ring holds — it does ` +
              `not carry a duration of its own.`,
          )
        }
      }
    }

    if (file !== REQUEST_OWNER && REQUEST_DECLARATION.test(code)) {
      violations.push(
        `${rel}: declares a pre-roll REQUEST constant. What a consumer asks for is declared ` +
          `once, in ${REQUEST_OWNER}, next to the path grammar that carries it (D382) — a ` +
          `second one is a second number about the same camera.`,
      )
    }

    if (IMPLICIT_ASK.test(code)) {
      violations.push(
        `${rel}: dials an intent WITHOUT stating how much history it asks for. An absent ask ` +
          `used to mean "the whole retained window", which is how every detection dial on the ` +
          `fleet came to be served a recording-sized backlog nobody had decided it needed ` +
          `(D382). Pass the amount — \`0\` is a legitimate, explicit "none".`,
      )
    }

    for (const key of RETIRED_FIELD_KEYS) {
      if (code.includes(key)) {
        violations.push(
          `${rel}: exposes the retired settings key ${key}. The prebuffer switch and its ` +
            `seconds (\`preBufferEnabled:\`/\`preBufferSec:\` per stream, \`defaultPreBufferSec\` ` +
            `cluster-wide) are the whole surface (D381).`,
        )
      }
    }

    if (
      NO_BAND_PREBUFFER_SUBTREES.some((dir) => file.startsWith(dir)) &&
      code.includes('preBufferSec')
    ) {
      violations.push(
        `${rel}: declares a \`preBufferSec:\` field. A recording band no longer carries a ` +
          `pre-buffer (D381): the keep gate is derived from the one prebuffer ceiling, so it ` +
          `cannot be configured narrower than the media the broker hands the writer.`,
      )
    }
  }

  if (violations.length > 0) {
    console.error('A SECOND prebuffer knob has reappeared:\n')
    for (const v of violations) console.error(`  - ${v}`)
    console.error(
      '\nSee docs/decisions/adr-0381-*.md. If the rule is wrong, change the record — ' +
        'do not add the knob back beside it.',
    )
    process.exit(1)
  }
  console.log('check-single-prebuffer-knob: ok — one prebuffer, one owner.')
}

main()
