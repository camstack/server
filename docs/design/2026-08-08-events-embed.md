# The events embed — an embeddable track surface on the player's rails

**Date:** 2026-08-08 · **Status:** shipped (Viewer) ·
**Route:** `/viewer/camstack/embed/index.html?mode=events`

Host integration reference (params, message tables):
`camstack/embed/src/embed/EVENTS-EMBED.md`.

## What was asked for

An embeddable web component that renders tracks/events with rich settings, able
to cover both the compact reel and the full events page, on the viewer and in
the admin UI. Infinite scroll; configurable row count, visible fields and
thumbnail size; events back to the host (card click and friends) via
`postMessage`.

## The decision: a fourth mode, not a fourth thing

The stream-broker addon already serves a chrome-less SPA at
`/addon/stream-broker/embed/`, dispatching on `?mode=` to a grid, a player and a
recording page. Everything the ask needs already exists there, and every piece of
it was earned:

| Concern | What the embed bundle already does |
| --- | --- |
| Serving | `ctx.dataPlane.serve({ prefix:'embed', access:'public' })` + an SPA-aware static handler, reverse-proxied on the hub's own origin/cert |
| Build | `vite build -c embed/vite.config.ts` → `embed-dist/`, packed by the addon's `files` |
| Ship | `camstack deploy packages/addon-pipeline` |
| Caching | content-hashed assets served `immutable` for a year; `index.html` `no-cache` |
| Config | native `window.__CAMSTACK_*` global, or the `embed-ready`→`embed-config` iframe handshake, or a standalone share URL with the token in `#t=` |
| Auth | token in the injected body config, never on the navigation |
| Messaging | `host-bridge.ts` — one `emitHost` that picks `ReactNativeWebView.postMessage` or `parent.postMessage` |
| Session cookie | `GET /api/embed-auth?next=…` allow-lists exactly the `/addon/stream-broker/embed/` prefix |

So the events surface is `?mode=events` in the same bundle. This is not a
size-of-diff argument. A second bundle would have had to re-earn the SPA
fallback, the immutable-asset headers, the two-transport bridge and the
`isEmbedRedirectTarget` allow-list — and the last one is a security check that
would have needed *widening* for a second prefix. Nothing hub-side changed:
no new route, no manifest entry, no capability, no backend edit.

The cost is honest and stated: the bundle is shared, so an events-only change
re-hashes assets the grid also loads. It is one gzipped ~357 KB chunk that every
embed surface already downloads once per app build.

### What was NOT reused

The viewer's `use-tracks.ts` was read, not copied. Two of its behaviours are
things the embed must not inherit — see below — and the embed cannot depend on
the app repo in any case.

## Data: cursor paging, incremental refresh

The feed is `pipelineAnalytics.listRecentTracks` with `projection: 'slim'` —
ONE merged request per page across every selected camera, ordered by
(`lastSeen` DESC, `trackId` DESC). Three decisions carry the design.

### 1. Pages follow the CURSOR, not a time window

The viewer walks fixed 12-hour windows backwards and asks for
`perCamera × cameras` rows per window. When a window fills its budget the older
tracks *inside* it are never shown, and nothing on screen distinguishes that
from "there were no more" — which is why that hook has to log
`window filled its budget — older tracks in it are not shown` (measured
2026-08-05: 716 rows against a 720 budget, 99.4 %).

`nextCursor` has no such failure mode. `TrackStore.queryRecent` overfetches by
one per device precisely so the cursor is exact: non-null means more rows are
KNOWN to exist, `null` means every device returned fewer rows than asked and is
therefore exhausted. The embed pages on that and nothing else.

### 2. The server's fan-out budget is mirrored client-side

`queryRecent` caps what it will materialise at `RECENT_FANOUT_ROW_BUDGET = 2000`
rows (`deviceCount × limit`) and quietly serves a shorter page, logging
`listRecentTracks page reduced by the fan-out budget`. A client asking for 200
rows across 20 cameras gets 100 and — reading only the length — concludes the
page was partial for some unrelated reason.

`resolveEventsPageLimit(requested, devices)` mirrors
`min(asked, 1000, floor(2000 / devices))` so the ask is honest to begin with.
The mirror is a hint, not a correctness dependency: if the server value moves,
the page merely comes back shorter and the cursor still carries it. Default page
size is 60 — deliberately short, because a short page paints sooner and the
cursor makes "short" cost nothing.

