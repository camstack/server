# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- camstack mcp: the support toolset (benchmark run and status, accelerator and camera diagnosis, gated issue and pull-request drafts through your own gh)

## [1.2.210] - 2026-10-30

### Changed

- New `camstack mcp` command: the public MCP server (stdio) with setup, ops, configure and develop toolsets, using your `camstack login` session
- Added the setup tools to camstack mcp: an install guide that interviews you and returns the official template files, hub discovery, a connection check and the add-agent pairing guide.
- camstack mcp: the ops toolset answers read-only questions about the hub (status, device, unhealthy devices, logs, events, track audit, accelerators)
- camstack mcp configure toolset adds addon store search/install/update/uninstall, camera provider listing/discovery/add and notification target management; secrets are never accepted as tool arguments and are pointed to the admin UI

## [1.2.209] - 2026-10-27

### Added

- Packs a README and a CHANGELOG.

## [1.2.208] - 2026-10-27

### Added

- CamStack CLI: CLI tool for managing and running CamStack server.
