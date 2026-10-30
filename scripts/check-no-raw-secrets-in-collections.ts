#!/usr/bin/env tsx
/**
 * A credential never sits in plain text in a persisted row (D879).
 *
 * ## The failure this catches
 *
 * D783/D797 keep every DECLARED config field in the keychain, and
 * `check-secret-fields-declared.ts` scans config SCHEMAS for credential-named
 * string fields. A secret an addon writes into a collection of its own (a
 * `declareCollection` table, a `ctx.settings` store, a hub-main builtin table)
 * is no config field: it is invisible to both, and was persisted in SQLite -
 * and in every database snapshot inside a backup - in plain text. Notifier
 * targets held bot tokens and webhook secrets that way for months.
 *
 * ## What it checks
 *
 * Every non-test `.ts` under `packages/*\/src` and `server/*\/src` that OWNS a
 * collection (it declares one, carries a `@durable` annotation, or exports a
 * `*_COLLECTION` constant), plus the row types such a file refers to by name
 * (a Zod schema or interface declared elsewhere). Inside those shapes, a
 * credential-named field (the name heuristic of `check-secret-fields-declared`,
 * used here only to FIND candidates) must either
 *
 *  - be typed as a keychain marker (`SecretMarker...`), or
 *  - be pinned in {@link ALLOWLIST} with the reason it is not a plaintext
 *    credential (a one-way hash, a public key, a lifetime, an identifier).
 *
 * Shapes inspected: Zod object properties (any value), interface / type-literal
 * members, column specs (`{ name: 'token', type: ... }`) and the keys of object
 * literals handed to a store write (`insert`, `update`, `upsert`, `set`...).
 *
 * Two more rules catch what no field name can show:
 *
 *  - `broker-rows`: an addon that persists `brokers` rows through
 *    `updateGlobalSettings({ brokers ... })` must keep their credentials in the
 *    keychain (`secretStatePaths` naming `brokers[`, or a config schema that
 *    declares them), or be listed in {@link RAW_UNTIL_RECORDS}.
 *  - `hidden-state`: a credential-named `this.state('...')` key must be named in
 *    the addon's `secretStatePaths`, or be listed in {@link RAW_UNTIL_RECORDS}.
 *
 * {@link RAW_UNTIL_RECORDS} is the census (D879): every credential that is STILL
 * plaintext today, with the records phase that moves it. The guard is green with
 * it and red for anything new; an entry whose evidence is gone fails too, so a
 * fixed row cannot leave a stale exemption behind. Both lists only shrink.
 *
 * Usage: npx tsx scripts/check-no-raw-secrets-in-collections.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { CREDENTIAL_NAME } from './check-secret-fields-declared.ts'

export type ShapeKind = 'zod' | 'type' | 'column' | 'write' | 'broker-rows' | 'hidden-state'

export interface RawSecretField {
  readonly file: string
  readonly key: string
  readonly kind: ShapeKind
}

/** `file#key` - how an allowlist entry names a finding. */
export function findingId(f: RawSecretField): string {
  return `${f.file}#${f.key}`
}

