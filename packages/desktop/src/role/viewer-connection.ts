/**
 * The viewer role's connection state machine and its shell-owned pages — pure,
 * no Electron, no I/O, so every transition and every page is unit-testable.
 * `viewer-window.ts` supplies the probe, the window and the clock.
 *
 * Three failure states, deliberately DISTINCT (conflating them sends an
 * operator to check his network for an addon that is still forking):
 *
 *   - `unreachable`      — nothing answered at the hub origin.
 *   - `viewer-starting`  — the hub answered, but the viewer mount is still
 *                          `503 {"error":"Viewer UI is starting"}`: the
 *                          `viewer-ui` cap has not resolved yet.
 *   - `cert-not-trusted` — the TLS chain was refused by `cert-trust.ts`.
 *
 * The window NEVER shows Chromium's error page: each of these is a shell page
 * naming the hub URL and the next action.
 */

/** Where the viewer window is, as far as the shell knows. */
export type ViewerConnectionState =
  | 'connecting'
  | 'connected'
  | 'unreachable'
  | 'viewer-starting'
  | 'cert-not-trusted'

/** The raw result of one probe of the hub origin. */
export type ProbeOutcome =
  | { readonly kind: 'reachable' }
  | { readonly kind: 'viewer-starting' }
  | { readonly kind: 'cert-rejected' }
  | { readonly kind: 'unreachable'; readonly detail: string }

/** First retry delay. A hub that is merely booting is back within this. */
export const PROBE_MIN_DELAY_MS = 1_000
/**
 * Retry ceiling. Unlike the hub/agent loop (60 attempts at a flat 1 s, tuned
 * for a local child that will be up in 5–30 s), a remote hub may be off for a
 * day — so the backoff is bounded but never gives up.
 */
export const PROBE_MAX_DELAY_MS = 30_000

/** Bounded exponential backoff: 1 s, 2 s, 4 s … capped at 30 s. */
export function nextProbeDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return PROBE_MIN_DELAY_MS
  const scaled = PROBE_MIN_DELAY_MS * 2 ** consecutiveFailures
  return Math.min(scaled, PROBE_MAX_DELAY_MS)
}

/** Map a probe outcome onto the state the window should be in. */
export function classifyProbeOutcome(outcome: ProbeOutcome): ViewerConnectionState {
  switch (outcome.kind) {
    case 'reachable':
      return 'connected'
    case 'viewer-starting':
      return 'viewer-starting'
    case 'cert-rejected':
      return 'cert-not-trusted'
    case 'unreachable':
      return 'unreachable'
  }
}

/**
 * Whether a probe that says "connected" may replace what the window is showing.
 * It may only ever replace a shell fallback page — never a window that already
 * holds a live session, which a reload would throw away.
 */
export function shouldLoadViewerUi(
  previous: ViewerConnectionState,
  next: ViewerConnectionState,
): boolean {
  return next === 'connected' && previous !== 'connected'
}

/** One-line tray label for a state. */
export function connectionLabel(state: ViewerConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Connection: connecting…'
    case 'connected':
      return 'Connection: connected'
    case 'unreachable':
      return 'Connection: retrying (hub unreachable)'
    case 'viewer-starting':
      return 'Connection: hub up, viewer UI starting…'
    case 'cert-not-trusted':
      return 'Connection: certificate not trusted'
  }
}

