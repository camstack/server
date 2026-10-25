# A notification you can act on — tap targets and per-provider actions

> Status: **analysis + design, 2026-08-18. Nothing here is implemented.** The
> operator's request: *"we must support the on-click URL property, e.g.
> supported by Zentik and ntfy and similar… on the notification tap we can do
> actions — for example by default open the camera in the native app. Analyse
> the situation and let's see how to support different actions per notification
> click depending on the provider."*
>
> Required background:
> [notifications.md](../architecture/notifications.md) (the outbox, the
> dispatcher, the degrade engine, the action plane),
> [ui.md](../architecture/ui.md),
> [D62](../decisions/adr-0062.md) (a control that cannot do anything must not be
> shown), [D52](../decisions/adr-0052.md) (one derivation, one owner).
>
> **Five decisions are deliberately left to the operator** (§7). Everything
> else here is decided, with the reasoning attached.
>
> The headline finding, stated once: **the transport already exists end to
> end.** `clickUrl` is a first-class field on the canonical notification, every
> one of the nine notifier kinds declares `caps.clickUrl: true` and renders it,
> and the degrade engine already gates it per target. What is missing is
> (a) anybody putting a *viewer* URL in it for a detection event, and (b) a
> viewer that can be reached by that URL from a cold start.

---

## 1. What ships today

### 1.1 The seam, in one line

`NotificationCenter` mints buttons → `NcDispatcher.deliver` builds the canonical
`Notification` → cap `notificationOutput.send` → `prepareNotification(caps, n)`
(the pure degrade engine) → `adapter.buildRequest(config, prepared)` (pure,
returns an `HttpRequestPlan`) → the provider executes it.

- The canonical notification: `packages/types/src/capabilities/notification-output.cap.ts:170`
- The per-kind capability descriptor: `packages/types/src/capabilities/notification-output.cap.ts:217`
- The degrade engine: `packages/types/src/notification/degrade-engine.ts:121`
- The adapter registry (8 kinds): `packages/addon-notifiers/src/addon.ts:40`
- The ninth kind, in a different addon: `packages/addon-provider-homeassistant/src/ha-notification-output.ts:213`

### 1.2 The two affordances that already exist on the wire

**`clickUrl`** — `packages/types/src/capabilities/notification-output.cap.ts:177`,
gated on `caps.clickUrl` (`:233`) by the engine at
`packages/types/src/notification/degrade-engine.ts:191`. Whole-notification tap
target.

**`actions[]`** — `NotificationActionSchema` at
`packages/types/src/capabilities/notification-output.cap.ts:129`:
`{ id, label, url?, icon?, destructive?, mode? }`. `mode` is
`'navigate' | 'background'` (`:158`) and its docblock is already the argument
this document extends: *navigate* means "the phone leaves the notification and
shows whatever the callback returns"; *background* means "fire it and stay put".
Buttons are minted per delivery by `mintActions`
(`packages/addon-post-analysis/src/notification-center/dispatcher.ts:880`) and
spread onto the notification at `:1040`.

**The icon vocabulary is a closed enum**, train-bound, at
`packages/types/src/capabilities/notification-output.cap.ts:102` — and it already
contains `view`, `play`, `open` and `camera`, which is exactly the vocabulary a
tap-through button needs. Nothing new is required there.

### 1.3 Per-provider capability table (read from the code, not assumed)

