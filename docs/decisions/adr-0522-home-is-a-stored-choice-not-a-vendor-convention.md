---
id: D522
title: Home is a stored choice, and a camera that has none refuses to go there
status: accepted
date: 2026-09-17
supersedes:
applies-to:
  - packages/types/src/capabilities/ptz.cap.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-hikvision/src/hikvision-camera.ts
  - packages/addon-provider-amcrest/src/amcrest-camera.ts
  - packages/addon-provider-onvif/src/onvif-camera.ts
  - packages/ui-library/src/composites/cap-settings/HomePresetPicker.tsx
---

## Context

`ptz.goHome` was three vendor "conventions", each written in a comment and none
of them true. Measured on this fleet on 2026-09-17:

    107  Camera camera Carol (reolink)   preset 0 -> "stanza"
    1438 Camera dispensa (hikvision)      preset 1 -> "Credenza"
    3836 Camera studio (amcrest)          preset 1 -> "Preset1"

Three cameras, three operator presets, no home anywhere. Worse, reolink
swallowed the failure in `catch {}` and amcrest in a background catch, so a head
that never moved was indistinguishable from a head that went home. This is the
hottest path an autotrack loop has — it runs on every subject release.

The first instinct was to pick a better convention. That is what produced the
three wrong ones. Enumerating the vendor libraries settled it:

- **Baichuan has no home command** in nodelink's exposed surface — presets,
  position, control, nothing else. (It turned out to have one under a name we
  did not know: see below.)
- The **Dahua CGI client** has none either, though the protocol may on some
  models; we do not implement it and did not probe.
- **Hikvision's home is a reserved PRESET** — id 34, "Back to origin", which the
  camera names itself inside the ordinary preset list.
- **ONVIF's home is the PTZ origin**, an absolute move to `(0,0,0)` with no
  preset involved at all.

Four vendors, four different shapes. No convention can be right about all of
them, and a convention that is wrong is worse than an absence, because it moves
the head somewhere plausible.

Then a capture of the official Reolink app (decrypted via the login handshake)
showed that Baichuan *does* have a home: the **guard point**, cmd 331 with
`setGrd` / `toGrd`, which nodelink declared as an ability leaf and never mapped.
That discovery did not change the decision — it added a fifth shape to the four.

## Decision

**Where `goHome` sends a camera is a stored per-camera choice, resolved through
`getHomePreset`, and a camera with no answer REFUSES rather than moving.**

The resolution has four sources, and `source` — not `presetId` — is what decides
whether the call can proceed:

    operator   the operator picked a preset here; always wins
    firmware   the camera named one itself (`fn: 'home'`, Hikvision's 34)
    native     the camera homes without a preset at all (ONVIF's origin,
               Reolink's guard point). `presetId` is null and that is NOT a
               failure
    none       nothing is configured and the camera names nothing. `goHome`
               throws, with the reason

Setting it needs two verbs, because one shape does not fit all four vendors.
`setHomePreset(presetId)` pins an existing preset. `captureHomeHere()` makes the
head's CURRENT position the home — the natural gesture (aim, then say "here"),
and the only one a camera whose home is not a preset can accept.

## Amendment, same day — the idle-return is ONE fact, not two

The first version of this cap exposed `getHomeReturnSeconds` /
`setHomeReturnSeconds` and nothing else. That was wrong twice over, and the
operator caught it by reading the capture I had read myself.

On the camera, `benable` and `timeout` live in the SAME element and are written
by the SAME command. Exposing only the delay meant:

- there was no way to switch the behaviour on or off at all, and
- a camera holding a 68 s delay with the behaviour OFF — exactly what the vendor
  app leaves when you disable the guard point without clearing it — was
  reported as though it would return after 68 s. The state was invisible.

So the two became one shape, `getHomeReturn` / `setHomeReturn` carrying
`{ enabled, seconds }`, written together. Reading them apart means two
round-trips that can disagree; writing one alone means reading the other back
first and racing whoever else is writing.

`null` still means the camera has NO idle-return behaviour, and that is a
different statement from `enabled: false`. A camera that cannot return home by
itself and one configured not to are not the same thing, and only the second
gets a switch in the UI.

The delay stays editable while the behaviour is off, because the camera keeps it
either way and clearing it on disable would lose a value the operator chose.

## Consequences

**A provider must be able to say "I don't know".** That is why `source` is a
four-value union rather than a nullable preset id: `presetId === null` is
ambiguous between "no home" and "a home that is not a preset".

**A refusal has to be visible.** `goHome` throwing turns a wrong movement into a
silent no-op unless every caller surfaces it — which the Viewer did not
(`.catch(() => {})`), and the admin overlay would not have. Both were changed:
the overlay disables Home and names the reason, the Viewer reports it as a
notice. A disabled feature must never look like a broken one (D62). And
`homePreset === null` means STILL LOADING, never "not configured" (D315).

**"Set home here" may have to claim a preset slot**, on the two vendors whose
home is a preset. It must never take an operator's slot and never a reserved
function id, and when the camera is full it REFUSES — losing "Credenza" to make
room for a home is a worse trade than not setting one.

**Protocol knowledge does not live here.** The guard point commands went into
`@apocaliss92/nodelink-js` 0.7.2 (`getPtzGuard` / `setPtzGuard` /
`goToPtzGuard`); this repo keeps only the product default (60 s, copied from the
camera's own app). A second copy of a wire format diverges at the first firmware
that changes it.

**An unreadable camera is not evidence of absence.** Every read on this path
returns `null` on failure rather than a default that claims no home exists — the
answer decides whether the head moves (D393).

## Enforcement

Tests, not a guard. The four-source union is enforced by the type: a provider
that returns an unlisted source does not compile. The refusal path, the free-slot
rule and the protocol shapes each have specs, and each was sabotaged to confirm
the specs catch it — the reserved-id refusal, the two-digit exponent, the
conditional `needSetPos`, and the slot chooser refusing a full camera.

What is NOT enforced: nothing checks that a new PTZ provider implements
`captureHomeHere` honestly rather than as a silent no-op. Review only, and worth
knowing.
