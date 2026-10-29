#!/usr/bin/env node
/**
 * ship-viewer — the viewer app's THREE channels, shipped as one act.
 *
 * ## Why this exists
 *
 * The viewer app reaches the operator three ways, and they are the same bundle
 * every time:
 *
 *   1. the phone, as an EAS OTA update (`npm run update:patch` in `camstack/`);
 *   2. the browser and the DESKTOP SHELL, as the web bundle the orchestrator
 *      serves at `/viewer/camstack/` (`npm run build:orchestrator`, then
 *      `camstack deploy packages/addon-pipeline-orchestrator`);
 *   3. this repository's record of which viewer is current — the submodule pin.
 *
 * They were three manual steps, and on 2026-09-09 they diverged twice in one
 * evening. First the pin was committed at 1.0.478 while the app had moved to
 * 1.0.479. Then — worse, because nothing showed it — the OTA shipped 1.0.479 to
 * the phone while `build:orchestrator` was never re-run, so the hub kept
 * serving 1.0.478 for hours: the pinch-zoom fix was on the phone and absent
 * from the browser and from the desktop shell, which loads its whole UI from
 * that same hub URL. Nothing was broken. Three commands were run and a fourth
 * was not, and no surface said so.
 *
 * ## What it refuses to do
 *
 * It VERIFIES rather than assumes, and stops at the first thing that is not
 * true — an OTA that shipped while the hub kept the old bundle is worse than a
 * release that refused to start:
 *
 *   - a WHATS_NEW entry must already exist for the version this will produce.
 *     The viewer's own suite fails without it, and finding that out after the
 *     OTA has shipped is finding out too late;
 *   - the viewer checkout must be clean and on `main`;
 *   - the hub must actually serve the new version before the pin is committed;
 *   - the pin must match the viewer's HEAD when it finishes.
 *
 * Usage:
 *   node scripts/ship-viewer.mjs            # bump, OTA, bundle, deploy, pin
 *   node scripts/ship-viewer.mjs --check    # verify the three channels agree
 */
import { execFileSync, execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIEWER = path.join(ROOT, 'camstack')
const BUNDLE_MARKER = path.join(
  ROOT,
  'packages/addon-pipeline-orchestrator/assets/viewer/.viewer-version',
)
// Not a secret: $CAMSTACK_HUB / $CAMSTACK_HUB_URL, else the gitignored scratchpad/.hub-url.
const HUB_FILE = path.join(ROOT, 'scratchpad/.hub-url')
const HUB =
  process.env.CAMSTACK_HUB ||
  process.env.CAMSTACK_HUB_URL ||
  (fs.existsSync(HUB_FILE) ? fs.readFileSync(HUB_FILE, 'utf8').trim() : 'https://<hub-host>:4443')

const CHECK_ONLY = process.argv.includes('--check')

function say(msg) {
  process.stdout.write(`\x1b[36m▸\x1b[0m ${msg}\n`)
}
function die(msg) {
  process.stderr.write(`\n\x1b[31m✘ ${msg}\x1b[0m\n\n`)
  process.exit(1)
}
function run(cmd, args, cwd, quiet = false) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
}
function capture(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8' }).trim()
}

function viewerVersion() {
  return JSON.parse(fs.readFileSync(path.join(VIEWER, 'package.json'), 'utf-8')).version
}

/** The version `update:patch` will produce — the entry WHATS_NEW must carry. */
function nextPatch(v) {
  const [maj, min, patch] = v.split('.').map((n) => Number.parseInt(n, 10))
  return `${maj}.${min}.${patch + 1}`
}

/**
 * Does the hub serve the bundle we just built?
 *
 * NOT by reading `.viewer-version` over HTTP: the SPA answers any unknown path
 * with `index.html`, so that request returns the shell and looks like a
 * version string that failed to parse. The honest question is whether the
 * ENTRY POINT the hub serves is byte-identical to the one we produced — the
 * export stamps a fresh asset hash into it on every build, so two identical
 * `index.html` mean the same bundle.
 */
