---
id: D885
title: A critical alert is a severity on the alert centre
status: accepted
date: 2026-10-19
applies-to:
  - packages/types/src/capabilities/alerts.cap.ts
  - packages/system/src/builtins/alerts/emit-alert-policy.ts
  - packages/system/src/builtins/alerts/alerts.addon.ts
  - packages/addon-google-services/src/google-broker-reconnect-alert.ts
  - packages/addon-google-services/src/google-services.addon.ts
---

## Context

D877 made hub-main the sole pusher for runner failures through
`notification-output`, keyed by category. Integrations such as Google OAuth can
also reach a state the operator must act on, without being a runner refusal.
Those findings belong in the same alert centre row set, with an urgent grade and
the same digest push path, but they are not runner categories.

## Decision

`critical` is a severity on the existing `alerts` capability. Any alert whose
severity is `critical`, or whose category is already in `CRITICAL_CATEGORIES`,
is eligible for the D877 digest push when it is `active` and unread. An episode
is keyed by `metadata.episodeKey`; re-emitting the same id with the same key
after `markRead` preserves `read` and does not push again. A new key after the
condition cleared starts a new episode. Optional `action.href` points the admin
UI at a same-hub remedy path. Google broker `invalid_grant` on refresh emits
`google.broker-reconnect`; a successful OAuth callback that stores a refresh
token completes that alert.

## Consequences

- Producers use `alerts.emit` / `alerts.update`; no parallel notification rule.
- Push copy comes from `metadata.pushLine` when present.
- UI must render `critical` and optional `action` (handled outside this change).

## Enforcement

`packages/system/src/builtins/alerts/__tests__/emit-alert-policy.spec.ts` and
`packages/addon-google-services/src/__tests__/google-broker-reconnect-alert.spec.ts`;
review only for cap schema and ADR alignment.

> **Amended by [D890](adr-0890-the-alert-centre-notifies-nothing-an-alert-reaches-a-phone-only-through-a-system-event-rule.md):** `critical` stays a severity, but the D877 digest push and `metadata.pushLine` are gone; a critical alert is notified through an `alert-critical` rule, once per episode.
