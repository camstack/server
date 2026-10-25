---
id: D324
title: "An action button that mutates the fleet freezes WHAT and WHERE, never a version — and asks the authority what is still true before it acts"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/addon-update-buttons.ts
  - packages/addon-post-analysis/src/notification-center/addon-update-apply.ts
  - packages/addon-post-analysis/src/notification-center/action-token.ts
  - packages/addon-post-analysis/src/notification-center/action-plane.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
---

## Context

The operator asked (2026-08-31) for a **button** on the `addon-update-available`
notification that applies the updates it lists. [D305](adr-0305-a-notification-action-names-the-page-that-can-act-and-the-target-parses-what-it-is-given.md)
gave that notification a tap TARGET — `/system/addons?node=<nodeId>` — which is
the page where the work is done by hand. This is the other half: the same work,
without the page.

The mechanism already existed and needed nothing new. Buttons are minted per
delivery, each with a single-use HMAC-signed callback on the addon's public
`nc-action` route (`action-token.ts`, [D47](adr-0047.md)); the plane spends the
token before it runs anything; three grant families already ride it. What did
not exist was the DATA. `NcDispatcher.mintActions` handed the builder
`systemEventKind` and nothing else — enough for the alarm buttons, which are a
function of the transition alone, and useless for an update button, which is a
function of *which packages* and *on which node*.

Three things reading settled that the request did not:

- **The packages were already on the row and the type did not say so.** The
  intake freezes `packageNames` and `nodeIds` onto `NcSystemEventSubject`, and
  the enqueue spreads the whole `systemEvent` object onto the outbox payload —
  so live rows have carried both for as long as batching has existed. Only the
  payload TYPE stopped at `packageName`/`nodeId`. Exactly the `deviceType`
  situation D305 fixed: widen the declaration to read it back, migrate nothing.
- **The prompt's shape for the row was wrong, and the right field was better.**
  `data.packages` rows are `{packageName, currentVersion, latestVersion,
  nodeId}` — not `fromVersion`/`toVersion`. Reading the typed `packageNames`
  instead of walking the `unknown` bag avoids the mistake structurally, needs no
  cast, and has the property the section below is about: it cannot see a
  version even by accident.
- **An icon would have deleted the notification.** `NotificationActionIcon` is a
  closed vocabulary carried in the published `@camstack/server` closure, and the
  cap seam validates against the HUB's copy. There is no member meaning
  "update", and an addon emitting a token the running hub does not know does not
  lose the icon — its whole `send` fails Zod. The button ships with no icon.

## Decision

**An action button that mutates the fleet freezes only WHAT and WHERE. It
states no version, it names exactly one node, and before it changes anything it
asks the authority that owns the answer what is still true.**

1. **No version, in either direction.** `NcAddonUpdateGrant` carries package
   names and one `nodeId`. It does not carry `latestVersion`, and the
   `applyAddonUpdate` seam passes none and returns none. This is
   [D313](adr-0313-a-version-is-read-back-never-restated-and-unknown-is-an-absent-field.md)
   made structural rather than remembered. Pinning the row's `latestVersion`
   would install what the registry offered when the 6-hourly check ran, which by
   the tap may be neither latest nor available; and reading the version BACK out
   of `addons.updatePackage` is worse than useless, because its hub branch
   answers `input.version ?? 'latest'` — the literal string D313 exists to keep
   off an operator's phone. The dist-tag is resolved once, by
   `LifecycleJobEngine.fetchAddonTask`, and what actually landed reaches the
   operator as the `addon-updated` notification, which reads it back.
2. **The cheap question first.** `addons.listUpdates(nodeId)` is called BEFORE
   the first apply and its answer is the work set: the button applies
   `frozen ∩ still-out-of-date`, in the row's order. A frozen package that is
   already current is *skipped* and reported as skipped — never re-installed and
   then counted as work. A read that THROWS changes nothing and says so; it is
   never read as "everything is current" and never as "apply the frozen list
   anyway". One spent token is recoverable from the Addons page; a node's worth
   of unnecessary addon restarts is not.
3. **One node, named in the label.** The label is
   `Aggiorna 3 addon su agent-a` — count and node, both from the frozen
   row. A row whose packages span several nodes carries `nodeId: undefined` (the
   intake only sets one when there is a single answer) and mints **no button**,
   logged. The hub's emitter announces one scope per event
   (`UpdateAvailabilityEmitter.emitList`, 2026-08-19), so this refusal should
   never be met in practice — which is why it is a refusal and not a fallback to
   "all of them".
4. **`server-update-available` gets none.** That kind is a node reboot; D305
   already sends it to the Cluster page, where the decision belongs.
