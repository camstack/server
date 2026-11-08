# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- No operator change: the legacy profile rows the migration is tested against now live in a replay seed

## [0.4.181] - 2026-11-08

### Changed

- LLM profiles of every provider kind list again: the profile now reports its stored kind, so the integrations page no longer fails on a hub with several LLM providers

## [0.4.180] - 2026-11-07

### Changed

- AI profiles are integration-instances records now: the llm capability no longer carries profile CRUD, test or raw-secret migration methods.

## [0.4.179] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.4.178] - 2026-11-06

### Changed

- LLM profiles are now instances of the llm function cap (their kinds, test and key handling served through integration-instances); a one-time migration moves leftover flat profile rows and plaintext keys into the keychain
- An LLM profile's on/off switch now goes through the shared instance switch, so it changes only the enabled flag and works while the keychain is locked

## [0.4.177] - 2026-11-05

### Changed

- AI chat retention settings are declared on the cluster hook; the form and stored values are unchanged.

## [0.4.176] - 2026-11-02

### Changed

- A per-call reasoning effort beats the profile's on the openai-compatible wire
- Reasoning effort now reaches Anthropic (thinking), Google (thinking budget) and OpenAI reasoning models; the model list reports which models think

## [0.4.175] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.4.174] - 2026-10-29

### Changed

- Forgetting a node removes the local and Apple LLM profiles bound to it

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
