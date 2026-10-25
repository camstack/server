---
title: A central link domain — HA-style hub redirect + working Universal Links
status: superseded in shape — implemented 2026-10-06 as the hosted viewer PWA (see note)
date: 2026-08-19
applies-to:
  - packages/addon-post-analysis/src/notification-center/default-tap-url.ts
  - server/backend/src/core/app-links/well-known-app-links.ts
  - camstack/src/navigation/pending-deep-link.ts
  - camstack/app.config.ts
last-verified: 2026-08-18
---

> **Implemented differently (2026-10-06).** `camstack.zentik.app` is not a
> separate static redirector: it serves the **viewer PWA itself**
> (`camstack/web-server/`, deployed to Railway), which also serves the
> `.well-known` app-link files and `/connect`. With the app installed a link
> opens the app; without it, the same viewer runs in the browser and talks to
> the user's hub directly (CORS allowlist, D707). Notification taps use it by
> default through the Network page's notifications flag (D709). The standalone
> redirector (`camstack-link`) was deleted.


# A central link domain — HA-style hub redirect + working Universal Links

> Status: **design, 2026-08-19. Nothing here is implemented.** The operator's
> request, verbatim: *"bisogna progettare il viewer stile HA per connettere i
> Cloud degli utenti, una volta che l'utente ci arriva una volta, il redirect
> sarà automatico al prossimo tap?"*
> [We need to design the HA-style viewer to connect the users' Clouds; once the user gets there once, will the redirect be automatic on the next tap?]
>
> **The short answer: yes — automatic after the first visit, per browser.**
> The hub URL is stored in the browser's `localStorage` on first contact;
> every later tap redirects without interaction. And on a phone with the app
> installed it is better than automatic: the OS opens the app directly and the
> page never loads at all. The limits are the storage's: per browser profile,
> per device, gone on "clear site data", not persisted in private browsing.
> Details in §1.4.
>
> Required background:
> [2026-08-18-notification-click-actions.md](./2026-08-18-notification-click-actions.md)
> (§3.1 established that a self-hosted hub can never be a Universal Link
> origin; this document is the answer to that finding),
> `packages/addon-post-analysis/src/notification-center/default-tap-url.ts`
> (the default tap URL that is already live),
> `camstack/src/navigation/pending-deep-link.ts` (cold-start URL preservation,
> live since v1.0.347).

---

## 1. The my.home-assistant.io model, verified from source

Everything in this section was read from
`github.com/home-assistant/my.home-assistant.io` (fetched 2026-08-18) and the
live FAQ — not assumed.

### 1.1 The mechanism

The entire service is a **static site** with no backend state. The instance
URL lives in the visitor's browser:

```ts
// src/const.ts — verbatim
export const HASS_URL = "hassUrl";
export const DEFAULT_HASS_URL = "http://homeassistant.local:8123";
export const MOBILE_URL = "homeassistant://navigate";

// src/data/instance_info.ts — verbatim
export const getInstanceUrl = (): string | null => {
  if (isMobile) return MOBILE_URL;
  return localStorage.getItem(HASS_URL);
};
```

Links have the shape `https://my.home-assistant.io/redirect/<intent>/?<params>`.
Every `<intent>` is a **pre-registered entry** in a redirect registry with
typed parameters (`src-11ty/_data/redirects.js`, validated in
`src/util/validate.ts`) — the FAQ states it as policy: *"All links and their
parameters are pre-defined in this website and in the 'my' integration in
Home Assistant."* There is no free-form destination anywhere in the URL, which
is what keeps a client-side redirector from being an open-redirect service.

The redirect page (`src/entrypoints/my-redirect.ts`) does this, in order:

1. `getInstanceUrl()` returns `null` (**first visit**) → the page forwards
   itself to the configuration page (`/redirect/_change/?redirect=…`), where
   the visitor types their instance URL; it is written to `localStorage` and
   the visitor comes back to the original link.
2. URL stored (**every later visit**) → the page composes
   `${instanceUrl}/_my_redirect/<intent>?<params>` and renders it as an
   **"Open link" button**. Note carefully: **HA does not auto-navigate** — the
   visitor always confirms with one tap. The footer shows the stored URL with
   a pencil icon to change it.
3. `?mobile=1` on the link (**inside the companion app's browser**) → the
   target becomes `homeassistant://navigate/…` — the app's custom scheme —
   and the change-URL footer is hidden.

Separately from `?mobile=1`, the iOS and Android **companion apps register
`my.home-assistant.io` as an associated domain**, so a tap on a my-link
outside the app opens the app directly via Universal Link / App Link — the
web page is only the fallback for browsers and appless phones.

### 1.2 The privacy posture

Quoting the FAQ: *"All the data is stored in your browser"* and *"At no point
will any data leave your network."* This holds because documentation links
never contain the instance URL — the visitor types it once, locally. The
trade-off is the visible one: **first contact requires a form.**

### 1.3 What we copy and what we deliberately do not

| my.home-assistant.io | CamStack central link | why the divergence |
| --- | --- | --- |
| static site, no backend | same | the whole point — nothing to run, nothing to breach |
| instance URL in `localStorage`, never in the link | hub URL in `localStorage`, **optionally seeded by `?hub=`** (§3.3, §6) | our links come from the user's *own hub*, not from public docs — the hub already knows its URL and can save the user the form |
| closed intent registry | closed **path-family allowlist** (§2.3) | same property (no free-form destination), different shape — our intents are the viewer's routes |
| "Open link" **button**, never auto-navigate | **automatic** `location.replace` | HA is linked from third-party documentation read by strangers; our links are minted by the user's own hub into their own notification channel. A notification tap that lands on a page demanding a second tap is a regression against today's direct hub URL, which needs zero |
| companion app registers the domain | **already shipped**: the viewer declares `applinks:camstack.zentik.app` (`camstack/app.config.ts:36`) and the Android `autoVerify` filter (`:66`) | this is the decisive constraint — reusing this exact domain needs **no store release** (§2.1) |

### 1.4 The operator's question, answered precisely

*"una volta che l'utente ci arriva una volta, il redirect sarà automatico al
prossimo tap?"* [once the user gets there once, will the redirect be automatic on the next tap?] — **Yes**, with these boundaries:

- **Automatic per browser profile.** Safari on the phone, Chrome on the
  laptop and Firefox on the desktop are three first visits. (With `?hub=` on
  the link, §3.3, each "first visit" is itself automatic — the form only
  exists for links that omit it.)
- **App installed = the page never runs.** The OS hands the URL straight to
  the app; localStorage is irrelevant on that device from then on.
- **What resets it:** clear site data / clear browsing data, a different
  browser profile, private/incognito windows (storage dies with the window),
  and browsers that expire storage for unvisited sites (ITP can drop
  localStorage after ~7 days of no interaction on Safari — one more reason to
  keep `?hub=` on the link as the self-healing seed).
- **Not synced.** localStorage does not roam across devices, unlike HA's
  companion-app path — same limit HA lives with.

---

## 2. The architecture

### 2.1 The domain: `camstack.zentik.app`, because the app already vouches for it

The viewer's native config already declares exactly one Universal Link
origin: `applinks:camstack.zentik.app` (iOS, `camstack/app.config.ts:36`) and
`https://camstack.zentik.app/*` with `autoVerify: true` (Android, `:66`).
Today that domain has a DNS record and **serves nothing** — the AASA fetch
fails, so the entitlement is dead weight and every https link opens a
browser.

Choosing any other domain means editing the entitlement, which means a native
build and a store release on both platforms. Choosing this one means the
existing installed apps start opening links the moment the domain serves a
valid AASA: **iOS refreshes AASA via Apple's CDN on app install and roughly
weekly thereafter; Android re-verifies on install/update.** No release, no
OTA — a pure server-side unlock. That asymmetry decides it.

The domain serves exactly three things:

| path | content | consumer |
| --- | --- | --- |
| `/.well-known/apple-app-site-association` | AASA claiming the viewer route families (§2.3) | iOS, via Apple CDN |
| `/.well-known/assetlinks.json` | cert-fingerprinted statement for both bundle ids | Android verifier |
| everything else on the allowlist | one static redirect page (§3) | browsers without the app |

### 2.2 The well-known pair: generated from the existing single owner

`server/backend/src/core/app-links/well-known-app-links.ts:35` is already the
single owner of team id, bundle ids and the AASA/assetlinks shapes (mounted
on the hub at `server/backend/src/main.ts:1311`). The central site must not
become a second hand-written copy — that is exactly the drift CLAUDE.md's
codegen rule exists to prevent, and the Zentik notifier's checked-in static
copies (`zentik-notifier/frontend/public/.well-known/*`) are the pattern we
are *not* copying, because nothing guards them.

**Decision: generate, don't copy.** The site's source lives in this repo
(proposed: `sites/central-link/`) <!-- drift-ok: planned directory, does not
exist yet --> and its build step imports `buildAppLinkFiles` and writes both
files into the publish directory. One change: the function grows a
`components` parameter, because the two domains claim different paths — the
hub claims `/viewer/camstack/*` (the viewer's mount under the hub), the
central domain claims the viewer's route families at root (§2.3). Same
constants, same shapes, two call sites. Android fingerprints arrive the same
way they do on the hub: `CAMSTACK_ANDROID_CERT_SHA256` as a build-time env
var on the Pages project.

### 2.3 The link shape: direct viewer paths, no `/l/` prefix

Two candidates were on the table:

- `https://camstack.zentik.app/l/camera/101?at=…` — a namespaced redirect
  prefix, HA-style (`/redirect/…`);
- `https://camstack.zentik.app/camera/101?at=…` — the viewer's own route,
  verbatim.

**Decision: the viewer's own paths, verbatim.** Three constraints all point
the same way:

1. **expo-router matches the path against the file tree.** A Universal Link
   delivers the full URL to the app, and `/camera/101` matches
   `app/(app)/camera/[id].tsx` with **zero app changes**. `/l/camera/101`
   matches nothing — it would need a `+native-intent` rewrite hook, i.e. new
   native-adjacent code and a new failure mode, to strip a prefix that buys
   nothing.
2. **The cold-start stash already knows these paths.** `STASHABLE_PREFIXES`
   in `camstack/src/navigation/pending-deep-link.ts:20` is
   `['/camera/', '/events', '/grid/', '/notifications']` — the central
   domain's allowlist and the stash allowlist become the *same list*, one
   invariant instead of two.
3. **The browser fallback is a suffix append.** The redirect page maps
   `path + query` → `<storedHub>/viewer/camstack/<path>?<query minus hub>`
   mechanically. A prefix would need stripping in one place and not the
   other — a second derivation of the same string, which is the D52 failure
   shape in miniature.

The AASA therefore claims exactly the route families and nothing else:

```
components: [ {"/": "/camera/*"}, {"/": "/events"}, {"/": "/grid/*"}, {"/": "/notifications"} ]
```

The root `/` (landing + configuration page) and `/.well-known/*` are *not*
claimed, so a person opening the domain to configure their browser stays in
the browser on iOS. One known wart: the **Android** intent filter shipped
with `pathPrefix: "/"` (`camstack/app.config.ts:73`), so a verified Android
install captures the root too. Acceptable — a phone with the app installed
has no use for the browser config page — and tightened to per-family
`pathPrefix` entries at the next native release, not before.

The redirect page itself is a single `index.html` rewritten onto every
allowlisted path (Cloudflare Pages `_redirects` rewrites, plus a `_headers`
entry forcing `content-type: application/json` on the extensionless AASA).
A path outside the allowlist is a hard 404, never a redirect.

---

## 3. The four flows

| situation | what happens | interaction needed |
| --- | --- | --- |
| app installed (iOS/Android) | OS opens the app on the route; page never loads; cold start survives the auth gate via `pending-deep-link.ts` | none |
| browser, hub already stored | page loads, `location.replace` to `<hub>/viewer/camstack/<path>?<query>` | none |
| browser, first visit, link carries `?hub=` | validate → store → redirect, with a one-line banner naming the hub host | none |
| browser, first visit, no `?hub=` | configuration form (HA's `/redirect/_change/` equivalent): paste hub URL, validate, store, redirect | one form, once |

### 3.1 App installed

Nothing new to build. The entitlement is live, `pending-deep-link.ts`
preserves the URL across cold start and login, and the `/camera/[id]?at=`
route is the same one today's direct hub links target. The only novelty is
that the AASA finally exists, so the OS actually routes the tap. Note the
in-app-browser caveat: some chat clients (Telegram's webview, notably) open
links internally where Universal Links may not fire — the tap then falls
through to the browser flow, which still lands on the right hub page. Every
failure mode of the app path degrades to the web path, never to a dead end.

### 3.2 Browser with a stored hub — the automatic redirect

The page reads `localStorage.camstackHubUrl`, validates it is still a
well-formed `https://` origin, strips `hub` from the query, and issues
`location.replace(hub + '/viewer/camstack' + path + query)`. `replace`, not
`assign`: the interstitial must not pollute the back button. A tiny static
frame ("Opening your CamStack…" with the target host named, plus a "change
hub" link) renders behind the redirect for the sub-second it is visible and
becomes the error surface if the stored value fails validation.

Unlike HA there is **no confirmation button** (§1.3 has the reasoning). The
open-redirect analysis that makes this safe: the destination *host* never
comes from the tapped URL — it comes from localStorage (user-established) or
from a `?hub=` that is subject to §3.3's poisoning guard — and the *path* is
a closed allowlist appended to a fixed `/viewer/camstack` mount. An attacker
who controls the link controls, at most, which camera page of the victim's
own hub opens.

### 3.3 First visit with `?hub=` — the self-configuring link

The hub mints its default tap links with `&hub=<base>` where `<base>` is the
same answer the endpoint ladder already gives `defaultTapUrl` today
(`dispatcher.ts:1016`). First visit: validate (`https:` scheme, no
credentials, no query/fragment, origin only), store, banner, redirect. The
form in §3.4 then exists only for hand-shared links and edge cases — the
normal user never sees it, which is the concrete improvement over HA's
first-run.

**The poisoning guard:** `?hub=` auto-configures **only when nothing is
stored**. If a stored hub exists and the link's `hub` differs, the page does
NOT silently rewrite storage — it redirects to the *stored* hub and shows a
dismissible notice ("this link was minted by a different hub — switch?").
Without this rule, one crafted link re-points every future tap at an
attacker's host; with it, changing hubs is always an explicit act, same as
HA's pencil-icon flow.

### 3.4 First visit without `?hub=`, and the appless phone

The form: one input, client-side validation identical to §3.3's, store,
redirect. A short "get the app" hint may sit under the form, but **decision:
no store interstitial and no store auto-detection.** The web viewer under
`/viewer/camstack/` is a complete PWA — redirecting an appless phone to it
is a working outcome, not a consolation page. A store-badge page is the
classic place these flows go to die (wrong store links, region gaps, the
"open in app" banner nobody asked for); if the operator wants badges later
they go on the root landing page, phase 3, never in the tap path.

---

## 4. Hosting: Cloudflare Pages, not a Zentik backend route

The two candidates, honestly compared:

| | Cloudflare Pages on `zentik.app` | route on the Zentik notifier backend |
| --- | --- | --- |
| what runs | nothing — static files on a CDN | a NestJS app in a self-hosted container (`zentik-notifier/backend`, which serves its frontend from `/public`) |
| blast radius of an outage | Cloudflare's | every CamStack notification tap, for every user, coupled to one homelab deployment |
| release cadence | its own (`sites/central-link/` in this repo, §2.2) | Zentik's — a CamStack link change would ride Zentik's docker releases |
| `.well-known` content-type / cache control | `_headers` file, trivial | NestJS static-serving config in a foreign repo |
| cost | free tier, comfortably | already paid, but see blast radius |

**Decision: Cloudflare Pages.** The operator controls the `zentik.app` zone
and the `camstack.zentik.app` DNS record already exists — pointing it at a
Pages project is a CNAME flip. The deciding argument is coupling, not cost:
this page is in the critical path of *every* notification tap for *every*
CamStack install, and the Zentik notifier backend is one self-hosted service
among many. The redirect logic is ~100 lines of dependency-free vanilla JS
with no build-time framework — the only build step is the well-known
generation of §2.2. (Precedent honesty: Zentik itself serves its well-known
pair from the NestJS backend in production, and it works — but Zentik's
domain vouches for Zentik's own app on the same deployment. Here the domain
vouches for a *different product's* installed base, which deserves the more
boring host.)

Privacy note, stated rather than hidden: HA can claim "no data leaves your
network" because its links carry no instance URL. Ours carry `?hub=` (§6),
so the hub hostname transits the notifier channel and Cloudflare sees
request paths. §6 weighs this; the summary is that today's live default tap
URL already exposes strictly more.

---

## 5. What changes in the dispatcher

Today (`default-tap-url.ts:31`, called at `dispatcher.ts:1016`): the default
tap is `<base>/viewer/camstack/camera/<id>?at=<ts>`, base from the endpoint
ladder, no URL when the ladder has no answer.

**Decision: the central link becomes the default for app-capable notifiers;
browser-bound notifiers keep the direct hub URL.** Using the vocabulary the
click-actions design already assigned per kind (§4.3 there):

| kinds | default tap URL | why |
| --- | --- | --- |
| zentik, ntfy, homeassistant, pushover (phone-push kinds) | `https://camstack.zentik.app/camera/<id>?at=<ts>&hub=<base>` | the tap may land on a phone with the app — only the central domain can open it. One https URL now serves *both* the app and the appless case, which quietly retires the `camstack://`-vs-https question (D2 of the click-actions design) for the default tap: the custom scheme is no longer needed on this path |
| telegram, discord, whatsapp, gotify (chat/desktop kinds) | `<base>/viewer/camstack/camera/<id>?at=<ts>` — unchanged | the reader is a browser; the central hop buys nothing and adds a moving part. Also the privacy floor: these channels already receive the hub URL today, so keeping the direct form changes nothing |
| webhook | direct, unchanged | the consumer is a machine; give it the truth |

Mechanically: `defaultTapUrl` stays the single owner and gains a
`form: 'central' | 'direct'` input; the dispatcher picks the form off the
target kind (the same static table above, next to `clickUrlKinds` when that
lands). A rule-authored `clickUrl` still always wins, unchanged.

**One real improvement hiding here:** today, `baseUrl === null` (no
reachable non-loopback base) means *no tap URL at all*. The central form
does not need the base to be useful — the app reaches the hub through its
own configured endpoints, tunnels and all. So: central links are minted
**even when the ladder returns null**, just without `&hub=` (and a browser
that was configured earlier still redirects fine). The only case that still
yields no URL is the one that should: system events and unknown cameras.

---

## 6. `?hub=` and privacy — include it, with eyes open

What `&hub=<base>` costs: the hub's public hostname rides inside every
notification payload, through the notifier's infrastructure (Zentik's APNs
relay, ntfy's server, …), and reaches Cloudflare when a browser follows the
link. What it buys: the first visit configures itself (§3.3), and Safari's
storage expiry self-heals (§1.4).

**Decision: include it, because it is not a new disclosure.** The live
default tap URL *is* the hub base URL — every channel that would see
`hub=<base>` in the new link sees `<base>` as the entire link today. The
central link with `?hub=` is at worst privacy-neutral against what ships,
and for the chat kinds we keep the direct URL anyway (§5). If the operator
later wants a paranoid mode, the natural knob is a per-target passthrough
param that omits `hub=` — the cost is the §3.4 form on that channel's first
browser tap, and it is phase 3, not now. What we do **not** do is invent a
hub-identifier indirection (an opaque id resolved by the central page) — that
requires the central service to hold a registry of hub URLs, which destroys
the static-site property and builds the exact database HA refuses to have.

---

## 7. Phases

| phase | contents | size | proof it worked |
| --- | --- | --- | --- |
| **1 — the domain goes live** | `sites/central-link/`: redirect page (localStorage read, allowlist, `?hub=` seed + poisoning guard, form, `location.replace`), `_redirects`/`_headers`, build step generating AASA + assetlinks via `buildAppLinkFiles(components, certs)`, Cloudflare Pages project + CNAME | ~1 day; the page is ~100 lines of vanilla JS + one HTML file | AASA validates (Apple CDN fetch + `swcutil`/validator); a hand-typed `https://camstack.zentik.app/camera/101?at=…&hub=…` opens the app on an installed phone and redirects a clean browser after one visit |
| **2 — the hub mints central links** | `defaultTapUrl` grows `form`; dispatcher picks per kind (§5); mint even on `baseUrl === null` (central, no `hub=`); unit tests beside `default-tap-url.spec.ts` | ~half day, pure TS + tests | tap a real Zentik notification on a phone with the app → app opens on the camera; same tap on an appless phone → browser lands on the hub viewer |
| **3 — polish, each independently skippable** | root landing page (+ optional store badges), per-target "omit `hub=`" privacy param, Android intent-filter tightening at next native release, "switch hub" UX beyond the §3.3 notice | small, on demand | — |

Phase 1 is deliberately self-contained and shippable **before** any hub or
viewer change: the moment the domain serves a valid AASA, links minted by
hand (or by a curious operator's rule params) already open the app. Phase 2
is what puts those links into every notification. Nothing in either phase
touches the viewer's native config, so **no store release anywhere in this
plan** — that constraint shaped §2.1 and it held.

### Left to the operator

- **O1 — confirm the domain.** Everything above assumes
  `camstack.zentik.app` because the shipped entitlement names it. If CamStack
  is ever to live on its own zone (`camstack.app`?), that is a store release
  and a different plan — decide before phase 1, not after.
- **O2 — the `hub=` default.** §6 argues include-by-default is
  privacy-neutral versus today. Veto here if the long-term intent is for
  notification payloads to stop carrying the hub URL entirely.
