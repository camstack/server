#!/usr/bin/env node
// ONE-OFF, OPERATOR-RUN: copy Bosch integration credentials from the live
// Home Assistant VM (Unraid + qemu-guest-agent + docker exec) into
// scratchpad/bosch-ha-import/ for CamStack import. Never prints secret values.
//
// Read-only on HA (except writing local scratchpad). Does not commit secrets.
//
// Usage:
//   node scripts/ops/import-bosch-creds-from-ha.mjs extract [options]
//   node scripts/ops/import-bosch-creds-from-ha.mjs apply-hub [options]
//   node scripts/ops/import-bosch-creds-from-ha.mjs cleanup [options]
//
// Options (both subcommands):
//   --out-dir <path>       default: scratchpad/bosch-ha-import (under repo root)
//   --unraid-host <name>   hl config host name (default: unraid)
//   --vm-name <name>       libvirt domain (default: Home Assistant)
//   --ha-container <name>  docker name inside the VM (default: homeassistant)
//   --json                 machine-readable stdout for extract summary only
//
// apply-hub additionally:
//   --server <host>        hub URL/host (default: 192.0.2.20 dev hub)
//   --dry-run              print hub steps without calling hub.mjs
//
// Extract writes:
//   ha-bosch-config-entries.json   filtered HA config entries (secrets inside)
//   pem/<basename>                 copied PEM material (mode 0600)
//   camstack-import.json           CamStack-oriented plan (paths, not inline PEM)
//
// Apply-hub (when camstack-import.json marks readyToApply):
//   integrations.create + integrations.setSettings via scripts/hub/hub.mjs
//
// Coordinator manual apply (.50 example):
//   node scripts/hub/hub.mjs --server 192.0.2.20 POST integrations.create \
//     '{"addonId":"bosch-shc","name":"Bosch SHC (from HA)"}'
//   node scripts/hub/hub.mjs --server 192.0.2.20 POST integrations.setSettings \
//     '{"id":"<integrationId>","settings":{...},"secretKeys":["..."]}'
//
// Requires: ~/.claude/homelab/bin/hl (or HL_BIN), virsh + qemu-guest-agent on Unraid.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** HA config entry domains we import. */
export const BOSCH_HA_DOMAINS = Object.freeze(['bosch_shc', 'homeconnect_ws', 'bosch_homecom'])

/** CamStack addon ids (provider-bosch manifest). */
export const HA_DOMAIN_TO_CAMSTACK_ADDON = Object.freeze({
  bosch_shc: 'bosch-shc',
  homeconnect_ws: 'bosch-home-connect',
  bosch_homecom: 'bosch-homecom',
})

const SECRET_KEY_HINTS = Object.freeze([
  'password',
  'token',
  'refresh_token',
  'access_token',
  'psk',
  'api_key',
  'client_secret',
  'ssl_key',
  'ssl_certificate',
  'cert',
  'key',
])

/**
 * @param {unknown} store
 * @returns {Array<Record<string, unknown>>}
 */
