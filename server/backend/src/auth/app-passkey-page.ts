/**
 * The standalone passkey page for a native app sign-in (D858).
 *
 * Served by the hub at `/auth/app/passkey`, NOT part of the admin-ui bundle:
 * plain HTML and one small inline script, no third-party asset, no framework.
 * The app opens it in the system browser (`ASWebAuthenticationSession` /
 * Custom Tab); the WebAuthn relying party is the hub's own origin, so the app
 * needs no per-domain entitlement. The page runs the usernameless assertion
 * ceremony against `POST …/begin` and `POST …/finish` (same origin) and
 * navigates to the `location` the hub answers - the app's custom scheme.
 *
 * The CSP pins exactly the one script and one style by hash, forbids every
 * other source, and lets the page talk to its own origin only. Nothing request
 * specific is ever placed in the script; the only server-rendered value is the
 * (allow-listed, HTML-escaped) cancel link.
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
  var q = new URLSearchParams(location.search);
  var base = location.pathname.replace(/\\/+$/, '');
  var btn = document.getElementById('go');
  var msg = document.getElementById('msg');
  var S = function (k) { return document.body.getAttribute('data-s-' + k) || ''; };
  var KEYS = ['code_challenge', 'code_challenge_method', 'state', 'purpose', 'redirect', 'lang'];
  var APP_CALLBACK = /^camstack(\\.dev)?:\\/\\/auth-callback(\\?|$)/;
  function fromB64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var b = atob(s), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  }
  function toB64u(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function flow() {
    var o = {};
    KEYS.forEach(function (k) { var v = q.get(k); if (v !== null) o[k] = v; });
    return o;
  }
  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }
  function fail(text) { msg.textContent = text; btn.disabled = false; }
  function go() {
    btn.disabled = true;
    msg.textContent = '';
    if (!window.PublicKeyCredential || !navigator.credentials) {
      return fail(S('passkey-unsupported'));
    }
    post('/begin', flow()).then(function (begin) {
      if (!begin.ok) throw new Error('unavailable');
      var opts = begin.body.optionsJSON;
      var pk = {
        challenge: fromB64u(opts.challenge),
        timeout: opts.timeout,
        rpId: opts.rpId,
        userVerification: opts.userVerification,
        allowCredentials: (opts.allowCredentials || []).map(function (c) {
          return { type: c.type, id: fromB64u(c.id), transports: c.transports };
        })
      };
      return navigator.credentials.get({ publicKey: pk });
    }).then(function (cred) {
      var r = cred.response;
      var body = flow();
      body.response = {
        id: cred.id,
        rawId: toB64u(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: {
          authenticatorData: toB64u(r.authenticatorData),
          clientDataJSON: toB64u(r.clientDataJSON),
          signature: toB64u(r.signature),
          userHandle: r.userHandle ? toB64u(r.userHandle) : undefined
        }
      };
      return post('/finish', body);
    }).then(function (done) {
      var next = done.body && done.body.confirm;
      if (typeof next === 'string' && /^confirm\\?confirm=[A-Za-z0-9_-]+$/.test(next)) {
        location.assign(next);
        return;
      }
      var target = done.body && done.body.location;
      if (typeof target !== 'string' || !APP_CALLBACK.test(target)) {
        throw new Error('failed');
      }
      location.assign(target);
    }).catch(function (e) {
      fail(
        e && e.name === 'NotAllowedError' ? S('passkey-cancelled')
          : e && e.message === 'unavailable' ? S('passkey-unavailable')
          : S('sign-in-failed')
      );
    });
  }
  btn.addEventListener('click', go);
})();`

/**
 * The page's CSP: the shell's style and the one script by hash, same-origin
 * requests only, no framing, no base rewrite, no form posts, no plugins.
 */
export const APP_PASSKEY_CSP = appPageCsp({ script: PAGE_SCRIPT })

/** The page; `cancelHref` is the app callback carrying `error=cancelled`. */
export function appPasskeyPage(cancelHref: string, lang: AppPageLang): string {
  const t = appStrings(lang)
  return renderAppPage({
    lang,
    title: t.passkey.title,
    heading: t.passkey.heading,
    noReferrer: true,
    script: PAGE_SCRIPT,
    scriptStrings: {
      'passkey-unsupported': t.script.passkeyUnsupported,
      'passkey-unavailable': t.script.passkeyUnavailable,
      'passkey-cancelled': t.script.passkeyCancelled,
      'sign-in-failed': t.script.signInFailed,
    },
    body: [
      appParagraph(t.passkey.body),
      appButton(t.passkey.button, 'id="go"'),
      appErrorLine('msg'),
      appCancelLink(cancelHref, t.passkey.cancel),
      `<noscript><p class="error">${escapeHtml(t.passkey.noscript)}</p></noscript>`,
    ].join(''),
  })
}

/** The page for a request the hub refuses to serve: a sentence, no script, no assets. */
export function appPasskeyRefusalPage(message: string, lang: AppPageLang): string {
  const t = appStrings(lang).refused
  return renderAppPage({
    lang,
    title: t.title,
    heading: t.title,
    body: appParagraph(message) + appHint(t.hint),
  })
}

/** CSP of the refusal page: the shell's style only, nothing runs. */
export const APP_PASSKEY_REFUSAL_CSP = appPageCsp()