### 3. Refresh is a delta, never a restart

The viewer's refresh bumps a bucketed anchor that is part of the query key, so a
refresh mints a new infinite query and re-fetches the whole feed. (That model is
under review in the viewer; it is not reproduced here.)

The embed asks only for what is newer than the head:

```
since = rows[0].lastSeen        // INCLUSIVE
```

Inclusive is load-bearing. `lastSeen` is a millisecond and two tracks on two
cameras routinely share one; `since = head + 1` skips every tie, and a skipped
track never comes back because the next delta's floor is higher still. The
overlap it costs is exactly one row, which the merge deduplicates.

The merge is by `trackId` and the incoming row WINS: an active track's
`lastSeen` advances between polls, and a naive prepend would show it twice. The
paging cursor and the `exhausted` flag are untouched — a delta says nothing
about how far back the feed has been paged, and clobbering them is precisely how
an "incremental" refresh turns into a restart.

A delta page that returns with a non-null cursor means rows exist between it and
the head. The hook drains that cursor, bounded at 5 pages; hitting the bound is
logged on the host log channel, because a feed with a hole and no line saying so
is indistinguishable from a quiet night.

### Memory ceiling

`maxRows` (default 600) stops pagination; it never truncates the loaded list.
Dropping the tail would strand the cursor past a hole nobody could ever fill.

## Media: fetched, not `src`-ed

The event-media data plane is `access: 'admin'` and authenticates on
`Authorization: Bearer` or the hub session cookie. A browser `<img src>` can
carry neither — the native viewer solves this by handing `expo-image` a
`headers` option, and there is no web equivalent. Verified on the live hub:

```
GET /addon/pipeline-analytics/event-media/<id>?variant=thumb&size=192
  with Bearer → 200, image/jpeg, 192×192, 3 870 B
  without     → 401
```

So `use-authed-image.ts` fetches with the header and renders an object URL from
a **bounded, revoking** LRU (250 entries). The plane serves
`cache-control: public, max-age=31536000, immutable` plus an ETag, so a repeat
fetch is served from the HTTP cache and the object URL is the only new
allocation. Concurrent mounts of one URL share a single in-flight promise —
infinite scroll mounts many cells at once.

`?kind=` is deliberately not sent: the default resolver serves the per-event
`crop` and, when the id is a TRACK id (which it is for the majority of tiles,
since `bestEventId` falls back to the trackId), the track's own `thumbnail`.
Forcing `kind=crop` skips that fallback and leaves those tiles empty — the same
trap the viewer's `TrackCropImage` documents.

The alternative — routing hosts through `GET /api/embed-auth` for a session
cookie — was rejected as the primary path: it obliges every host to navigate a
particular way, and the grid embed's existing model (token in the body config,
nothing on the navigation) is the one already proven in the WebView. The cookie
path still works when a host happens to have set one.

## Configuration

`serverUrl` and `token` are required; everything else has a default, so a host
that knows only those two gets a working reel. Three sources, in precedence
order: native global → URL with `#t=` token → iframe handshake, with the URL's
layout params applied on top of the handshake config (a web host can put the
look in the `src` and only the credentials on the channel).

`acquireConfig` gained one option, `urlFirst`, used only by this mode: the grid
share links are only ever opened as a top-level window, but
`<iframe src="…?mode=events&v=1…#t=…">` is the entire integration for a page
that has a token and no message plumbing, and without it the frame would hang on
a handshake nobody answers.

Knobs: `view` (reel | gallery), `rows` (reel), `columns` (gallery, `auto` or
fixed), `thumbSize`, per-field visibility (`label`, `sublabel`, `camera`,
`time`, `badges`), `deviceIds`, `classes`, `search`, `pageSize`, `maxRows`,
`refreshMs`, `maxAgeMs`, `theme`. All of them are patchable at runtime through
one validated `setConfig` command; `serverUrl` / `token` are not, because
swapping the identity of a mounted embed is a remount.

Filters apply CLIENT-SIDE over the loaded window, so toggling one is instant and
costs no round-trip; only the camera set and the age floor reset the feed.

## Protocol

Versioned from the first line (`v: 1` on every outbound message), unlike the
grid protocol which predates versioning and cannot gain it without breaking
shipped hosts. v1 rule: fields may be ADDED, never removed or retyped.

