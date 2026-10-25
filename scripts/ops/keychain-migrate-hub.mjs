#!/usr/bin/env node
// ONE-OFF, OPERATOR-RUN: move the plaintext secrets a pre-keychain hub still
// stores into the keychain (D787). Not shipped in any package — the product
// has no migration code; this script is the only migrator, and it is run once,
// by the operator, against the operator's hub.
//
// It never prints a secret value: only paths, refs, counts and ids.
//
// It talks to the hub's admin API with the operator's OWN session: run
// `camstack login <host>` once as an admin (the shared resolver renews it;
// --token-file is an explicit override only). Every write goes through the product's normal OPERATOR write
// paths, which store a sent secret in the keychain and leave a marker:
//   addon settings    addonSettings.updateGlobalSettings
//   device configs    deviceManager.persistConfig      (unstamped = operator)
//   integrations      integrations.setSettings         (unstamped = operator)
//
// Steps (run in this order; each is safe to re-run):
//   plan       (default) dry run — the inline secrets that WOULD move, by path.
//   backup     trigger a manual system backup, wait for it, record its id.
//   apply      --backup-id <id>  move them; then delete the stale
//              system-settings rows auth.jwtSecret / auth.adminPassword /
//              auth.adminUsername / cluster.secret.
//   import-system   (D797) the hub's OWN secrets that used to come from env /
//              config.yaml, into the keychain — each only if it is set:
//                --values-file <f>   KEY=VALUE lines (0600, deleted by you
//                                    after): CAMSTACK_JWT_SECRET — the value
//                                    the hub container had in its environment.
//                                    (There is no cluster secret to import
//                                    since D857; a CAMSTACK_CLUSTER_SECRET
//                                    line is read and ignored.)
//                --config-yaml <f>   the hub's config.yaml (as mounted on the
//                                    host): its auth.jwtSecret is imported and
//                                    the retired auth.* keys are REMOVED from
//                                    the file.
//              The session signing key → keychainAdmin.setSystemSecret.
//              env wins over config.yaml, exactly as the hub resolved it.
//   mqtt       (D797) decrypt mqtt-broker's retired `enc:v1` passwords and
//              store them through the operator write path (→ keychain).
//              Needs the old key: --mqtt-key-file <copy of
//              /data/addons-data/mqtt-broker/.secret-key> or
//              CAMSTACK_SECRET_KEY in --values-file. Run it whenever convenient
//              after the release: mqtt-broker reads the enc:v1 values
//              read-only with its .secret-key meanwhile.
//   verify     re-scan: no inline secret left, keychain ready, refs in use.
//   plaintext-backups   list the most recent backups taken BEFORE the
//              migration (they hold the plaintext). With
//              --delete <destinationId>:<backupId> ... --confirm it deletes
//              exactly those, and nothing else.
//
//   node scripts/ops/keychain-migrate-hub.mjs
//        [plan|backup|apply|import-system|mqtt|verify|plaintext-backups]
//        [--hub https://<hub-host>:4443] [--token-file <file>]
//        [--state scratchpad/keychain-migration-state.json] [--json]
//
// Exit codes: 0 done · 1 refused / something left to do · 2 a read failed
// (a failed read proves nothing — it is never "nothing to migrate").
import { resolveHubAuth } from '../hub/credentials.mjs'
import { createDecipheriv, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

// ── Hidden state declared in code (`secretStatePaths`). Keep in sync with the
//    addons; the form-declared secrets come from each addon's own schema. ─────
export const SECRET_STATE_PATHS = {
  'export-alexa': [
    'ingressToken',
    'snapshotSigningKey',
    'tokens[userId].accessToken',
    'tokens[userId].refreshToken',
    'tokens[userId].brokerCredential',
  ],
  'export-hap': ['identity.pincode'],
  'cloudflare-tunnel': ['customTunnelToken'],
  'provider-reolink': ['emailPushAuthPassword'],
}

/**
 * mqtt-broker's `enc:v1` values are NOT moved by `apply` (it would store the
 * ciphertext): the `mqtt` step decrypts them first.
 */
export const SKIPPED_ADDONS = new Set(['mqtt-broker'])

/**
 * Stale rows nothing reads any more (D675, D797); deleted (after a backup),
 * never migrated by `apply`. `cluster.secret` held the cluster secret, which
 * no longer exists (D857): it is deleted, not imported.
 */
export const STALE_SYSTEM_ROWS = [
  'auth.jwtSecret',
  'auth.adminPassword',
  'auth.adminUsername',
  'cluster.secret',
]

/** config.yaml `auth.*` keys retired by D797; removed from the file by `import-system`. */
export const RETIRED_AUTH_CONFIG_KEYS = ['jwtSecret', 'adminUsername', 'adminPassword']

// ── Pure helpers (exercised by scripts/__tests__/keychain-migrate-hub.spec.ts) ─

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isMarker(v) {
  return isRecord(v) && typeof v.$secret === 'string' && v.$secret.length > 0
}

function isKeychainField(field) {
  if (!isRecord(field)) return false
  const secret = field.type === 'password' || field.secret === true
  const jsonBlob = field.type === 'textarea' && field.isJson === true
  return secret && !jsonBlob && field.storage !== 'inline'
}

/**
 * Secret paths a (hydrated) settings schema declares by TYPE, in
 * `secretStatePaths` syntax: `key`, `arr[idKey].member`.
 */
export function secretPathsFromSchema(schema) {
  const out = []
  const walk = (fields) => {
    for (const f of Array.isArray(fields) ? fields : []) {
      if (!isRecord(f)) continue
      if (f.type === 'group') walk(f.fields)
      else if (f.type === 'sub-tabs') for (const t of f.tabs ?? []) walk(t?.fields)
      else if (f.type === 'editable-array') {
        const idKey = typeof f.itemIdKey === 'string' ? f.itemIdKey : 'id'
        for (const item of f.itemFields ?? []) {
          if (isKeychainField(item) && typeof item.key === 'string') {
            out.push(`${f.key}[${idKey}].${item.key}`)
          }
        }
      } else if (isKeychainField(f) && typeof f.key === 'string') out.push(f.key)
    }
  }
  for (const s of isRecord(schema) && Array.isArray(schema.sections) ? schema.sections : []) {
    walk(s?.fields)
  }
  return out
}

/** `a.b[id].c` → segments; `[]` (a device path) means `[id]`. */
export function parsePath(p) {
  return p
    .replace(/\[\]/g, '[id]')
    .split('.')
    .map((seg) => {
      const m = /^([^[\]]+)(?:\[([^[\]]+)\])?$/.exec(seg)
      if (!m) throw new Error(`malformed path ${p}`)
      return m[2] ? { key: m[1], idKey: m[2] } : { key: m[1] }
    })
}

/**
 * Every INLINE (non-empty string, not a marker) secret under `blob` at
 * `paths`, as `{ topKey, path }` — the top-level key a write must carry and a
 * printable path. Never the value.
 */
export function inlineSecrets(blob, paths) {
  const found = []
  const visit = (value, segs, topKey, printed) => {
    if (segs.length === 0) {
      if (typeof value === 'string' && value.length > 0) found.push({ topKey, path: printed })
      return
    }
    const [head, ...rest] = segs
    const next = isRecord(value) ? value[head.key] : undefined
    const label = printed === '' ? head.key : `${printed}.${head.key}`
    if (head.idKey === undefined) return visit(next, rest, topKey, label)
    if (!Array.isArray(next)) return
    for (const row of next) {
      const id = isRecord(row) ? row[head.idKey] : undefined
      visit(row, rest, topKey, `${label}[${String(id ?? '?')}]`)
    }
  }
  for (const p of paths) {
    const segs = parsePath(p)
    // A perNode key is stored as `<key>@<node>`: check every scoped copy too.
    const top = segs[0].key
    const keys = Object.keys(isRecord(blob) ? blob : {}).filter(
      (k) => k === top || k.startsWith(`${top}@`),
    )
    for (const k of keys) visit({ [k]: blob[k] }, [{ ...segs[0], key: k }, ...segs.slice(1)], k, '')
  }
  return found
}

/** The patch that re-sends every top-level key holding an inline secret, as stored. */
export function migrationPatch(blob, found) {
  const patch = {}
  for (const { topKey } of found) patch[topKey] = blob[topKey]
  return patch
}

// ── D797 helpers: env-file values, config.yaml, the retired mqtt codec ───────

/** `KEY=VALUE` lines (`#` comments, optional quotes). Never logged. */
export function parseValuesFile(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[key] = value
  }
  return out
}

