#!/usr/bin/env tsx
/**
 * Every credential-named config field is DECLARED secret by its schema (D783).
 *
 * ## The failure this catches
 *
 * D634's non-admin redaction decided a device-config secret by key NAME, top
 * level only. UniFi / VeSync / Velux / Rademacher / Ecowitt / Unraid nest
 * their credentials under `connection.*` and went out whole; Tuya `localKey`
 * and Dreame `navigationAccessCode` match no keyword at all. The rule now is
 * that a schema declares its secrets — `.meta({ secret: true })` on a Zod
 * field, `type: 'password'` or `secret: true` on a config-UI field — and
 * everything that treats secrets specially (redaction now, the keychain
 * later) reads that declaration. A field the schema forgot to declare is
 * invisible to all of it, so this guard looks for fields whose NAME says
 * "credential" and whose schema does not.
 *
 * The name is used here only to FIND candidates for a human; it never decides
 * anything at runtime.
 *
 * ## What it checks
 *
 * Every non-test `.ts` under `packages/addon-*\/src` and
 * `packages/system/src/builtins`:
 *
 *   - a Zod object property whose value is a `z.string()` chain (also inside
 *     `z.preprocess`) and whose key looks like a credential, with no
 *     `.meta({ secret: true })` in the chain;
 *   - a config-UI field literal (`{ key: '…', type: 'text' | 'textarea' }`)
 *     whose key looks like a credential, with no `secret: true`.
 *
 * Findings not fixed are pinned in {@link ALLOWLIST} with a reason. The list
 * only shrinks: an entry that no longer matches fails too, so a fixed field
 * cannot leave a stale exemption behind.
 *
 * Usage: npx tsx scripts/check-secret-fields-declared.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/** Key names that LOOK like a credential (case-insensitive). Candidates only. */
export const CREDENTIAL_NAME =
  /(password|passwd|passphrase|secret|token|api_?key|local_?key|private_?key|access_?code|auth_?key|credential|cookie|pincode|pin$)/i

export interface UndeclaredField {
  readonly file: string
  readonly key: string
  readonly kind: 'zod' | 'config-ui'
}

/** `file#key` — how an allowlist entry names a finding. */
export function findingId(f: UndeclaredField): string {
  return `${f.file}#${f.key}`
}

/**
 * Pinned exceptions, each with the reason it is not (yet) declared. Keyed by
 * `file#key`. Adding to this list needs a reason a reviewer would accept;
 * removing from it is always welcome.
 */
export const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([
  // ── Not a secret: the name matches, the value is not a credential ──
  [
    'packages/addon-ai/src/client/list-models.ts#nextPageToken',
    'Gemini model-list pagination cursor in a parsed RESPONSE, not a credential',
  ],
  [
    'packages/addon-provider-onvif/src/onvif-camera.ts#profileToken',
    'ONVIF media-profile identifier (`Profile_1`), not a credential',
  ],
  [
    'packages/addon-provider-onvif/src/onvif-camera.ts#subProfileToken',
    'ONVIF media-profile identifier, not a credential',
  ],
  [
    'packages/system/src/builtins/system-config/system-config.addon.ts#tokenExpiry',
    'a session-token lifetime (e.g. `24h`), not a token',
  ],
  [
    'packages/system/src/builtins/system-config/system-config.addon.ts#accessTokenExpiry',
    'an access-token lifetime (e.g. `1h`), not a token',
  ],
  [
    'packages/addon-training/src/providers/modal/modal-entry-schema.ts#tokenId',
    'Modal token id (public half of the pair); the secret is `tokenSecret` (password field)',
  ],
  [
    'packages/addon-mqtt-broker/src/mqtt-broker.addon.ts#passwordHash',
    'a bcrypt hash (one-way), shown so the operator can paste one in; keychain P2 decides',
  ],
  [
    'packages/addon-export-alexa/src/handlers/data-controller.ts#nextToken',
    'Alexa pagination cursor, not a credential',
  ],
  [
    'packages/addon-export-alexa/src/handlers/error-envelope.ts#correlationToken',
    'Alexa directive correlation id, not a credential',
  ],
  [
    'packages/addon-export-alexa/src/handlers/types.ts#correlationToken',
    'Alexa directive correlation id, not a credential',
  ],
  // ── In flight, never a stored config field: request / action / wire shapes ──
  [
    'packages/addon-admin-ui/src/pages/EmbedPlayerPage.tsx#token',
    'embed bootstrap message from the host page; validated, never persisted',
  ],
  [
    'packages/addon-cloudflare/src/tunnel/cloudflare-actions.ts#token',
    'custom-action INPUT (the API token typed into the form, used for one call); the stored copy is `customApiToken`, a password field',
  ],
  [
    'packages/addon-export-alexa/src/handlers/types.ts#token',
    'Alexa directive bearer scope on the wire, validated per request, never persisted',
  ],
  [
    'packages/addon-export-alexa/src/handlers/broker-link-callback.ts#brokerCredential',
    'broker callback payload on the wire; the stored copy is hidden state — keychain P2 `secretStatePaths`',
  ],
  [
    'packages/addon-export-alexa/src/handlers/broker-link-callback.ts#lwaAccessToken',
    'broker callback payload on the wire; stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-export-alexa/src/handlers/lwa-tokens-callback.ts#lwaAccessToken',
    'LWA token-exchange response on the wire; stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-export-alexa/src/handlers/lwa-tokens-callback.ts#lwaRefreshToken',
    'LWA token-exchange response on the wire; stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-export-alexa/src/broker-client.ts#accessToken',
    'token-broker response on the wire; stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-export-alexa/src/broker-client.ts#brokerCredential',
    'token-broker response on the wire; stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-export-alexa/src/custom-actions.ts#ingressToken',
    'custom-action OUTPUT of the audited reveal; the stored copy is hidden state (keychain P2)',
  ],
  [
    'packages/addon-provider-bosch/src/shc/custom-actions.ts#systemPassword',
    'custom-action INPUT (the SHC system password typed into the form, used for one pairing call, never persisted); the form field itself is `type: password`',
  ],
  // ── Record kinds (D881): one-way digests and public identifiers ──
  [
    'packages/system/src/builtins/local-auth/record-kinds.ts#tokenHash',
    'SHA-256 digest of an admin token (one-way), the unique lookup index; the token itself is never stored',
  ],
  [
    'packages/system/src/builtins/local-auth/record-kinds.ts#tokenPrefix',
    'the 12-char display prefix (the token kind tag + 8 of 43 random chars) that lets an operator tell tokens apart; not enough to authenticate',
  ],
  [
    'packages/system/src/builtins/local-auth/record-kinds.ts#credentialId',
    'WebAuthn credential id of the passkey that opened a session: a public identifier the browser is sent in allowCredentials',
  ],
  [
    'packages/addon-auth/src/webauthn/record-kinds.ts#credentialId',
    'WebAuthn credential id: a public identifier (sent to the browser in allowCredentials); the passkey row holds only the PUBLIC key',
  ],
])