```
embed → host   ready · error · state · trackClick · countChanged
host  → embed   setConfig · refresh · reload · loadMore · scrollToTop
```

`trackClick` carries `bestEventId` alongside `trackId`/`deviceId` so a host can
open a detail view with no extra round-trip. `countChanged` separates `loaded`
(from the server) from `shown` (after client filters) — collapsing them is how
"your filter hid everything" reads as "nothing was recorded".

## Verification

Live against the hub at `https://<hub-ip>:4443` after
`camstack deploy packages/addon-pipeline`:

- `GET /addon/stream-broker/embed/?mode=events&v=1&view=gallery` → 200 (the
  prefix is `access: 'public'`; the DATA is token-gated);
- the deployed bundle contains the events code (`__CAMSTACK_EVENTS__`,
  `countChanged`, `variant=thumb&size=`);
- `listRecentTracks` slim over 6 cameras: 12 rows, `positions`/`snapshots`
  empty, a `nextCursor`; the second page overlaps the first by **0** rows and
  continues strictly older;
- the delta query with `since = head` returns exactly the head row and
  `nextCursor: null` — idempotent, no restart, no gap;
- the media thumb: 200 / 192×192 JPEG with Bearer, 401 without.

Tests: **87** across the pure modules (feed engine 22, row normalisation 21,
URL config 18, config 13, protocol 13) plus **10** render-level wiring tests
that drive the real surface with a fake data client and assert on the
postMessage protocol — 97 in total, inside a bundle suite of 321.

Both suites were mutation-checked, because a green suite is not proof: the pure
specs go red when `applyDelta` clobbers the paging cursor or the fan-out mirror
is removed; the wiring specs go red when the "all cameras" resolution, the
inclusive delta floor, or the deferred-`loadMore` replay is broken.

The deferred-`loadMore` replay exists *because* of a test. A 1-in-5 flake in the
cursor-paging spec was not a test artefact: a `loadMore` arriving while a
request was in flight was dropped, and the sentinel is an
`IntersectionObserver`, which fires on a TRANSITION — so the ask never came
again and the feed stalled with pages still available. Two things were needed:
remember the ask and replay it on settle, and advance the paging ref
*synchronously* in the `.then` (a replay one microtask later reads the ref, not
the uncommitted React state, and would re-request page one forever).

## Not done here

**Viewer integration.** The events surfaces in the viewer repo
(`camstack/src/screens/EventsScreen.tsx`, `components/events/track/TrackReel.tsx`,
`data/use-tracks.ts`) are being worked on concurrently and were not touched. The
hook-up point is the one the live grid already uses:
`camstack/src/grid-embed/GridLiveEmbed.tsx` is the template — a `WebView` that
injects `window.__CAMSTACK_EVENTS__` before load, forwards commands through
`injectedJavaScript` calling `window.__camstackEvents.*`, and routes `onMessage`
by `type`. `buildGridEmbedUrl`'s `EmbedMode` union gains `'events'` and nothing
else changes. `trackClick` maps onto the same navigation the reel's `onPress`
performs today.

**Admin UI.** `addon-admin-ui` already renders `/embed/player` outside the
protected tree; an `<iframe>` at
`?mode=events&v=1&view=gallery#t=<session token>` needs no new plumbing at all.


---

# Addendum, 2026-08-08 — what the gallery needed, and the reel bug it exposed

The reel switched to the embed (viewer 1.0.275). The gallery could not follow:
three capabilities of the events page had no protocol, and two rendering defects
turned up the moment a real surface used it.

## Versioning: v1, additive — NOT v2

Every addition below is a new optional config field, a new command, or a new
field on an existing message. A host that sends none of them gets byte-identical
behaviour, which is exactly the condition v1 declared when it said *"fields may
be ADDED (a host ignores what it does not know)"*. Bumping to v2 would tell every
host to branch on `v` for a break that does not exist.

Additive is not the same as discoverable, though, and the viewer and the embed
ship on **different chains** — this repo has been bitten by that twice. So
`ready` now carries `features: ['window','sort','semantic-search',
'macro-classes']`. A host gates a new command on that list instead of sending it
into silence. An absent `features` IS the older embed.

## 1. Day navigation — the bounds ride the request

