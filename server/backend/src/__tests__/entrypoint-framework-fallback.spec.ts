/**
 * The entrypoint seeds the framework ONLY when the closure is broken.
 *
 * The container entrypoint is shell inside the Dockerfile, so nothing else in
 * this repo can hold it to a rule. This test EXTRACTS the fallback block from
 * the real shipped text and runs it against a fake data root — a regression
 * fails here rather than on the next container recreate.
 *
 * It replaces `entrypoint-addon-seed.spec.ts`, whose subject no longer exists:
 * the bootstrap addon seed left the image on 2026-08-13 (operator: every
 * non-system addon single-copy, installed from npm at first boot). A test that
 * still described that block would read as verification of a tree nobody ships.
 *
 * What THIS one prevents is the other half of the same decision. `/data/framework`
 * used to be re-seeded whenever it was missing, so the post-boot single-copy
 * sweep could delete 509 MB and the next restart would put it straight back —
 * a second `@camstack/system` on `NODE_PATH`, for ever. The recreation is now
 * the explicit fallback for a closure that cannot boot, and it says so out loud.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DOCKERFILE = path.resolve(__dirname, '..', '..', '..', '..', 'Dockerfile')

/** The `if [ "$NEED_FRAMEWORK" = 1 ]; then … fi` block, verbatim from the image. */
function extractFallbackBlock(): string {
  const source = fs.readFileSync(DOCKERFILE, 'utf-8')
  const start = source.indexOf('DATA_ROOT_SYSTEM="$DATA_DIR/server-root/current')
  expect(start, 'the entrypoint no longer computes DATA_ROOT_SYSTEM').toBeGreaterThan(-1)
  const end = source.indexOf('\nfi', source.indexOf('if [ "$NEED_FRAMEWORK" = 1 ]; then', start))
  expect(end, 'unterminated NEED_FRAMEWORK block').toBeGreaterThan(start)
  return source.slice(start, end + 3)
}

describe('entrypoint — the image no longer carries a bootstrap addon seed', () => {
  it('has no addon seed tree, no COPY of one, and no bundled-addons env', () => {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')

    // `CAMSTACK_BUNDLED_ADDONS_DIR` is the one that must not survive alone: the
    // launcher resolves `installSource: 'local'` from it, so a leftover env
    // would send the bootstrap looking for a tree that is not in the image.
    expect(source).not.toContain('ENV CAMSTACK_BUNDLED_ADDONS_DIR')
    expect(source).not.toContain('COPY --from=fetch /opt/camstack-seed-addons')
    expect(source).not.toContain('NEED_ADDONS')
  })

  it('still ships ONE seed tree — the fallback a broken closure boots from', () => {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')
    // There used to be TWO: `/opt/camstack-hub` (the closure, also the CMD
    // entry) and a second framework-only tree built beside it purely to be
    // copied into `$FRAMEWORK_DIR` on the fallback boot. Measured 2026-08-25 it
    // was 510 MB duplicating what the first already held — `/opt/camstack-hub`
    // hoists `better-sqlite3`, `node-av`, `sharp` and `zod` at its root and
    // carries `@camstack/{sdk,system,types}` as dependencies of the server — and
    // it was the THIRD copy of every framework package, which is what made the
    // D45 inventory report three where the design allows two.
    expect(source).toContain('COPY --from=fetch /opt/camstack-hub /opt/camstack-hub')
    expect(source).not.toContain('camstack-seed-framework')
  })
})

