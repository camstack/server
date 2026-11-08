# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.160] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.159] - 2026-11-07

### Changed

- The Cloudflare tunnel writes its local origin through the node settings of network-access, to the same stored keys.

## [1.2.158] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.157] - 2026-11-05

### Changed

- Cloudflare tunnel writes its local origin through the node-scoped settings path; stored values are unchanged.

## [1.2.156] - 2026-11-04

### Changed

- The integration states its role (devices, services or both) to the Integrations page

## [1.2.155] - 2026-11-04

### Changed

- Cloudflare TURN now supports several accounts; the ICE servers of every enabled account are served together

## [1.2.153] - 2026-11-03

### Changed

- The Cloudflare tunnel is now one record on the Remote Access page (tokens in the keychain), and where it forwards to is a per-node setting; the old settings are moved automatically.

## [1.2.152] - 2026-11-02

### Changed

- Cloudflare TURN is configured as an account row on the TURN Servers page, with a Test button; the existing credentials move over on first start

## [1.2.151] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.150] - 2026-10-27

### Changed

- Shown as "Cloudflare TURN" (was "Cloudflare TURN Relay").

## [1.2.149] - 2026-10-27

### Added

- Cloudflare: Cloudflare bundle — Tunnel (network-access) + TURN relay (turn-provider). Multi-entry npm package shipping 2 addons under a single bundle.
- Provides the addons Cloudflare Tunnel, Cloudflare TURN.
