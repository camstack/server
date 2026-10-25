---
id: D609
title: A device's admin page is ONE read that may answer null, and its URL comes from the one builder that cannot be handed a credential
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/types/src/capabilities/device-admin-link.cap.ts
  - packages/types/src/capabilities/device-admin-link-url.ts
  - scripts/check-admin-link-builder-is-the-only-url-source.ts
---

## Context

The operator asked for a button that opens a device's own configuration page,
on the device row and in the device-detail header, for every provider that can
answer.

Three things made this less trivial than it reads.

**First, "can answer" is three different states, not two.** A VeSync humidifier
is reached only through a vendor cloud and has no address at all. A Tuya plug
and a Wyze camera DO have a LAN IP and still have no HTTP management page behind
it. A Reolink battery camera adopted over UDP by `uid` has a blank `host`
although its mains-powered sibling on the same fleet has a working page. A
Home Assistant broker authenticated by supervisor token carries no `baseUrl` at
all, while a long-lived-token broker carries one. Collapsing all of that into
"has a page: true/false" would either hide the page on devices that have one or
render a dead button on devices that do not.

**Second, the port field is a trap.** The obvious implementation reads `host`
and `port` off the device config. It is wrong on Reolink: `port` there is the
Baichuan media port, default 9000. Measured on the live fleet on 2026-09-22 —
device 107, 192.168.x.x — `http://…:9000/` refuses the connection outright
while `http://…/` returns 200 `text/html`. It is wrong on generic ONVIF too,
where the ONVIF service port is not the web port on several vendors. This is
exactly the class of bug that passes a unit test asserting a string and fails on
the wire.

**Third, and the one that decided the shape: every provider that knows a
device's host knows its password.** `{ host, port, username, password }` is one
object on Hikvision, Amcrest, Reolink and ONVIF alike. The "helpful" version of
this feature is one template literal away — `http://admin:hunter2@192.168.x.x/`
is a URL browsers accept — and it would put a live camera credential in the DOM,
in a right-click → copy, in a screenshot and in every log line that printed what
was opened. This repo has already shipped that leak once, on the RTSP surfaces,
which is why `scripts/check-no-credential-urls-in-fixtures.ts` exists.

A `deviceConfig` cap (D14) was considered and rejected: it exists to DERIVE a
settings form, costs a `builderId` reducer in `device-config-contribution.ts`
plus a `*-config-schema.ts`, and renders a form section. There is nothing here
to edit.

## Decision

`device-admin-link` is a device-native, singleton, pure-RPC capability with one
admin-gated query, `getAdminLink({ deviceId }) → DeviceAdminLink | null`.

- **A provider that cannot say does not register the cap.** No binding, no
  query, no surface. A provider that CAN say for its devices in general, but not
  for this one, registers and answers `null`.
- **Both answers draw nothing.** So do "not yet answered" and "the caller was
  refused". No surface ever renders a disabled button: none of those four states
  is broken, and a greyed-out control says broken (D62).
- **Every URL is built by `buildDeviceAdminUrl`**, which takes host, port,
  scheme and path as separate arguments — there is no parameter a credential
  could arrive in — refuses a host containing `@`, refuses a credential-shaped
  query key, and re-checks its own output against the same `scheme://user:pass@`
  pattern the fixture guard bans. An operator-configured base URL goes through
  `parseAdminBase`, which REFUSES userinfo rather than silently stripping it.
- **A port is only passed when the provider knows it is the WEB port.** Reolink
  passes `port: null` (the scheme default) with the Baichuan measurement in the
  comment; ONVIF answers `null` entirely when its service port is not 80 or 443.
- **`target` says whose page it is** — `device` for a web server on the device,
  `integration` for a page in the system that manages it. The surfaces hide a
  `device` link when the device is offline and KEEP an `integration` one, which
  is exactly when an operator wants the Home Assistant page for a dropped sensor.

## Consequences

- Adding a provider means answering "do I know the WEB port, or only a port?"
  A provider that cannot answer that must return `null`, not a default.
- The label is the provider's ("Web UI", "Home Assistant", "UniFi controller",
  "CCU WebUI"): a surface deriving it from the addon id would call the Home
  Assistant device page "Provider Homeassistant".
- Both surfaces resolve through ONE hook (`useDeviceAdminLink`). Two copies of a
  four-state gate is how two surfaces come to disagree about one device.
- The URL is a LAN fact. Nothing proxies it, nothing makes it reachable from
  outside, and it is not sent anywhere.
- UniFi and Homematic get the controller / CCU ROOT, not a per-device deep link,
  because neither snapshot carries the device's own address and both deep-link
  routes are UI-version dependent. That is a deliberate floor, not an omission.

## Enforcement

- `scripts/check-admin-link-builder-is-the-only-url-source.ts` (wired into
  `.github/workflows/ci.yml`): every `getAdminLink` body must call
  `buildDeviceAdminUrl` and must contain no self-assembled `scheme://…` literal.
  Scoped to the method body, not the file — the same camera classes legitimately
  build `rtsp://user:pass@host/…` a few hundred lines away, and a file-wide rule
  fired on seven of those.
- `packages/types/src/capabilities/__tests__/device-admin-link-url.spec.ts`
  pins the refusals; each was verified to go RED with its gate removed.
- `server/backend/src/__tests__/cap-routers/device-admin-link.router.spec.ts`
  pins the device-native mount (the `motion` 412-on-every-camera failure mode)
  and the admin gate; both verified RED with `deviceNative` / `auth` removed.
- `packages/ui-library/src/composites/device-item/__tests__/admin-link-quick-action.test.tsx`
  pins the four draw-nothing states and that nothing is even ASKED for an
  unbound cap.