const ZOD_SECRET_META = /\.meta\(\s*\{[^}]*\bsecret\s*:\s*true/
const ZOD_STRING = /\bz\s*\.\s*string\s*\(/
const ZOD_CONTAINER = /^\s*z\s*\.\s*(array|record|object|enum|literal|union|tuple|map|set)\s*\(/

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function stringLiteralProp(obj: ts.ObjectLiteralExpression, prop: string): string | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propertyName(p.name) !== prop) continue
    const init = p.initializer
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text
    // `'password' as const`
    if (ts.isAsExpression(init) && ts.isStringLiteral(init.expression)) return init.expression.text
  }
  return null
}

function hasTrueProp(obj: ts.ObjectLiteralExpression, prop: string): boolean {
  return obj.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      propertyName(p.name) === prop &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  )
}

/** Is `obj` the argument of a `z.object({...})` / `z.looseObject` / `z.strictObject` call? */
function isZodObjectShape(obj: ts.ObjectLiteralExpression): boolean {
  const call = obj.parent
  if (!call || !ts.isCallExpression(call)) return false
  const callee = call.expression.getText()
  return /^z\s*\.\s*(object|looseObject|strictObject)$/.test(callee)
}

/** Scan one file's source. */
export function findUndeclaredSecretFields(file: string, text: string): readonly UndeclaredField[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: UndeclaredField[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      if (isZodObjectShape(node)) {
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p)) continue
          const key = propertyName(p.name)
          if (key === null || !CREDENTIAL_NAME.test(key)) continue
          const init = p.initializer.getText(sf)
          if (!ZOD_STRING.test(init) || ZOD_CONTAINER.test(init)) continue
          if (ZOD_SECRET_META.test(init)) continue
          out.push({ file, key, kind: 'zod' })
        }
      } else {
        const key = stringLiteralProp(node, 'key')
        const type = stringLiteralProp(node, 'type')
        if (
          key !== null &&
          (type === 'text' || type === 'textarea') &&
          CREDENTIAL_NAME.test(key) &&
          !hasTrueProp(node, 'secret')
        ) {
          out.push({ file, key, kind: 'config-ui' })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', '__mocks__', 'test', 'tests'])

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, acc)
    else if (/\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      acc.push(abs)
  }
}

/** Source roots that hold addon / driver config schemas. */
export function schemaSourceRoots(root: string): readonly string[] {
  const roots: string[] = []
  const pkgs = join(root, 'packages')
  for (const name of readdirSync(pkgs)) {
    if (!name.startsWith('addon-')) continue
    const src = join(pkgs, name, 'src')
    if (existsSync(src)) roots.push(src)
  }
  const builtins = join(pkgs, 'system', 'src', 'builtins')
  if (existsSync(builtins)) roots.push(builtins)
  return roots
}

export function scanRepo(root: string): readonly UndeclaredField[] {
  const files: string[] = []
  for (const dir of schemaSourceRoots(root)) walk(dir, files)
  const out: UndeclaredField[] = []
  for (const abs of files) {
    out.push(...findUndeclaredSecretFields(relative(root, abs), readFileSync(abs, 'utf8')))
  }
  return out
}

export interface GuardResult {
  /** Findings neither declared nor allowlisted. */
  readonly undeclared: readonly UndeclaredField[]
  /** Allowlist entries that no longer match anything — must be removed. */
  readonly stale: readonly string[]
}

export function evaluate(
  findings: readonly UndeclaredField[],
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
): GuardResult {
  const ids = new Set(findings.map(findingId))
  return {
    undeclared: findings.filter((f) => !allowlist.has(findingId(f))),
    stale: [...allowlist.keys()].filter((id) => !ids.has(id)),
  }
}

function main(): void {
  const { undeclared, stale } = evaluate(scanRepo(process.cwd()))
  if (undeclared.length === 0 && stale.length === 0) {
    console.log('✔ every credential-named config field is declared secret by its schema')
    return
  }
  for (const f of undeclared) {
    console.error(
      `✘ ${f.file}: '${f.key}' (${f.kind}) looks like a credential but is not declared secret`,
    )
  }
  for (const id of stale) console.error(`✘ stale allowlist entry (fixed — remove it): ${id}`)
  console.error(
    "\nDeclare it: `.meta({ secret: true })` on a Zod field, `type: 'password'` or `secret: true` on a config-UI field (D783).",
  )
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-secret-fields-declared.ts')) main()
