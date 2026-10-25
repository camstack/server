/**
 * `GET /authorize` — the step of Alexa account linking where the operator says
 * WHICH hub the skill talks to. Alexa sends the user's browser here (it is the
 * skill's "authorization URI"); the hub is not known yet, so it has to be asked.
 *
 * Two parts, no script:
 *
 *   1. No `hubUrl` yet: the form. It is the CamStack page family — the hub's own
 *      stylesheet and brand mark (`page-style.js`, generated from the hub's page
 *      shell), en/it — not a hand-written page.
 *   2. `hubUrl` given: the address is CHECKED before the browser is sent there.
 *      Syntax and `https` first, then not a local address (this runs in the
 *      cloud and cannot reach one), then one unauthenticated discovery request
 *      (`GET /api/oauth2/integrations`) that proves it is a CamStack hub, that
 *      this Lambda's TLS trust accepts its certificate, and that it serves
 *      Alexa linking. Any failure re-renders the form with a plain sentence and a
 *      reason CODE; success is a 302 to the hub's own consent page.
 *
 * The hub's address is always TYPED here: a cloud function cannot read the hub's
 * `local-network` roles. The hub shows the value to enter (its public endpoint)
 * in the Alexa export settings.
 *
 * Nothing sensitive passes through: the account-linking parameters are the
 * ones Amazon sent, escaped into hidden fields and forwarded untouched.
 */
'use strict'

const crypto = require('node:crypto')

const { STYLE, LOGO_DARK, LOGO_LIGHT } = require('./page-style.js')

const INTEGRATION_ID = 'export-alexa'

/** Why a hub address was refused — the codes the page and the logs share. */
const REASONS = [
  'invalid_url',
  'not_https',
  'local_address',
  'unreachable',
  'tls_error',
  'not_camstack',
  'integration_missing',
  'hub_starting',
]

const STRINGS = {
  en: {
    title: 'CamStack · Link your hub',
    heading: 'Link CamStack to Alexa',
    intro:
      'Enter the public HTTPS address of your CamStack hub. Alexa will then ask that hub to authorise this Echo.',
    label: 'Hub address',
    placeholder: 'https://camstack.example.com',
    hint: 'The address shown in CamStack under Connectivity → Alexa. It must be reachable from the internet (a tunnel, a reverse proxy or a public address).',
    submit: 'Continue',
    code: 'Code: ',
    reasons: {
      invalid_url:
        'That is not a web address. Enter it in full, for example https://camstack.example.com.',
      not_https: 'The address must start with https://. Alexa only talks to hubs over HTTPS.',
      local_address:
        'That address is only reachable inside your network. Alexa connects from the internet, so use the hub’s public address.',
      unreachable:
        'Could not reach that address from the internet. Check the address, and that the hub is running and published.',
      tls_error:
        'The hub answered, but its HTTPS certificate is not trusted. Use an address with a certificate from a public authority.',
      not_camstack: 'That address answers, but it is not a CamStack hub (or the hub is too old).',
      integration_missing:
        'This hub does not offer Alexa linking. Install and enable the Alexa export on it, then try again.',
      hub_starting: 'The hub is still starting up. Wait a moment and try again.',
    },
  },
  it: {
    title: 'CamStack · Collega il tuo hub',
    heading: 'Collega CamStack ad Alexa',
    intro:
      'Inserisci l’indirizzo HTTPS pubblico del tuo hub CamStack. Alexa chiederà poi a quell’hub di autorizzare questo Echo.',
    label: 'Indirizzo dell’hub',
    placeholder: 'https://camstack.example.com',
    hint: 'L’indirizzo mostrato in CamStack sotto Connettività → Alexa. Deve essere raggiungibile da internet (un tunnel, un reverse proxy o un indirizzo pubblico).',
    submit: 'Continua',
    code: 'Codice: ',
    reasons: {
      invalid_url:
        'Non è un indirizzo web. Inseriscilo per intero, ad esempio https://camstack.example.com.',
      not_https: 'L’indirizzo deve iniziare con https://. Alexa parla con gli hub solo via HTTPS.',
      local_address:
        'Quell’indirizzo è raggiungibile solo dentro la tua rete. Alexa si collega da internet: usa l’indirizzo pubblico dell’hub.',
      unreachable:
        'Impossibile raggiungere quell’indirizzo da internet. Controlla l’indirizzo e che l’hub sia acceso e pubblicato.',
      tls_error:
        'L’hub ha risposto, ma il suo certificato HTTPS non è attendibile. Usa un indirizzo con un certificato di un’autorità pubblica.',
      not_camstack:
        'Quell’indirizzo risponde, ma non è un hub CamStack (oppure l’hub è troppo vecchio).',
      integration_missing:
        'Questo hub non offre il collegamento ad Alexa. Installa e abilita l’export Alexa, poi riprova.',
      hub_starting: 'L’hub si sta ancora avviando. Attendi un momento e riprova.',
    },
  },
}

