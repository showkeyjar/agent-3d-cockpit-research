# Contributing to Agent 3D Cockpit

Thanks for your interest! This project has one unusual rule that makes contributing here different from most repos — please read it first.

**中文读者**：核心规则只有一条——每个改动先回答「它推进了 P1–P4 的哪一条」。只推进呈现层的改动默认视为未构成实质进展，需给出理由。详见下文（英文）。

## The one rule: P1–P4 self-check

Every change must answer: **which of the four substantive-progress criteria does it advance?**

| Criterion | Question |
| --- | --- |
| P1 Real | Does the task/artifact actually change? |
| P2 Verifiable | Can the user verify it themselves? |
| P3 Attributable | Can the user tell which step/who did it? |
| P4 Perceivable | Is it recognizable in the UI? |

- Presentation-only changes (visual polish, more effects) are **presumed non-substantive** and require written justification in the PR.
- This is not bureaucracy — it is the project's core research finding: four rounds of presentation-layer iteration produced the user feedback "no substantive progress". See [docs/EVIDENCE.md](docs/EVIDENCE.md).

## Engineering red lines (no PR may regress these)

1. **No fabricated completion signals.** If work didn't happen, the UI must not say it did.
2. **No fabricated data.** Local fallbacks are labeled `local`/`offline`, never `llm`.
3. **Interruption is a third state.** Interrupted ≠ completed ≠ failed. Partial text preserved, honestly labeled.
4. **Camera on-rail invariant.** `camOffRail ≈ 0`; camera position formula unchanged.
5. **Experiment manipulation consistency.** `?mode=opaque / transparent-nolink / decorative / no-fingerprint` semantics locked by `verify_opaque.js` etc.
6. **No secrets in the repo.** Tokens, keys, personal absolute paths — never commit. `.gitignore` covers known patterns; double-check your diff.

## Development setup

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt
npm install   # playwright-core for frontend regression

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

A small local model (e.g. Ollama `gemma3:1b`) is enough for development; backend tests use fake-LLM and don't occupy model slots.

## Before opening a PR

1. **Run the relevant regression suites** (see [prototype/README.md](prototype/README.md)):
   ```bash
   cd prototype/backend && pytest          # backend contract tests
   cd prototype && node test_honesty.js    # honesty guardrails
   node test_cancel.js                     # interruption contract
   node verify_opaque.js                   # experiment manipulation
   ```
   Add/extend tests for any behavior you change. A bug fix without a regression test that would have caught it is incomplete.
2. **Update the docs that your change makes stale**: `prototype/DESIGN.md` (design decisions), `prototype/CHANGELOG.md` (version facts, reverse chronological), root `README*` if user-facing.
3. **Fill the PR template** including the P1–P4 self-check.
4. Keep diffs focused. One logical change per PR.

## Commit messages

Follow the existing convention (see `git log`):

```
v0.9.X.Y · <short summary>

- <what changed, with the invariant/contract it touches>
- <regression evidence: which suites, pass counts>
```

If your change is not a version bump, a clear imperative summary is fine (`fix: …`, `docs: …`, `test: …`).

## Translations

Multilingual READMEs (`README.en/ja/de/fr/es.md`) and research summaries (`docs/i18n/`) are first-class deliverables. Translation PRs are very welcome:

- Keep technical terms consistent with the English README glossary (fork / sign / arrival / provenance / theater / broken link).
- Do not translate away the honesty caveats — they are load-bearing.
- Full translations of primary research docs (`docs/*.md`, currently Chinese) are especially valuable.

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE). For bugs, include: prototype version (`prototype/CHANGELOG.md` top entry), browser, LLM endpoint type, and the provenance badges visible in the UI (`source` state) — they are diagnostic gold.

## Code of conduct

Be kind. This project audits its own work publicly; critique ideas and code, not people. Harassment of any kind is not tolerated.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