| kind | endpoint / transport | `clickUrl` rendered as | `caps.actions` | how a button is rendered | `actionIcons` | `bodyMaxLen` |
| --- | --- | --- | --- | --- | --- | --- |
| **zentik** | `POST {base}/api/v1/messages`, JSON | `tapUrl` (`packages/addon-notifiers/src/adapters/zentik.ts:487`) | **4** | `NAVIGATE` \| `BACKGROUND_CALL` (`POST::url`) \| `OPEN_NOTIFICATION` (`packages/addon-notifiers/src/adapters/zentik.ts:253`) | ✅ SF Symbols (`packages/addon-notifiers/src/adapters/zentik.ts:189`) | 500 |
| **ntfy** | `POST {server}` JSON, or `PUT {server}/{topic}` raw + `X-*` | `click` (`packages/addon-notifiers/src/adapters/ntfy.ts:144`) / `x-click` (`:181`) | **3** | `view` \| `http` (`packages/addon-notifiers/src/adapters/ntfy.ts:102`) | ❌ explicit `false` (`packages/addon-notifiers/src/adapters/ntfy.ts:295`) | 4096 |
| **homeassistant** | broker WS `call_service notify.<svc>` | `data.url` **and** `data.clickAction` (`packages/addon-provider-homeassistant/src/ha-notification-output.ts:239`) | **3** | `data.actions[] = {action,title,uri,icon}` (`packages/addon-provider-homeassistant/src/ha-notification-output.ts:229`) | ✅ `mdi:` | 3500 |
| **telegram** | `POST api.telegram.org/bot…/<method>` | an `<a href>` **inside the text** (`packages/addon-notifiers/src/adapters/telegram.ts:147`) | **3** | `reply_markup` inline URL keyboard, `{text,url}` only (`packages/addon-notifiers/src/adapters/telegram.ts:159`) | ❌ absent | 4096 |
| **webhook** | `{config.method} {config.url}`, JSON | `clickUrl` verbatim (`packages/addon-notifiers/src/adapters/webhook.ts:174`) | **99** | `PreparedAction[]` verbatim (`packages/addon-notifiers/src/adapters/webhook.ts:175`) | ✅ | 1 000 000 |
| **gotify** | `POST {server}/message`, JSON | `extras['client::notification'].click.url` (`packages/addon-notifiers/src/adapters/gotify.ts:222`) | **0** | — (engine slices to zero) | n/a | 4096 |
| **discord** | `POST {webhookUrl}` | `embeds[0].url` (`packages/addon-notifiers/src/adapters/discord.ts:227`) | **0** | — | n/a | 2000 |
| **pushover** | `POST api.pushover.net/1/messages.json`, multipart | `url` + `url_title` (`packages/addon-notifiers/src/adapters/pushover.ts:223`) | **0** | — | n/a | 1024 |
| **whatsapp** | 3 backends (green-api / waha / evolution) | appended as a **text line** (`packages/addon-notifiers/src/adapters/whatsapp.ts:131`) | **0** | — | n/a | — |

Two columns are worth reading together. **Every kind can take a tap URL.**
Only five can take buttons, and of those only three (zentik, HA, webhook) carry
an icon. That asymmetry is the whole reason the design below puts the *primary*
intent on `clickUrl` and treats buttons as an enrichment.

### 1.4 The affordances that exist and are unused

1. **`clickUrl` is never set for a detection event.** The only automatic
   producers are the timelapse (`packages/addon-post-analysis/src/notification-center/timelapse/timelapse-scheduler.ts:400`)
   and the digest/summary (`packages/addon-post-analysis/src/notification-center/summary/summary-delivery.ts:251`),
   both a download link. For everything else it can only arrive as a **static**
   per-target passthrough param, read at
   `packages/addon-post-analysis/src/notification-center/dispatcher.ts:1780`.
   A rule can therefore pin one fixed URL for all its notifications and nothing
   more. **This is the hole.**
2. **`deviceId`, `eventId` and `metadata`** are accepted by the cap
   (`packages/types/src/capabilities/notification-output.cap.ts:182`) and then
   dropped: they are not on `PreparedNotification`
   (`packages/types/src/notification/degrade-engine.ts:54`), so no adapter can
   ever see them. A backend has no way to learn what the notification is *about*
   except through the URL we hand it.
3. **`renderedAs` is computed and thrown away.** The provider returns it on
   every send (`packages/addon-notifiers/src/provider.ts:203`) and the dispatcher
   never reads it — a grep of `dispatcher.ts` for `renderedAs` returns nothing.
   So "your tap URL was dropped for this target" is calculated on every delivery
   and told to nobody. That is the same silence D62 is about, and §5 fixes it.
4. **`tag`** is passed through ungated (`packages/types/src/notification/degrade-engine.ts:205`)
   and consumed by only two of nine backends (webhook, HA). Notification
   replace-in-place is effectively dead on zentik and ntfy.
5. **HA action ids round-trip** as a `mobile_app_notification_action` bus event
   (`packages/addon-provider-homeassistant/src/ha-notification-output.ts:227`)
   and **nothing in this repo listens for it** — a second, structurally
   different actionable path that is half-present.

### 1.5 What `navigate` means today — and what it does not