describe('entrypoint framework fallback', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-entrypoint-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeClosureSystem(dataDir: string): void {
    const dir = path.join(dataDir, 'server-root', 'current', 'node_modules', '@camstack', 'system')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@camstack/system', version: '1.2.84' }),
    )
  }

  /**
   * Run the extracted block against a sandbox. The block hardcodes
   * `/opt/camstack-hub`, so the test rewrites that one prefix — the LOGIC under
   * test is the condition, not the literal path.
   */
  function runFallback(dataDir: string, seedDir: string): string {
    const block = extractFallbackBlock().replaceAll('/opt/camstack-hub', seedDir)
    // The trailing echo observes what the block EXPORTED into the boot
    // environment — the contract the single-copy sweep depends on: a healthy
    // boot must leave NODE_PATH empty or /data/framework is unremovable forever.
    const script =
      `set -e\nDATA_DIR="${dataDir}"\nFRAMEWORK_DIR="${dataDir}/framework"\n` +
      `SEED_VERSION=test\nRECORDED_VERSION=none\n${block}\n` +
      `echo "OBSERVED_NODE_PATH=<$NODE_PATH>"\n`
    return execFileSync('sh', ['-c', script], {
      encoding: 'utf-8',
      env: { PATH: process.env['PATH'] ?? '' },
    })
  }

  /**
   * A seed tree shaped like the real one: all THREE framework packages, plus a
   * package the fallback must NOT carry over.
   *
   * The single baked tree is `@camstack/server`'s own install, so it also holds
   * the server and every baked addon. The fallback narrows the `@camstack` scope
   * to system/types/sdk on purpose — copying it wholesale would plant a second
   * `@camstack/server` and `shm-ring` inside the framework dir, which is the
   * very shadowing D45 forbids and D184 removed.
   */
  function seedTree(): string {
    const seed = path.join(root, 'seed')
    for (const [name, version] of [
      ['system', '1.2.78'],
      ['types', '1.2.78'],
      ['sdk', '1.2.78'],
      ['server', '1.2.78'],
    ] as const) {
      const dir = path.join(seed, 'node_modules', '@camstack', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: `@camstack/${name}`, version }),
      )
    }
    return seed
  }

  it('does NOTHING when the closure is healthy — the tree the sweep removed stays removed', () => {
    const dataDir = path.join(root, 'data')
    writeClosureSystem(dataDir)

    const out = runFallback(dataDir, seedTree())

    expect(fs.existsSync(path.join(dataDir, 'framework'))).toBe(false)
    expect(out).not.toContain('FALLBACK')
    // The sweep's contract: a healthy boot exports NO framework NODE_PATH.
    expect(out).toContain('OBSERVED_NODE_PATH=<>')
  })

  it('seeds the framework, loudly, when the active closure has no @camstack/system', () => {
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })

    const out = runFallback(dataDir, seedTree())

    const seeded = path.join(dataDir, 'framework', 'node_modules', '@camstack', 'system')
    expect(fs.existsSync(path.join(seeded, 'package.json'))).toBe(true)
    expect(out).toContain('FALLBACK')
    expect(out).toContain('so this node can boot')
    // The seeded tree must be resolvable THIS boot: NODE_PATH exported.
    expect(out).toContain(`OBSERVED_NODE_PATH=<${path.join(dataDir, 'framework', 'node_modules')}>`)
  })

  it('carries system/types/sdk and leaves @camstack/server behind', () => {
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })

    runFallback(dataDir, seedTree())

    const scope = path.join(dataDir, 'framework', 'node_modules', '@camstack')
    expect(fs.readdirSync(scope).toSorted()).toEqual(['sdk', 'system', 'types'])
  })

  it('FAILS LOUDLY when the baked seed is missing a framework package', () => {
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    // A seed without `types`: the node would otherwise start and then fail
    // module resolution with an error that names nothing.
    const crippled = path.join(root, 'crippled')
    for (const name of ['system', 'sdk']) {
      const dir = path.join(crippled, 'node_modules', '@camstack', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: `@camstack/${name}` }),
      )
    }

    expect(() => runFallback(dataDir, crippled)).toThrow()
  })

  it('records the seed version it applied, so an image upgrade is still readable', () => {
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })

    runFallback(dataDir, seedTree())

    expect(fs.readFileSync(path.join(dataDir, '.camstack-seed-version'), 'utf-8')).toBe('test')
  })
})

