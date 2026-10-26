---
id: DNNN
title: A device is named by one function, and the stored name is not that string
status: accepted
date: 2026-10-26
supersedes:
applies-to:
  - packages/ui-library/src/composites/device-name/**
  - packages/addon-admin-ui/src/**
  - camstack/src/data/device-name.ts
---

## Context

The same child was painted ten different ways: the stored string, the stored string with the parent prefix cut off, `name · parent`, `parent · name`, the parent alone, and a second line that said "in &lt;parent&gt;" under a title that already named the parent. A motion sensor stored as `Motion` under `Sensore movimento veranda` read as `Motion · Sensore movimento veranda` in a picker and as `Motion` in the device list. Each screen had invented the rule.

The stored name cannot be rewritten to fix this. It is what the integration reported, what search matches, and what the identity editor changes.

## Decision

One function names a device for display (`formatDeviceName`). A child whose stored name is a stock word for its role or type — in either locale — is shown as the active locale's short noun (Movimento, Batteria, Telecamera). A name the operator wrote is kept. Compact form is the container's name alone when this child is that container's only meaningful child, or when the child's name is the container's name; otherwise `container · noun`. Full form is `container · noun` unless the noun is the container's name. Nested form, under the parent, is the noun alone.

Screens call `DeviceName` or `useDeviceLabel`. They do not interpolate `device.name`. Parent names come from one slim device list for the page. Until that list has answered, the stored name is shown. Search keeps the stored name as a keyword.

The viewer mirrors the function (it cannot import the admin library). Its screens are not switched in the same change.

## Consequences

A new screen that paints a device name uses the component and one of the four forms. The guard `check-device-name-rendered-via-component` fails a JSX file that renders `device.name` outside the allow-list. `check-device-name-in-sync` fails when the viewer's copy drifts. Identity editors and adoption previews stay on the stored string, and they are named in the guard.