The action plane is the only tap-through that exists. A button URL is
`{base}/addon/pipeline-analytics/nc-action/{id}?exp={ms}&sig={hmac}`
(`packages/addon-post-analysis/src/notification-center/action-token.ts:151`),
the route is `access: 'public'`
(`packages/addon-post-analysis/src/pipeline-analytics/data-plane-access.ts:72`),
and the authority is the signature alone. `mode` is set in exactly three
places: snooze buttons `background`
(`packages/addon-post-analysis/src/notification-center/action-buttons.ts:180`),
arm buttons `background` (`:267`), and the disarm button `navigate` (`:279`).

**So `navigate` today is not "open a page in the app".** It is "GET this
callback and render whatever it returns" — and what it returns is a hard-coded
inline-CSS confirmation page
(`packages/addon-post-analysis/src/notification-center/action-plane.ts:104`).
There is no app scheme and no viewer route anywhere in the action plane. Do not
mistake the existing `navigate` mode for the feature this document designs; they
share a word and nothing else.

---

## 2. What each provider actually offers

### 2.1 ntfy — verified

Consulted: <https://docs.ntfy.sh/publish/> (2026-08-18).

- **Click action.** `X-Click` header / `click` JSON field. Documented URL
  types: `http(s)://`, `mailto:`, `geo:`, `ntfy://`, `twitter://` — i.e. **ntfy
  explicitly documents custom schemes**, which matters for §3.
- **Action buttons.** `X-Actions` header or an `actions[]` array in the JSON
  publish. Four types: `view` (open a URL), `http` (GET/POST/PUT with optional
  `headers`/`body`), `broadcast` (Android intent), `copy`. Per-action fields:
  `action`, `label`, `url`, `method`, `headers`, `body`, `intent`, `extras`,
  `value`, `clear`.
- **Not supported:** per-action icons; a sound field; a TTL.
- CamStack renders `view` and `http` and nothing else
  (`packages/addon-notifiers/src/adapters/ntfy.ts:102`). `broadcast` and `copy`
  are unused — `copy` would be a sensible future "copy the track id" button;
  `broadcast` is Android-only and out of scope.

### 2.2 Zentik — verified against the operator's own server

Consulted: `https://notifier-api.zentik.app/api/docs-json` (fetched 2026-08-18),
which is the same source the adapter's header block was written from
(`packages/addon-notifiers/src/adapters/zentik.ts:9`).

`CreateMessageDto` carries, verbatim:

- `tapUrl` — *"Optional tap URL. If provided, will automatically set the
  tapAction to NAVIGATE with this URL."* **This is the on-click URL property the
  operator is asking for, and CamStack already sets it** from `clickUrl`
  (`packages/addon-notifiers/src/adapters/zentik.ts:487`).
- `tapAction` — a full `NotificationActionDto`, i.e. the whole-notification tap
  can be any action type, not just a URL. CamStack deliberately uses the
  `tapUrl` shortcut instead (`packages/addon-notifiers/src/adapters/zentik.ts:40`).
- `actions[]` of `NotificationActionDto` = `{ type, title, value, destructive,
  icon }`. `NotificationActionType` enum, read from the live schema:
  `NAVIGATE`, `BACKGROUND_CALL`, `MARK_AS_READ`, `SNOOZE`, `POSTPONE`,
  `OPEN_NOTIFICATION`, `WEBHOOK`, `DELETE`.
- Also present and **entirely unused by CamStack**: `subtitle`, `groupId`,
  `collapseId` (APNS collapse-id — the replace-in-place `tag` we already compute
  and drop), `snoozes: number[]` and `postpones: number[]` (Zentik's own
  client-side snooze menus), `addMarkAsReadAction` / `addDeleteAction`
  (default `true`), `remindEveryMinutes` / `maxReminders`, `scheduledSendAt`.
- Note the field names are `title` for the label and `value` for the payload —
  **not** `label`/`url`. The adapter already handles this.

**Assumed, not verified:** how Zentik's iOS client behaves when a `NAVIGATE`
value is a *custom scheme* rather than `https`. The API accepts any string
(`value` is an unvalidated `@IsString()`), and the failure mode of a scheme the
OS cannot open is a tap that does nothing, silently. §7 D2 turns this into an
experiment the operator can run.

### 2.3 The other seven — capability summary

