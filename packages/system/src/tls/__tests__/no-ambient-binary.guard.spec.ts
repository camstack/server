/**
 * The hub's own TLS identity may not be a function of what is installed on
 * the machine (D551).
 *
 * `cert-openssl.ts` used to shell out to `openssl` three times. That made
 * the certificate the hub serves depend on which openssl the host happened
 * to ship, and this fleet already carries four of them: OpenSSL 3.6.2
 * (Homebrew), LibreSSL 3.3.6 (`/usr/bin/openssl` on macOS), OpenSSL 3.0.13
 * (the hub image) and OpenSSL 1.1.1f (the CI runner, Ubuntu 20.04).
 *
 * On 1.1.1 the `-addext` flags were ADDED to the extensions the ambient
 * `/etc/ssl/openssl.cnf` already contributes through `[req] x509_extensions
 * = v3_ca`, so the root came out with TWO `basicConstraints` and TWO
 * `subjectKeyIdentifier` extensions. RFC 5280 allows each extension at most
 * once; OpenSSL 3 — which is what `node:crypto` is — marks such a
 * certificate invalid, so `X509Certificate.ca` read `false` on our own root
 * and `checkIssued()` refused the pair. `evaluateExistingCert` then answered
 * `not-issued-by-local-ca` on every boot, which under D227 means: rotate the
 * root, every boot, forever, voiding every trust an operator granted by hand.
 *
 * So: no process is spawned from `src/tls/**`. This guard is here rather
 * than in `scripts/` because it reads exactly one package (D548).
 */
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const TLS_DIR = path.join(import.meta.dirname, '..')

/**
 * Every way a Node module can reach a binary on the host. Matched as bare
 * identifiers, not as call sites: the old code reached openssl through
 * `promisify(execFile)`, which no `execFile(` pattern would have caught.
 */
const SPAWN_PATTERN = /\b(execFile|execFileSync|execSync|spawnSync|spawn|fork)\b/

function tlsSourceFiles(): readonly string[] {
  return readdirSync(TLS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(TLS_DIR, name))
}

describe('tls generation is free of ambient binaries', () => {
  it('spawns no process from src/tls', () => {
    const offenders: string[] = []
    for (const file of tlsSourceFiles()) {
      const source = readFileSync(file, 'utf-8')
      if (SPAWN_PATTERN.test(source)) offenders.push(path.basename(file))
    }
    expect(offenders).toEqual([])
  })

  it('imports node:child_process nowhere in src/tls', () => {
    const offenders: string[] = []
    for (const file of tlsSourceFiles()) {
      if (readFileSync(file, 'utf-8').includes('node:child_process')) {
        offenders.push(path.basename(file))
      }
    }
    expect(offenders).toEqual([])
  })
})
