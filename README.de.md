<div align="center">

# 🚗 Agent 3D Cockpit

**KI-Agenten-Zusammenarbeit: vom Lesen von Antworten zum Fahren einer Reise.**

[![Version](https://img.shields.io/badge/prototype-v0.9.49.2-5ee0ff)](prototype/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-34f5a0)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md)

![Live-Aufnahme: Eine Frage lässt Kandidaten-Wegweiser aufleuchten](docs/assets/demo-forecast.gif)

*▲ Echte Laufzeit-Aufnahme: Frage eingeben → latentes Pfadgerüst erscheint → die Vorausschau leuchtet fünf Kandidaten-Wegweiser auf. Das Ausführungs-Backend ist ein lokales Modell; die Herkunft der Vorausschau wird in der UI ehrlich gekennzeichnet.*

</div>

---

## Was ist das?

**Agent 3D Cockpit** ist ein lauffähiger Forschungsprototyp plus ein interdisziplinäres Forschungsframework. Die zentrale Frage:

> Wenn ein KI-Agent für dich arbeitet — wie kannst du **Richtungen sehen, Entscheidungen treffen, Fortschritt überprüfen und Verlauf nachvollziehen**, statt auf einen Fortschrittsbalken zu starren und zu raten, was er eigentlich tut?

Die Zusammenarbeit wird auf eine 3D-Fahrt abgebildet:

| Frage der Zusammenarbeit | Ausdruck im Cockpit | Deine Fähigkeit |
| --- | --- | --- |
| Was könnte als Nächstes passieren? | **Wegweiser & Abzweigungen** voraus | Richtungen vor dem Losfahren vergleichen |
| Worin unterscheiden sich Optionen? | Straßenform, räumliche Anordnung, Vergleichspanel | Entscheidungen verstehen statt blind „weiter" klicken |
| Wo stehen wir gerade? | **Fahrt + streamende Token-Ausgabe** | Echten Ausführungssignalen folgen |
| Was hat dieser Schritt produziert? | **Ankunftschild + Ergebniskarte** (Dauer/Tokens/Herkunft) | Artefakt öffnen und prüfen, nicht nur ein „Fertig"-Badge |
| Warum sind wir hier? | Fahrspur, 2D-Timeline, Entscheidungskette | Rückblick, Vergleich, Neu-Abzweigung von jedem Knoten |

![Live-Screenshot: fünf Kandidaten-Wegweiser](docs/assets/screenshot-fork.png)

## ✨ Funktionen

- **Vorausschau-gesteuerte Straßen**: Das Backend sampelt Kandidatenrichtungen und berechnet Divergenz — geringe Divergenz ergibt eine gerade Straße, hohe ergibt Abzweigungen. Die Straßenform *ist* die Visualisierung semantischer Struktur, keine Dekoration.
- **Semantisches Bucketing**: Synonym-Cluster-Faltung + Farthest-Point-Backfill garantiert, dass fünf Schilder fünf wirklich verschiedene Richtungen sind.
- **Ehrliche Ausführungskette**: Ein einzelner echter Streaming-LLM-Aufruf; Fortschritt = tatsächliche Ausgabelänge. Vier Zustände (`llm / fast / local / offline`) werden pro Runde ehrlich gekennzeichnet — lokale Fallbacks geben sich nie als Modell-Inferenz aus.
- **Überprüfbare Herkunft**: Ergebniskarten mit Dauer, Tokens, Ausführungskette und Quelle.
- **Mehr-Runden-Gedächtnis & Replay**: Runden-Ledger, 2D-Timeline (Rückblick / Vergleich / Neu-Abzweigung / JSON·CSV-Export), Entscheidungs-Trace.
- **Unterbrechung ist ein dritter Zustand**: „Generierung stoppen" bricht den Backend-Stream wirklich ab. Unterbrochen ≠ fertig ≠ fehlgeschlagen; Teiltext bleibt erhalten und wird ehrlich gekennzeichnet.
- **Tastatur-äquivalente Ansicht**: `[` `]` wählen, `Enter` losfahren, `Tab` Gruppen wechseln.
- **Eingebaute Experiment-Apparatur**: `?mode=opaque / transparent-nolink / decorative / no-fingerprint` schaltet A/B/B0/B1/B2/C-Kontrollgruppen.
- **MCP-Toolset**: `tools/cockpit_mcp_server.py` stellt das Cockpit als agenten-aufrufbare Tools bereit.
- **MoE-Fingerprint-Ring** (Forschungszweig): Echte Expert-Routing-Signale als 3D-Ring (gleicher Prompt r=0.990, verschiedene Themen max=0.079).

## 🛡️ Ehrlichkeit als Designprinzip

Wir haben unseren eigenen Prototyp auditiert und festgestellt, dass die Zwischenschritte der alten Ausführungskette („Retrieval", „Verifikation") **Theater** waren, angetrieben von `sleep(0.09)` — der Balken bewegte sich, Arbeit geschah nicht. Audit, Laufzeit-Evidenz und Fix sind vollständig öffentlich in [docs/AUDIT.md](docs/AUDIT.md) und [docs/RUNTIME-AUDIT.md](docs/RUNTIME-AUDIT.md).

Daraus entstanden vier **Kriterien für substantiellen Fortschritt (P1–P4)** als Gate vor jeder Entwicklung:

| Kriterium | Muss beantworten |
| --- | --- |
| **P1 Real** | Hat sich Aufgabe/Artefakt wirklich verändert? |
| **P2 Überprüfbar** | Kann der Nutzer es selbst verifizieren? |
| **P3 Zuordenbar** | Welcher Schritt / wer hat es getan? |
| **P4 Wahrnehmbar** | Ist es in der UI erkennbar? |

Engineering-rote-Linien: **keine erfundenen Fertig-Signale, keine erfundenen Daten, Unterbrechung gibt sich nie als Fertig aus, lokaler Fallback nie als Modell.**

## 🚀 Schnellstart

**Voraussetzungen**: Python 3.10+; ein OpenAI-kompatibler LLM-Endpunkt (lokales llama.cpp / Ollama / Cloud-API). Frontend ohne Build-Schritt.

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

**http://127.0.0.1:8770/** öffnen und eine Frage eingeben. Oder Ein-Klick-Start:

```bash
python tools/open_cockpit.py
```

> 💡 Kein großes lokales Modell? Ein kleines Ollama-Modell (z. B. `gemma3:1b`) reicht für die volle Interaktion; die UI kennzeichnet Herkunft und Grenzen ehrlich. Der LLM-Endpunkt lässt sich auch **direkt in der UI** konfigurieren (ohne Neustart).

Details zu Umgebungsvariablen, Tastatur und Tests: [English README](README.en.md#-quick-start) und [prototype/README.md](prototype/README.md).

## 📚 Forschungsdokumentation

Deutsche Zusammenfassung: [docs/i18n/RESEARCH-SUMMARY.de.md](docs/i18n/RESEARCH-SUMMARY.de.md)

Kerndokumente: [PROBLEM](docs/PROBLEM.md) · [EVIDENCE](docs/EVIDENCE.md) · [AUDIT](docs/AUDIT.md) · [RUNTIME-AUDIT](docs/RUNTIME-AUDIT.md) · [SUBDISCIPLINES](docs/SUBDISCIPLINES.md) · [M-EXPERIMENT](docs/M-EXPERIMENT.md) · [M3-ACCEPTANCE](docs/M3-ACCEPTANCE.md)

*Die primären Forschungsdokumente sind auf Chinesisch verfasst. Übersetzungs-PRs sind sehr willkommen.*

## 🗺️ Roadmap

- [x] Ehrliche Ausführungskette (Theater entfernt)
- [x] P2-Überprüfbarkeitssystem
- [x] Unterbrechungs-Drittzustand + WS-Lifecycle-Härtung
- [x] MoE-Fingerprint-Ring
- [x] M1-Experiment-Apparatur
- [ ] **M2 kontrollierte Humanstudien** ← aktueller Fokus
- [ ] M0 Think-Aloud-Validierung
- [ ] M3 Acceptance-Checkliste
- [ ] Echte Tool-Chain-Segmente (Route A)

## 🤝 Mitwirken

PRs willkommen! Bitte zuerst [CONTRIBUTING.md](CONTRIBUTING.md) lesen — Kernregel: **Jede Änderung muss beantworten, welches der P1–P4 sie voranbringt.**

## 📄 Lizenz

[MIT](LICENSE) © 2026 showkeyjar

---

<div align="center">

**Das Auto darf cool sein. Aber jede erleuchtete Straße muss zu etwas führen, das wirklich passiert ist — und das der Nutzer überprüfen kann.**

</div>