| kind | tap URL | buttons | verified from |
| --- | --- | --- | --- |
| homeassistant | `data.url` + `data.clickAction`, both set | 3, with `uri` or a bus-event id | the adapter + HA Companion conventions encoded at `packages/addon-provider-homeassistant/src/ha-notification-output.ts:236` |
| telegram | rendered as a link in the message text | 3 inline URL buttons | `packages/addon-notifiers/src/adapters/telegram.ts:154` |
| pushover | `url` + `url_title` | none | `packages/addon-notifiers/src/adapters/pushover.ts:222` |
| gotify | `client::notification.click.url` extra | none | `packages/addon-notifiers/src/adapters/gotify.ts:217` |
| discord | embed `url` | none (a webhook cannot post components) | `packages/addon-notifiers/src/adapters/discord.ts:18` |
| whatsapp | appended text line | none | `packages/addon-notifiers/src/adapters/whatsapp.ts:131` |
| webhook | passthrough | 99, verbatim | `packages/addon-notifiers/src/adapters/webhook.ts:165` |

For pushover, gotify, discord, telegram and whatsapp the tap is **read on a
desktop as often as on a phone**. That is not a detail — it decides §4.3.

---

## 3. The deep link that has to exist on the other end

### 3.1 What the viewer registers

| | value | reference |
| --- | --- | --- |
| custom scheme (prod) | `camstack` | `camstack/app.config.ts:7` |
| custom scheme (dev client) | `camstack.dev` | `camstack/app.config.ts:7` |
| iOS associated domains | `applinks:camstack.zentik.app` — **one domain, not the hub** | `camstack/app.config.ts:36` |
| Android App Links | `https://camstack.zentik.app/*`, `autoVerify: true` | `camstack/app.config.ts:69` |
| `assetlinks.json` | **does not exist in either repo** | (absence) |
| AASA | ships inside the web export | `camstack/public/.well-known/apple-app-site-association:7` |

There is no `ios/` or `android/` directory (CNG/prebuild only), no
`expo-router` `linking:` config and no `+native-intent` hook: deep linking is
entirely expo-router's default scheme-prefix + file-tree matching.

**The consequence, stated plainly:** a self-hosted hub can never be a
Universal/App Link origin with the current native config. An `https://myhub…`
link opens a browser, not the app.

### 3.2 The routes a link could target

Group segments `(app)` and `(tabs)` are not in the URL.

| URL path | surface | params |
| --- | --- | --- |
| `/cameras` | camera list | — |
| `/camera/[id]` | **single-camera live / recorded** | `[id]` = numeric deviceId; `?at=<epochMs>` seeks a recorded moment |
| `/events` | the **Library** shell | `?section=events\|artifacts\|exports`, `?trackId=`, `?deviceId=`, `?ts=` |
| `/grid/[id]`, `/grid/adhoc?devices=1,2,3` | grids | grid id / csv device list |
| `/notifications` | the Notification Center | — |
| `/artifacts`, `/exports` | stacked aliases of the Library sections | — |

Files: `camstack/app/(app)/camera/[id].tsx:12`,
`camstack/app/(app)/(tabs)/events.tsx:6`,
`camstack/app/(app)/grid/adhoc.tsx:12`.

### 3.3 What works today

1. **`camstack://events?trackId=…&deviceId=…`** — the shared-track link. Built
   at `camstack/src/data/track-share.ts:35` and turned into a URL at
   `camstack/src/components/events/track/TrackDetailView.tsx:426`; consumed at
   `camstack/src/screens/EventsScreen.tsx:135`, which resolves the track **by
   id** so it works for a track that is not in the loaded page, then clears the
   params at `:147`. The Library shell forces the Events section when a
   `trackId` is present (`camstack/src/screens/library-sections.ts:67`).
2. **The web route already resolves from a cold browser load.** The hub serves
   the SPA shell for any extensionless path under `/viewer`
   (`server/backend/src/main.ts:1327`), and the effective base is
   `/viewer/camstack` (`camstack/app.config.ts:121`, redirect at
   `server/backend/src/main.ts:1300`). An operator already holding a hub session
   is bootstrapped without a login screen
   (`camstack/src/auth/HubSessionBootstrap.tsx:54`). **So
   `https://<hub>/viewer/camstack/camera/101` works today, with zero app
   changes.**