/** Pinned exceptions, each with the reason the field is not a plaintext credential. */
export const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([
  // -- one-way hashes and public halves: nothing to protect --
  ...[
    'packages/system/src/builtins/local-auth/auth-schema.ts',
    'packages/system/src/builtins/local-auth/record-kinds.ts',
    'packages/system/src/auth/legacy-token-tables.ts',
    'packages/types/src/schemas/auth-records.ts',
  ].flatMap((f) =>
    ['tokenHash', 'tokenPrefix'].map((k): [string, string] => [
      `${f}#${k}`,
      'SHA-256 of a token (or its 12-character display prefix); one-way, a leak exposes no live token',
    ]),
  ),
  ...[
    'packages/system/src/builtins/local-auth/auth-schema.ts',
    'packages/types/src/schemas/auth-records.ts',
  ].map((f): [string, string] => [`${f}#passwordHash`, 'bcrypt hash of a user password; one-way']),
  [
    'packages/system/src/auth/device-credential-manager.ts#credentialId',
    'id of a device credential row (public); the private key never leaves the device',
  ],
  [
    'packages/system/src/auth/login-session-manager.ts#credentialId',
    'id of the device credential a session was minted from (public)',
  ],
  [
    'packages/system/src/builtins/local-auth/record-kinds.ts#credentialId',
    'id of the device credential a session was minted from (public)',
  ],
  ...['scoped-tokens', 'admin-tokens', 'device-credentials', 'deviceCredentials'].map(
    (k): [string, string] => [
      `packages/system/src/builtins/local-auth/record-kinds.ts#${k}`,
      'a record kind definition / RecordKindHandle to auth rows, not a credential value',
    ],
  ),
  [
    'packages/system/src/auth/device-credential-manager.ts#deviceCredentialsKind',
    'records kind handle (typed store accessor), not a credential value',
  ],
  // -- a keychain marker, or the resolved view of a row that stores one --
  [
    'packages/system/src/builtins/local-auth/auth-schema.ts#secret',
    'user_totp.secret holds a keychain marker as JSON text (D878)',
  ],
  [
    'packages/system/src/auth/totp-manager.ts#secret',
    'in-memory view of a TOTP row: the seed is resolved from the keychain marker (D878)',
  ],
  [
    'packages/system/src/builtins/local-auth/record-kinds.ts#secret',
    'UserTotpBody, the resolved view of a `user-totp` row: its Zod field is `.meta({ secret: true })`, so the records layer stores a keychain marker (D878)',
  ],
  // -- request / response shapes, never a stored column --
  [
    'packages/system/src/auth/totp-manager.ts#secrets',
    'a SecretsAccess handle (keychain door), not a value',
  ],
  [
    'packages/types/src/interfaces/addon.ts#secrets',
    'a SecretsAccess handle (keychain door), not a value',
  ],
  [
    'packages/system/src/auth/user-manager.ts#password',
    'a create-user REQUEST field; stored only as passwordHash',
  ],
  [
    'packages/system/src/auth/user-manager.ts#resetPassword',
    'a flag name on an input shape, not a value',
  ],
  [
    'packages/system/src/auth/login-session-manager.ts#refreshToken',
    'returned to the client ONCE at mint / rotation; the row keeps refreshHash',
  ],
  [
    'packages/system/src/auth/device-credential-manager.ts#credential',
    'the issued certificate returned to the device; the private key stays on the device',
  ],
  [
    'packages/system/src/auth/device-ca.ts#privateKey',
    'an in-memory CryptoKey; the PEM is stored in the keychain (DEVICE_CA_KEY_REF)',
  ],
  [
    'packages/system/src/kernel/moleculer/mesh-mtls/mesh-ca.ts#privateKey',
    'an in-memory CryptoKey; the PEM is an owner-only file, not a collection',
  ],
  [
    'packages/addon-post-analysis/src/pipeline-analytics/tracking-bench/recorder/tape-pin-ledger.ts#pin',
    'a retention pin on a tape, not a credential',
  ],
  // -- LLM token COUNTS and limits --
  ['packages/types/src/capabilities/llm.cap.ts#maxTokens', 'a generation length bound'],
  ['packages/types/src/capabilities/llm.cap.ts#firstTokenTimeoutMs', 'a timeout'],
  ...[
    'packages/addon-ai/src/record-kinds.ts',
    'packages/addon-ai/src/usage/usage-store.ts',
    'packages/addon-ai/src/usage/usage-port.ts',
  ].flatMap((f) =>
    ['inputTokens', 'outputTokens'].map((k): [string, string] => [
      `${f}#${k}`,
      'a usage COUNT of LLM tokens',
    ]),
  ),
])

/**
 * The census of credentials that are STILL plaintext (D879): the work list of the
 * `ctx.records` migration, where a record kind's `.meta({ secret: true })` field
 * becomes a keychain marker automatically. Not an exemption to grow: a new raw
 * secret is a finding, not an entry.
 */
export interface RawCensusRow {
  readonly owner: string
  readonly where: string
  readonly field: string
  /** Records migration phase that moves it (proposed; 2 notifiers, 3 broker rows, 4 link-signing state). */
  readonly phase: 2 | 3 | 4
  readonly file: string
  /** Text that proves the row is still raw; if it disappears the entry is stale. */
  readonly evidence: RegExp
  /** Finding ids (`pkg:<dir>#brokers` for broker-rows, `file#key` for hidden-state) this row accounts for. */
  readonly covers: readonly string[]
}

