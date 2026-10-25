/**
 * The hub-rendered confirmation page of a native app sign-in (D858):
 * "Sign in the CamStack app as <username>?".
 *
 * Same discipline as the passkey page (`app-passkey-page.ts`): plain HTML on the
 * shared shell (`app-page-shell.ts`, which owns the look and the style hash),
 * one inline script pinned by SHA-256 in the CSP, same-origin requests only, no
 * framing, no third-party asset. The page carries the
 * one-shot token in a `data-` attribute (never in the script), so the script
 * hash is a constant. Continue POSTs the token and navigates to the
 * `location` the hub answers; Cancel is a plain link to the app with
 * `error=cancelled`.
 */
import {
  appButton,
  appCancelLink,
  appErrorLine,
  appHint,
  appPageCsp,
  appParagraph,
  escapeHtml,
  renderAppPage,
} from './app-page-shell.js'
import { type AppPageLang, appStrings } from './app-page-strings.js'

const PAGE_SCRIPT = `(function () {
  var btn = document.getElementById('go');
  var msg = document.getElementById('msg');
  var S = function (k) { return document.body.getAttribute('data-s-' + k) || ''; };
  var APP_CALLBACK = /^camstack(\\.dev)?:\\/\\/auth-callback(\\?|$)/;
  btn.addEventListener('click', function () {
    btn.disabled = true;
    msg.textContent = '';
    fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: btn.getAttribute('data-confirm') }),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (typeof body.location !== 'string' || !APP_CALLBACK.test(body.location)) {
        throw new Error('bad-location');
      }
      location.assign(body.location);
    }).catch(function () {
      msg.textContent = S('confirm-expired');
    });
  });
})();`

/** The CSP: the shell's style and this page's one script by hash, same-origin requests, no framing, no form posts. */
export const APP_CONFIRM_CSP = appPageCsp({ script: PAGE_SCRIPT })

/** CSP of the refusal page: the shell's style only, nothing runs. */
export const APP_CONFIRM_REFUSAL_CSP = appPageCsp()

/** The confirmation page for `username`; `cancelHref` is the app callback carrying `error=cancelled`. */
export function appConfirmPage(input: {
  readonly lang: AppPageLang
  readonly username: string
  readonly token: string
  readonly cancelHref: string
}): string {
  const t = appStrings(input.lang)
  return renderAppPage({
    lang: input.lang,
    title: t.confirm.title,
    heading: t.confirm.heading,
    noReferrer: true,
    script: PAGE_SCRIPT,
    scriptStrings: { 'confirm-expired': t.script.confirmExpired },
    body: [
      `<p>${escapeHtml(t.confirm.signedInAsBefore)}<strong>${escapeHtml(input.username)}</strong>${escapeHtml(t.confirm.signedInAsAfter)}</p>`,
      appHint(t.confirm.hint),
      appButton(t.confirm.continueLabel, `id="go" data-confirm="${escapeHtml(input.token)}"`),
      appErrorLine('msg'),
      appCancelLink(input.cancelHref, t.confirm.cancel),
      `<noscript><p class="error">${escapeHtml(t.confirm.noscript)}</p></noscript>`,
    ].join(''),
  })
}

/** A confirmation that is gone (expired, used, or opened in another browser): a sentence, nothing runs. */
export function appConfirmRefusalPage(lang: AppPageLang): string {
  const t = appStrings(lang).confirmExpired
  return renderAppPage({
    lang,
    title: t.title,
    heading: t.title,
    body: appParagraph(t.body) + appHint(t.hint),
  })
}
