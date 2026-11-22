# Forschungszusammenfassung (Deutsch)

> Eine originalgetreue Übersicht des Forschungsframeworks. Die vollständigen Argumente stehen in den Primärdokumenten ([docs/PROBLEM.md](../PROBLEM.md) usw., auf Chinesisch).
> Andere Sprachen: [中文](RESEARCH-SUMMARY.zh.md) · [English](RESEARCH-SUMMARY.en.md) · [日本語](RESEARCH-SUMMARY.ja.md) · [Français](RESEARCH-SUMMARY.fr.md) · [Español](RESEARCH-SUMMARY.es.md)

## Forschungsfrage

Unter welchen Bedingungen nehmen Nutzer in einer Oberfläche, die Agentenarbeit als 3D-Cockpit darstellt, **substanziellen Fortschritt** wahr statt **formalen Fortschritt** (Bewegung ohne Veränderung)?

Ausgangspunkt ist echtes Nutzerfeedback: *„Die Oberfläche fühlt sich an, als gäbe es keinen substanziellen Fortschritt.“* Vier vorangegangene Iterationen (Kandidatenzahl, Vorschau-Flotte, Immersion/Stereo, semantisches Bucketing) landeten alle in der Präsentationsschicht; das fünfte Feedback sprang über die Präsentation hinaus in die Ausführungsschicht.

## Arbeitsdefinition: P1–P4

Substanzieller Fortschritt = die Oberfläche lässt den Nutzer wahrnehmen, dass *sich ein realer Aufgabenzustand von ihm durch die Arbeit des Agenten überprüfbar und nachvollziehbar verändert hat*. Vier Kriterien; fehlt eines, degradiert es zu formalem Fortschritt:

- **P1 Real** — die Veränderung betrifft die tatsächliche Aufgabe/das Artefakt;
- **P2 Überprüfbar** — der Nutzer kann die Veränderung selbst bestätigen;
- **P3 Zuordenbar** — der Nutzer erkennt, wer/welcher Schritt sie verursacht hat;
- **P4 Wahrnehmbar** — die Veränderung ist in der UI erkennbar.

## Kernbefund: Theater in der Mitte + reale Spitze

Das statische Audit (AUDIT.md) ergab: Die Zwischenschritte der alten Ausführungskette riefen das LLM nie auf — `prompt` war ein toter Parameter, Fortschritt wurde von `asyncio.sleep(0.09)` getrieben, Zwischenausgaben waren Templatesätze. Laufzeit-Evidenz (RUNTIME-AUDIT.md) fixierte es per WebSocket-Timing: `task_update`-Intervalle lagen gleichmäßig bei 90–100 ms ohne Streuung — der Fingerabdruck von sleep; in jenem Datensatz beanspruchte die Schein-Kadenz ~86 % der Gesamtdauer (Diagnosewert nur für diesen Datensatz). Nur der letzte `output`-Schritt war ein echter LLM-Aufruf.

Damit wurde die optimistische Hypothese „Fortschritt existiert, wird aber nicht gezeigt" falsifiziert: Das Problem ist zuerst P1/P3 (Realität und Zuordnung), erst dann P4 (Präsentation).

## Der Fix: Route B (ehrliches Downgrade)

Alle theatralischen Zwischenschritte wurden entfernt; die Ausführung konvergierte auf einen einzigen echten Streaming-LLM-Aufruf. Fortschritt = tatsächliche Ausgabelänge; die Zuordnungskette `["output"]` entspricht der Realität. Re-Test: Der Gleichmäßigkeits-Fingerabdruck verschwand; Token-Streaming deckte 60–70 % der Ausführungszeit ab.

**Grenze**: Route B repariert P1/P3, nicht automatisch P2 — bei Analyseaufgaben ohne Eingabedaten sind die vom Modell generierten konkreten Zahlen nicht nachrechenbar, P2 scheitert. Die UI muss „fehlende Eingabe" ehrlich anzeigen, statt Schlussfolgerungen zu erfinden.

## Disziplinäres Framework: bidirektionaler Bruch (broken link)

- Disziplin 1 (Vektorraum-Kontextvisualisierung): Echte semantische Strukturveränderung ließ einst keinen wahrnehmbaren Unterschied im Pfadraum;
- Disziplin 2 (3D-Pfraum-HCI): Reiche Präsentation hatte einst „Fortschritte" ohne reale Verschiebung.

Keine gegenseitige Bezeugung = bidirektionaler Bruch — die mechanistische Hypothese hinter „kein substanzieller Fortschritt" (Validierung durch Humanstudien ausstehend).

## Experimentplan

Die M1-Apparatur steht: A/B (opaque vs. transparente Ausführung), B0/B1 (3D-Kopplung, Einzelzuordnung), B2 (Fingerprint-Ring, Einzelvariable), C (dekorative Schein-Ausführung als Spiegelgruppe mit Debrief); drei Aufgabentypen (Entwurf / Analyse mit Daten / Analyse ohne Daten); Skalen s1–s7 + f1–f3. **M2-kontrollierte Humanstudien und M0 Think-Aloud stehen aus**; alle menschseitigen Kriterien bleiben unverifiziert bis Daten vorliegen — kein vorzeitiges Fertig-Statement.

## Evidenzdisziplin

Vier Stufen: statisches Code-Audit → Laufzeit-Evidenz → Proxy-Teilnehmer → echte Teilnehmer. Kleine Stichproben berichten nur Richtung, keine Signifikanzclaims; Proxy-Schlussfolgerungen werden herabgestuft und gekennzeichnet; entwicklerseitige Beobachtungen geben sich nie als nutzerseitige Schlussfolgerungen aus.
