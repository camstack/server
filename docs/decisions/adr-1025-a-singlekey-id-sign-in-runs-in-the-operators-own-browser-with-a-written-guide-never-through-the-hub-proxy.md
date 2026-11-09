---
id: D1025
title: A SingleKey ID sign-in runs in the operator's own browser with a written guide, never through the hub proxy
status: accepted
date: 2026-11-09
applies-to:
  - packages/addon-provider-bosch/src/shared/sign-in-guide.ts
  - packages/addon-provider-bosch/src/homecom/config.ts
  - packages/addon-provider-bosch/src/home-connect/config.ts
---

## Context

D955 served the vendor's login page under the hub origin so the redirect to the vendor's app
scheme could be captured automatically. HomeCom and Home Connect both sign in on SingleKey ID,
whose login page carries an hCaptcha. The sitekey is bound to SingleKey's own domains: a page
served under the hub origin gets `429` from `api.hcaptcha.com` (`getcaptcha`, action
`network-error`) and can never pass. Headers, cookies and a server cookie jar do not change that.

## Decision

HomeCom and Home Connect do not use the hub login proxy. The form shows a guide (open the real
sign-in page in your own browser, sign in, copy the address the browser stops on, per browser) and
the paste box; `beginSignIn` only publishes the authorize URL and `finishSignIn` exchanges the
pasted address. The `claimSignIn` action and the field's `claimAction` are gone. The
`VendorLoginProxy` stays in `@camstack/types` for the Alexa sign-in, which has no captcha bound to a
vendor domain. D955 stays for that use only.

## Consequences

The operator copies one address by hand; the guide text carries the per-browser steps. A vendor whose
login page cannot work under a foreign origin must take this path, not the proxy.

## Enforcement

`sign-in-guide.spec.ts` pins the guide rows, their English and Italian lines, and the absence of a
claim action for both forms.