5. **The operator hears twice.** A `BACKGROUND_CALL` returns while the updates
   run for minutes, so the tap is acknowledged before the first apply
   ("Aggiornamento di 3 addon su agent-a…") and the verdict follows it
   ("3 addon aggiornati" / "agent-a: 1 aggiornati, 2 già aggiornati, 1
   falliti" plus the failing names). Both go to `grant.targetId` — the delivery
   this button was minted for, which is the only addressee a tap can honestly
   name, on the same reasoning that freezes `userId` on a snooze grant. They ride
   `deliverAnnouncement`, not the outbox: an outcome retried four minutes later
   is a stale claim, and a `reason` in the log is the better record.
6. **Fifteen minutes, not sixty.** `actionTtlMs` prices this family at the
   sequence window. A snooze gets an hour because at worst it silences the one
   person the notification was addressed to; this one restarts every addon it
   names on a whole node, over a link that travelled through a push relay. Past
   the window the plane says "expired — open CamStack", which is precisely the
   D305 tap target the same notification already carries: the button degrades
   into the page.
7. **Authorisation is the signature, and the button is narrowed to OWNED
   targets.** The route is `access: 'public'` + HMAC by design (D47): whoever
   holds the notification can run it, once, inside the window. The mute buttons
   already refuse a destination nobody owns, and this one follows them — for a
   stronger reason than theirs. A snooze refuses an unowned target for
   CORRECTNESS (the window would belong to nobody). This one refuses for blast
   radius: a sequence button is opt-in per rule ("do not author one for a
   sequence you would not want a forwarded screenshot to run"), whereas this
   button appears on EVERY `addon-update-available` notification of every rule,
   so the operator never made that choice per button. Making it for them means a
   shared family channel gets the D305 tap URL — a page that asks who is holding
   the phone — instead of a link that restarts a node for whoever scrolled past
   it. What bounds the owned case is the TTL, the single use, per-delivery
   minting, and that the worst outcome is *the packages the notification already
   named being updated on the node it already named* — the same thing that
   recipient would have done on the page the notification links to.
   `destructive: true` is set so it does not look like the "Silenzia 10 min"
   beside it; it is a rendering hint and never a gate.

## Consequences

- `NcMintButtonsInput.systemEventKind` became `systemEvent` — the frozen row
  object, handed over whole. A future button family needing another frozen field
  adds no parameter. The D305 property is unchanged: everything a button acts on
  is on the row, so a row that drains days late still names the right subject.
- `NcOutboxPayload.subject.systemEvent` gained `packageNames` and `nodeIds`.
  Declaration only — the enqueue already spread them and live rows already carry
  them. Nothing migrates.
- `NcActionGrant` has a fourth member, so `describeGrant`, `grantMeta`,
  `actionTtlMs` and `runGrantedAction` each had to be made to handle it before
  this compiled. That is the union doing its job.
- The button costs one `addons.listUpdates` per tap, which reaches npm. On an
  agent node that is a roster fetch plus a diff. Accepted: it is the difference
  between reporting work and reporting truth.
- **What this forbids**: a button that restates a version it observed; a button
  that applies a frozen list without asking whether it is still the work; a
  fleet-mutating button whose label cannot say how many things and where; and a
  mutating action that returns while the operator learns nothing.
- **Still open**: `addons.updatePackage`'s hub branch returns `version:
  input.version ?? 'latest'` to every caller. Nothing on this path reads it, but
  it is a restated version sitting on a cap output, and the next consumer to
  trust it will reproduce the D313 sentence. Recorded in
  (planning repo: sessions/sessions.md); not fixed here. <!-- drift-ok: moved to the private planning repo -->
- **Also still open**: the centre does not wire its own button minter — the
  addon does (`buildActions: (input) => this.notificationCenter?.mintButtons(input)`).
  An addon wiring that forgets it loses every button on every notification with
  nothing to say so.

## Enforcement

`packages/addon-post-analysis/src/notification-center/__tests__/addon-update-action.spec.ts`
— thirteen cases, every one of them asserted on what LEAVES the process: the
`notification-output.send` payload the dispatcher hands over, and the
`addons.updatePackage` seam the runner reaches through. Each case walks the real
chain (raw `update.available` bus event → intake → durable outbox row → a real
drain → the minted URL → the real `NcActionPlane` handler), and the harness
late-binds `buildActions` exactly as the addon does, so a test cannot pass on a
minter the production wiring never reaches. Every implementing line was removed
in turn and confirmed to fail a named case:

| removed | fails |
| --- | --- |
| the dispatcher handing over the frozen `systemEvent` | 9 of 12 |
| the button joining the notification's `actions` | 9 of 12 |
| the several-nodes refusal | "a row that spans several nodes gets no button" |
| the owned-target refusal | "a destination nobody owns gets no button" |
| the kind refusal | "a NODE's own server update gets no button" |
| the `frozen ∩ updatable` intersection | "asks the registry what is STILL out of date" |
| the throw on a failed freshness read | "changes nothing when it cannot read what needs updating" |
| the start announcement | "tells the operator it started, and then what actually landed" |
| `destructive` / `mode: 'background'` | "names how many packages and which node" |
| `claim()`'s spent check | "spends the button once" |

The version rule is pinned negatively — the announcement text is asserted to
contain neither the row's versions nor the string `latest` — which is a guard,
not a disarmable line, and is stated here so the next reader knows the
difference.
