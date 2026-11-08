/**
 * The OTA notification: EAS sends webhooks for builds and submissions only, so
 * an `eas update` is announced by the ship chain itself, in the same EAS build
 * payload shape the receiver already parses (`ZENTIK_EXPO`).
 *
 * The receiver URL carries its own access code, so it is never in the repo: it
 * is read from a 0600 file (`~/.camstack/zentik-ota-url`). No file, no
 * notification — a ship never fails because the announcement could not go out.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const OTA_NOTIFY_URL_FILE = path.join(os.homedir(), '.camstack', 'zentik-ota-url')
const NOTIFY_TIMEOUT_MS = 10_000

/** The notes of one version from `whats-new.ts`, in one language; [] when absent. */
export function whatsNewNotes(source, version, lang) {
  const at = source.indexOf(`version: '${version}'`)
  if (at < 0) return []
  const next = source.indexOf('version: ', at + 1)
  const entry = source.slice(at, next < 0 ? undefined : next)
  const list = entry.match(new RegExp(`\\b${lang}: \\[([\\s\\S]*?)\\]`))
  if (!list) return []
  return [...list[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? m[2]).replace(/\\(.)/g, '$1'),
  )
}

/** An EAS build webhook body describing a finished OTA update. */
export function buildOtaPayload({ version, runtimeVersion, commit, notes, channel, projectName, accountName, at }) {
  const iso = new Date(at).toISOString()
  return {
    id: `ota-${version}`,
    accountName,
    projectName,
    appId: projectName,
    // The receiver accepts only `ios` | `android`; one update serves both.
    platform: 'ios',
    status: 'finished',
    buildDetailsPageUrl: `https://expo.dev/accounts/${accountName}/projects/${projectName}/updates`,
    metadata: {
      appVersion: version,
      runtimeVersion,
      channel,
      buildProfile: `OTA ${channel} (iOS + Android)`,
      gitCommitHash: commit,
      gitCommitMessage: notes.length > 0 ? notes.join(' · ') : `viewer ${version}`,
    },
    createdAt: iso,
    completedAt: iso,
    updatedAt: iso,
  }
}

/** The receiver URL, or null when the file is missing or empty. */
export function readOtaNotifyUrl(file = OTA_NOTIFY_URL_FILE) {
  try {
    const url = fs.readFileSync(file, 'utf8').trim()
    return url.length > 0 ? url : null
  } catch {
    return null
  }
}

/** POST the payload; resolves to a one-line outcome, never throws. */
export async function sendOtaNotification(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    return res.ok ? `notifica OTA inviata (${res.status})` : `notifica OTA rifiutata: HTTP ${res.status}`
  } catch (err) {
    return `notifica OTA non inviata: ${err instanceof Error ? err.message : String(err)}`
  }
}
