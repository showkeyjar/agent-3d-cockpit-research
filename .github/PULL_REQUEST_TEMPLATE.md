## Summary

<!-- One logical change. What and why. -->

## P1–P4 self-check (required)

Which substantive-progress criterion does this advance?

- [ ] P1 Real
- [ ] P2 Verifiable
- [ ] P3 Attributable
- [ ] P4 Perceivable
- [ ] None (presentation-only / docs / infra) — justification: …

## Red-line checklist

- [ ] No fabricated completion signals or data
- [ ] Fallback paths labeled `local`/`offline` (never impersonate `llm`)
- [ ] Interruption stays a third state (≠ done ≠ failed)
- [ ] Camera on-rail invariant untouched (`camOffRail ≈ 0`)
- [ ] Experiment modes (`?mode=…`) semantics unchanged or explicitly re-locked
- [ ] No secrets / personal absolute paths in the diff

## Regression evidence

<!-- Which suites ran, pass counts. New behavior ⇒ new/extended test that would catch its regression. -->

```
pytest: …
node test_…: …
```

## Docs updated

- [ ] `prototype/CHANGELOG.md` (if version bump)
- [ ] `prototype/DESIGN.md` (if design decision)
- [ ] Root `README*` / `docs/i18n` (if user-facing)