3. `camstack://auth-callback?code=…` is the login handoff
   (`camstack/src/auth/handoff.ts:18`), allowlisted hub-side at
   `packages/addon-admin-ui/src/lib/login-redirect.ts:36`. Note it is **not a
   route** — there is no `app/auth-callback.tsx`; it is consumed only as the
   return value of `WebBrowser.openAuthSessionAsync`
   (`camstack/src/screens/LoginScreen.tsx:124`).

### 3.4 What does not, and must be added

1. **The intended URL is discarded on a cold, unauthenticated start.** The
   `(app)` guard does a bare `Redirect href="/"` (`camstack/app/(app)/_layout.tsx:90`)
   and the index then redirects to `/cameras` (`camstack/app/index.tsx:44`).
   Nothing captures the URL that was being opened. A notification tap on a phone
   whose app is cold or logged out therefore lands on the camera list, and the
   operator concludes the link is broken. **This is the single most important
   viewer-side gap** and it is a prerequisite, not an enhancement.
2. **No `camstack://camera/<id>` producer and no test that it round-trips.**
   expo-router *should* match `/camera/101` from the scheme, but nothing builds
   such a URL, nothing asserts it, and the `(app)` guard sits between the URL
   and the screen.
3. **No hub identity on the link.** `trackShareTarget` emits only
   `trackId`/`deviceId`/`ts` (`camstack/src/data/track-share.ts:38`). An app
   configured against hub B that opens a link minted by hub A will query the
   wrong hub and show nothing.
4. **No push client at all.** `expo-notifications` is not a dependency and there
   is no notification-response listener anywhere. The viewer is a *control
   surface* for the hub's notification rules, never a recipient. Zentik is the
   recipient. Any design that assumes "the app receives the push" is a much
   larger project than this one.
5. `assetlinks.json` is missing, so the Android `autoVerify: true` filter cannot
   verify — links to `camstack.zentik.app` show a disambiguation dialog at best.
6. Built-but-never-parsed leftovers worth deleting or wiring while nearby:
   `ts=` on the share link (`camstack/src/data/track-share.ts:41`) and `devices=`
   on the embed URL (`camstack/src/grid-embed/embed-url.ts:103`).

---

## 4. The design

### 4.1 The shape, in one sentence

**The rule author expresses an INTENT; the dispatcher resolves that intent into
a pair of candidate URLs at send time; the degrade engine picks the one the
backend can use; the adapter renders it in its own vocabulary; a backend that
can use neither drops it and says so.**

That is not a new mechanism. It is exactly how `actions`, `attachments` and
`level` already flow, and it puts each decision where the repo already puts
that class of decision.

```
rule (INTENT, authored)                      NcTapIntent — a discriminated union
  ↓ frozen on the outbox row at enqueue      (with the subject that is already frozen there)
dispatcher (RESOLUTION, at send time)        tap-intent.ts → { app?: string; web?: string }
  ↓ notification.clickUrl (+ optional button)
degrade engine (SELECTION, per target)       caps.clickUrlKinds → one URL, or dropped
  ↓ PreparedNotification.clickUrl
adapter (RENDERING, per backend)             tapUrl / click / data.url / <a href> / …
```

### 4.2 Where each piece belongs, and why not elsewhere

**The intent belongs on the RULE, not on the outbox and not on the notifier.**
It is operator intent ("when this fires, I want to end up at the camera"), and
operator intent lives in the rule store — the same place `media`, `template`,
`priority` and `snoozeOptions` live
(`packages/types/src/capabilities/notification-rules.cap.ts:1016`). Putting it on
the target would make it per-destination, which is precisely backwards: the
operator wants the same destination on every phone.

**The resolution belongs in the DISPATCHER, at send time — never at enqueue.**
The reachable base URL is chosen, never assumed
(`packages/addon-post-analysis/src/notification-center/artifact-plane.ts:263`,
ladder at `:74`), and a row can sit in the outbox across a tunnel coming up or
going down. Freezing a URL at enqueue would ship a link that was correct when
the event happened and dead when the notification arrived. The subject the URL
is built from is *already* frozen on the row (`deviceId`, `trackId`, `recordId`)
— freeze the intent, resolve the URL.

