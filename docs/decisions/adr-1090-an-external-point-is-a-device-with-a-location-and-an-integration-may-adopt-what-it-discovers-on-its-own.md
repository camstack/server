---
id: D1090
title: An external point is a device with a location; an integration may adopt what it discovers on its own
status: accepted
date: 2026-11-25
supersedes:
applies-to:
  - packages/types/src/capabilities/device-adoption.cap.ts
  - packages/types/src/capabilities/device-manager.cap.ts
  - packages/types/src/capabilities/location.cap.ts
  - packages/system/src/builtins/device-manager/**
---

## Context

The operator asked for the items an external source lists around the site, with
nearby fuel stations and their prices as the first case (planning#596). Two
shapes were on the table: a new capability holding a typed list of entries on
one device, or one device per item.

A list cap would be a second device model inside a slice: an entry would have
no id the history, the automation picker, the notification rules, the exports
or the grants could name, and each of those would need a parallel "entry of a
list" form. Everything an entry needs already exists for a device: the
`location` cap is a generic WGS84 fix with history, `numeric-sensor` carries a
value in a declared quantity, `binary` carries an on/off state, and
`device-adoption` lists an integration's candidates and turns the picked ones
into devices.

What does not exist is adoption without a person. Every adoption today is a
pick in the shared modal. A source of points changes on its own (a station
opens, closes, leaves the search radius), and asking the operator to adopt each
one would make the integration useless.

The operator decided the shape on 2026-11-22 and the requirements on
2026-11-25 (below).

## Decision

**An external point is a device.** It is declared with its own `DeviceType`
(`place`) and carries the `location` cap with the point's fixed coordinates.
Its values are accessory children on existing caps: a fuel station has one
`numeric-sensor` child per fuel, in a price-per-volume quantity, and one
`binary` child "open". Brand and address are device metadata; the distance from
the site is computed from the site location (`system.getSiteLocation`) and the
point's fix, never stored as a second source of truth. Price history is the
existing long-term statistics of the `numeric-sensor` children; nothing new
stores history. No capability holds a list of entries.

**Points come from a device-provider addon, `addon-fuel-prices`.** It is named
after what it lists; another kind of external point is another addon. One
integration instance is one source with its search settings. The search is
centred on the site location; an instance stores only the radius (km) and the
fuels to list. Each source is a provider behind the integration: it implements
`device-adoption` (`listCandidates`, `adopt`, `release`, `resync`) with the
source's own station id as the candidate id, and refreshes the adopted points'
slices on the core state-refresh schedule (D1062).

Two sources, two providers, in this order:

1. **Tankerkönig** (Germany): an API key, a `password` field kept in the
   keychain (D783), never an environment variable; prices every few minutes.
2. **MIMIT Osservaprezzi** (Italy): the open daily dataset, no key.

**Auto-adopt is a mode of the adoption layer, not of a provider.** An
integration instance has `adoptMode: 'manual' | 'auto'` (default `manual`),
stored and applied by the device manager, which already fronts every adoption
call (`deviceManager.adoption*`). A provider may declare `auto` as the instance
default; it cannot adopt on its own. In `auto`, after each discovery refresh the
device manager:

- adopts the candidates that are not adopted, through the same adoption job an
  operator's pick starts. There is no per-instance maximum;
- never re-adopts a candidate the operator released or removed: the tombstone
  of the device (D865) is the record, and it is cleared only by an explicit
  adopt;
- marks a device whose candidate is missing (below), and never releases or
  removes a device on its own.

**A device the source no longer offers has a typed adoption state**:
`offered | withdrawn`, with `withdrawnSince`. `withdrawn` means the source
answered and no longer lists the device; that is distinct from offline, where
the source or the device does not answer.

- A device becomes `withdrawn` after 3 consecutive confirmed discoveries
  without its candidate (D49: a failed or empty discovery changes nothing).
- A `withdrawn` device, auto-adopted or person-adopted, is kept with its history
  until the operator removes it. The UI shows a badge and an attention filter.
- A candidate that comes back returns the device to `offered`.

**The base card for a device with a `location` is a map.** It draws the point on
OpenStreetMap tiles, needs no key, and is the shared card any `location`
device gets, not a fuel-specific widget.

## Consequences

- A point is addressable everywhere a device is: history of its price,
  automation triggers and conditions, notification rules, the exports, grants.
- A map or list of points is a view over devices of type `place` with a
  `location`, not a new data shape. The same view serves planning#613 (personal
  devices with a historized location).
- The device count grows with the search radius and is not capped; the radius
  is the operator's bound.
- Every adoption records who adopted (`operator` or `auto`).
- `adoptMode` and the adoption state are generic: an existing integration can
  opt in later without a change in its provider.
- The units registry has no price-per-volume quantity today. It is added first,
  in its own change (a currency per volume, base EUR/L).
- The OSM tiles are fetched by the viewer and the admin UI from the public tile
  server; its usage policy (attribution, no bulk prefetch) applies.
- What the operator does with the points (threshold notifications, a list or
  map view, a viewer card, automations) is decided once real data is in.

Rejected: a list capability (above); a provider that creates devices directly at
discovery, which would bypass the tombstone, the adoption job log and the
operator's release; and an automatic release of a withdrawn auto-adopted device,
which would delete its price history.

## Enforcement

Specs on the device manager: an `auto` instance adopts a new candidate through
the job engine; a released candidate is not adopted again; one empty or failed
discovery changes nothing; 3 confirmed absences mark the device `withdrawn` and
remove nothing; a returning candidate makes it `offered` again. A guard that the
new addon registers no device outside `device-adoption.adopt`. Otherwise review
only.
