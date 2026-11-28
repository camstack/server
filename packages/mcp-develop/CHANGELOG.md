# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed to Dominevo: the package is now published as @dominevo/mcp-develop, restarting at version 0.1.0.

## [0.1.33] - 2026-11-25

### Changed

- Track review tools now use the saved camstack login session (hub address, credential, TLS) when no CAMSTACK_HUB_* variables are set, and refuse the write tools up front without an admin login.

### Removed

- Track review uses the camstack login session; CAMSTACK_HUB_TOKEN and CAMSTACK_HUB_TOKEN_FILE are no longer read.

## [0.1.32] - 2026-11-20

### Changed

- The standalone camstack-mcp-develop server binary is retired in favour of `camstack mcp --toolsets develop`; the package stays as the library behind that toolset, and registerDevelopTools takes options to register a subset

## [0.1.31] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.30] - 2026-11-05

### Changed

- scaffold_addon accepts the integration kinds device-integration, service-integration and exporter

## [0.1.29] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [0.1.28] - 2026-10-30

### Changed

- Deprecated: use `camstack mcp --toolsets develop`; the package stays as an alias for one release

## [0.1.27] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

## [0.1.26] - 2026-10-27

### Added

- CamStack Develop MCP: MCP server for CamStack plugin authors — catalogue, scaffold, validate, find_example, and track review (wraps @camstack/develop).
