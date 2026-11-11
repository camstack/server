---
id: D1044
title: An event-emitter declares its events in a typed vocabulary, under one category
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/capabilities/event-vocabulary.ts
  - packages/types/src/capabilities/event-emitter.cap.ts
  - scripts/check-event-emitter-vocabulary.ts
---

## Context

A stateless device (a remote, a wall button, a doorbell chime) fires
events and holds no state. The `event-emitter` capability carried its
events as bare strings (`eventTypes`): no name for a person, no meaning
shared between vendors, and no way to say WHICH button of a six-button
remote was pressed. A rule could react to "any event of this device" and
nothing finer, and two identical presses in a row looked like one value
that did not change.

An integration cannot add its own event category: `EventCategory` is a
closed list and a hand-rolled topic is forbidden (D8).

## Decision

- **The status of an `event-emitter` carries `vocabulary`**, a list of
  `EventVocabularyEntry`: the native token (`id`, verbatim), a `label`, an
  optional `description`, an optional `source` (`{ id, label }`: the
  button or channel), an optional `kind`, and an optional `payload` (the
  scalar fields of the event's `data`, by dotted path).
- **`kind` is the meaning shared by every integration**: `press`,
  `long-press`, `long-press-start`, `release`, `repeat`, `double-press`,
  `other`. "Any long press" is asked by kind, without a vendor's token.
- **An entry is identified by its token AND its source.** A remote
  declares one entry per button and token, so the same token appears once
  per button (`findVocabularyEntry`).
- **A fire names its source**: `EventFire.sourceId`, optional. A device
  with no sources leaves it out.
- **One category for every fire.** A fire stays
  `EventCategory.EventEmitted`; the typing lives in the device's
  vocabulary, read through the device's own provider (D13).
- **`eventTypes` stays**, as the list of native tokens, for readers older
  than the vocabulary. A reader goes through `readEventVocabulary`, which
  answers with the plain tokens when a status declares no vocabulary: a
  provider that has not been updated yet is still usable.
- **A source that announces nothing is listed, with its reason.** A raw
  bus event type has no declared set; its vocabulary is empty and its file
  is named in `OPEN_VOCABULARY`.

This record covers the contract. Each integration's own labels, sources
and kinds are filled in after it: until then a provider declares the plain
tokens (`plainEventVocabulary`), labelled with the token itself.

## Consequences

- Every provider of the capability writes the new field: the status TYPE
  requires it. The schema still parses a status without it, as an empty
  vocabulary, because a hub is updated before its provider addons and
  must keep reading what they wrote.
- A consumer that shows or matches events (the device page, a rule, the
  notification picker) has one list to read, and one fallback.
- A fire whose token is not in the vocabulary is still delivered. Saying
  so in the log, once per token, belongs to the providers and is not built
  by this record.

## Rejected alternatives

- **One `EventCategory` per integration or per event.** It grows a closed
  list with every vendor and contradicts D8.
- **Normalising the token** (`PRESS_LONG` to `long-press`). The token is
  what the vendor's own tools show; `kind` carries the shared meaning
  without losing it.
- **Making `vocabulary` optional in the status type.** Nothing would then
  tell a provider that forgot it from one that has nothing to declare.
- **Refusing a status without it at parse time.** The device page of
  every event device would read "unknown" between the hub update and the
  addon update.

## Enforcement

- `scripts/check-event-emitter-vocabulary.ts`: a runtime file that names
  the capability writes `vocabulary:`, and does not write it as the
  literal `[]` unless it is listed as open. Textual: a vocabulary computed
  from a list that is empty at run time is not seen.
- `packages/types/src/capabilities/__tests__/event-vocabulary.spec.ts`.
