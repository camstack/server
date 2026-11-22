---
title: Matter broker
covers:
  - packages/addon-matter-broker/**
---

# Matter broker

Hub-only addon. One broker is one Matter fabric. Commissioned nodes become
container devices; each mappable endpoint becomes an accessory child.

Commissioning is on-network only. Paste the 11-digit or 21-digit manual
code, or the `MT:` payload, from a device that is already sharing on the
LAN. BLE commissioning is not wired.

## Adding a brand-new device (an Aqara lock)

CamStack cannot pair a device that is still in factory mode: there is no BLE
commissioning and no Thread dataset step on the hub. The supported path is:

1. Create the Matter fabric (Integrations, Matter fabric). There is no restore
   id to give; a fabric is new and its devices go with it.
2. Pair the lock in an ecosystem that can (the Aqara app or Home Assistant).
3. In that ecosystem choose **Share device** (multi-admin) to get the code.
4. In CamStack add a Matter integration on the fabric, open **Add Matter
   device** and paste the code over IP. No Thread dataset is needed when the
   lock is already on a Thread border router's mesh.

## Share a device from Home Assistant

1. The device is already commissioned in Home Assistant (the Aqara Hub M3
   on Wi-Fi is the usual first node; an Aqara U200 that is already on that
   hub's Thread mesh can be shared after the hub).
2. Open the device and choose **Share device**.
3. In CamStack, open the Matter integration and choose **Add Matter device**.
4. Paste the numeric code or the `MT:` code before it expires. The dialog
   reports discovering, then PASE, then commissioning. A failure is named:
   the code expired, no device answered on the network, or the code was
   rejected.
5. When commissioning finishes, adopt the new node. The device stays in
   Home Assistant; sharing adds CamStack as another controller on the fabric.

The Aqara app can share the same way: the share sheet shows the same manual
code or QR payload.

## Thread

A Thread device is reachable only when a Thread border router is already on
the LAN. For this setup that router is the Aqara Hub M3, a HomePod mini, or
both. Sharing a device that is already on that mesh does not need a Thread
operational dataset.

The dataset field on the fabric settings is only for commissioning a Thread
device onto a dataset this controller knows. It is a secret: the settings
read returns it blank, and a save that sends a blank value keeps the stored
secret. The same applies to the Wi-Fi password. Do not put either value in a
log or a ticket.

## Commissioning a Thread device already on another fabric

A lock or sensor that is already paired to another ecosystem (Aqara, Apple
Home, Home Assistant) is added as a second admin, not reset.

1. In the current ecosystem, open the device and start sharing (multi-admin).
   It shows an 11-digit manual code or an `MT:` payload that is valid for a
   few minutes.
2. Paste it into the fabric's commissioning field here, before it expires.
3. The hub must reach the Thread mesh over IPv6. A Thread border router
   advertises the mesh prefix in a router advertisement route; a container
   ignores it unless the kernel accepts route information. Set
   `net.ipv6.conf.<interface>.accept_ra_rt_info_max_plen=64` on the hub
   container (and `accept_ra=2` when the host forwards). Without the route
   the share code is accepted and the node never answers.

A node that is unreachable is shown offline. It is never shown with its last
state, so an offline lock does not read as locked.

## What is stored where

`threadDataset` and `wifiPassword` are secret fields. They go through the
keychain. The public settings read never returns them in clear.

The fabric root certificate, NOC and node registry are matter.js files under
the addon data directory (`Environment` `storage.path`). That is the
library-owned exception, the same class as HAP pairing files: the library
reads and writes those paths itself, and they are not copied into the
keychain. Backups rely on backup encryption. Every controller in this
process shares one `Environment` and one data directory, so this addon runs
one fabric. A second fabric needs per-broker storage first.

A lock PIN is never stored. If the lock requires a PIN for remote operation,
the lock or unlock call must include one for that command. The command
refuses when the device requires a PIN and none was passed. The PIN is not
written to settings, the keychain, or a log.

## What the addon maps

Attribute reports arrive on a per-node subscription. A missing report is not
a value: the previous state stays until a real report arrives. The
subscription resubscribes when the session drops or the node comes back
online, with a delay that grows up to one minute.

| Matter cluster | CamStack |
| --- | --- |
| On/Off | switch |
| Level | brightness |
| Color | color state. Setting a color is not implemented. |
| Door lock | lock (and event emitter). Not fully locked and unlatched are jammed and unlocked, with a detail. A door contact is added only when the lock reports DoorState; DoorJammed stays a lock state. Battery comes from Power Source when that cluster is present: the percentage when reported, otherwise the charge-level enum (ok, warning, critical), which never overwrites a real percentage. |
| Thermostat | climate |
| Window covering | cover |
| Temperature, humidity, pressure, illuminance | the matching sensor |
| Boolean state | contact; flood when the endpoint's Descriptor device type is a water-leak, rain or freeze detector |
| Occupancy | motion |
| Power source | battery |
| Electrical power and energy | power meter |
| Switch (button) | button device type and event emitter: press, long press, release and multi-press events |
| Smoke/CO alarm | smoke and carbon monoxide detectors, each only when the unit reports that state |
| Valve | valve: open and close. Position is read; setting a position and stop are not implemented. |
| CO2, PM2.5, PM10, TVOC | air quality sensor. Units are assumed ppm, ug/m3 and ppb. |
| Plug-in unit device types | switch device type instead of light |

Not mapped, because no capability exists for them yet: Fan Control and air
purifiers, the Air Quality enum, Mode Select and robot vacuum cleaners.

## Events

Matter events are one-shot facts, not states. Door lock operation (locked,
unlocked, unlatched, with source and user index), alarms (jammed, tamper,
wrong-code lockout, forced open and others), operation errors and door
open/close, and the switch events above, are emitted as device events. The
node numbers its events; a resubscribe that replays buffered events delivers
nothing twice, and an event stamped more than ten minutes old is dropped.
Every event that is dropped is logged on the device with the reason.

Lock and unlock send `lockDoor` / `unlockDoor`. The device shows locking or
unlocking until the subscription reports the outcome.
