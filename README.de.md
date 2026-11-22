<div align="center">

# 🚗 Agent 3D Cockpit

**Zusammenarbeit mit KI-Agenten: vom Lesen von Antworten zum Fahren einer Reise.**

[![Version](https://img.shields.io/badge/prototype-v0.9.49.5-5ee0ff)](prototype/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-34f5a0)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md)

![Live-Aufnahme: Eine Frage lässt Kandidaten-Wegweiser aufleuchten](docs/assets/demo-forecast.gif)

*▲ Echte Laufzeit-Aufnahme: Frage eingeben → das latente Pfadgerüst erscheint → mit dem Eintreffen der Vorausschau leuchten fünf Kandidaten-Wegweiser auf. Das Ausführungs-Backend ist ein lokales Modell; die Herkunft der Vorausschau wird in der UI ehrlich gekennzeichnet.*

</div>

---

## Was ist das?

**Agent 3D Cockpit** ist ein lauffähiger Forschungsprototyp samt einem interdisziplinären Forschungsrahmen. Die zentrale Frage:

> Wenn ein KI-Agent für dich arbeitet — wie kannst du **Richtungen überblicken, Entscheidungen treffen, Fortschritt überprüfen und den Verlauf nachvollziehen**, statt auf einen Fortschrittsbalken zu starren und zu raten, was er eigentlich tut?

Die Zusammenarbeit wird als 3D-Fahrt dargestellt:

| Frage der Zusammenarbeit | Darstellung im Cockpit | Deine Möglichkeit |
| --- | --- | --- |
| Was könnte als Nächstes passieren? | **Wegweiser & Abzweigungen** voraus | Richtungen vor dem Losfahren vergleichen |
| Worin unterscheiden sich die Optionen? | Straßenform, räumliche Anordnung, Vergleichspanel | Entscheidungen verstehen, statt blind auf „Weiter“ zu klicken |
| Wo stehen wir gerade? | **Fahrt + streamende Token-Ausgabe** | Echten Ausführungssignalen folgen |
| Was hat dieser Schritt erbracht? | **Ankunftsschild + Ergebniskarte** (Dauer/Tokens/Herkunft) | Das Artefakt öffnen und prüfen — nicht nur ein „Fertig“-Badge sehen |
| Warum sind wir hier? | Zurückgelegte Strecke, 2D-Timeline, Entscheidungs-Trace | Von jedem Knoten aus zurückblicken, vergleichen, neu abzweigen |

![Live-Screenshot: fünf Kandidaten-Wegweiser](docs/assets/screenshot-fork.png)

## ✨ Funktionen

- **Vorausschau-gesteuerte Straßen**: Das Backend erzeugt per Sampling Kandidatenrichtungen und berechnet die Divergenz — geringe Divergenz ergibt eine gerade Straße, hohe ergibt Abzweigungen. Die Straßenform *ist* die Visualisierung der semantischen Struktur, keine Dekoration.
- **Semantisches Bucketing**: Synonym-Cluster-Faltung + Farthest-Point-Backfill stellen sicher, dass fünf Wegweiser fünf wirklich verschiedene Richtungen sind.
- **Ehrliche Ausführungskette**: Ein einziger echter Streaming-LLM-Aufruf; Fortschritt = tatsächliche Ausgabelänge. Die vier `source`-Zustände (`llm / fast / local / offline`) werden pro Runde ehrlich gekennzeichnet — lokale Fallbacks geben sich nie als Modell-Inferenz aus.
- **Überprüfbare Herkunft**: Ergebniskarten mit Dauer, Tokens, Ausführungskette und Quelle.
- **Mehr-Runden-Gedächtnis & Replay**: Rundenprotokoll, 2D-Timeline (Rückblick / Vergleich / neu abzweigen / JSON·CSV-Export), Entscheidungs-Trace.
- **Unterbrechung ist ein dritter Zustand**: „Generierung stoppen“ bricht den Backend-Stream tatsächlich ab. Unterbrochen ≠ fertig ≠ fehlgeschlagen; der bereits erzeugte Teiltext bleibt erhalten und wird ehrlich gekennzeichnet.
- **Tastatur-äquivalente Ansicht**: `[` `]` zum Auswählen, `Enter` zum Losfahren, `Tab` zum Gruppenwechsel — 3D ist nicht der einzige Bedienweg.
- **Eingebaute Experiment-Apparatur**: `?mode=opaque / transparent-nolink / decorative / no-fingerprint` schaltet die Kontrollgruppen A/B/B0/B1/B2/C.
- **MCP-Toolset**: `tools/cockpit_mcp_server.py` stellt das Cockpit als von Agenten aufrufbare Werkzeuge bereit.
- **MoE-Fingerprint-Ring** (Forschungszweig): Echte Expert-Routing-Signale als 3D-Ring kodiert (gleicher Prompt r=0.990, verschiedene Themen max=0.079) — so wird unterscheidbar, ob das Modell wirklich anders „denkt“.

## 🛡️ Ehrlichkeit als Designprinzip

Wir haben unseren eigenen Prototyp auditiert und festgestellt, dass die Zwischenschritte der alten Ausführungskette („Retrieval“, „Verifikation“) **Theater** waren, angetrieben von `sleep(0.09)` — der Balken bewegte sich, aber es geschah keine Arbeit. Audit, Laufzeit-Evidenz und der Weg zur Korrektur sind vollständig öffentlich in [docs/AUDIT.md](docs/AUDIT.md) und [docs/RUNTIME-AUDIT.md](docs/RUNTIME-AUDIT.md).

Das Laufzeit-Timing zeigte: Die `task_update`-Intervalle der alten Kette lagen gleichmäßig bei 90–100 ms ohne Streuung — der Fingerabdruck von sleep; in jenem Datensatz beanspruchte die Schein-Kadenz ~86 % der Gesamtdauer (Diagnosewert nur für diesen Datensatz). Nach dem Fix: Die Gleichmäßigkeit verschwand, Token-Streaming deckte 60–70 % der Ausführungszeit ab.

Daraus entstanden vier **Kriterien für substanziellen Fortschritt (P1–P4)** — als Prüftor vor jeder Entwicklung:

| Kriterium | Zu beantwortende Frage |
| --- | --- |
| **P1 Realität** | Hat sich Aufgabe/Artefakt wirklich verändert? |
| **P2 Überprüfbarkeit** | Kann der Nutzer es selbst verifizieren? |
| **P3 Zuordenbarkeit** | Welcher Schritt / wer hat es getan? |
| **P4 Wahrnehmbarkeit** | Ist es in der UI erkennbar? |

Unverhandelbare Grenzen: **keine erfundenen Fertig-Signale, keine erfundenen Daten, Unterbrechung wird nie als „fertig“ ausgegeben, lokaler Fallback nie als Modell, Kamera-Schieneninvariante (`camOffRail≈0`) bleibt unangetastet.**

![Live-Screenshot: Ergebniskarte mit Ausführungs-Herkunft](docs/assets/screenshot-result.png)

## 🚀 Schnellstart

**Voraussetzungen**: Python 3.10+; ein OpenAI-kompatibler LLM-Endpunkt (lokales llama.cpp / Ollama / Cloud-API). Das Frontend kommt ohne Build-Schritt aus.

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

**http://127.0.0.1:8770/** öffnen, eine Frage eingeben — los geht die Fahrt. Oder per Ein-Klick-Start:

```bash
python tools/open_cockpit.py
```

> 💡 Kein großes lokales Modell? Ein kleines Ollama-Modell (z. B. `gemma3:1b`) reicht, um die gesamte Interaktion auszuprobieren; die UI kennzeichnet Herkunft und Grenzen des Artefakts ehrlich. Der LLM-Endpunkt lässt sich auch **direkt in der UI** konfigurieren — ohne Neustart.

Details zu Umgebungsvariablen, Tastatur und Tests: [English README](README.en.md#-quick-start) und [prototype/README.md](prototype/README.md).

## 📚 Forschungsdokumentation

Deutsche Zusammenfassung: [docs/i18n/RESEARCH-SUMMARY.de.md](docs/i18n/RESEARCH-SUMMARY.de.md) · Glossar: [GLOSSARY](docs/i18n/GLOSSARY.md)

Kerndokumente: [PROBLEM](docs/PROBLEM.md) · [EVIDENCE](docs/EVIDENCE.md) · [AUDIT](docs/AUDIT.md) · [RUNTIME-AUDIT](docs/RUNTIME-AUDIT.md) · [SUBDISCIPLINES](docs/SUBDISCIPLINES.md) · [M-EXPERIMENT](docs/M-EXPERIMENT.md) · [M3-ACCEPTANCE](docs/M3-ACCEPTANCE.md)

*Die primären Forschungsdokumente sind auf Chinesisch verfasst. Übersetzungs-PRs sind sehr willkommen.*

## 🗺️ Roadmap

- [x] Ehrliche Ausführungskette (Theater entfernt)
- [x] P2-Überprüfbarkeitssystem (Herkunftsleiste / Vergleich / Timeline / Export)
- [x] Unterbrechung als dritter Zustand + Härtung des WS-Lifecycles
- [x] MoE-Fingerprint-Ring
- [x] M1-Experiment-Apparatur
- [ ] **M2 kontrollierte Studien mit Teilnehmenden** ← aktueller Fokus
- [ ] M0 Validierung durch lautes Denken
- [ ] M3 Abnahme-Checkliste ausfüllen
- [ ] Feldproblem-Fixes ([FIELD-ISSUES](docs/FIELD-ISSUES.md): Fahrt↔Ausführung-Kopplung, Kürzungskennzeichnung, Modellverfeinerung im Explorationsloop)
- [ ] Echte Tool-Chain-Segmente (Route A)

## 🤝 Mitwirken

PRs willkommen! Bitte zuerst [CONTRIBUTING.md](CONTRIBUTING.md) lesen — die Kernregel: **Jede Änderung muss beantworten, welches der Kriterien P1–P4 sie voranbringt.**

## 📄 Lizenz

[MIT](LICENSE) © 2026 showkeyjar

---

<div align="center">

**Das Auto darf cool sein. Aber jede erleuchtete Straße muss zu etwas führen, das wirklich passiert ist — und das der Nutzer überprüfen kann.**

</div>
