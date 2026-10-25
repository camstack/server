import {
  appHiddenField,
  appHint,
  appSubmitButton,
  escapeHtml,
  renderAppPage,
} from '../../auth/app-page-shell.js'
import { type AppPageLang, appStrings } from '../../auth/app-page-strings.js'

interface ConsentPageInput {
  lang: AppPageLang
  displayName: string
  username: string
  scopeSummary: string
  /** Where the authorization code will be sent. Rendered because an
   *  integration may admit a redirect_uri by PATTERN (a self-hosted client on
   *  a private host), which makes the operator the last check on the
   *  destination. Omitted renders nothing rather than an empty row. */
  redirectUri?: string
  /** Hidden form fields replayed on POST. */
  hidden: Record<string, string>
}

/** Allow/Deny consent screen on the hub's shared page shell (the look of the
 *  app sign-in pages). Submitting POSTs to the same path with the hidden query
 *  fields + `consent=allow|deny`. */
export function renderConsentPage(input: ConsentPageInput): string {
  const hidden = Object.entries(input.hidden)
    .map(([name, value]) => appHiddenField(name, value))
    .join('')
  const t = appStrings(input.lang).consent
  const destination = input.redirectUri
    ? `<p class="hint">${escapeHtml(t.sendingTo)}<code>${escapeHtml(input.redirectUri)}</code></p>`
    : ''
  return renderAppPage({
    lang: input.lang,
    title: `${t.titlePrefix}${input.displayName}`,
    heading: `${t.headingPrefix}${input.displayName}`,
    body: [
      `<p>${escapeHtml(t.signedInAs)}<strong>${escapeHtml(input.username)}</strong></p>`,
      appHint(`${t.grantPrefix}${input.scopeSummary}`),
      destination,
      `<form method="POST">${hidden}<div class="actions">${appSubmitButton(t.allow, 'consent', 'allow')}${appSubmitButton(t.deny, 'consent', 'deny', true)}</div></form>`,
    ].join(''),
  })
}
