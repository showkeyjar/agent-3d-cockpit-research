# Research Summary (English)

> A faithful overview of the research framework. Full arguments live in the primary documents ([docs/PROBLEM.md](../PROBLEM.md) etc., written in Chinese).
> Other languages: [中文](RESEARCH-SUMMARY.zh.md) · [日本語](RESEARCH-SUMMARY.ja.md) · [Deutsch](RESEARCH-SUMMARY.de.md) · [Français](RESEARCH-SUMMARY.fr.md) · [Español](RESEARCH-SUMMARY.es.md)

## Research question

In an interface that renders agent work as a 3D cockpit, under what conditions do users perceive **substantive progress** rather than **formal progress** (motion without change)?

The starting point is real user feedback: *"The interface feels like there's no substantive progress."* Four prior iterations (candidate count, preview fleet, immersive/stereo, semantic bucketing) all landed in the presentation layer; the fifth feedback leapt past presentation into the execution layer.

## Working definition: P1–P4

Substantive progress = the interface lets the user perceive that *a real task state of theirs has changed, verifiably and traceably, because of the agent's work*. Four criteria; missing any one degrades to formal progress:

- **P1 Real** — the change happens to the actual task/artifact;
- **P2 Verifiable** — the user can confirm the change themselves;
- **P3 Attributable** — the user can tell who/which step caused it;
- **P4 Perceivable** — the change is recognizable in the UI.

## Key finding: middle theater + real tail

The static audit (AUDIT.md) found the old execution chain's intermediate steps never called the LLM: `prompt` was a dead parameter, progress was driven by `asyncio.sleep(0.09)`, intermediate outputs were template sentences. Runtime evidence (RUNTIME-AUDIT.md) pinned it with WebSocket timing: `task_update` intervals sat uniformly at 90–100 ms with zero spread — the fingerprint of sleep; in that record fake cadence occupied ~86% of total duration (a diagnostic figure for that record only). Only the final `output` step was a real LLM call.

This falsified the optimistic hypothesis "progress exists but isn't shown": the problem is first P1/P3 (reality and attribution), and only then P4 (presentation).

## The fix: Route B (honest downgrade)

All theatrical intermediate steps were removed; execution converged to a single real streaming LLM call. Progress = actual output length; the attribution chain `["output"]` matches reality. Re-test: the uniform-cadence fingerprint disappeared; token streaming covered 60–70% of execution time.

**Boundary**: Route B fixes P1/P3, not automatically P2 — for data-analysis tasks without input data, specific numbers the model generates are not recomputable, so P2 fails. The UI must honestly present "missing input" instead of fabricating conclusions.

## Disciplinary framework: bidirectional broken link

- Discipline 1 (vector-space context visualization): real semantic-structure change (bucketing/direction differentiation) once left no perceivable difference in path space;
- Discipline 2 (3D path-space HCI): rich presentation (fleet/immersive/stereo) once had "advances" unsupported by real displacement.

Neither attesting to the other = bidirectional broken link, the mechanistic hypothesis behind "no substantive progress" (pending human-study validation).

## Experiment plan

M1 apparatus is ready: A/B (opaque vs transparent execution), B0/B1 (3D-linkage single attribution), B2 (fingerprint-ring single variable), C (decorative fake-execution mirror group with debrief); three task types (drafting / analysis with data / analysis without data); scales s1–s7 + f1–f3. **M2 human controlled studies and M0 think-aloud are pending**; all human-side criteria remain unverified until data arrives — completion must not be declared early.

## Evidence discipline

Four evidence tiers: static code audit → runtime evidence → proxy participants → real participants. Small samples report direction only, no significance claims; proxy-participant conclusions are downgraded and labeled; developer-side observations never impersonate user-side conclusions.