export const RAW_UNTIL_RECORDS: readonly RawCensusRow[] = [
  // notifiers:notification-targets — migrated to records (phase 2, step 17).
  // The config blob may still hold plaintext adapter secrets (tokens, passwords)
  // at the records layer; a future phase will mark individual fields with
  // `.meta({ secret: true })` once the adapter config schemas can enumerate them.
  {
    owner: 'provider-homeassistant',
    where: 'addon-settings brokers[]',
    field: 'auth.accessToken, auth.supervisorToken',
    phase: 3,
    file: 'packages/addon-provider-homeassistant/src/addon.ts',
    evidence: /updateGlobalSettings\(\{\s*brokers/,
    covers: ['pkg:addon-provider-homeassistant#brokers'],
  },
  {
    owner: 'matter-broker',
    where: 'addon-settings brokers[]',
    field: 'connection.threadDataset, connection.wifiPassword',
    phase: 3,
    file: 'packages/addon-matter-broker/src/addon.ts',
    evidence: /updateGlobalSettings\(\{\s*brokers/,
    covers: ['pkg:addon-matter-broker#brokers'],
  },
  {
    owner: 'import-alexa',
    where: 'addon-settings brokers[]',
    field: 'connection.cookie, connection.refreshToken, connection.macDms',
    phase: 3,
    file: 'packages/addon-import-alexa/src/addon.ts',
    evidence: /updateGlobalSettings\(\{\s*brokers/,
    covers: ['pkg:addon-import-alexa#brokers'],
  },
  {
    owner: 'google-services',
    where: 'addon-settings brokers[] (+ legacy top-level clientSecret)',
    field: 'clientSecret',
    phase: 3,
    file: 'packages/addon-google-services/src/google-services.addon.ts',
    evidence: /updateGlobalSettings\(\{\s*brokers/,
    covers: ['pkg:addon-google-services#brokers'],
  },
  {
    owner: 'snapshot',
    where: 'addon-settings state snapshotLinkSecret',
    field: 'snapshotLinkSecret (HMAC key of signed snapshot links)',
    phase: 4,
    file: 'packages/system/src/builtins/snapshot/snapshot.addon.ts',
    evidence: /snapshotLinkSecret/,
    covers: ['packages/system/src/builtins/snapshot/snapshot.addon.ts#snapshotLinkSecret'],
  },
  {
    owner: 'pipeline-analytics',
    where: 'addon-settings state ncActionSecret, ncArtifactSecret',
    field: 'HMAC keys of notification action / artifact links',
    phase: 4,
    file: 'packages/addon-post-analysis/src/pipeline-analytics/index.ts',
    evidence: /ncActionSecret/,
    covers: [
      'packages/addon-post-analysis/src/pipeline-analytics/index.ts#ncActionSecret',
      'packages/addon-post-analysis/src/pipeline-analytics/index.ts#ncArtifactSecret',
    ],
  },
  {
    owner: 'homeassistant-export',
    where: 'addon-settings state haExportMediaSecret',
    field: 'haExportMediaSecret (HMAC key of media links)',
    phase: 4,
    file: 'packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts',
    evidence: /haExportMediaSecret/,
    covers: [
      'packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts#haExportMediaSecret',
    ],
  },
]

/** Packages whose broker rows are already keychain-backed by their config SCHEMA (a `password` item field). */
const BROKER_ROWS_SCHEMA_BACKED: ReadonlySet<string> = new Set(['pkg:addon-mqtt-broker#brokers'])

const OWNS_COLLECTION = /declareCollection|@durable|_COLLECTION\s*[:=]/
const MARKER_TYPE = /secretmarker|\$secret/i
/** A records kind field the engine stores as a keychain marker (D879). */
const ZOD_SECRET_META = /\.meta\(\s*\{[^}]*\bsecret\s*:\s*true/
const WRITE_CALLEES = new Set(['insert', 'update', 'upsert', 'set', 'setAll', 'write', 'mutate'])
const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'generated',
])

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, acc)
    else if (
      /\.tsx?$/.test(name) &&
      !/\.(spec|test)\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts') &&
      !/generated/.test(name)
    )
      acc.push(abs)
  }
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  for (const top of ['packages', 'server']) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    for (const pkg of readdirSync(dir)) {
      const src = join(dir, pkg, 'src')
      if (existsSync(src)) walk(src, files)
    }
  }
  return files
}

function propName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
}

function isZodObjectShape(obj: ts.ObjectLiteralExpression): boolean {
  const call = obj.parent
  return (
    ts.isCallExpression(call) &&
    /^z\s*\.\s*(object|looseObject|strictObject)$/.test(call.expression.getText())
  )
}

function isStoreWriteArg(obj: ts.ObjectLiteralExpression): boolean {
  let node: ts.Node = obj
  // `{ data: { ... } }` and `{ id, data: { ... } }` - climb out of a `data:` property.
  if (
    ts.isPropertyAssignment(node.parent) &&
    propName(node.parent.name) === 'data' &&
    ts.isObjectLiteralExpression(node.parent.parent)
  ) {
    node = node.parent.parent
  }
  const call = node.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return false
  const callee = call.expression
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : ''
  return WRITE_CALLEES.has(name)
}

function columnName(obj: ts.ObjectLiteralExpression): string | null {
  let name: string | null = null
  let hasType = false
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const key = propName(p.name)
    if (key === 'name' && ts.isStringLiteral(p.initializer)) name = p.initializer.text
    if (key === 'type') hasType = true
  }
  return hasType ? name : null
}

/** The credential-named fields of one parsed shape container, minus marker-typed ones. */
function shapeFields(sf: ts.SourceFile, root: ts.Node, file: string): RawSecretField[] {
  const out: RawSecretField[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const zod = isZodObjectShape(node)
      const write = !zod && isStoreWriteArg(node)
      const column = !zod && !write ? columnName(node) : null
      if (column !== null && CREDENTIAL_NAME.test(column)) {
        out.push({ file, key: column, kind: 'column' })
      }
      if (zod || write) {
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
          const key = propName(p.name)
          if (key === null || !CREDENTIAL_NAME.test(key)) continue
          const init = ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : ''
          if (MARKER_TYPE.test(init)) continue
          if (zod && ZOD_SECRET_META.test(init)) continue
          out.push({ file, key, kind: zod ? 'zod' : 'write' })
        }
      }
    } else if (ts.isPropertySignature(node) && node.name !== undefined) {
      const key = propName(node.name)
      if (
        key !== null &&
        CREDENTIAL_NAME.test(key) &&
        !MARKER_TYPE.test(node.type?.getText(sf) ?? '')
      ) {
        out.push({ file, key, kind: 'type' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return out
}

interface ParsedFile {
  readonly rel: string
  readonly sf: ts.SourceFile
  readonly owns: boolean
}

function topLevelDeclarations(sf: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const out = new Map<string, ts.Node>()
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.set(d.name.text, stmt)
      }
    } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      out.set(stmt.name.text, stmt)
    }
  }
  return out
}

