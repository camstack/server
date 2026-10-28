---
id: D429
title: One release, both products, and the legs run in parallel
status: accepted
date: 2026-09-10
applies-to:
  - .github/workflows/release.yml
last-verified: 2026-10-28
---

## Context

A `v*.*.*` tag builds five Electron legs — the full CamStack desktop app (mac
arm64, mac x64, linux x64, each staging the `@camstack/server` closure) and the
viewer shell (mac arm64, linux x64, no closure) — and attaches all of it,
~2.2 GB, to one GitHub Release.

That saturated the operator's uplink. Measured on v1.2.265: WAN latency to
three independent targets went from 12-18 ms to a **610-650 ms average with
2.9-second peaks**, all three degrading together — saturation, not a route
fault. The Docker leg, pulling the closure from npm in the same window, died on
`npm error network aborted`. The operator experienced it as his UniFi
disconnecting repeatedly.

The fix applied then was `max-parallel: 1`. It reduced no bytes; it only
stopped the peaks stacking, and it cost wall clock — a release went from about
one hour to nearly three.

**Splitting the viewer onto its own `viewer-v*` tag was implemented and then
reverted**, on the operator's call and for a good reason. It moves only the
viewer's ~232 MB, about **10%** of the traffic — the tempting "90%" figure
described the opposite move, attaching *only* the viewer — so it does not solve
the uplink. And it buys nothing else: the desktop viewer is a **shell** that
loads `https://<hub>/viewer/camstack/` at runtime, so a viewer app change never
needs a new shell build at all (`ship-viewer.mjs` owns that: OTA, the
orchestrator's web bundle, the submodule pin). A shell whose version merely has
to exist is happiest sharing the server's version and the server's rare
release, not carrying a second tag for someone to remember.

Two things were also wrong in what the file *said*. It credited `max-parallel:
1` for making `security default-keychain -d user` race-free; that safety
actually comes from the two mac legs running as **different users**
(ghrunner1 / ghrunner2), where `-d user` is per-user by definition. And the
architecture page described `build-electron` as three legs, which it had not
been since the viewer shell was added.

## Decision

**One release builds both products, at one version, and the legs run in
parallel.** `max-parallel: 1` is removed: the keychain race it was blamed for
does not exist, and a full release is rare enough that the operator prefers the
hour over the three.

The viewer shell keeps the server's version deliberately. It carries no
closure and no app — the app arrives by OTA and from the hub — so its version
number is an identifier, not a contract.

## Consequences

- A full release goes back to roughly one hour from nearly three.
- **The uplink is not fixed.** Three fat legs plus the viewer still push
  ~2.2 GB concurrently, which is the configuration that broke the operator's
  connection in the first place. This is a knowing trade, not an oversight.
- If the disconnections return, the answer is NOT to restore `max-parallel: 1`
  and NOT to re-split the tags. It is to **stop attaching the full installers
  to a release**: ~2.0 GB of the 2.2 is the desktop product, which reaches the
  nodes through Docker and npm and is never downloaded from a release by hand.
  That remains the only change that moves the number, and it is open.

**Amended 2026-09-21 — one release also meant one FEED.**
[D584](adr-0584-each-desktop-product-owns-its-update-channel-and-a-mac-product-ships-the-zip-its-updater-applies.md)
found the cost this record did not price: both products publishing to one
release on the default channel meant one `latest-mac.yml` answering for both,
and the last leg to finish won. On v1.2.338 that was the viewer's, so the FAT
app's macOS updater was pointed at the Viewer. Keeping one tag stays right —
splitting it was tried and reverted for the reasons above — but it requires a
distinct `publish.channel` per product, which is now guarded
(`check-desktop-update-feeds.ts`). The parallel legs make this worse rather
than causing it: two legs writing one filename is a race, and `max-parallel`
only changes which one wins.

**Amended 2026-10-28 — legs on one macOS user must not share keychain state.**
The claim above that the keychain race "does not exist" assumed one macOS user
per runner. Both self-hosted Mac runners run as the SAME user on the Mac mini,
and every mac leg replaced the user-wide search list (`security list-keychains
-d user -s`) and the default keychain, so parallel legs dropped each other's
signing keychain (run 40728859444: `no identity found`,
`errSecInternalComponent`). The invariant is now: **a leg creates its own
keychain, uniquely named by run, attempt, target and arch, under
`$RUNNER_TEMP`, and hands it to the tools by path — `CSC_KEYCHAIN` for
electron-builder (it feeds `security find-identity` and `codesign --keychain`),
`--keychain` for `notarytool`. It never rewrites the search list and never sets
the default keychain; cleanup deletes only its own keychain.** There is no
per-user runner requirement.

