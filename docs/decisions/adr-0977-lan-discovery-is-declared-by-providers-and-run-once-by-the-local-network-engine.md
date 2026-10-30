---
id: D977
title: LAN discovery is declared by providers and run once by the local-network engine
status: accepted
date: 2026-10-30
supersedes:
applies-to:
  - packages/types/src/capabilities/device-provider.cap.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/scan/**
  - packages/system/src/builtins/device-manager/discovery-orchestrator.ts
---

## Context

Every provider scanned the LAN by itself inside `discoverDevices`. The mDNS
datagram code was copied into three addons, the "/24 of the hub" helper into
four, and a scan of N providers swept the same hosts N times. None of them could
see a device on another subnet (a Velux box on 192.168.20.x was invisible: its
only advertisement is multicast, and multicast does not cross subnets), and a
candidate carried no way to say "this is an integration to set up" or "this
device sits behind that gateway" except a string key inside `prefilledConfig`.

## Decision

A provider DECLARES how it is found (`device-provider.getDiscoveryModes`: `mdns`,
`ws-discovery`, `ssdp`, `udp-broadcast`, `http-probe`, or `custom` for what the
engine cannot do) and CLASSIFIES what the engine saw
(`classifyDiscoveryHits`, which may make unicast follow-up requests to a hit
host, never a sweep). The `local-network` builtin owns the network:
`scanNetwork` runs every declared mode once for every provider (one mDNS browse
for the union of service types, one host sweep that visits each host once and
runs every http-probe, directed broadcasts) over the hub's own /24s, a saved
cluster list (`getScanSubnets` / `setScanSubnets`) and a per-call list. On a
subnet the hub is not on, multicast is replaced by a unicast query per host
(DNS-SD to host:5353, WS-Discovery, SSDP) or a directed broadcast.
`device-manager.discoverAllProviders` / `discoverProvider` collect the modes,
make one `scanNetwork` call, and hand each provider only the hits of its own
modes. A provider with no modes keeps `discoverDevices`; a provider with a
`custom` mode additionally gets `params.subnets`. Candidates gain typed
`setupIntegration`, `parentStableId` and `selectable`.

## Consequences

Limits are the engine's, in one place: 64 requests in flight, 1.2 s per request,
at most a /22 per saved entry and 4096 hosts per scan; a scan over the cap is
refused, not truncated. Each scan logs one summary line (hosts probed, hits,
timeouts per mode). An addon may not keep a private LAN scan once migrated; each
`custom` mode is a written exception. The old
`prefilledConfig.setupIntegration` key is still read for one release.

## Enforcement

Specs: `local-network/scan/__tests__/scan-engine.spec.ts` (batching, subnet
union, host cap, extra-subnet unicast) and
`device-manager/__tests__/discovery-orchestrator.spec.ts` (routing, legacy
path). The guard against private LAN scans in addons lands with the addon
migrations.
