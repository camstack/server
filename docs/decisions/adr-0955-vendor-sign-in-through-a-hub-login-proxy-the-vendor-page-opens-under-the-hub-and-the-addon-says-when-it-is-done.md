---
id: D955
title: Vendor sign-in through a hub login proxy — the vendor page opens under the hub and the addon says when it is done
status: accepted
date: 2026-10-27
applies-to:
  - packages/types/src/vendor-login-proxy/**
  - packages/addon-provider-bosch/src/shared/login-proxy-sign-in.ts
  - packages/addon-provider-bosch/src/home-connect/home-connect-sign-in-proxy.ts
  - packages/addon-provider-bosch/src/homecom/homecom-sign-in-proxy.ts
  - packages/addon-import-alexa/src/alexa-proxy-login.ts
  - packages/addon-import-alexa/src/alexa-proxy-login-manager.ts
---

## Context

Some vendors have no third-party OAuth callback we can register. Home Connect and
SingleKey ID (HomeCom) end their login on an address of the vendor's own mobile app
(`hcauth://auth/prod?code=…`, `com.bosch.tt.dashtt.pointt://app/login?code=…`) that no
browser can open; Amazon has no OAuth at all. Until now the operator opened the vendor's
page, signed in, and then dug the redirect out of the browser's developer tools (Network
tab, Preserve log, filter by `code=`) to paste it back. Alexa instead ran alexa-cookie2's
own listener on `http://<lan-ip>:3456`, which an HTTPS admin page cannot open (mixed
content) and which needed a published port on a containerised hub.

## Decision

The hub is the HTTPS face of the vendor's login. A reusable `VendorLoginProxy` lives in
the bare `@camstack/types` entry (bundled into each addon, no `node:` imports beyond the
types of `http`; subpaths are host-resolved, D15) and is mounted by the addon on a data
plane (`ctx.dataPlane.serve({ prefix: VENDOR_LOGIN_PROXY_PREFIX, access: 'admin' })`). The browser opens
`/addon/<addonId>/vendor-login/<attemptId>/<vendorHost>/<path>`: the hub authenticates the
admin session, the proxy fetches the vendor page and rewrites its absolute URLs,
`Location` and `Set-Cookie` into the mount.

- **The mount prefix is `vendor-login`, never `login`.** The hub matches an addon's
  data-plane prefixes BEFORE its HTTP routes, and the Alexa addon serves
  `/addon/import-alexa/login/start|status|commit|cancel`. Mounted on `login`, the proxy
  swallowed `POST /login/start` (an attempt named "start") and answered HTML, so the
  admin UI's `res.json()` failed ("The string did not match the expected pattern").
  `VENDOR_LOGIN_PROXY_PREFIX` is one constant in `@camstack/types`; `VendorLoginProxy`
  takes no prefix option, and a spec asserts no route the addon serves starts with it.
- The **terminal condition is the addon's**: a function over each upstream response that
  answers `continue` or `done(payload)`. Bosch: a `Location` (or a script/meta
  navigation) starting with the app scheme. Alexa: alexa-cookie2's redirect to
  `/cookie-success`. On `done` the addon's `onDone` runs the SAME exchange the paste path
  runs (`finishHomeConnectSignIn`, `finishHomeComSignIn`, the cookie capture) and the
  browser is redirected to the existing CamStack result page (`oauthLandingUrl`, status
  plus a closed reason code — never a token or a code in the URL).
- The form that started the attempt receives the result by polling a `claimSignIn`
  custom action (`claimAction` on the `account-sign-in` field): `pending` until the
  exchange finished, then the fields `finishSignIn` returns, claimed once. The paste box
  stays as the fallback ("If the page does not finish, paste…") and is the only path
  when the hub is not serving the data plane.
- **Option (b) for Alexa:** alexa-cookie2's own proxy keeps running, bound to
  `127.0.0.1` (`proxyOwnIp` and `proxyListenBind` both loopback), and our primitive is its
  public HTTPS face — the allow-listed upstream is that one loopback `http` origin. We did
  not replace it with our own Amazon-specific proxy (option a): the capture needs the
  PKCE verifier, device id, initial cookies, the `/ax/claim` and CSRF steps and the app
  registration alexa-cookie2 already performs, and re-implementing them would add
  failure modes where Amazon builds a URL in JavaScript without the host prefix. The
  hub proxy only has to rewrite the loopback-origin URLs alexa-cookie2 emits, which are
  absolute and uniform.

Security rules the primitive enforces: the attempt id is a random one-shot capability
that expires with `SIGN_IN_ATTEMPT_TTL_MS` and is consumed on `done`; starting an attempt
needs an admin session; only allow-listed upstream hosts are reachable (an open proxy is
an SSRF) and `http` only for a loopback host; the hub's own `camstack_*` cookies and
`Authorization` are never forwarded upstream; `Set-Cookie` loses its `Domain` and is
scoped to the attempt's path; CSP, frame and HSTS headers that would break the page under
the hub origin are dropped; URLs embedded in query parameters are left alone; request
bodies, cookies, `Authorization`, the captured address and the code are never logged.

## Consequences

The Bosch and Alexa sign-ins no longer ask the operator to read the browser's network
log, and the Alexa flow no longer needs a published port or a LAN address (the
`proxyHost` setting and the LAN-only warnings are gone; `proxyPort` is loopback only).
The vendor pages now run under the hub's origin: a page that builds a URL in JavaScript
without it appearing as a quoted absolute URL, a captcha bound to the original origin, or
a cookie whose domain the vendor re-checks can still break the flow — which is why the
paste path stays. The host allow-lists (`api.home-connect.com`, `singlekey-id.com`) are
the vendors' documented login hosts and could not be exercised against the live pages
without credentials. A hub behind a path prefix opens the proxied page on the page's own
origin and relies on the reverse proxy forwarding `/addon/…`.

## Enforcement

Specs in `packages/types/src/vendor-login-proxy/__tests__` (rewriting, cookies, allow-list,
replay and expiry), `packages/addon-provider-bosch/src/shared/__tests__/login-proxy-sign-in.spec.ts`
(fake vendor ending on `hcauth://…`, exchange run, result page reached) and
`packages/addon-import-alexa/src/__tests__/alexa-login-through-hub-proxy.spec.ts`
(loopback bind asserted on the options alexa-cookie2 receives). No guard; review only for
a new vendor's host list.

## Addendum: form fields travel back reversed

The response rewrite also touches hidden-input values, so a page that carries a return URL
in a form field reaches the browser as a proxy address. On the way back, the proxy therefore
reverses every `application/x-www-form-urlencoded` field value that is a proxy URL of this
attempt (absolute or root-relative, host in the attempt's upstreams) to the vendor URL,
the same rule as the `Referer` (`rewriteFormBody`). Other pairs stay byte-identical;
multipart bodies are not reversed (no current vendor posts one).