`sinceMs` / `untilMs` on the config, plus `setWindow` as sugar over the same two
fields (one conversion, `windowCommandToPatch`, so the two entry points cannot
disagree). Both go to `listRecentTracks`'s own `since`/`until`.

Three states per bound, all distinct: a number SETS, `null` CLEARS (back to the
rolling feed), absent LEAVES ALONE. That three-way is the whole ergonomics of day
navigation and it had a real bug: the first implementation spread `{}` over a
base that still carried the old value, so a clear did nothing. The test written
for it caught that before it shipped.

Two consequences fall out and both are enforced:

- **The window resets the feed.** A cursor issued for one window is meaningless
  against another, so `sinceMs`/`untilMs` join the reset key alongside the camera
  set.
- **A window CLOSED in the past stops the poll.** Nothing newer can appear inside
  a finished day; polling it is a query a minute that can only return the head
  back. The upper bound also rides the DELTA request — without it, a day view
  polling "newer than my head" would pull in tracks from after the day it shows,
  which is the one way an explicit window can leak.

## 2. Sort — client-side, and said so

`sort: 'time' | 'importance'`. `importance` **cannot** be pushed into the query:
`listRecentTracks` orders by `lastSeen` and its cursor encodes that position, so
an importance-ordered page could not be continued. It therefore sorts what is
loaded, and the docs say that in those words rather than implying a global
ranking. Unscored rows sink below every scored one (ties break on the time
order) instead of scattering through them.

## 3. CLIP search — PASSTHROUGH, not host-driven

The choice was between the embed calling the search itself, and a documented
"host supplies trackIds" mode. Passthrough wins on every axis that mattered:

- **Fan-out.** `searchObjectEvents` takes ONE optional `deviceId` and omitting it
  searches every camera — a single request, the same economy the feed was
  designed around. Host-driven would hand the embed ids it has not loaded, and
  the only way to render those is `getTrack` per id: exactly the per-camera
  fan-out this surface removed.
- **Divergence.** Two implementations of "what does this query match" drift. The
  `mediaKey ?? trackId ?? id` thumbnail rule already took a real bug to find
  once; re-deriving it in a host would have been the second time.
- **Auth.** `searchObjectEvents` is `access: 'view'` — the same level as
  `listRecentTracks`, which the embed already calls with the token it holds. No
  new grant.

The honest cost, documented and reported to the host: a hit is an EVENT, not a
track. `zonesVisited` / `audioLabels` / `active` render empty rather than being
faked from a second query, and `countChanged.mode: 'semantic'` tells the host the
counts describe a complete result set (`hasMore` always false) so it does not
render a "load more". Results are deduplicated by track, best score wins — one
subject crossing a frame is many detections of one crop.

## 4. The two weak filters, aligned to the viewer

Both now resolve through `listEventKindsBatch` (`kind` → `parentKind`), the same
server descriptors the viewer's picker is built from — nothing hardcoded, so a
class the hub learns tomorrow expands without an embed redeploy.

- **Class filter**: selecting `vehicle` keeps a `truck`. Expansion is one-way,
  UPWARD — a `truck` never matches `car`, because that is not a broader search,
  it is a wrong one. Audio matches by its namespaced id plus the bare `audio`
  macro (labels are stored bare; the picker emits namespaced — the mismatch that
  made an audio selection match 0 of 1000 rows on the live hub).
- **Free text**: reads BOTH label tiers plus the class family. Tier 2 is the one
  that matters — identities live there now, so a box captioned "label / identity
  / plate" that read only tier 1 matched nothing when you typed a name.

A taxonomy that fails to load degrades to an exact-id compare: narrower, never
empty, and logged.

## 5. The reel bug: one number, two symptoms

The operator reported "the embed shows no time" and "small isn't small". They
were **the same defect**.

The native reel card is a square hero with the caption overlaid and a ONE-LINE
footer holding the time, and the host reserves exactly that:
`reelRowHeight(cardWidth) = cardWidth + 3*2 + 14 + 4*2` — 108 px for the small
preset. The embed's own scale was 96/128/168 against the native
`REEL_THUMB_SIZE_PX` of **80/106/132** (read out of the viewer's settings store,
not estimated). At `small` the hero alone plus padding already exceeded 108, so
the footer — the time — sat below the fold. It had been rendered all along.