**One module builds a viewer URL. Only one.** A new
`packages/addon-post-analysis/src/notification-center/tap-intent.ts` <!-- drift-ok: planned module, does not exist yet -->
is the single owner, mirroring `deriveDetailCropRect` (D52) and
`packages/addon-post-analysis/src/notification-center/artifact-url.ts:1`. Two
places composing `/viewer/camstack/...` by hand is how one of them silently
keeps the old base path after a rename.

**The per-provider choice belongs in the DEGRADE ENGINE, not in each adapter.**
The engine is already the one place that knows what a backend can take, and it
is already the only place a loss becomes *visible* (`renderedAs.dropped`,
`packages/types/src/notification/degrade-engine.ts:181`). An adapter deciding
for itself whether a `camstack://` URL is useful would be nine copies of one
judgement, and the eight that got it wrong would fail silently.

### 4.3 The one new capability flag

`TargetKindCapsSchema` (`packages/types/src/capabilities/notification-output.cap.ts:217`)
gains:

```ts
/**
 * Which KINDS of tap URL this backend can hand to whoever reads the
 * notification. Absent ⇒ ['web'] — the safe direction: an https URL always
 * renders as something, a custom scheme on a desktop chat client is an
 * unclickable string.
 */
clickUrlKinds: z.array(z.enum(['web', 'app'])).optional(),
```

Declared per kind, from what §1.3 and §2 established:

| kind | `clickUrlKinds` | why |
| --- | --- | --- |
| zentik, ntfy, homeassistant, pushover | `['app', 'web']` | a phone push; the OS opens the URL, and ntfy documents custom schemes explicitly |
| telegram, discord, whatsapp, gotify | `['web']` | the link is read in a chat client, often on a desktop; `camstack://` is dead text there |
| webhook | `['app', 'web']` | the consumer decides; the webhook payload already carries everything verbatim |

The engine picks the first declared kind for which the resolver produced a URL,
and pushes `'clickUrl'` into `dropped` when it produced neither. `.optional()`
and never `.default()`, for the reason already written down twice in this cap
(`packages/types/src/capabilities/notification-output.cap.ts:230`): a Zod default
does not run on the addon cap path.

Note what this flag deliberately is **not**: a "supports deep links" boolean. It
is a *preference list*, so a backend that would rather have the app but can take
the web URL degrades instead of dropping — which is the same trade `mode` makes
at `packages/types/src/capabilities/notification-output.cap.ts:152`.

### 4.4 The intent vocabulary

On the rule (`NcRuleSchema`), one optional field:

```ts
/** Where a tap on this rule's notification should land. Absent = the delivery
 *  kind's natural target (§7 D1). */
tap: NcTapIntentSchema.optional(),
```

`NcTapIntentSchema` is a discriminated union on `kind`:

| `kind` | resolves to (app) | resolves to (web) | when it cannot resolve |
| --- | --- | --- | --- |
| `'camera'` | `camstack://camera/<deviceId>` | `https://<base>/viewer/camstack/camera/<deviceId>` | `deviceId === 0` (a system event) ⇒ nothing |
| `'camera-at'` | `camstack://camera/<deviceId>?at=<subject.timestamp>` | same path `+ ?at=` | no timestamp ⇒ degrade to `'camera'` |
| `'event'` | `camstack://events?trackId=<t>&deviceId=<d>` | `…/viewer/camstack/events?trackId=…&deviceId=…` | no `trackId` on the subject ⇒ degrade to `'camera'` |
| `'library'` | `camstack://events` | `…/viewer/camstack/events` | never fails |
| `'url'` | — | the authored URL, verbatim | never fails |
| `'none'` | — | — | explicitly no tap target |

Three properties of that table are load-bearing:

- **It degrades toward something rather than nothing**, and every degradation is
  a *narrowing of specificity*, never a jump to an unrelated screen. A rule that
  asks for the event and fires on a subject with no track gets the camera, not
  the Library.
- **`'none'` is a real member.** D62: a control that cannot do anything must not
  be shown — and the inverse, a notification that must not be tappable (a
  system-event rule about a package update has nowhere useful to go) says so
  rather than pointing at a screen that will confuse.
- **Only `'url'` accepts free text**, and it is admin-only. A per-user rule that
  could author an arbitrary tap URL on a household topic is a phishing surface.

### 4.5 Buttons, and why they are second

A tap on the notification body is free — it costs no button slot and every one
of the nine kinds renders it. A *button* costs one of 4 (zentik) or 3
(ntfy, HA, telegram) slots that snooze and alarm buttons already compete for
(`packages/addon-post-analysis/src/notification-center/index.ts:1243`).