describe('entrypoint ownership repair', () => {
  it('does not traverse the complete data volume during a normal restart', () => {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')

    expect(source).not.toContain(
      'chown -R camstack:camstack "$DATA_DIR" "$CONFIG_DIR" "$FRAMEWORK_DIR" "$ADDONS_DIR"',
    )
    expect(source).toContain('if [ "${CAMSTACK_REPAIR_PERMISSIONS:-0}" = "1" ]; then')
  })

  it('allows health probes enough time to start under CPU contention', () => {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')

    expect(source).toContain(
      'curl -fsSk --max-time 20 "https://localhost:${CAMSTACK_PORT:-4443}/health"',
    )
    expect(source).toContain('HEALTHCHECK --interval=30s --timeout=25s')
  })

  it('probes plain HTTP when the operator turned TLS off', () => {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')

    expect(source).toContain('[ "$CAMSTACK_TLS_ENABLED" != "true" ]')
    expect(source).toContain(
      'curl -fsS --max-time 20 "http://localhost:${CAMSTACK_PORT:-4443}/health"',
    )
  })
})

/**
 * The capability line. It exists because its ABSENCE cost a diagnosis: on
 * 2026-08-13 the agent was recreated on an image built from the commit that
 * carries the post-boot sweep, the sweep never ran, and no log said why — the
 * image installs `@camstack/server@latest` from npm, and the published 1.2.101
 * it got predates that commit. A backend change is train-bound by construction;
 * the entrypoint now says so out loud, before Node starts.
 */
describe('entrypoint — which backend is about to run', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backend-line-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function extractCapabilityBlock(): string {
    const source = fs.readFileSync(DOCKERFILE, 'utf-8')
    const start = source.indexOf('ACTIVE_SERVER="$DATA_DIR/server-root/current')
    expect(start, 'the entrypoint no longer names the backend it is about to run').toBeGreaterThan(
      -1,
    )
    const end = source.indexOf('\nfi', start)
    return source.slice(start, end + 3)
  }

  function writeServer(dir: string, version: string, withSweep: boolean): void {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version }),
    )
    if (withSweep) fs.writeFileSync(path.join(dir, 'dist', 'single-copy-cleanup.js'), '// sweep')
  }

  function run(dataDir: string, seedServer: string): string {
    const script =
      `set -e\nDATA_DIR="${dataDir}"\nCAMSTACK_SEED_SERVER_DIR="${seedServer}"\n` +
      `${extractCapabilityBlock()}\n`
    return execFileSync('sh', ['-c', script], { encoding: 'utf-8' })
  }

  it('names the closure version and reports the sweep PRESENT when it ships it', () => {
    const dataDir = path.join(root, 'data')
    writeServer(
      path.join(dataDir, 'server-root', 'current', 'node_modules', '@camstack', 'server'),
      '1.2.102',
      true,
    )
    const out = run(dataDir, path.join(root, 'seed-server'))

    expect(out).toContain('@camstack/server@1.2.102')
    expect(out).toContain('sweep PRESENT')
  })

  it('says the copies WILL REMAIN when the running backend predates the sweep', () => {
    const dataDir = path.join(root, 'data')
    writeServer(
      path.join(dataDir, 'server-root', 'current', 'node_modules', '@camstack', 'server'),
      '1.2.101',
      false,
    )
    const out = run(dataDir, path.join(root, 'seed-server'))

    expect(out).toContain('@camstack/server@1.2.101')
    expect(out).toContain('sweep ABSENT')
    expect(out).toContain('WILL REMAIN')
  })

  it('falls back to the baked seed server when there is no closure yet', () => {
    const seedServer = path.join(root, 'seed-server')
    writeServer(seedServer, '1.3.0', true)
    const out = run(path.join(root, 'data'), seedServer)

    expect(out).toContain('@camstack/server@1.3.0')
    expect(out).toContain(seedServer)
  })
})