export function scan(root: string): readonly RawSecretField[] {
  const parsed: ParsedFile[] = sourceFiles(root).map((abs) => {
    const text = readFileSync(abs, 'utf8')
    return {
      rel: relative(root, abs),
      sf: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      owns: OWNS_COLLECTION.test(text),
    }
  })
  // name -> declaring file, for row types declared next to (not in) the owner.
  const declared = new Map<string, { file: ParsedFile; node: ts.Node }>()
  for (const file of parsed) {
    for (const [name, node] of topLevelDeclarations(file.sf)) {
      if (/^[A-Z]/.test(name) && !declared.has(name)) declared.set(name, { file, node })
    }
  }
  const found = new Map<string, RawSecretField>()
  const add = (fields: readonly RawSecretField[]): void => {
    for (const f of fields) found.set(`${findingId(f)}:${f.kind}`, f)
  }
  for (const file of parsed) {
    if (!file.owns) continue
    add(shapeFields(file.sf, file.sf, file.rel))
    const referenced = new Set<string>()
    const collect = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && /^[A-Z]/.test(n.text)) referenced.add(n.text)
      ts.forEachChild(n, collect)
    }
    collect(file.sf)
    for (const name of referenced) {
      const decl = declared.get(name)
      if (decl === undefined || decl.file === file) continue
      add(shapeFields(decl.file.sf, decl.node, decl.file.rel))
    }
  }
  add(textRules(root, parsed))
  return [...found.values()]
}