Fixed by adopting the native numbers and reproducing the native reel layout line
for line (`bodyReel` padding 3, `styles.time` 11 px on an explicit 14 px line,
tabular numerals, caption as a pill over the image). `reelRowHeightPx` mirrors
the host contract and is pinned by a test, so the next drift is a red suite
rather than a clipped strip.

Separately, the media plane is now asked for `cardEdge × devicePixelRatio`
(clamped to the plane's [64, 320]) instead of a fixed table — physical pixels,
measured from the running view. An 80 px tile on a 2x WebView gets 160 px of
image instead of a soft upscale.

## Tests

+56 over the previous delivery (377 in the bundle suite). Every new capability
has a discriminating test, and all four were mutation-checked together — removing
the request-side window, making the importance sort a no-op, deleting the macro
expansion, and restoring the old card scale turned **16 tests red across 3
files**.


---

# Addendum 2, 2026-08-08 — a shared link could not list at all

The first shared events link failed on
`'pipelineAnalytics.listRecentTracks' is not available to share-view tokens`.

`share-view-access.ts` is a **fail-closed enumeration** — for a share principal
the surface is "a closed enumeration, not a capability grant" — and it only ever
knew the GRID embed's call graph. The events embed calls four methods that were
never in it. The link authenticated fine and then could not read a row.

## A new scope kind, not a bigger `grid-view`

The tempting fix is to add three method names to the existing set. It is wrong:
every `csv_*` link an operator has already handed out carries `kind:'grid-view'`,
so widening that set **retroactively widens every one of them** — a link minted
to show a camera wall would silently begin serving that camera's event history,
with no new mint, no new consent, and nothing in any log to say the perimeter
moved.

So `events-view` is its own kind with its own enumeration, and neither is a
superset of the other: an events link cannot open a WebRTC session, a grid link
cannot read a track. Both directions are tested, because "the old token gained
nothing" is the actual security claim and it is not self-evident from the diff.

`ShareTokenScopeSchema` went from `z.literal('grid-view')` to
`z.enum(['grid-view','events-view'])` — the router's mint/list schemas derive
from it, so the new kind is accepted with no other change.

## The array problem, and why filter-and-serve

`listRecentTracks` / `listEventKindsBatch` take `deviceIds[]`. The existing
per-call pattern ("is `input.deviceId` in scope") does not even typecheck
against that shape, which is the real reason these were never covered.

The rule is **intersection**, and on a partial match the outcome is
**filter-and-serve**: a request naming at least one in-scope camera passes, and
the RESPONSE is stripped to the scope. Rejecting a partial match instead would
break a multi-camera link the moment its owner removed one camera from the
share — a change that should narrow the link, not kill it.

A **fully disjoint** request is denied rather than answered `[]`. An empty page
reads as "these cameras had no events"; the truth is "you cannot see these
cameras", and collapsing those two is how a permission problem gets debugged as
a data problem.

## The one that actually needed the response filter

`searchObjectEvents` takes an OPTIONAL single `deviceId`, and **omitting it
searches the entire deployment**. That is precisely why the caller cannot be
trusted to scope its own query — the caller is a URL a third party is holding.

The call is ALLOWED and the answer is cut server-side. Rejecting the un-pinned
case would leave a multi-camera share unable to search at all and would not be
one bit safer. So `projectShareScopeRows` is not defence-in-depth on this path;
it is the enforcement. The middleware applies it to all three methods, a row
with no numeric `deviceId` is DROPPED ("probably in scope" is not an argument),
and the paged envelope keeps its `nextCursor` — dropping it would end a shared
page's infinite scroll at page one.

Mutation-checked: making the projection a no-op, or folding the methods into
`grid-view`, turns **9 tests red across both suites**.

## Honest limitation, recorded rather than hidden

The `limit` is spent BEFORE the cut. A share covering 2 of 30 cameras can get
few or no hits from a 50-result CLIP query even when matches exist on its own
cameras. Pinning to one camera avoids it; fixing it properly means pushing the
scope into the cap's own query, which is server-side and belongs with the
thumbnail work.

**Thumbnails still do not load from a share link** — the data-plane gate resolves
a session JWT or a `cst_*` token and nothing else. Not an access-level problem,
and lowering one (already done) changed nothing here. The shared page now LISTS;
the tiles stay empty until the gate learns `csv_*` and carries the scope into
the plane.
