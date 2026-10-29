---
id: D968
title: An exporter may expose actions and notification targets as list entries beside devices, through the same export table
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/types/src/capabilities/device-export.cap.ts
  - packages/types/src/automation/export-entities.ts
  - packages/addon-export-hap/src/**
  - packages/addon-export-alexa/src/**
  - packages/addon-provider-homeassistant/src/ha-export/**
  - packages/ui-library/src/composites/device-export-panel.tsx
  - packages/ui-library/src/composites/export-entity-rows.ts
---

## Context

The operator wanted a way to fire an Action from HomeKit, Alexa and Home
Assistant, and to send to a notification target from Home Assistant. An action
is not a device (D954): it is a list entry of the `actions` cap and never enters
the device registry. The device export surface (`device-export`) was keyed by
device id end to end, so there was nowhere to put one. A separate "Actions"
section per exporter was rejected: it duplicates the table, the filters and the
search, and the operator asked for a single export table.

## Decision

The `device-export` cap gains four OPTIONAL methods that speak an entity
reference, a discriminated union of `{kind:'device'}`, `{kind:'action'}` and
`{kind:'notifier'}`: `listSupportedEntityKinds`, `listExposedEntities`,
`exposeEntity` and `unexposeEntity` (both mutations admin-only). The device
methods are unchanged, and a provider without the new methods exports devices
only. Each exporter declares what it supports and persists its selection in its
own settings:

| Exporter | Action | Notification target |
| --- | --- | --- |
| HomeKit | a momentary switch: on runs the action, then it turns itself off | no |
| Alexa | a scene (`Alexa.SceneController`): Activate runs the action, admin links only | no |
| Home Assistant | a `button`: pressing it runs the action | a `notify` entity: a message is sent to the target |

Running goes through `ctx.api` (`actions.run`, `notification-output.send`) via
shared helpers in `@camstack/types`. A refusal (already running, cooldown, no
such action) is logged with a named reason and never queued. A deleted action
or target is dropped from the export and the drop is logged; a list that could
not be read changes nothing (D49).

The UI extends the existing export table: actions and targets are merged as
rows, only for the kinds the exporter answered, and the type filter gains
"Action" / "Notifier" only for a supported kind. An unanswered kinds list is
unknown, never "supports nothing" (D315): devices only, and the action and
target lists are not requested.

## Consequences

- Alexa shows a scene only to an admin link: `actions.run` is an admin act and a
  scoped user has no way to express a per-action grant through a scene.
- Home Assistant builds a `notify` entity only if the custom component builds
  that platform; against one that does not, targets are withheld and logged by
  name. The component lives outside this repository.
- An action never gets a device id, so nothing here touches the device registry
  or `device-removal-hook`: an exporter prunes its own selection.

## Enforcement

Specs per exporter (`action-switch`, `action-exports`, `action-scenes`,
`action-scenes-router`, `exported-entities`) and the UI specs
(`export-entity-rows`, `device-export-panel-entities`); the method-tier and
method-role baselines pin the admin-only mutations.
