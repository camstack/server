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
| Door lock | lock: locked, unlocked, jammed. Not fully locked and unlatched are jammed and unlocked, with a detail. Door open, closed, forced open and ajar are details. A jammed door is lock state jammed. Battery comes from Power Source when that cluster is present. |
| Thermostat | climate |
| Window covering | cover |
| Temperature, humidity, pressure, illuminance | the matching sensor |
| Boolean state | contact |
| Occupancy | motion |
| Power source | battery |
| Electrical power and energy | power meter |
| Switch (button) | button device type. Inbound presses are not forwarded yet. |

Lock and unlock send `lockDoor` / `unlockDoor`. The device shows locking or
unlocking until the subscription reports the outcome.