/**
 * The hub's own secrets, as the pre-D797 hub resolved them: env over
 * config.yaml for the signing key. `null` when not set anywhere. There is no
 * cluster secret to carry over (D857).
 */
export function resolveSystemSecrets({ values = {}, configAuth = {} }) {
  const nonEmpty = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
  return {
    jwtSigningKey: nonEmpty(values.CAMSTACK_JWT_SECRET) ?? nonEmpty(configAuth.jwtSecret),
  }
}

/** The `auth` section of a config.yaml object without the retired credential keys. */
export function stripRetiredAuthKeys(config) {
  if (!isRecord(config) || !isRecord(config.auth)) return { config, removed: [] }
  const auth = { ...config.auth }
  const removed = []
  for (const key of RETIRED_AUTH_CONFIG_KEYS) {
    if (key in auth) {
      delete auth[key]
      removed.push(`auth.${key}`)
    }
  }
  const next = { ...config }
  if (Object.keys(auth).length === 0) delete next.auth
  else next.auth = auth
  return { config: next, removed }
}

const MQTT_ENC_PREFIX = 'enc:v1:'
const MQTT_KEY_BYTES = 32
const MQTT_SCRYPT_SALT = Buffer.from('camstack-mqtt-broker:v1', 'utf-8')

/** The retired mqtt codec's key from `CAMSTACK_SECRET_KEY` (base64 32 bytes, else scrypt). */
export function mqttKeyFromMaterial(material) {
  const decoded = Buffer.from(material, 'base64')
  if (
    decoded.length === MQTT_KEY_BYTES &&
    decoded.toString('base64').replace(/=+$/, '') === material.replace(/=+$/, '')
  ) {
    return decoded
  }
  return scryptSync(material, MQTT_SCRYPT_SALT, MQTT_KEY_BYTES)
}

