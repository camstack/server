/**
 * Friendly wording for a login session: the device/browser it signed in from
 * (parsed from the raw User-Agent with simple heuristics — not a UA database)
 * and its sign-in method. Anything unrecognised is shown raw, truncated.
 */

import i18n from '../../i18n/index'

const RAW_MAX = 40

export interface ClientDescription {
  /** What the list shows. */
  readonly label: string
  /** The raw User-Agent, for a tooltip; null when the hub had none. */
  readonly raw: string | null
}

interface Rule {
  readonly test: RegExp
  readonly name: string
}

/** Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari". */
const BROWSERS: readonly Rule[] = [
  { test: /Electron\//, name: 'CamStack desktop' },
  { test: /Edg(e|A|iOS)?\//, name: 'Edge' },
  { test: /OPR\/|Opera/, name: 'Opera' },
  { test: /Firefox\/|FxiOS\//, name: 'Firefox' },
  { test: /Chrome\/|CriOS\//, name: 'Chrome' },
  { test: /Version\/[\d.]+.*Safari\//, name: 'Safari' },
]

const SYSTEMS: readonly Rule[] = [
  { test: /iPhone/, name: 'iPhone' },
  { test: /iPad/, name: 'iPad' },
  { test: /Android/, name: 'Android' },
  { test: /Mac OS X|Macintosh/, name: 'macOS' },
  { test: /Windows/, name: 'Windows' },
  { test: /CrOS/, name: 'ChromeOS' },
  { test: /Linux/, name: 'Linux' },
]

/** Non-browser clients: the native apps and scripts. */
const OTHER_CLIENTS: readonly Rule[] = [
  { test: /CFNetwork\/.*Darwin\//, name: 'CamStack app on iOS' },
  { test: /^okhttp\//i, name: 'CamStack app on Android' },
  { test: /^(node|undici)\b/i, name: 'Script (Node.js)' },
  { test: /^curl\//i, name: 'curl' },
]

function firstMatch(rules: readonly Rule[], ua: string): string | null {
  return rules.find((r) => r.test.test(ua))?.name ?? null
}

function truncate(raw: string): string {
  return raw.length <= RAW_MAX ? raw : `${raw.slice(0, RAW_MAX)}…`
}

export function describeClient(client: string | null): ClientDescription {
  if (client === null || client.trim().length === 0) {
    return { label: i18n.t('helpers.sessionClient.unknownDevice'), raw: null }
  }
  const ua = client.trim()
  const other = firstMatch(OTHER_CLIENTS, ua)
  if (other !== null) return { label: other, raw: ua }
  const browser = firstMatch(BROWSERS, ua)
  const system = firstMatch(SYSTEMS, ua)
  if (browser !== null && system !== null)
    return { label: i18n.t('helpers.sessionClient.browserOnSystem', { browser, system }), raw: ua }
  if (browser !== null) return { label: browser, raw: ua }
  return { label: truncate(ua), raw: ua }
}

const METHOD_LABEL_KEY: Readonly<Record<string, string>> = {
  password: 'helpers.sessionClient.method.password',
  passkey: 'helpers.sessionClient.method.passkey',
  sso: 'helpers.sessionClient.method.sso',
  handoff: 'helpers.sessionClient.method.handoff',
  exchange: 'helpers.sessionClient.method.exchange',
}

export function describeMethod(method: string): string {
  const key = METHOD_LABEL_KEY[method]
  return key === undefined ? method : i18n.t(key)
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}
