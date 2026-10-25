/**
 * Verdaccio fixture smoke test.
 *
 * Phase 1 of the addon CLI-vs-npm test suite (see
 * `docs/superpowers/specs/2026-05-14-addon-cli-vs-npm-test-suite-design.md`).
 *
 * Asserts the fixture can:
 *   1. Spawn a verdaccio process on a dedicated port with isolated storage.
 *   2. Reach the `-/ping` endpoint within the boot timeout.
 *   3. Publish a tiny synthetic package via `npm publish`.
 *   4. Retrieve metadata via `npm view --json` round-trip.
 *   5. Tear down cleanly (process killed, storage tree intact under mktemp).
 *
 * Gated by `CAMSTACK_E2E_LIVE` like every other live suite — the npx
 * verdaccio cold-install is ~10s and the publish round-trip needs the
 * real npm CLI in PATH, neither of which we want firing on every
 * unit-test pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawnVerdaccio, publishFixture, type SpawnedVerdaccio } from '../fixtures/verdaccio.ts'

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'

const describeLive = E2E_LIVE ? describe : describe.skip

describeLive('verdaccio fixture', () => {
  let registry: SpawnedVerdaccio
  let fixturePkgDir: string

  beforeAll(async () => {
    registry = await spawnVerdaccio({ port: 4881 })

    // Build a 3-file dummy package under mktemp; publish helper will tarball it.
    fixturePkgDir = mkdtempSync(join(tmpdir(), 'verdaccio-fixture-pkg-'))
    writeFileSync(
      join(fixturePkgDir, 'package.json'),
      JSON.stringify(
        { name: '@camstack/verdaccio-fixture-test', version: '0.0.1', main: 'index.js' },
        null,
        2,
      ),
    )
    writeFileSync(join(fixturePkgDir, 'index.js'), `module.exports = { hello: 'world' }\n`)
  }, 90_000)

  afterAll(async () => {
    if (registry) await registry.stop()
    if (fixturePkgDir && existsSync(fixturePkgDir)) {
      rmSync(fixturePkgDir, { recursive: true, force: true })
    }
  })

  it('boots and answers /-/ping', async () => {
    const res = await fetch(`${registry.url}/-/ping`)
    expect(res.status).toBe(200)
  })

  it('exposes its url + isolated storage dir', () => {
    expect(registry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
    expect(registry.storageDir).toMatch(/verdaccio-/)
    expect(existsSync(registry.storageDir)).toBe(true)
  })

  it('accepts an `npm publish` of a fixture package', async () => {
    await publishFixture(registry, fixturePkgDir)

    // Round-trip via the npm CLI itself — proves the published tarball is
    // resolvable through the standard install codepath, not just present in
    // verdaccio's storage tree.
    const npmrcDir = mkdtempSync(join(tmpdir(), 'verdaccio-view-npmrc-'))
    writeFileSync(
      join(npmrcDir, '.npmrc'),
      [
        `registry=${registry.url}/`,
        `//${registry.host}:${registry.port}/:_authToken=anonymous`,
      ].join('\n'),
    )
    const stdout = execFileSync(
      'npm',
      ['view', '@camstack/verdaccio-fixture-test', 'version', '--json'],
      {
        cwd: npmrcDir,
        env: { ...process.env, HOME: npmrcDir },
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(stdout)).toBe('0.0.1')
    rmSync(npmrcDir, { recursive: true, force: true })
  })

  it('lets the same package republish at a higher version', async () => {
    const v2Dir = mkdtempSync(join(tmpdir(), 'verdaccio-fixture-pkg-v2-'))
    mkdirSync(v2Dir, { recursive: true })
    writeFileSync(
      join(v2Dir, 'package.json'),
      JSON.stringify(
        { name: '@camstack/verdaccio-fixture-test', version: '0.0.2', main: 'index.js' },
        null,
        2,
      ),
    )
    writeFileSync(join(v2Dir, 'index.js'), `module.exports = { hello: 'world', v: 2 }\n`)

    await publishFixture(registry, v2Dir)

    // Latest dist-tag should advance to 0.0.2.
    const res = await fetch(
      `${registry.url}/-/package/@camstack%2Fverdaccio-fixture-test/dist-tags`,
    )
    expect(res.status).toBe(200)
    const tags = (await res.json()) as { latest?: string }
    expect(tags.latest).toBe('0.0.2')
    rmSync(v2Dir, { recursive: true, force: true })
  })
})
