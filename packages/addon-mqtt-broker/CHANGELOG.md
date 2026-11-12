# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The MQTT broker is offered as "MQTT" so a new broker is prefilled "MQTT - Home".

## [1.2.158] - 2026-11-09

### Changed

- Rebuilt against updated dependencies.

## [1.2.157] - 2026-11-08

### Changed

- The embedded broker's client credentials and topic rules are instances of the broker page (migrated in place with the same ids), no longer two lists in the addon settings
- The embedded broker keeps serving the legacy client and ACL lists until their copy to instances is recorded, and refuses to open if they cannot be read

## [1.2.156] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.155] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.154] - 2026-11-06

### Changed

- The separate broker connection test is gone; a broker is tested from its instance row.

## [1.2.153] - 2026-11-06

### Changed

- Removed the deprecated broker-named in-use helpers; a delete refused for a linked instance is the one InstanceInUseError
- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged

## [1.2.152] - 2026-11-06

### Changed

- An MQTT broker can be edited in place (address, user, password, client id prefix) and removing one that an MQTT Discovery integration still names is refused with the list of integrations
- MQTT brokers declare the function they serve on their instance kind
- MQTT brokers are managed only on the instances page; deleting one an MQTT Discovery integration still names is refused
- Creating an onboard MQTT broker works again from the Add broker dialog: tick Run an onboard broker, pick a port or leave it blank, and the broker starts on this hub; deleting it stops it, and a broker can be tested before it is saved.
- The embedded broker (flat settings) moves to an onboard broker record under the same id: it is listed, tested, switched off and deleted like every other broker, and MQTT brokers now report connected, auth-failed, unreachable or TLS error; a delete is refused while MQTT Discovery is installed but not answering yet
- A legacy embedded broker that was stopped is migrated as a switched-off broker record (same id, port and password) instead of its settings being dropped.

## [1.2.151] - 2026-11-05

### Changed

- MQTT embedded broker settings are declared on the cluster hook; the form and stored values are unchanged.

## [1.2.150] - 2026-11-04

### Changed

- The instances state their role (service connections) so the Integrations page lists the addon correctly

## [1.2.149] - 2026-11-03

### Changed

- External MQTT brokers are now integration instances: they list on the Integrations page, an instance can be switched off, and the old settings list is migrated into records and removed.

## [1.2.148] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.147] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.146] - 2026-10-27

### Added

- MQTT Broker: MQTT broker registry addon for CamStack — manages external broker entries + an optional embedded aedes broker. Consumers spin up their own `mqtt.js` clients via the `mqtt-broker` cap.
- Provides the addon MQTT Broker.
