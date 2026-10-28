# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.173] - 2026-10-28

### Changed

- An AI profile can turn the model's thinking off or set its effort

## [0.4.172] - 2026-10-28

### Changed

- AI model lists: an Anthropic list that answered HTTP 400 is retried at the default page size, a base URL typed without /v1 or with a pasted /models works, and local servers (Ollama, llama.cpp, LM Studio) list their models even from a bare host.

## [0.4.171] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.4.170] - 2026-10-27

### Added

- AI: AI addon for CamStack — the `llm` collection provider (cloud, LAN, and camstack-managed local llama.cpp profiles) plus the per-node `llm-runtime` managed executor.
- Provides the addon AI.