/** The retired mqtt codec's key from its `.secret-key` file bytes. */
export function mqttKeyFromFile(bytes) {
  return bytes.length === MQTT_KEY_BYTES
    ? Buffer.from(bytes)
    : mqttKeyFromMaterial(bytes.toString('utf-8'))
}

export function isMqttCiphertext(value) {
  return typeof value === 'string' && value.startsWith(MQTT_ENC_PREFIX)
}

/** Decrypt one `enc:v1:<iv>:<tag>:<ct>` value (AES-256-GCM, no AAD). Throws on a bad key. */
export function decryptMqttValue(ciphertext, key) {
  if (!isMqttCiphertext(ciphertext)) throw new Error('not an enc:v1 value')
  const parts = ciphertext.slice(MQTT_ENC_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('malformed enc:v1 value')
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'))
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed enc:v1 value')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}

/** The printable paths of mqtt-broker's blob still holding `enc:v1` values. */
export function mqttCiphertextPaths(blob) {
  const paths = []
  for (const row of Array.isArray(blob?.brokers) ? blob.brokers : []) {
    if (isRecord(row) && isMqttCiphertext(row.password))
      paths.push(`brokers[${String(row.id ?? '?')}].password`)
  }
  if (isMqttCiphertext(blob?.embeddedPassword)) paths.push('embeddedPassword')
  return paths
}

/**
 * The mqtt-broker patch: `brokers` re-sent whole with every `enc:v1` password
 * decrypted (markers and the rest exactly as stored), plus `embeddedPassword`
 * when it is one. Returns the printable paths moved — never a value.
 */
export function mqttMigrationPatch(blob, key) {
  const patch = {}
  const paths = []
  if (Array.isArray(blob?.brokers)) {
    let touched = false
    const brokers = blob.brokers.map((row) => {
      if (!isRecord(row) || !isMqttCiphertext(row.password)) return row
      touched = true
      paths.push(`brokers[${String(row.id ?? '?')}].password`)
      return { ...row, password: decryptMqttValue(row.password, key) }
    })
    if (touched) patch.brokers = brokers
  }
  if (isMqttCiphertext(blob?.embeddedPassword)) {
    patch.embeddedPassword = decryptMqttValue(blob.embeddedPassword, key)
    paths.push('embeddedPassword')
  }
  return { patch, paths }
}

function readPrivateFile(file) {
  const mode = statSync(file).mode & 0o077
  if (mode !== 0) console.error(`warning: ${file} is readable by group/others — chmod 600 it`)
  return readFileSync(file)
}

// ── Hub client (operator token; never logs bodies) ───────────────────────────

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = out[key] === undefined ? next : [].concat(out[key], next)
      i++
    }
  }
  return out
}

