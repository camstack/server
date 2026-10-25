/**
 * A packaged desktop ships a bare bundled Node and NO npm — so `runNpm` uses
 * the bootstrapped npm, launched as `<bundled node> npm-cli.js`. npm then runs
 * every lifecycle script through `sh -c`, and `sh` looks `node` up on PATH.
 *
 * Measured 2026-09-13 on the Mac-mini agent, whose camstack process runs with
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`:
 *
 *   npm error command sh -c node install/check.js
 *   npm error sh: node: command not found
 *
 * The install died at exit 127 with no `better-sqlite3`, no `node-av` and no
 * werift patch. Under npm 12 the same host looked HEALTHY, because npm 12
 * blocks those scripts instead of running them — the closure just came out
 * quietly unpatched and the swap was refused with an unrelated-looking message.
 *
 * So the child needs one thing: a PATH on which `node` means the Node we are
 * already running.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNpmChildEnv } from '../npm-command.js'

const EXEC = '/Applications/camstack.app/Contents/Resources/node/bin/node'
const BIN = path.dirname(EXEC)

describe('buildNpmChildEnv', () => {
  it('puts the running Node first on PATH so lifecycle scripts can find it', () => {
    const env = buildNpmChildEnv({ PATH: '/usr/bin:/bin' }, EXEC)

    expect(env['PATH']).toBe(`${BIN}${path.delimiter}/usr/bin:/bin`)
  })

  it('works when the host has no PATH at all', () => {
    const env = buildNpmChildEnv({}, EXEC)

    expect(env['PATH']).toBe(BIN)
  })

  it('does not duplicate the directory when it is already first', () => {
    // Idempotent: a nested npm call must not grow PATH once per level.
    const env = buildNpmChildEnv({ PATH: `${BIN}${path.delimiter}/usr/bin` }, EXEC)

    expect(env['PATH']).toBe(`${BIN}${path.delimiter}/usr/bin`)
  })

  it('keeps every other variable untouched', () => {
    // npm needs the caller's registry/auth/proxy config; this function exists to
    // add one entry to PATH, not to curate the environment.
    const env = buildNpmChildEnv(
      { PATH: '/usr/bin', HOME: '/Users/x', npm_config_registry: 'r' },
      EXEC,
    )

    expect(env['HOME']).toBe('/Users/x')
    expect(env['npm_config_registry']).toBe('r')
  })
})
