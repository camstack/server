# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-27

### Added

- Node Root: CamStack shared node-root boot core — zero-dep starter machinery (state schema/IO, boot plan, semver compare, workspace detect, root update service) bundled INTO each node starter at build time. Never published; never a runtime dependency.
