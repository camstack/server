# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.149] - 2026-11-03

### Changed

- Tailscale client and funnel settings are now per node; existing values are copied to the hub's own settings on first boot

## [1.2.148] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.147] - 2026-10-27

### Changed

- Shown as "Tailscale" and "Tailscale Funnel".

## [1.2.146] - 2026-10-27

### Added

- Tailscale: Tailscale bundle for CamStack — joins the host to a tailnet (client) and exposes the hub via Serve/Funnel (ingress). Multi-entry npm package shipping 2 addons under a single bundle.
- Provides the addons Tailscale, Tailscale Funnel.