/** The package directory name of a repo-relative path (`packages/<dir>/...`). */
function packageOf(rel: string): string {
  return rel.split('/')[1] ?? rel
}

const BROKER_WRITE = /updateGlobalSettings\(\s*\{\s*brokers/
const HIDDEN_STATE_KEY = /\.state(?:<[^>]*>)?\(\s*'([A-Za-z]+)'/g

/** Rules that read the source text: persisted broker rows and credential-named hidden state. */
function textRules(root: string, files: readonly ParsedFile[]): RawSecretField[] {
  const out: RawSecretField[] = []
  const packageText = new Map<string, string>()
  for (const f of files) {
    const pkg = packageOf(f.rel)
    packageText.set(pkg, `${packageText.get(pkg) ?? ''}\n${f.sf.text}`)
  }
  for (const f of files) {
    const pkg = packageOf(f.rel)
    const text = f.sf.text
    if (BROKER_WRITE.test(text)) {
      const declared = /secretStatePaths[\s\S]{0,600}?brokers\[/.test(packageText.get(pkg) ?? '')
      if (!declared) out.push({ file: `pkg:${pkg}`, key: 'brokers', kind: 'broker-rows' })
    }
    for (const m of text.matchAll(HIDDEN_STATE_KEY)) {
      const key = m[1]
      if (key === undefined || !CREDENTIAL_NAME.test(key)) continue
      const inPaths = new RegExp(`secretStatePaths[\\s\\S]{0,800}?['"\\.]${key}\\b`).test(text)
      if (!inPaths) out.push({ file: f.rel, key, kind: 'hidden-state' })
    }
  }
  void root
  return out
}

export interface GuardResult {
  /** Credential-named fields neither marker-typed, allowlisted nor in the census. */
  readonly raw: readonly RawSecretField[]
  /** Allowlist / census entries that match nothing any more - must be removed. */
  readonly stale: readonly string[]
}

function censusIds(census: readonly RawCensusRow[]): ReadonlySet<string> {
  return new Set(census.flatMap((row) => row.covers))
}

export function evaluate(
  findings: readonly RawSecretField[],
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
  census: readonly RawCensusRow[] = RAW_UNTIL_RECORDS,
  readFile: (rel: string) => string | null = () => null,
): GuardResult {
  const ids = new Set(findings.map(findingId))
  const covered = censusIds(census)
  const stale: string[] = [...allowlist.keys()].filter((id) => !ids.has(id) && !covered.has(id))
  for (const row of census) {
    const text = readFile(row.file)
    if (text !== null && !row.evidence.test(text)) stale.push(`census ${row.owner}: ${row.file}`)
    for (const id of row.covers) if (!ids.has(id)) stale.push(`census ${row.owner}: ${id}`)
  }
  return {
    raw: findings.filter(
      (f) =>
        !allowlist.has(findingId(f)) &&
        !covered.has(findingId(f)) &&
        !BROKER_ROWS_SCHEMA_BACKED.has(findingId(f)),
    ),
    stale: [...new Set(stale)],
  }
}

function main(): void {
  const root = process.cwd()
  const { raw, stale } = evaluate(scan(root), ALLOWLIST, RAW_UNTIL_RECORDS, (rel) => {
    const path = join(root, rel)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  })
  if (raw.length === 0 && stale.length === 0) {
    console.log('✔ no credential-named field of a persisted row is plaintext')
    return
  }
  for (const f of raw) {
    console.error(
      `✘ ${f.file}: '${f.key}' (${f.kind}) is a credential-named field of a persisted row`,
    )
  }
  for (const id of stale) console.error(`✘ stale allowlist entry (fixed - remove it): ${id}`)
  console.error(
    '\nStore a keychain marker (makeSecretMarker, bound to the row) or pin the field in ALLOWLIST with its reason (D879).',
  )
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-no-raw-secrets-in-collections.ts')) main()