export function entriesFromHaStorage(store) {
  if (!store || typeof store !== 'object') return []
  const data = /** @type {{ data?: { entries?: unknown } }} */ (store).data
  if (!data || !Array.isArray(data.entries)) return []
  return data.entries.filter((e) => e && typeof e === 'object').map((e) => ({ ...e }))
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @returns {Array<Record<string, unknown>>}
 */
export function filterBoschEntries(entries) {
  const allowed = new Set(BOSCH_HA_DOMAINS)
  return entries.filter((e) => typeof e.domain === 'string' && allowed.has(e.domain))
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
export function redactEntrySummary(entry) {
  const domain = typeof entry.domain === 'string' ? entry.domain : 'unknown'
  const title = typeof entry.title === 'string' ? entry.title : ''
  const entryId = typeof entry.entry_id === 'string' ? entry.entry_id : ''
  const data =
    entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
      ? /** @type {Record<string, unknown>} */ (entry.data)
      : {}

  const host =
    typeof data.host === 'string'
      ? data.host
      : typeof data.ip_address === 'string'
        ? data.ip_address
        : null
  const username =
    typeof data.username === 'string'
      ? data.username
      : typeof data.email === 'string'
        ? data.email
        : ''

  /** @type {Record<string, boolean>} */
  const secretPresence = {}
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase()
    if (SECRET_KEY_HINTS.some((h) => lower.includes(h))) {
      secretPresence[key] = presentSecret(data[key])
    }
  }

  return {
    domain,
    entryId,
    title,
    host,
    usernameLength: username.length,
    secretPresence,
    haCertPath:
      typeof data.ssl_certificate === 'string'
        ? data.ssl_certificate
        : typeof data.certfile === 'string'
          ? data.certfile
          : null,
    haKeyPath:
      typeof data.ssl_key === 'string'
        ? data.ssl_key
        : typeof data.keyfile === 'string'
          ? data.keyfile
          : null,
  }
}

/**
 * @param {unknown} value
 */
function presentSecret(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'object') return Object.keys(/** @type {object} */ (value)).length > 0
  return true
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {{ outDir: string; pemFiles: Array<{ haPath: string; localPath: string }> }} ctx
 */
export function buildCamstackImport(entries, ctx) {
  const integrations = entries.map((entry) => {
    const domain = typeof entry.domain === 'string' ? entry.domain : ''
    const addonId = HA_DOMAIN_TO_CAMSTACK_ADDON[domain] ?? null
    const data =
      entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? /** @type {Record<string, unknown>} */ (entry.data)
        : {}
    const summary = redactEntrySummary(entry)

    /** @type {string[]} */
    const secretKeys = []
    /** @type {Record<string, unknown>} */
    const settings = {}
    /** @type {Record<string, string>} */
    const secretFieldsFromHa = {}

    if (typeof data.host === 'string') settings.host = data.host
    if (typeof data.ip_address === 'string') settings.host = data.ip_address
    if (typeof data.username === 'string') {
      secretFieldsFromHa.username = 'data.username'
      secretKeys.push('username')
    }
    if (typeof data.email === 'string') {
      secretFieldsFromHa.email = 'data.email'
      secretKeys.push('email')
    }
    if (typeof data.password === 'string') {
      secretFieldsFromHa.password = 'data.password'
      secretKeys.push('password')
    }
    if (typeof data.token === 'string') {
      secretFieldsFromHa.token = 'data.token'
      secretKeys.push('token')
    }
    if (typeof data.refresh_token === 'string') {
      secretFieldsFromHa.refreshToken = 'data.refresh_token'
      secretKeys.push('refreshToken')
    }
    if (typeof data.access_token === 'string') {
      secretFieldsFromHa.accessToken = 'data.access_token'
      secretKeys.push('accessToken')
    }
    if (typeof data.psk === 'string') {
      secretFieldsFromHa.psk = 'data.psk'
      secretKeys.push('psk')
    }
    if (domain === 'homeconnect_ws') {
      const dd = data.device_description ?? data.deviceDescription
      if (dd && typeof dd === 'object' && !Array.isArray(dd)) {
        settings.deviceDescription = dd
      } else if (typeof dd === 'string' && dd.trim().length > 0) {
        try {
          const parsed = JSON.parse(dd)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings.deviceDescription = parsed
          }
        } catch {
          settings.deviceDescription = dd
        }
      }
    }

    const certHa =
      typeof data.ssl_certificate === 'string'
        ? data.ssl_certificate
        : typeof data.certfile === 'string'
          ? data.certfile
          : null
    const keyHa =
      typeof data.ssl_key === 'string'
        ? data.ssl_key
        : typeof data.keyfile === 'string'
          ? data.keyfile
          : null

    if (certHa) {
      const local = pemLocalPath(ctx, certHa)
      if (local) {
        settings.sslCertificatePath = local
        secretKeys.push('sslCertificatePath')
      }
    }
    if (keyHa) {
      const local = pemLocalPath(ctx, keyHa)
      if (local) {
        settings.sslKeyPath = local
        secretKeys.push('sslKeyPath')
      }
    }

    return {
      haDomain: domain,
      haEntryId: summary.entryId,
      haTitle: summary.title,
      camstackAddonId: addonId,
      suggestedIntegrationName: summary.title || domain,
      settings,
      secretKeys: [...new Set(secretKeys)],
      secretsSource: {
        file: 'ha-bosch-config-entries.json',
        entryId: summary.entryId,
        fields: secretFieldsFromHa,
      },
      summary,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    outDir: ctx.outDir,
    readyToApply: false,
    readyToApplyReason:
      'Bosch provider addons are account-mode scaffolds without a finalized integration settings schema; use extract output to wire integrations.create/setSettings once schema lands.',
    integrations,
    hubApplyExample: {
      server: '192.0.2.20',
      steps: [
        'POST integrations.create {"addonId":"bosch-shc","name":"..."}',
        'POST integrations.setSettings {"id":"<id>","settings":{...},"secretKeys":[...]}',
        'Repeat per integration; PEM paths in settings should be absolute paths on the hub host only after copying scratchpad/pem there securely.',
      ],
    },
  }
}

/**
 * @param {{ outDir: string; pemFiles: Array<{ haPath: string; localPath: string }> }} ctx
 * @param {string} haPath
 */
function pemLocalPath(ctx, haPath) {
  const hit = ctx.pemFiles.find((p) => p.haPath === haPath)
  return hit ? hit.localPath : null
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} shellCommand
 */
function shellQuoteSingle(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function hlUnraidExec(hlBin, unraidHost, shellCommand) {
  // Do NOT wrap in `bash -lc`: that path yields an interactive virsh welcome
  // banner and no JSON. Pass the remote command as a single argv after `--`.
  return execFileSync(hlBin, ['host', unraidHost, '--', shellCommand], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd()
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {Record<string, unknown>} payload
 */
/**
 * Parse virsh stdout — interactive shells may prepend a welcome banner before JSON.
 * @param {string} raw
 */
export function parseVirshAgentJson(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('{') && line.endsWith('}')) {
      return JSON.parse(line)
    }
  }
  throw new Error('virsh qemu-agent-command: no JSON object in output')
}

function virshQemuAgent(hlBin, unraidHost, vmName, payload) {
  const cmd = `virsh --connect qemu:///system -q qemu-agent-command ${shellQuoteSingle(vmName)} ${shellQuoteSingle(JSON.stringify(payload))}`
  const raw = hlUnraidExec(hlBin, unraidHost, cmd)
  return parseVirshAgentJson(raw)
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {string} guestShellCommand
 */
function qemuGuestShell(hlBin, unraidHost, vmName, guestShellCommand) {
  const first = virshQemuAgent(hlBin, unraidHost, vmName, {
    execute: 'guest-exec',
    arguments: {
      path: '/bin/sh',
      arg: ['-c', guestShellCommand],
      'capture-output': true,
    },
  })
  const pid = first?.return?.pid
  if (typeof pid !== 'number') {
    throw new Error(`guest-exec failed to start (vm=${vmName})`)
  }

  for (let i = 0; i < 120; i++) {
    const status = virshQemuAgent(hlBin, unraidHost, vmName, {
      execute: 'guest-exec-status',
      arguments: { pid },
    })
    const ret = status?.return
    if (!ret || !ret.exited) {
      execFileSync('sleep', ['0.25'])
      continue
    }
    if (ret.exitcode !== 0) {
      throw new Error(`guest-exec exit ${ret.exitcode} (vm=${vmName})`)
    }
    const outB64 = ret['out-data'] ?? ''
    const errB64 = ret['err-data'] ?? ''
    const stdout = outB64 ? Buffer.from(outB64, 'base64').toString('utf8') : ''
    const stderr = errB64 ? Buffer.from(errB64, 'base64').toString('utf8') : ''
    if (stderr.trim()) {
      const safe = stderr.replace(/[^\x20-\x7E\n\r\t]/g, '?')
      process.stderr.write(`${safe}\n`)
    }
    return stdout
  }
  throw new Error(`guest-exec-status timed out (vm=${vmName}, pid=${pid})`)
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {string} haContainer
 * @param {string} innerShell
 */
/**
 * Run `docker exec <container> python3 -c <script>` via QGA guest-exec.
 * Avoids nesting Python inside `/bin/sh -c` (breaks multiline + quoting).
 */
function haDockerPython(hlBin, unraidHost, vmName, haContainer, pythonSource) {
  const first = virshQemuAgent(hlBin, unraidHost, vmName, {
    execute: 'guest-exec',
    arguments: {
      path: '/usr/bin/docker',
      arg: ['exec', haContainer, 'python3', '-c', pythonSource],
      'capture-output': true,
    },
  })
  const pid = first?.return?.pid
  if (typeof pid !== 'number') {
    throw new Error(`guest-exec docker python failed to start (vm=${vmName})`)
  }
  for (let i = 0; i < 120; i++) {
    const status = virshQemuAgent(hlBin, unraidHost, vmName, {
      execute: 'guest-exec-status',
      arguments: { pid },
    })
    const ret = status?.return
    if (!ret || !ret.exited) {
      execFileSync('sleep', ['0.25'])
      continue
    }
    if (ret.exitcode !== 0) {
      const errB64 = ret['err-data'] ?? ''
      const stderr = errB64 ? Buffer.from(errB64, 'base64').toString('utf8') : ''
      throw new Error(
        `docker exec python exit ${ret.exitcode} (vm=${vmName}): ${stderr.slice(0, 400)}`,
      )
    }
    const outB64 = ret['out-data'] ?? ''
    return outB64 ? Buffer.from(outB64, 'base64').toString('utf8') : ''
  }
  throw new Error(`guest-exec-status timed out (vm=${vmName}, pid=${pid})`)
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {string} haContainer
 * @param {string} innerShell
 */
function haDockerExec(hlBin, unraidHost, vmName, haContainer, innerShell) {
  const dockerCmd = `docker exec ${shellQuoteSingle(haContainer)} /bin/sh -c ${shellQuoteSingle(innerShell)}`
  return qemuGuestShell(hlBin, unraidHost, vmName, dockerCmd)
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {string} haContainer
 */
function fetchBoschConfigEntries(hlBin, unraidHost, vmName, haContainer) {
  const domainsLiteral = JSON.stringify(BOSCH_HA_DOMAINS)
  const py = [
    'import json',
    'path="/config/.storage/core.config_entries"',
    'store=json.load(open(path,encoding="utf-8"))',
    `domains=set(${domainsLiteral})`,
    'entries=[e for e in store.get("data",{}).get("entries",[]) if e.get("domain") in domains]',
    'print(json.dumps({"version":store.get("version"),"minor_version":store.get("minor_version"),"entries":entries}))',
  ].join('\n')
  const out = haDockerPython(hlBin, unraidHost, vmName, haContainer, py)
  const parsed = JSON.parse(out)
  return entriesFromHaStorage({ data: { entries: parsed.entries } })
}

/**
 * @param {string} hlBin
 * @param {string} unraidHost
 * @param {string} vmName
 * @param {string} haContainer
 * @param {string} haPath
 */
function fetchHaFileBase64(hlBin, unraidHost, vmName, haContainer, haPath) {
  const py = [
    'import base64,sys',
    `p=${JSON.stringify(haPath)}`,
    'sys.stdout.write(base64.b64encode(open(p,"rb").read()).decode("ascii"))',
  ].join(';')
  return haDockerPython(hlBin, unraidHost, vmName, haContainer, py).trim()
}

/**
 * @param {string} outDir
 * @param {Array<Record<string, unknown>>} entries
 * @param {Array<{ haPath: string; localPath: string }>} pemFiles
 */
function writeExtractArtifacts(outDir, entries, pemFiles) {
  mkdirSync(outDir, { recursive: true })
  mkdirSync(path.join(outDir, 'pem'), { recursive: true })

  const store = {
    version: 1,
    minor_version: 0,
    data: { entries },
  }
  writeFileSync(
    path.join(outDir, 'ha-bosch-config-entries.json'),
    `${JSON.stringify(store, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )

  const plan = buildCamstackImport(entries, { outDir, pemFiles })
  writeFileSync(path.join(outDir, 'camstack-import.json'), `${JSON.stringify(plan, null, 2)}\n`, {
    mode: 0o600,
  })
}

/**
 * @param {Array<Record<string, unknown>>} entries
 */
/**
 * @param {Array<Record<string, unknown>>} entries
 * @returns {Array<{ entryId: string; haPath: string }>}
 */
export function collectPemHaPaths(entries) {
  /** @type {Array<{ entryId: string; haPath: string }>} */
  const paths = []
  for (const entry of entries) {
    const entryId = typeof entry.entry_id === 'string' ? entry.entry_id : 'unknown'
    const data =
      entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? /** @type {Record<string, unknown>} */ (entry.data)
        : {}
    for (const key of ['ssl_certificate', 'ssl_key', 'certfile', 'keyfile']) {
      const v = data[key]
      if (typeof v === 'string' && v.endsWith('.pem')) {
        paths.push({ entryId, haPath: v })
      }
    }
  }
  return paths
}

function parseArgs(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {Record<string, string | boolean | string[]>} */
  const args = { _: positional }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return args
}

function resolveOutDir(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return path.isAbsolute(explicit) ? explicit : path.join(WORKSPACE_ROOT, explicit)
  }
  return path.join(WORKSPACE_ROOT, 'scratchpad/bosch-ha-import')
}

function hubCall(server, method, route, body, dryRun) {
  const hubScript = path.join(WORKSPACE_ROOT, 'scripts/hub/hub.mjs')
  const args = [hubScript]
  if (server) args.push('--server', server)
  args.push(method, route, JSON.stringify(body))
  if (dryRun) {
    console.log(`dry-run: node ${args.join(' ')}`)
    return null
  }
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(out)
}

function cmdExtract(args) {
  const hlBin = process.env.HL_BIN ?? path.join(process.env.HOME ?? '', '.claude/homelab/bin/hl')
  if (!existsSync(hlBin)) {
    console.error(`HL helper missing: ${hlBin} (set HL_BIN)`)
    return 2
  }
  const unraidHost = typeof args['unraid-host'] === 'string' ? args['unraid-host'] : 'unraid'
  const vmName = typeof args['vm-name'] === 'string' ? args['vm-name'] : 'Home Assistant'
  const haContainer =
    typeof args['ha-container'] === 'string' ? args['ha-container'] : 'homeassistant'
  const outDir = resolveOutDir(typeof args['out-dir'] === 'string' ? args['out-dir'] : undefined)

  const entries = fetchBoschConfigEntries(hlBin, unraidHost, vmName, haContainer)
  if (entries.length === 0) {
    console.error(
      'no Bosch HA config entries found (domains: bosch_shc, homeconnect_ws, bosch_homecom)',
    )
    return 1
  }

  mkdirSync(path.join(outDir, 'pem'), { recursive: true })

  /** @type {Array<{ haPath: string; localPath: string }>} */
  const pemFiles = []
  for (const { entryId, haPath } of collectPemHaPaths(entries)) {
    const base = path.basename(haPath)
    const localPath = path.join(outDir, 'pem', `${entryId}_${base}`)
    const b64 = fetchHaFileBase64(hlBin, unraidHost, vmName, haContainer, haPath)
    writeFileSync(localPath, Buffer.from(b64, 'base64'), { mode: 0o600 })
    pemFiles.push({ haPath, localPath })
  }

  writeExtractArtifacts(outDir, entries, pemFiles)

  const summaries = entries.map((e) => redactEntrySummary(e))
  const payload = {
    ok: true,
    outDir,
    entryCount: entries.length,
    pemFileCount: pemFiles.length,
    summaries,
  }
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(
      `extracted ${entries.length} HA config entr${entries.length === 1 ? 'y' : 'ies'} → ${outDir}`,
    )
    for (const s of summaries) {
      console.log(
        `  ${s.domain} (${s.entryId}) host=${s.host ?? '—'} usernameLen=${s.usernameLength} secrets=${
          Object.keys(s.secretPresence)
            .filter((k) => s.secretPresence[k])
            .join(',') || '—'
        } pem=${s.haCertPath ? 'cert' : '—'}/${s.haKeyPath ? 'key' : '—'}`,
      )
    }
    console.log(
      `wrote ha-bosch-config-entries.json, camstack-import.json, ${pemFiles.length} PEM file(s)`,
    )
  }
  return 0
}

function cmdApplyHub(args) {
  const outDir = resolveOutDir(typeof args['out-dir'] === 'string' ? args['out-dir'] : undefined)
  const planPath = path.join(outDir, 'camstack-import.json')
  if (!existsSync(planPath)) {
    console.error(`missing ${planPath} — run extract first`)
    return 2
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  if (!plan.readyToApply) {
    console.error(plan.readyToApplyReason ?? 'camstack-import.json is not ready to apply')
    const example = plan.hubApplyExample
    if (example && typeof example === 'object') {
      if (typeof example.server === 'string') {
        console.error(`hubApplyExample server: ${example.server}`)
      }
      if (Array.isArray(example.steps)) {
        console.error('hubApplyExample steps:')
        for (const step of example.steps) {
          console.error(`  - ${step}`)
        }
      }
    } else {
      console.error('Manual hub.mjs steps are documented in camstack-import.json → hubApplyExample')
    }
    return 1
  }
  const server =
    typeof args.server === 'string' ? args.server : (plan.hubApplyExample?.server ?? '192.0.2.20')
  const dryRun = args['dry-run'] === true

  for (const item of plan.integrations) {
    if (!item.camstackAddonId) continue
    const created = hubCall(
      server,
      'POST',
      'integrations.create',
      { addonId: item.camstackAddonId, name: item.suggestedIntegrationName },
      dryRun,
    )
    const integrationId = created?.id
    if (!integrationId && !dryRun) {
      console.error(`integrations.create failed for ${item.camstackAddonId}`)
      return 2
    }
    hubCall(
      server,
      'POST',
      'integrations.setSettings',
      {
        id: integrationId ?? '<integration-id>',
        settings: item.settings,
        secretKeys: item.secretKeys,
      },
      dryRun,
    )
    if (!dryRun) console.log(`applied ${item.camstackAddonId} integration id=${integrationId}`)
  }
  return 0
}

function cmdCleanup(args) {
  const outDir = resolveOutDir(typeof args['out-dir'] === 'string' ? args['out-dir'] : undefined)
  if (!existsSync(outDir)) {
    console.log(`cleanup: nothing to remove (${outDir})`)
    return 0
  }
  rmSync(outDir, { recursive: true, force: true })
  console.log(`cleanup: removed ${outDir}`)
  return 0
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sub = /** @type {string[]} */ (args._)[0] ?? 'extract'
  if (sub === 'extract') process.exit(cmdExtract(args))
  if (sub === 'apply-hub') process.exit(cmdApplyHub(args))
  if (sub === 'cleanup') process.exit(cmdCleanup(args))
  console.error('usage: import-bosch-creds-from-ha.mjs extract|apply-hub|cleanup [options]')
  process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
