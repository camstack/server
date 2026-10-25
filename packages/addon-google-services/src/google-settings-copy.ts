/**
 * Operator-facing setup copy for Connectivity → Calendars / Email.
 * Keep Connect as a same-origin relative link so the admin session cookie
 * rides along (an absolute Public URL from a LAN admin tab drops the cookie).
 * Root-relative hrefs must survive `sanitizeInfoHtml` in ui-library.
 */
import { OAUTH_CALLBACK_SUFFIX, OAUTH_START_PATH } from './google-types.js'

export type GoogleSettingsCap = 'calendar-source' | 'smtp-provider' | undefined

/** Enable APIs library in Google Cloud Console. */
export const GOOGLE_CONSOLE_APIS_URL = 'https://console.cloud.google.com/apis/library'
/** Create / manage OAuth Web clients. */
export const GOOGLE_CONSOLE_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

export function redirectUriDisplay(publicOrigin: string | null): string {
  if (publicOrigin === null || publicOrigin.length === 0) {
    return `<public-hub>${OAUTH_CALLBACK_SUFFIX}`
  }
  return `${publicOrigin.replace(/\/$/, '')}${OAUTH_CALLBACK_SUFFIX}`
}

function consoleLinksHtml(): string {
  return [
    `<a href="${GOOGLE_CONSOLE_APIS_URL}">API library</a>`,
    ` · `,
    `<a href="${GOOGLE_CONSOLE_CREDENTIALS_URL}">Credentials</a>`,
  ].join('')
}

export function introHtml(cap: GoogleSettingsCap, publicOrigin: string | null): string {
  const redirect = escapeHtml(redirectUriDisplay(publicOrigin))
  const console = consoleLinksHtml()
  if (cap === 'smtp-provider') {
    return [
      '<ol>',
      `<li>Open Google Cloud Console (${console}) and enable the <strong>Gmail API</strong> (and Calendar API if you also use Calendars).</li>`,
      '<li>Under Credentials, create an OAuth client of type <strong>Web application</strong>.</li>',
      `<li>Add this authorized redirect URI (Network → <strong>Public endpoint</strong>, not Internal): <code>${redirect}</code></li>`,
      '<li>Paste Client ID and Client secret below, then <strong>Save</strong>.</li>',
      `<li>Open <a href="${OAUTH_START_PATH}">Connect Google</a> while signed in as admin (same browser tab as this hub).</li>`,
      '<li>Set From address (connected account or a verified send-as). Turn this integration off with the page <strong>Enable</strong> toggle when you do not want Gmail send — Calendar can stay connected.</li>',
      '</ol>',
    ].join('')
  }
  if (cap === 'calendar-source') {
    return [
      '<ol>',
      `<li>Open Google Cloud Console (${console}) and enable the <strong>Google Calendar API</strong> (and Gmail API if you also use Email).</li>`,
      '<li>Under Credentials, create an OAuth client of type <strong>Web application</strong>.</li>',
      `<li>Add this authorized redirect URI (Network → <strong>Public endpoint</strong>, not Internal): <code>${redirect}</code></li>`,
      '<li>Paste Client ID and Client secret below, then <strong>Save</strong>.</li>',
      `<li>Open <a href="${OAUTH_START_PATH}">Connect Google</a> while signed in as admin (same browser tab as this hub).</li>`,
      '<li>Optionally restrict which calendars are exposed with the filter below.</li>',
      '</ol>',
    ].join('')
  }
  return [
    '<ol>',
    `<li>Open Google Cloud Console (${console}) and enable <strong>Google Calendar API</strong> and <strong>Gmail API</strong>.</li>`,
    '<li>Create a <strong>Web application</strong> OAuth client under Credentials.</li>',
    `<li>Register redirect URI: <code>${redirect}</code> (Network → Public endpoint).</li>`,
    `<li>Paste Client ID / secret, Save, then <a href="${OAUTH_START_PATH}">Connect Google</a>.</li>`,
    '<li>Calendars and Email share one Google account; use each page’s <strong>Enable</strong> toggle to turn a capability off without revoking OAuth.</li>',
    '</ol>',
  ].join('')
}

export function connectHtml(cap: GoogleSettingsCap, publicOrigin: string | null): string {
  const redirect = escapeHtml(redirectUriDisplay(publicOrigin))
  if (cap === 'smtp-provider') {
    return [
      `After Save, open <a href="${OAUTH_START_PATH}">Connect Google</a> in this hub (admin session required). `,
      'Connect requests <code>gmail.send</code> (and Calendar read for the Calendars page). ',
      `Google must list exactly: <code>${redirect}</code>. `,
      'If an older Connect predates Gmail send, revoke CamStack in Google Account → Security and Connect again. ',
      `Console: ${consoleLinksHtml()}.`,
    ].join('')
  }
  if (cap === 'calendar-source') {
    return [
      `After Save, open <a href="${OAUTH_START_PATH}">Connect Google</a> in this hub (admin session required). `,
      'Connect requests <code>calendar.readonly</code> (and Gmail send for the Email page). ',
      `Google must list exactly: <code>${redirect}</code>. `,
      `Console: ${consoleLinksHtml()}.`,
    ].join('')
  }
  return [
    `After Save, open <a href="${OAUTH_START_PATH}">Connect Google</a>. `,
    `Redirect URI registered in Google Cloud must be <code>${redirect}</code>. `,
    `Console: ${consoleLinksHtml()}.`,
  ].join('')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