function pickLang(params, headers) {
  const asked = (params.get('lang') || '').slice(0, 2).toLowerCase()
  if (asked === 'it' || asked === 'en') return asked
  const accept = String(
    (headers && (headers['accept-language'] || headers['Accept-Language'])) || '',
  )
  for (const part of accept.split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase()
    if (tag === 'it' || tag === 'en') return tag
  }
  return 'en'
}

/** Escapes text for an HTML text node or a double-quoted attribute (as the hub's page shell does). */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function sha256Source(text) {
  return `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`
}

/** The CSP of the page: the one inline style pinned by hash, no script, no framing. */
function pageCsp() {
  return [
    "default-src 'none'",
    `style-src ${sha256Source(STYLE)}`,
    "base-uri 'none'",
    // The form submits to this Lambda, which answers with a redirect to the
    // operator's hub: browsers apply form-action to that redirect too.
    "form-action 'self' https:",
    "frame-ancestors 'none'",
  ].join('; ')
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  if (host === '::1' || host === '::' || host.startsWith('fe80:')) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  const m = IPV4.exec(host)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return false
}

/** `{ ok: true, base }` (origin + path, no trailing slash) or `{ ok: false, reason }`. */
function parseHubAddress(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (url.protocol === 'http:') return { ok: false, reason: 'not_https' }
  if (url.protocol !== 'https:' || !url.hostname) return { ok: false, reason: 'invalid_url' }
  if (isLocalHost(url.hostname)) return { ok: false, reason: 'local_address' }
  return { ok: true, base: url.origin + url.pathname.replace(/\/+$/, '') }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
])

function classifyNetworkError(err) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || ''
  if (TLS_CODES.has(code) || /certificate/i.test(String((err && err.message) || ''))) {
    return 'tls_error'
  }
  return 'unreachable'
}

/** Prove `base` is a CamStack hub that serves Alexa linking, as THIS Lambda sees it. */
async function probeHub(base, deps) {
  let res
  try {
    res = await deps.fetch(`${base}/api/oauth2/integrations`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    return { ok: false, reason: classifyNetworkError(err) }
  }
  if (!res || !res.ok) return { ok: false, reason: 'not_camstack' }
  let body
  try {
    body = JSON.parse(await res.text())
  } catch {
    return { ok: false, reason: 'not_camstack' }
  }
  if (!body || !Array.isArray(body.integrations)) return { ok: false, reason: 'not_camstack' }
  const serves = body.integrations.some((i) => i && i.integrationId === INTEGRATION_ID)
  if (serves) return { ok: true }
  return { ok: false, reason: body.complete === false ? 'hub_starting' : 'integration_missing' }
}

function renderForm(lang, forwarded, hubUrl, reason) {
  const t = STRINGS[lang]
  const hidden = forwarded
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('')
  const error = reason
    ? `<p class="error" role="alert" data-reason="${escapeHtml(reason)}">${escapeHtml(t.reasons[reason])}</p><p class="hint">${escapeHtml(t.code)}<code>${escapeHtml(reason)}</code></p>`
    : ''
  const body =
    `<p>${escapeHtml(t.intro)}</p>` +
    `<form method="get" action="/authorize">${hidden}` +
    `<div class="field"><label for="hubUrl">${escapeHtml(t.label)}</label>` +
    `<input id="hubUrl" name="hubUrl" type="url" inputmode="url" autocomplete="url" spellcheck="false" autocapitalize="off" required placeholder="${escapeHtml(t.placeholder)}" value="${escapeHtml(hubUrl)}"></div>` +
    `<p class="hint">${escapeHtml(t.hint)}</p>${error}` +
    `<button class="btn" type="submit">${escapeHtml(t.submit)}</button></form>`
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t.title)}</title><style>${STYLE}</style></head><body><main><div class="brand">${LOGO_DARK}${LOGO_LIGHT}</div><div class="card"><h1>${escapeHtml(t.heading)}</h1>${body}</div></main></body></html>`
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': pageCsp(),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
    body: html,
  }
}

async function handleAuthorizePage(event, deps) {
  const params = new URLSearchParams(event.rawQueryString || '')
  const lang = pickLang(params, event.headers)
  const hubUrl = params.get('hubUrl') || ''
  // What Amazon sent, forwarded to the hub's own authorize untouched.
  const forwarded = [...params.entries()].filter(([k]) => k !== 'hubUrl' && k !== 'integration')

  if (hubUrl === '') return renderForm(lang, forwarded, '', null)

  const parsed = parseHubAddress(hubUrl)
  if (!parsed.ok) return renderForm(lang, forwarded, hubUrl, parsed.reason)
  const probe = await probeHub(parsed.base, deps)
  if (!probe.ok) {
    deps.log.warn('authorize hub check refused', {
      reason: probe.reason,
      host: new URL(parsed.base).host,
    })
    return renderForm(lang, forwarded, hubUrl, probe.reason)
  }
  const query = new URLSearchParams(forwarded)
  query.set('integration', INTEGRATION_ID)
  return {
    statusCode: 302,
    headers: {
      location: `${parsed.base}/api/oauth2/authorize?${query.toString()}`,
      'cache-control': 'no-store',
    },
    body: '',
  }
}

module.exports = { handleAuthorizePage, parseHubAddress, REASONS, STRINGS }