// -- Shell-owned pages ------------------------------------------------------

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         margin: 0; padding: 48px 44px; background: #0c0a09; color: #fafaf9; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  p { font-size: 13px; line-height: 1.55; color: #d6d3d1; max-width: 620px; }
  code, .fp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
              font-size: 12px; color: #f59e42; word-break: break-all; }
  dl { font-size: 12px; color: #a8a29e; max-width: 620px; }
  dt { font-weight: 600; color: #fafaf9; margin-top: 10px; }
  dd { margin: 2px 0 0; }
  .hint { color: #a8a29e; font-size: 12px; }
  .btn { display: inline-block; margin-top: 6px; padding: 9px 16px; border-radius: 6px;
         background: #f59e42; color: #0c0a09; font-size: 13px; font-weight: 600;
         text-decoration: none; }
`

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style></head><body>${body}</body></html>`
}

/** The hub did not answer at all. */
export function renderUnreachablePage(hubUrl: string, lastError: string): string {
  return page(
    'CamStack — hub unreachable',
    `<h2>Cannot reach the hub</h2>
<p>Nothing answered at <code>${escapeHtml(hubUrl)}</code>.</p>
<p class="hint">Last error: ${escapeHtml(lastError)}</p>
<p class="hint">CamStack keeps retrying in the background and opens the viewer the
moment the hub answers. Use the tray icon to change the hub or open the logs.</p>`,
  )
}

/** The hub is up; its viewer mount is still answering 503. */
export function renderViewerStartingPage(hubUrl: string): string {
  return page(
    'CamStack — viewer UI starting',
    `<h2>The hub is up — its viewer UI is still starting</h2>
<p><code>${escapeHtml(hubUrl)}</code> answered, but the <code>viewer-ui</code>
capability has not published its files yet (the hub replies
<code>503 Viewer UI is starting</code>).</p>
<p class="hint">This is not a network problem: nothing here needs changing. The
window opens by itself as soon as the hub serves the UI.</p>`,
  )
}

/**
 * The URL the trust page's accept button navigates to.
 *
 * A custom scheme, not an http link and not IPC. The shell pages are plain
 * static HTML with no preload and no bridge, and giving one of them a channel
 * to the main process for a single button would be a larger surface than the
 * button is worth. `viewer-window.ts` intercepts exactly this URL in
 * `will-navigate` and lets every other navigation through untouched — which is
 * what keeps the SPA's `/login` bounce working (see this file's header).
 *
 * It carries no payload on purpose. The fingerprint to pin is the one the main
 * process ALREADY holds from the refusal it is showing; accepting a value the
 * page hands back would mean trusting a string that came out of a renderer.
 */
export const TRUST_ACCEPT_URL = 'camstack-trust:accept'

/** Everything the trust page needs. Filled by `cert-trust.ts`'s rejection. */
export interface CertTrustPageInput {
  readonly hubUrl: string
  readonly hostname: string
  readonly hadPin: boolean
  readonly presentedIssuerFingerprint: string | null
  readonly leafSubjectName: string
  readonly leafIssuerName: string
  readonly validFrom: string
  readonly validTo: string
  readonly verificationResult: string
}

/**
 * The certificate page. Two moods, one function: with no pin this is honest
 * trust-on-first-use and the operator is told exactly what to compare and
 * where. With a pin already stored, a different root means something changed —
 * that page offers no acceptance at all.
 */
export function renderCertTrustPage(input: CertTrustPageInput): string {
  const details = `<dl>
  <dt>Certificate subject</dt><dd>${escapeHtml(input.leafSubjectName)}</dd>
  <dt>Issued by</dt><dd>${escapeHtml(input.leafIssuerName)}</dd>
  <dt>Valid</dt><dd>${escapeHtml(input.validFrom)} → ${escapeHtml(input.validTo)}</dd>
  <dt>Root SHA-256 fingerprint</dt>
  <dd class="fp">${escapeHtml(input.presentedIssuerFingerprint ?? 'none presented')}</dd>
  <dt>Chromium verdict</dt><dd>${escapeHtml(input.verificationResult)}</dd>
</dl>`

  if (input.hadPin) {
    return page(
      'CamStack — certificate changed',
      `<h2>This hub's certificate authority CHANGED</h2>
<p><code>${escapeHtml(input.hostname)}</code> presented a root that is not the one
this machine trusted for <code>${escapeHtml(input.hubUrl)}</code>. CamStack refused
the connection and will not offer to accept it.</p>
<p>A hub re-issues its leaf certificate on every address change without changing
its root, so a NEW root means the hub itself was reinstalled — or something else
is answering on that address. Check the hub's admin UI →
<em>Network → Local access certificate</em> against the fingerprint below.</p>
${details}
<p class="hint">To trust a new root, remove this hub in the tray's
<em>Change hub…</em> and add it again.</p>`,
    )
  }

  return page(
    'CamStack — certificate not trusted yet',
    `<h2>First connection to this hub</h2>
<p><code>${escapeHtml(input.hubUrl)}</code> uses its own local certificate
authority, which this machine has never seen. Nothing has been trusted yet.</p>
<p>Compare the fingerprint below with the one in the hub's admin UI →
<em>Network → Local access certificate</em>. Only if they match should this hub be
trusted — this is trust on first use, and the comparison is the whole of the
security it provides.</p>
${details}
<p><a class="btn" href="${TRUST_ACCEPT_URL}">Trust this certificate authority</a></p>
<p class="hint">Trusting it pins THIS root for this hub. If the hub ever presents
a different one, CamStack refuses the connection and does not offer to accept
it — that refusal is the value of pinning, and it only works if you compared the
fingerprint now.</p>`,
  )
}
