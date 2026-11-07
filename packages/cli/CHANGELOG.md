# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.226] - 2026-11-07

### Changed

- The MCP notification tools list and write targets through integration instances
- The setup-locations tool changes a location's state through its instance instead of the retired storage upsert
- configure_oidc creates and updates connections through integration-instances

## [1.2.225] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.224] - 2026-11-06

### Changed

- New support tools migrations_status and media_storage_check, and report_issue now includes them: the migration ledger with the failure chain and refused runners, and stored media per storage location with a per-camera thumbnail sample
- deploy --closure stamps the server's required addon minimums from the workspace so a dev closure is judged like a release

## [1.2.223] - 2026-11-05

### Changed

- camstack develop scaffold addon accepts --kind device-integration, service-integration and exporter

## [1.2.222] - 2026-11-04

### Changed

- configure_export_set writes to each enabled export instance of the exporter

## [1.2.221] - 2026-11-04

### Changed

- MCP: report_issue drafts a GitHub issue for camstack/server (typed environment, per-kind logs, every string scrubbed with redaction counts) and files it with your own gh only after you read the full text and confirm; without gh it returns a prefilled link

## [1.2.220] - 2026-11-03

### Changed

- MCP: assisted-setup tools (setup_locations, setup_recording, setup_streams, setup_benchmark, setup_pipeline and their gated configure_setup_* applies), debug_report (versions, streams, churn, tracks and media per kind, viewer lines) and client_logs for the viewer app's own log

## [1.2.219] - 2026-11-01

### Changed

- setup_wizard now also checks that no admin account still has the default password (admin / changeme); on a hub too old to answer, that step reports unknown

## [1.2.218] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.217] - 2026-11-01

### Changed

- MCP: new read-only setup_wizard tool lists what a fresh hub still lacks (admin 2FA, remote access, backups, cameras, notifiers, alert rules, calibration) and the tool to run next
- Sign in without a TTY by approving in the admin UI (camstack login <host> --browser), assistant tools setup_login/setup_login_wait, Node 24 check, and camstack mcp update/rollback
- mcp update installs without running scripts and checks the registry integrity; rollback checks its target and runs the doctor

## [1.2.216] - 2026-10-31

### Changed

- The MCP checks versions before every tool call: it prepends one warning line when the hub server, its addons or the CLI/MCP are outdated, and a new version_check tool asks on demand.

## [1.2.215] - 2026-10-31

### Changed

- The automation interview accepts a domain target for a step and writes the target shape

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