function makeClient(hub, token) {
  return async function call(method, route, input) {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    let url = `${hub}/trpc/${route}`
    const opt = { method, headers }
    if (method === 'POST') opt.body = JSON.stringify({ json: input })
    else if (input !== undefined)
      url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
    const res = await fetch(url, opt)
    const body = await res.json()
    if (body?.error) {
      // The error text is the hub's; it names the route, never a value we sent.
      throw new Error(`${route}: ${String(body.error?.json?.message ?? 'error').slice(0, 300)}`)
    }
    return body?.result?.data?.json
  }
}

const GET = 'GET'
const POST = 'POST'

async function inventory(call) {
  const addons = (await call(GET, 'addons.list')) ?? []
  const addonItems = []
  for (const a of addons) {
    const addonId = a?.manifest?.id
    if (typeof addonId !== 'string' || SKIPPED_ADDONS.has(addonId)) continue
    let schema
    try {
      schema = await call(GET, 'addonSettings.getGlobalSettings', { addonId })
    } catch {
      addonItems.push({ addonId, error: 'schema unreadable (addon not running?)' })
      continue
    }
    const paths = [...secretPathsFromSchema(schema), ...(SECRET_STATE_PATHS[addonId] ?? [])]
    if (paths.length === 0) continue
    const blob =
      (await call(GET, 'settingsStore.get', {
        namespace: addonId,
        collection: 'addon-settings',
        key: 'root',
      })) ?? {}
    const found = inlineSecrets(blob, paths)
    if (found.length > 0) addonItems.push({ addonId, blob, found })
  }

  const devices = (await call(GET, 'deviceManager.listAll', {})) ?? []
  const deviceItems = []
  for (const d of devices) {
    const paths = Array.isArray(d?.secretConfigPaths) ? d.secretConfigPaths : []
    if (paths.length === 0 || !isRecord(d.config)) continue
    const found = inlineSecrets(d.config, paths)
    if (found.length > 0)
      deviceItems.push({ deviceId: d.id, addonId: d.addonId, paths, config: d.config, found })
  }

  const integrations = (await call(GET, 'integrations.list')) ?? []
  const integrationItems = []
  for (const i of integrations) {
    let schema
    try {
      schema = await call(GET, 'addonSettings.getGlobalSettings', { addonId: i.addonId })
    } catch {
      continue
    }
    const keys = secretPathsFromSchema(schema).filter((p) => !p.includes('['))
    if (keys.length === 0) continue
    const settings = (await call(GET, 'integrations.getSettings', { id: i.id })) ?? {}
    const found = inlineSecrets(settings, keys)
    if (found.length > 0)
      integrationItems.push({ integrationId: i.id, addonId: i.addonId, settings, keys, found })
  }

  const staleRows = []
  for (const key of STALE_SYSTEM_ROWS) {
    const row = await call(GET, 'settingsStore.get', { collection: 'system-settings', key })
    if (row !== undefined && row !== null) staleRows.push(key)
  }
  return { addonItems, deviceItems, integrationItems, staleRows }
}

function printPlan(inv, json) {
  const lines = {
    addonSettings: inv.addonItems.map((x) => ({
      addonId: x.addonId,
      ...(x.error ? { error: x.error } : { paths: x.found.map((f) => f.path) }),
    })),
    deviceConfigs: inv.deviceItems.map((x) => ({
      deviceId: x.deviceId,
      addonId: x.addonId,
      paths: x.found.map((f) => f.path),
    })),
    integrations: inv.integrationItems.map((x) => ({
      integrationId: x.integrationId,
      addonId: x.addonId,
      paths: x.found.map((f) => f.path),
    })),
    staleSystemSettingsRows: inv.staleRows,
    notMovedHere: [...SKIPPED_ADDONS].map((a) => `${a} (keeps its own codec)`),
  }
  if (json) {
    console.log(JSON.stringify(lines, null, 2))
    return
  }
  for (const a of lines.addonSettings) {
    console.log(`addon    ${a.addonId}: ${a.error ?? a.paths.join(', ')}`)
  }
  for (const d of lines.deviceConfigs)
    console.log(`device   ${d.deviceId} (${d.addonId}): ${d.paths.join(', ')}`)
  for (const i of lines.integrations)
    console.log(`integr.  ${i.integrationId} (${i.addonId}): ${i.paths.join(', ')}`)
  for (const r of lines.staleSystemSettingsRows)
    console.log(`stale    system-settings ${r} (deleted, not migrated)`)
  const n =
    lines.addonSettings.reduce((s, a) => s + (a.paths?.length ?? 0), 0) +
    lines.deviceConfigs.reduce((s, d) => s + d.paths.length, 0) +
    lines.integrations.reduce((s, i) => s + i.paths.length, 0)
  console.log(
    `\n${n} inline secret(s) to move; ${lines.staleSystemSettingsRows.length} stale row(s) to delete.`,
  )
}

