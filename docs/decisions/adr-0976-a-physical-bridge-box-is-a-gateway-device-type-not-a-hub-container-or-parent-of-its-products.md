---
id: D976
title: A physical bridge box is a Gateway device type, not a Hub, a Container or the parent of its products
status: accepted
date: 2026-10-30
supersedes:
applies-to:
  - packages/types/src/device/device-type.ts
  - packages/addon-provider-velux/src/**
---

## Context

The Velux KLF-200 is a box that talks to the shutters over radio and to CamStack over a LAN socket. It is a
device in its own right (it reboots, has firmware, has a web page) but it is not the shutters. The first
Velux addon modelled it as a `Hub` that every cover was bound to, as a standalone device the operator added by
hand. That conflated two things: the bridge box, and the per-equipment grouping that `Hub` and `Container`
already carry (a hub groups what one account exposes; a container groups the functions of one piece of
equipment, such as a window and its rain sensor). It also gave the operator no way to offer the box and its
products from one integration form.

## Decision

A physical bridge box is `DeviceType.Gateway`. Its actions come only from capabilities that exist already
(`reboot`, `update`, `device-admin-link`), and only those the box really supports; a Gateway has no
capability of its own. Its products are NOT children of the gateway: they are sibling devices of the same
integration, and a window with a rain sensor is a `Container` as before. `Hub` and `Container` are unchanged.

## Consequences

Every exhaustive table keyed by `DeviceType` carries `Gateway` (device meta, control resolution, do-actions,
the customize catalog). The viewer needs a label and an icon for it. The parent-child model and the grouping
semantics of `Hub` and `Container` stay as they were, so nothing that walks children changes.

Rejected: the gateway as a `Hub` or `Container` (conflates the bridge with per-equipment grouping), and the
gateway as parent of its products (changes the parent-child model and the viewer for one vendor).

## Enforcement

The exhaustive `Record<DeviceType, …>` types fail typecheck when a table lacks `Gateway`. The Velux specs
assert the discovery shape (one Gateway, window containers, plain covers).
