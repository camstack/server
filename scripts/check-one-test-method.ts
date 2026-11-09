#!/usr/bin/env tsx
/**
 * One connection test (planning#440 step 4, D1016).
 *
 * `integration-instances.testInstance` is the only way to ask "do these settings work?". A capability
 * method named `test…`, `verify…`, `check…`, `probe…`, `ping…` or `validate…Credentials` is a second connection test, so it is refused unless
 * it is in one of two lists below, each entry with the reason:
 *
 * - PERMANENT: it tests something that is not an instance's settings (a notification target, a rule,
 *   a login, a single creation-form field). It stays.
 * - PENDING: it tests an instance-shaped thing that has not moved to `testInstance` yet; it folds in
 *   at step 5/6 and the entry is deleted then. The pending list only shrinks.
 *
 * A listed method that no longer exists is an error too: remove the line.
 *
 * Textual: the `*.cap.ts` source is read, not run.
 *
 * Usage: npx tsx scripts/check-one-test-method.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const METHOD_RE =
  /^\s{2,4}((?:(?:test|verify|check|probe|ping)\w*|validate\w*Credentials))\s*:\s*(?:optionalMethod|method)\s*\(/
const ALLOWED = 'integration-instances.cap.ts:testInstance'

/** Key: `<cap file>:<method>`. Value: why it is not a connection test of an instance. */
export const PERMANENT: Readonly<Record<string, string>> = {
  'notification-output.cap.ts:testTarget':
    'sends a test notification to one target, not a settings check',
  'notification-rules.cap.ts:testRule': 'dry-runs a notification rule against an event',
  'user-management.cap.ts:validateCredentials': 'a user login, not an integration',
  'auth-provider.cap.ts:validateCredentials': 'a user login through an auth provider',
  'device-manager.cap.ts:testCreationField':
    'probes one creation-form field of a device that does not exist yet',
  'device-manager.cap.ts:testField': 'probes one field of an existing device',
  'storage-provider.cap.ts:testLocation':
    'the provider-level probe of one config that the storage instances call, not an instance test',
  'device-provider.cap.ts:testCreationField':
    'probes one creation-form field of a device that does not exist yet',
  'backup.cap.ts:checkBackupKey':
    'checks an encryption passphrase against an archive, not a connection',
  'device-manager.cap.ts:probeStreams':
    'measures the streams of one existing camera (codec, size), not settings',
  'notification-output.cap.ts:probeTargetConfig':
    'dry-runs the config of one notification target before it is saved, not an instance',
  'server-management.cap.ts:checkServerUpdate':
    'asks the registry whether a newer server version exists',
  'sso-bridge.cap.ts:verifyBridgeToken': 'verifies a signed bridge token of a user session',
  'stream-broker.cap.ts:probeStream':
    'probes one stream URL for its media info, not a connection test',
  'user-management.cap.ts:verifyTotp': 'verifies a one-time code of a user login',
}

/** Folds into `testInstance` at step 5/6 of planning#440; delete the entry then. */
export const PENDING: Readonly<Record<string, string>> = {}

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  readonly path: string
  readonly text: string
}

export interface Violation {
  readonly where: string
  readonly message: string
}

export function testMethodsOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const name = METHOD_RE.exec(line)?.[1]
    if (name !== undefined) out.push(name)
  }
  return out
}

export function findViolations(
  caps: readonly SourceFile[],
  permanent: Readonly<Record<string, string>> = PERMANENT,
  pending: Readonly<Record<string, string>> = PENDING,
): Violation[] {
  const out: Violation[] = []
  const seen = new Set<string>()
  for (const cap of caps) {
    const base = cap.path.slice(cap.path.lastIndexOf('/') + 1)
    for (const method of testMethodsOf(cap.text)) {
      const key = `${base}:${method}`
      seen.add(key)
      if (key === ALLOWED || permanent[key] !== undefined || pending[key] !== undefined) continue
      out.push({
        where: cap.path,
        message: `${method}: a second connection test. Use integration-instances.testInstance (the instance provider's \`test\` hook); a method that tests something else is listed with its reason in scripts/check-one-test-method.ts`,
      })
    }
  }
  for (const key of [...Object.keys(permanent), ...Object.keys(pending)]) {
    if (!seen.has(key)) {
      out.push({
        where: 'scripts/check-one-test-method.ts',
        message: `lists "${key}" but no such method exists: remove the line`,
      })
    }
  }
  return out
}

function main(): number {
  const files = execFileSync('git', ['ls-files', '*.cap.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '')
  const caps: SourceFile[] = files.map((f) => ({
    path: f,
    text: readFileSync(path.join(ROOT, f), 'utf8'),
  }))
  const violations = findViolations(caps)
  for (const v of violations) console.error(`check-one-test-method: ${v.where}: ${v.message}`)
  if (violations.length === 0) console.log('check-one-test-method: OK')
  return violations.length === 0 ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