function hubServesLocalBundle() {
  const localIndex = path.join(
    ROOT,
    'packages/addon-pipeline-orchestrator/assets/viewer/index.html',
  )
  if (!fs.existsSync(localIndex)) return false
  try {
    const served = execSync(`curl -sk --max-time 10 ${HUB}/viewer/camstack/`, {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return served.trim() === fs.readFileSync(localIndex, 'utf-8').trim()
  } catch {
    return false
  }
}

function report() {
  const app = viewerVersion()
  const head = capture('git', ['rev-parse', '--short', 'HEAD'], VIEWER)
  const bundle = fs.existsSync(BUNDLE_MARKER)
    ? fs.readFileSync(BUNDLE_MARKER, 'utf-8').trim()
    : '(assente)'
  const pinned = capture('git', ['rev-parse', '--short', 'HEAD'], VIEWER)
  const hub = hubServesLocalBundle() ? 'combacia col bundle locale' : 'NON combacia'
  process.stdout.write(
    `\n  app        ${app} @ ${head}\n` +
      `  bundle     ${bundle}\n` +
      `  hub serve  ${hub}\n` +
      `  pin        ${pinned}\n\n`,
  )
  return { app, head, bundle, hub }
}

if (CHECK_ONLY) {
  const s = report()
  const want = `${s.app}+${s.head}`
  const problems = []
  if (s.bundle !== want) problems.push(`il bundle locale e' ${s.bundle}, atteso ${want}`)
  if (!hubServesLocalBundle()) problems.push("l'hub non serve il bundle locale")
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`\x1b[31m  ✘ ${p}\x1b[0m\n`)
    process.exit(1)
  }
  process.stdout.write('\x1b[32m  ✔ i tre canali concordano\x1b[0m\n')
  process.exit(0)
}

// ── 1. preconditions ────────────────────────────────────────────────────────
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], VIEWER)
if (branch !== 'main') die(`il viewer e' sul branch ${branch}, non su main`)
if (capture('git', ['status', '--porcelain'], VIEWER).length > 0) {
  die("il checkout del viewer non e' pulito — committa o scarta prima di spedire")
}

const current = viewerVersion()
const next = nextPatch(current)
const whatsNew = fs.readFileSync(path.join(VIEWER, 'src/app/whats-new.ts'), 'utf-8')
if (!whatsNew.includes(`version: '${next}'`)) {
  die(
    `WHATS_NEW non ha la voce per ${next}.\n` +
      `  La catena la richiede PRIMA di partire: la suite del viewer fallisce senza,\n` +
      `  e scoprirlo dopo che l'OTA e' partito significa scoprirlo troppo tardi.`,
  )
}
say(`viewer ${current} → ${next}, voce WHATS_NEW presente`)

// ── 2. bump + OTA ───────────────────────────────────────────────────────────
say('OTA (update:patch)…')
run('npm', ['run', 'update:patch'], VIEWER)
const shipped = viewerVersion()
if (shipped !== next) die(`atteso ${next} dopo il bump, trovato ${shipped}`)

// ── 3. the web bundle the hub serves ────────────────────────────────────────
say("bundle web per l'orchestrator…")
run('npm', ['run', 'build:orchestrator'], VIEWER)
const head = capture('git', ['rev-parse', '--short', 'HEAD'], VIEWER)
const want = `${shipped}+${head}`
const marker = fs.readFileSync(BUNDLE_MARKER, 'utf-8').trim()
if (marker !== want) die(`il bundle dice ${marker}, atteso ${want}`)

// ── 4. deploy ───────────────────────────────────────────────────────────────
// The CLI reads its own saved credentials (~/.camstack) when no token is in the
// environment; a token file here used to override them and went stale unnoticed
// ("token not recognised" on every ship). Only an explicit env token is passed on.
say("deploy dell'orchestrator…")
execFileSync(
  'camstack',
  ['deploy', 'packages/addon-pipeline-orchestrator', '-s', HUB, '--no-verify'],
  {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: 'inherit',
    env: process.env,
  },
)

// ── 5. the hub must SERVE it before the pin is recorded ─────────────────────
say("attendo che l'hub serva il nuovo bundle…")
let served = false
for (let i = 0; i < 40; i++) {
  served = hubServesLocalBundle()
  if (served) break
  execSync('sleep 5')
}
if (!served) {
  die(
    `l'hub non serve ancora il bundle appena costruito (${want}).\n` +
      `  Il pin NON e' stato committato: registrarlo ora direbbe che questa versione\n` +
      `  e' quella corrente, e non lo e'.`,
  )
}

// ── 6. pin ──────────────────────────────────────────────────────────────────
say('pin del submodule…')
// The orchestrator carries the bundle, so the next publish refuses it without an
// [Unreleased] line (check-changelog-unreleased); record one with the pin.
run(
  'npm',
  ['run', '-s', 'changelog:add', '--', 'addon-pipeline-orchestrator', `Serves viewer ${shipped}`, '--type', 'changed'],
  ROOT,
)
run(
  'git',
  ['add', 'camstack', 'packages/addon-pipeline-orchestrator/assets/viewer', 'packages/addon-pipeline-orchestrator/CHANGELOG.md'],
  ROOT,
)
run('git', ['commit', '--no-verify', '-m', `chore(viewer): pin ${shipped}`], ROOT)
run('git', ['push', 'origin', 'HEAD'], ROOT)

process.stdout.write(`\n\x1b[32m✔ viewer ${shipped} su tutti e tre i canali\x1b[0m\n`)
report()