So: **the intent renders as `clickUrl` always, and as a BUTTON only when the
rule asks for a second destination.** `NcRule.tapButtons?: NcTapIntent[]`
<!-- drift-ok: planned rule field, does not exist yet --> mints one
`NotificationAction` per entry, `mode: 'navigate'`, `icon: 'camera' | 'view' |
'play'` from the closed enum. They are appended **after** the snooze and alarm
buttons in the mint order at
`packages/addon-post-analysis/src/notification-center/index.ts:1243`, so a
backend with three slots drops the *tap* button rather than the snooze — a
silence control outranks a convenience.

A kind with `caps.actions: 0` already loses them at the engine, recorded in
`renderedAs.dropped`. No adapter changes at all.

### 4.6 What each notifier does with it, end to end

| kind | body tap | button |
| --- | --- | --- |
| zentik | `tapUrl` ⇒ `tapAction: NAVIGATE` — already wired | `{type:'NAVIGATE', title, value, icon:'sfsymbols:video.fill'}` — already wired |
| ntfy | `click` / `x-click` — already wired | `{action:'view', label, url}` — already wired |
| homeassistant | `data.url` + `data.clickAction` — already wired | `{action, title, uri, icon:'mdi:…'}` — already wired |
| telegram | link line in the message text — already wired | inline keyboard `{text,url}` — already wired |
| pushover | `url` + `url_title` — already wired | n/a (`caps.actions: 0`) |
| gotify | `extras` click url — already wired | n/a |
| discord | embed `url` — already wired | n/a |
| whatsapp | appended line — already wired | n/a |
| webhook | `clickUrl` — already wired | verbatim — already wired |

**Every cell says "already wired".** The adapter layer needs no change
whatsoever; it needs `clickUrl` to be non-null. That is the strongest argument
for this shape: the per-provider translation the operator is asking for already
exists and is already tested — what is missing is one intent field, one
resolver, one capability flag, and the viewer side of §3.4.

### 4.7 A notifier that supports nothing

Two distinct cases, and they must not be conflated:

- **`caps.clickUrl: false`** — no kind declares this today, but the path exists
  (`packages/types/src/notification/degrade-engine.ts:192`). The URL is dropped
  and `'clickUrl'` lands in `renderedAs.dropped`.
- **`clickUrlKinds` excludes the only kind we resolved** — e.g. a `'camera'`
  intent on a Discord target where the hub has no public https base. Dropped,
  and recorded as `'clickUrl:app'` / `'clickUrl:web'` so the *reason* survives.

In both cases the notification still ships. A tap target is an enrichment; a
missing one must never cost the delivery. And the loss must be **reported** —
see §5.

---

## 5. Making the loss visible (a prerequisite, not a nicety)

`renderedAs` is computed on every send and read by nobody (§1.4.3). Ship this
first, because without it every failure in §4.7 is indistinguishable from a
feature that does not work:

1. The dispatcher logs `renderedAs.dropped` on the `notification delivered`
   line when it is non-empty, with `tags: { deviceId }` — the line is at
   `packages/addon-post-analysis/src/notification-center/dispatcher.ts:600` and
   already carries `target`, `kind` and `eventId`.
2. The rule editor never offers an intent a rule's targets cannot render. D62:
   the switch is derived from `listTargetKinds().caps`, not stored. A rule whose
   only target is Discord and whose hub has no public base shows the tap control
   **disabled with the reason**, never absent and never enabled-and-inert.

Two guards, in `scripts/`, wired into `.github/workflows/ci.yml`:

| guard | fails when |
| --- | --- |
| `scripts/check-tap-url-single-owner.ts` <!-- drift-ok: planned guard, does not exist yet --> | any file other than `tap-intent.ts` composes a `camstack://` or `/viewer/camstack` string (modelled on `scripts/check-clip-crop-single-owner.ts`) |
| `scripts/check-click-url-kinds-declared.ts` <!-- drift-ok: planned guard, does not exist yet --> | a `TargetKind` declares `caps.clickUrl: true` without `clickUrlKinds` (modelled on `scripts/check-capability-metadata-drift.ts`) |