function readState(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function waitForRun(call, runId) {
  for (let i = 0; i < 720; i++) {
    const runs = (await call(GET, 'backup.listRuns')) ?? []
    const run = runs.find((r) => r.id === runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.state)) return run
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error(`backup run ${runId} did not finish within an hour`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const step = args._[0] ?? 'plan'
  // The hub URL is not a secret: --hub, else $CAMSTACK_HUB_URL, else the
  // gitignored scratchpad/.hub-url that scripts/hub/hub.mjs reads too.
  const hubFile = path.resolve('scratchpad/.hub-url')
  const hub =
    typeof args.hub === 'string'
      ? args.hub
      : process.env.CAMSTACK_HUB_URL ||
        (existsSync(hubFile) ? readFileSync(hubFile, 'utf8').trim() : '')
  if (!hub) {
    console.error(
      'no hub URL: pass --hub https://<hub-host>:4443, set CAMSTACK_HUB_URL, or write scratchpad/.hub-url',
    )
    process.exit(1)
  }
  const stateFile =
    typeof args.state === 'string'
      ? args.state
      : path.resolve('scratchpad/keychain-migration-state.json')
  // The hub serves a self-signed certificate.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  // The operator's `camstack login` session (admin), via the shared resolver;
  // --token-file is an explicit override only.
  const auth = await resolveHubAuth({
    server: hub,
    ...(typeof args['token-file'] === 'string' ? { tokenFile: args['token-file'] } : {}),
  })
  const call = makeClient(hub, auth.token)
  const state = readState(stateFile)

  if (step === 'plan') {
    printPlan(await inventory(call), args.json === true)
    return 0
  }

  if (step === 'backup') {
    const label = `pre-keychain-migration-${Date.now()}`
    const result = await call(POST, 'backup.trigger', { label })
    const runId = result?.runId
    console.log(`backup run ${runId} started (${label}); waiting…`)
    const run = await waitForRun(call, runId)
    if (run.state !== 'succeeded') {
      console.error(`backup run ended ${run.state} — do not apply`)
      return 1
    }
    const entries = (await call(GET, 'backup.list')) ?? []
    const entry = entries
      .filter((e) => e.label === label)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    writeState(stateFile, {
      ...state,
      backup: {
        label,
        runId,
        backupId: entry?.id,
        destinationId: entry?.destinationId,
        at: Date.now(),
      },
    })
    console.log(`backup ${entry?.destinationId}:${entry?.id} recorded in ${stateFile}`)
    return 0
  }

  if (step === 'apply') {
    const backupId =
      typeof args['backup-id'] === 'string' ? args['backup-id'] : state.backup?.backupId
    const entries = (await call(GET, 'backup.list')) ?? []
    if (!backupId || !entries.some((e) => e.id === backupId)) {
      console.error(
        'refusing: no verified backup — run `backup` first (or pass --backup-id of an existing one)',
      )
      return 1
    }
    const status = await call(GET, 'keychainAdmin.status', {})
    if (status?.keychain?.state !== 'ready') {
      console.error(
        `refusing: the keychain is ${status?.keychain?.state} (${status?.keychain?.reason ?? ''})`,
      )
      return 1
    }
    const inv = await inventory(call)
    let moved = 0
    for (const a of inv.addonItems) {
      if (a.error) continue
      await call(POST, 'addonSettings.updateGlobalSettings', {
        addonId: a.addonId,
        patch: migrationPatch(a.blob, a.found),
      })
      moved += a.found.length
      console.log(`moved    addon ${a.addonId}: ${a.found.map((f) => f.path).join(', ')}`)
    }
    for (const d of inv.deviceItems) {
      await call(POST, 'deviceManager.persistConfig', {
        deviceId: d.deviceId,
        data: migrationPatch(d.config, d.found),
        secretConfigPaths: d.paths,
      })
      moved += d.found.length
      console.log(`moved    device ${d.deviceId}: ${d.found.map((f) => f.path).join(', ')}`)
    }
    for (const i of inv.integrationItems) {
      await call(POST, 'integrations.setSettings', {
        id: i.integrationId,
        settings: migrationPatch(i.settings, i.found),
        secretKeys: i.keys,
      })
      moved += i.found.length
      console.log(
        `moved    integration ${i.integrationId}: ${i.found.map((f) => f.path).join(', ')}`,
      )
    }
    for (const key of inv.staleRows) {
      await call(POST, 'settingsStore.delete', { collection: 'system-settings', key })
      console.log(`deleted  system-settings ${key}`)
    }
    writeState(stateFile, { ...state, migratedAt: Date.now(), moved })
    console.log(`\n${moved} secret(s) moved. Next: restart the hub once, then run \`verify\`.`)
    return 0
  }

  if (step === 'import-system') {
    const values =
      typeof args['values-file'] === 'string'
        ? parseValuesFile(readPrivateFile(args['values-file']).toString('utf-8'))
        : {}
    const configFile = typeof args['config-yaml'] === 'string' ? args['config-yaml'] : null
    let configObj = null
    let yamlLib = null
    if (configFile !== null) {
      yamlLib = await import('js-yaml')
      configObj = yamlLib.load(readFileSync(configFile, 'utf-8')) ?? {}
    }
    const found = resolveSystemSecrets({
      values,
      configAuth: isRecord(configObj?.auth) ? configObj.auth : {},
    })
    const status = await call(GET, 'keychainAdmin.status', {})
    if (status?.keychain?.state !== 'ready') {
      console.error(
        `refusing: the keychain is ${status?.keychain?.state} (${status?.keychain?.reason ?? ''})`,
      )
      return 1
    }
    if (found.jwtSigningKey !== null) {
      await call(POST, 'keychainAdmin.setSystemSecret', {
        name: 'jwt-signing-key',
        value: found.jwtSigningKey,
      })
      console.log('imported the session signing key (sessions signed by the old hub stay valid)')
    } else {
      console.log(
        'no session signing key set in env or config.yaml — the hub keeps the one it generated',
      )
    }
    if (configFile !== null && yamlLib !== null) {
      const { config: stripped, removed } = stripRetiredAuthKeys(configObj)
      if (removed.length > 0) {
        const tmp = `${configFile}.tmp`
        writeFileSync(
          tmp,
          yamlLib.dump(stripped, { lineWidth: 120, indent: 2, quotingType: '"' }),
          {
            mode: statSync(configFile).mode & 0o777,
          },
        )
        renameSync(tmp, configFile)
        console.log(`removed ${removed.join(', ')} from ${configFile}`)
      }
    }
    writeState(stateFile, { ...readState(stateFile), systemImportedAt: Date.now() })
    console.log(
      'Next: remove CAMSTACK_JWT_SECRET / CAMSTACK_CLUSTER_SECRET (retired) / CAMSTACK_ADMIN_* / CAMSTACK_SECRET_KEY from the container template, delete the values file, run `apply` (deletes the stale rows), restart.',
    )
    return 0
  }

  if (step === 'mqtt') {
    let key = null
    if (typeof args['values-file'] === 'string') {
      const values = parseValuesFile(readPrivateFile(args['values-file']).toString('utf-8'))
      if (typeof values.CAMSTACK_SECRET_KEY === 'string')
        key = mqttKeyFromMaterial(values.CAMSTACK_SECRET_KEY)
    }
    if (key === null && typeof args['mqtt-key-file'] === 'string')
      key = mqttKeyFromFile(readPrivateFile(args['mqtt-key-file']))
    if (key === null) {
      console.error(
        'refusing: no old mqtt key — pass --mqtt-key-file <copy of .secret-key> or CAMSTACK_SECRET_KEY in --values-file',
      )
      return 1
    }
    const status = await call(GET, 'keychainAdmin.status', {})
    if (status?.keychain?.state !== 'ready') {
      console.error(
        `refusing: the keychain is ${status?.keychain?.state} (${status?.keychain?.reason ?? ''})`,
      )
      return 1
    }
    const blob =
      (await call(GET, 'settingsStore.get', {
        namespace: 'mqtt-broker',
        collection: 'addon-settings',
        key: 'root',
      })) ?? {}
    let migration
    try {
      migration = mqttMigrationPatch(blob, key)
    } catch (err) {
      console.error(
        `refusing: an enc:v1 value did not decrypt with that key (${err instanceof Error ? err.message : 'error'}) — nothing written`,
      )
      return 1
    }
    if (migration.paths.length === 0) {
      console.log('no enc:v1 value left in mqtt-broker')
      return 0
    }
    await call(POST, 'addonSettings.updateGlobalSettings', {
      addonId: 'mqtt-broker',
      patch: migration.patch,
    })
    console.log(`moved    mqtt-broker: ${migration.paths.join(', ')}`)
    console.log(
      'Next: restart mqtt-broker and check every broker connects; THEN delete /data/addons-data/mqtt-broker/.secret-key on the hub and your local copy.',
    )
    return 0
  }

  if (step === 'verify') {
    const status = await call(GET, 'keychainAdmin.status', {})
    const inv = await inventory(call)
    const left =
      inv.addonItems.filter((a) => !a.error).reduce((s, a) => s + a.found.length, 0) +
      inv.deviceItems.reduce((s, d) => s + d.found.length, 0) +
      inv.integrationItems.reduce((s, i) => s + i.found.length, 0)
    const secrets = (await call(GET, 'keychainAdmin.listSecrets', {})) ?? []
    const byUsage = secrets.reduce((m, s) => ({ ...m, [s.usage]: (m[s.usage] ?? 0) + 1 }), {})
    console.log(
      `keychain ${status?.keychain?.state} · source ${status?.keySource?.kind ?? '—'} · fingerprint ${status?.fingerprint ?? '—'}`,
    )
    console.log(`stored values: ${secrets.length} ${JSON.stringify(byUsage)}`)
    console.log(`inline secrets left: ${left}; stale rows left: ${inv.staleRows.length}`)
    if (left > 0 || inv.staleRows.length > 0) printPlan(inv, false)
    // D797: the hub's own secrets, and mqtt-broker's retired ciphertext.
    const hasSigningKey = secrets.some((s) => s.ref === 'secret://system/global/jwtSigningKey')
    console.log(`session signing key in the keychain: ${hasSigningKey ? 'yes' : 'NO'}`)
    const mqttBlob =
      (await call(GET, 'settingsStore.get', {
        namespace: 'mqtt-broker',
        collection: 'addon-settings',
        key: 'root',
      })) ?? {}
    const mqttLeft = mqttCiphertextPaths(mqttBlob).length
    console.log(`mqtt-broker enc:v1 values left: ${mqttLeft}`)
    const ok =
      status?.keychain?.state === 'ready' &&
      left === 0 &&
      inv.staleRows.length === 0 &&
      hasSigningKey &&
      mqttLeft === 0
    return ok ? 0 : 1
  }

  if (step === 'plaintext-backups') {
    const cutoff = state.migratedAt
    if (!cutoff) {
      console.error('no migration recorded in the state file — nothing is known to be pre-keychain')
      return 1
    }
    const entries = ((await call(GET, 'backup.list')) ?? [])
      .filter((e) => e.createdAt <= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
    const deletions = [].concat(args.delete ?? []).filter((x) => typeof x === 'string')
    if (deletions.length === 0) {
      console.log('Backups taken BEFORE the migration (newest first) — they hold the plaintext:')
      for (const e of entries.slice(0, 20)) {
        console.log(
          `  ${e.destinationId}:${e.id}  ${new Date(e.createdAt).toISOString()}  ${e.label ?? ''}`,
        )
      }
      console.log(
        '\nDelete the ones you choose with: plaintext-backups --delete <destinationId>:<backupId> ... --confirm',
      )
      return 0
    }
    if (args.confirm !== true) {
      console.error('refusing to delete without --confirm')
      return 1
    }
    for (const d of deletions) {
      const [destinationId, backupId] = d.split(':')
      if (!entries.some((e) => e.id === backupId && e.destinationId === destinationId)) {
        console.error(`skip ${d}: not a pre-migration backup`)
        continue
      }
      await call(POST, 'backup.delete', { destinationId, backupId })
      console.log(`deleted backup ${d}`)
    }
    return 0
  }

  console.error(`unknown step "${step}"`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    },
  )
}
