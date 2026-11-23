---
name: 🐛 Bug report
about: Something behaves incorrectly or violates an honesty invariant
title: "[Bug] "
labels: bug
---

## What happened

<!-- A clear description of the incorrect behavior. -->

## What you expected

<!-- Especially if this touches an honesty invariant: fabricated completion, mislabeled source, interruption shown as done, camera off-rail, etc. -->

## Provenance state (important!)

The UI's provenance badges are diagnostic gold. Please report:

- Result card `source`: `llm / fast / local / offline`
- Proof bar state (divergence D / road type / forecast source)
- Task bar summary at the moment of the bug

## Steps to reproduce

1.
2.
3.

## Environment

- Prototype version (top entry of `prototype/CHANGELOG.md`):
- Browser + version:
- LLM endpoint type (llama.cpp / Ollama / cloud API) + model:
- OS:
- Experiment mode if any (`?mode=…`):

## Logs / screenshots

<!-- Browser console errors, backend logs, screenshots. Redact any API keys. -->

## P1–P4 impact (optional but helpful)

<!-- Which criterion does this bug violate: P1 real / P2 verifiable / P3 attributable / P4 perceivable? -->
