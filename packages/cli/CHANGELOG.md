# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.214] - 2026-10-31

### Changed

- Every failing MCP tool now reports isError, and hub calls trust only the CA pinned for that hub instead of skipping TLS verification
- New `camstack mcp doctor` checks Node, hub, pinned CA, session, token scope and CLI version; `camstack login --token-file` logs in without a TTY from a 0600 file

## [1.2.213] - 2026-10-30

### Changed

- MCP: new configure_oidc tool connects an OpenID Connect provider (authentik, pocket-id, keycloak, google and more) with a preview, a discovery check and the redirect URI to paste; the client secret is typed in the admin UI
- The automation interview and save tools write the single 'when' tree; stored recipes in the old triggers/conditions shape are still accepted.

## [1.2.212] - 2026-10-30

### Changed

- The MCP gains ops_update_check (cluster-wide server, wrapper, addon and CLI update report) and ops_update_apply (ordered, verified, confirm-gated cluster update; wrapper updates are reported with instructions)

## [1.2.211] - 2026-10-30

### Changed

- camstack mcp configure toolset adds addon store search/install/update/uninstall, camera provider listing/discovery/add and notification target management; secrets are never accepted as tool arguments and are pointed to the admin UI
- camstack mcp configure toolset: automation and notification-rule interviews with gated saves, camera calibration report and apply, zones, alarm, remote access (secrets are never tool arguments), exports and the Home Assistant guide
- camstack mcp: the support toolset (benchmark run and status, accelerator and camera diagnosis, gated issue and pull-request drafts through your own gh)

## [1.2.210] - 2026-10-30

### Changed

- New `camstack mcp` command: the public MCP server (stdio) with setup, ops, configure and develop toolsets, using your `camstack login` session
- Added the setup tools to camstack mcp: an install guide that interviews you and returns the official template files, hub discovery, a connection check and the add-agent pairing guide.
- camstack mcp: the ops toolset answers read-only questions about the hub (status, device, unhealthy devices, logs, events, track audit, accelerators)

## [1.2.209] - 2026-10-27

### Added

- Packs a README and a CHANGELOG.

## [1.2.208] - 2026-10-27

### Added

- CamStack CLI: CLI tool for managing and running CamStack server.
