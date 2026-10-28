# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The hub serves viewer 1.0.664: device values read the quantity field names, falling back to the old ones

## [1.2.634] - 2026-10-28

### Changed

- The hub serves viewer 1.0.663: the embed hides the assignment chip, shows short ages up to a week and follows the lang parameter

## [1.2.633] - 2026-10-28

### Changed

- The hub serves viewer 1.0.662: events embed tile settings and a track detail page

## [1.2.632] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.631] - 2026-10-27

### Added

- Pipeline Orchestrator: Hub-side camera-to-agent load balancer — tracks runner capacity and dispatches attachCamera calls to the optimal pipeline-runner instance.
- Provides the addon Pipeline Orchestrator.
