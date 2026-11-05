# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The starter checks the server range it hosts at boot too: a closure below it is not booted, the baked seed is, and the log says why
- The starter refuses to boot an older baked seed over a data root that last ran a newer server, and says which version to restore

## [1.0.0] - 2026-10-27

### Added

- Node Root: CamStack shared node-root boot core — zero-dep starter machinery (state schema/IO, boot plan, semver compare, workspace detect, root update service) bundled INTO each node starter at build time. Never published; never a runtime dependency.
