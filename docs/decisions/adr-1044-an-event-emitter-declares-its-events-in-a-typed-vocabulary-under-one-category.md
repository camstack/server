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
  - packages/addon-provider-homematic/src/devices/hm-key-vocabulary.ts
  - packages/addon-provider-homematic/src/devices/hm-event-emitter-device.ts
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

- **A vocabulary is read from the live device, not from the child's
  config.** A child's config is written once, at adoption, so a remote
  adopted before this record would never get its buttons. Homematic reads
  its key channels from the CCU's channel list each time it starts
  (`hm-key-vocabulary.ts`): one source per key channel, the source id is
  the channel index a press carries, and the label is the button's
  position with the channel beside it ("Button 1 (channel 3)"). While the
  CCU has not answered, the persisted tokens stand in, without buttons.
- **A source that announces tokens only is read by convention**
  (`conventionalEventVocabulary`: ESPHome, a Home Assistant event entity,
  an MQTT discovery event). The label is the token made readable; the kind
  is set only when the WHOLE token is one many integrations use for a
  button (`long_press`, `double_click`, `release`…). An unknown token gets
  no kind rather than a guessed one.
- **A press outside the declared vocabulary is delivered**, and Homematic
  says so in its log once per button and token, with the device tag.

## Consequences

- Every provider of the capability writes the new field: the status TYPE
  requires it. The schema still parses a status without it, as an empty
  vocabulary, because a hub is updated before its provider addons and
  must keep reading what they wrote.
- A consumer that shows or matches events (the device page, a rule, the
  notification picker) has one list to read, and one fallback.
- Only Homematic logs a fire outside its vocabulary. The other providers
  deliver it without a line.
- The CCU's own name for a channel is not shown: the library the addon
  uses does not expose it.
- The Home Connect events keep their native names as labels: they are not
  button presses and the convention table does not describe them.

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
- `packages/addon-provider-homematic/src/__tests__/hm-key-vocabulary.spec.ts`
  and `hm-event-emitter-vocabulary.spec.ts` (a remote adopted with tokens
  only still gets its buttons).
