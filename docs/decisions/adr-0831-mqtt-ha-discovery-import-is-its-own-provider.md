---
id: D831
title: MQTT Home Assistant discovery import is its own hub-only provider
status: accepted
date: 2026-10-12
supersedes:
applies-to:
  - packages/addon-provider-mqtt-ha/**
  - packages/addon-mqtt-broker/**
---

## Context

Operators run Mosquitto (or CamStack's embedded aedes) with devices that publish
Home Assistant MQTT discovery (`homeassistant/<component>/<object_id>/config`)
and state topics — Zigbee2MQTT, ESPHome, and similar. CamStack already imports
HA entities over the Home Assistant **WebSocket** (`provider-homeassistant`) and
registers MQTT **brokers** (`mqtt-broker`) without pub/sub proxying. Putting the
discovery consumer inside `mqtt-broker` would couple aedes/registry crashes to
adoption; extending the WS HA provider would mix two transports and identity
spaces (`ha:` vs MQTT `unique_id`).

## Decision

Home Assistant MQTT discovery **import** lives in a dedicated hub-only addon
(`provider-mqtt-ha`). It reads broker credentials via `mqtt-broker.getBrokerConfig`,
opens its own `mqtt.js` client, indexes retained config topics, and exposes
`device-adoption`. Stable ids use the `mqtt:{brokerId}:…` namespace and never reuse
`ha:` WebSocket ids. Export to HA remains HTTP (`homeassistant-export`); this
addon does not resurrect `export-ha-mqtt`.

## Consequences

- One integration instance per observed MQTT broker (`mqttBrokerId` setting).
- The same physical device may appear twice if also imported via HA WS — the
  operator chooses one path; there is no automatic dedup in v1.
- v1 covers `sensor` and `switch` components; other HA MQTT components stay
  out of the candidate list until mapped.

## Enforcement

Nothing automated beyond addon-entry / capability wiring checks. Review only
for identity-namespace collisions with `provider-homeassistant`.