And on the viewer side, the test that matters is a **route round-trip**: assert
that `camstack://camera/101` and `camstack://events?trackId=…` reach the screens
in §3.2, and that a cold, unauthenticated start replays the intended URL after
login. Without that last assertion §3.4.1 will regress the first time the auth
flow is touched.

---

## 6. Order of work

| # | Step | Blocked by |
| --- | --- | --- |
| 1 | Log `renderedAs.dropped` on the delivered line (§5.1) | — |
| 2 | Viewer: capture the pending deep-link intent across the auth gate and replay it (§3.4.1) | — |
| 3 | Viewer: `camstack://camera/<id>[?at=]` round-trip test (§5) | 2 |
| 4 | `tap-intent.ts` + `NcTapIntentSchema` + `NcRule.tap`, `npm run codegen` | operator D1, D3 |
| 5 | `caps.clickUrlKinds` on nine descriptors + the engine's selection | 4 |
| 6 | Dispatcher: resolve at send time, set `clickUrl` | 4, 5 |
| 7 | Rule editor (admin UI **and** viewer mirror — `scripts/check-viewer-condition-mirror.ts` guards the pair) | 4 |
| 8 | `tapButtons` (§4.5) | 6 |

Steps 1–3 are useful on their own and unblock nothing else — start there.

---

## 7. What the operator must decide

**D1 — where does a tap land by default?** A rule that authors no `tap` needs a
default per delivery kind. The candidates:

| delivery | option A ("the event that fired") | option B ("the live camera") |
| --- | --- | --- |
| `immediate` / track-end | `'event'` — the track detail, with the picture that was attached | `'camera'` — live, "what is happening NOW" |
| `device-event` (doorbell) | `'event'` (the marker track) | `'camera'` |
| `package-event` | `'event'` | `'camera'` |
| `system-event` | `'none'` | `'none'` |

The two are genuinely different products. A tap that opens the **event** answers
"what was that?"; a tap that opens the **camera** answers "what is going on?".
The operator's own words were *"by default open the camera in the native app"* —
so the draft above assumes **B for everything except system events**, but the
notification already carries the picture of the event, which is the argument for
A. **This needs his answer before step 4.**

**D2 — does a `camstack://` URL survive Zentik's `NAVIGATE`?** The API accepts
any string and the failure is a silent no-op (§2.2). Settle it with one live
send before building on it — this is a mutation, so the operator runs it:

```bash
node scripts/hub/hub.mjs POST notificationOutput.testTarget \
  '{"addonId":"notifiers","targetId":"zentik-1784924941052","sample":{"body":"tap test — should open the CamStack app on camera 101","title":"CamStack tap test","clickUrl":"camstack://camera/101"}}'
```

Then tap it. If the app opens: `clickUrlKinds: ['app','web']` for zentik stands.
If nothing happens: zentik becomes `['web']` and D3 becomes urgent.

**D3 — what happens when there is no public https base?** The hub's endpoint
ladder refuses loopback and prefers a tunnel, then LAN
(`packages/addon-post-analysis/src/notification-center/artifact-url.ts:42`). A
LAN-only base produces a link that works at home and is dead on mobile data.
Three answers, and they are the operator's:

1. ship the LAN URL anyway (works at home, dead outside);
2. ship no web URL at all when only LAN is available (so the app URL is the only
   tap target, and desktop notifiers get nothing);
3. ship the LAN URL only to backends the operator marks as "home only".

The repo's precedent is (1) — the artifact plane already ships LAN URLs. Making
tap targets stricter than attachments would be a second policy for the same
question.

**D4 — desktop and web.** Discord, Telegram and WhatsApp are read on laptops.
Should their tap open `https://<hub>/viewer/camstack/...` (which works today, and
which leaks the hub's hostname into a third-party chat) or nothing? The design
above assumes yes; the counter-argument is that a Discord webhook is often the
*least* private target on the list.

**D5 — a second button, or just the body tap?** §4.5 keeps buttons optional
because they cost a slot that snooze already wants. If the operator wants "Open
camera" as a visible button on every notification, snooze buttons lose a slot on
ntfy/HA/telegram (3 slots) and zentik keeps both (4). His call, per rule or
globally.

**Out of scope until asked:** making the viewer itself a push recipient
(§3.4.4), per-hub associated domains (§3.1), and consuming HA's
`mobile_app_notification_action` bus event (§1.4.5). Each is a separate project.
