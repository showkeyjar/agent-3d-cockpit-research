# Résumé de recherche (Français)

> Un aperçu fidèle du cadre de recherche. Les arguments complets figurent dans les documents primaires ([docs/PROBLEM.md](../PROBLEM.md) etc., en chinois).
> Autres langues : [中文](RESEARCH-SUMMARY.zh.md) · [English](RESEARCH-SUMMARY.en.md) · [日本語](RESEARCH-SUMMARY.ja.md) · [Deutsch](RESEARCH-SUMMARY.de.md) · [Español](RESEARCH-SUMMARY.es.md)

## Question de recherche

Dans une interface qui représente le travail d'un agent comme un cockpit 3D, à quelles conditions les utilisateurs perçoivent-ils un **progrès substantiel** plutôt qu'un **progrès formel** (du mouvement sans changement) ?

Le point de départ est un retour utilisateur réel : *« L'interface donne l'impression qu'il n'y a pas de progrès substantiel. »* Quatre itérations précédentes (nombre de candidats, flotte de prévisualisation, immersion/stéréo, regroupement sémantique) sont toutes restées dans la couche de présentation ; le cinquième retour a sauté au-delà de la présentation vers la couche d'exécution.

## Définition de travail : P1–P4

Progrès substantiel = l'interface permet à l'utilisateur de percevoir qu'*un état réel de sa tâche a changé, de manière vérifiable et traçable, grâce au travail de l'agent*. Quatre critères ; s'il en manque un, dégradation en progrès formel :

- **P1 Réel** — le changement concerne la tâche/l'artefact réel ;
- **P2 Vérifiable** — l'utilisateur peut confirmer le changement lui-même ;
- **P3 Attribuable** — l'utilisateur sait qui/quelle étape l'a causé ;
- **P4 Perceptible** — le changement est reconnaissable dans l'interface.

## Découverte clé : théâtre au milieu + queue réelle

L'audit statique (AUDIT.md) a montré que les étapes intermédiaires de l'ancienne chaîne n'appelaient jamais le LLM : `prompt` était un paramètre mort, la progression était pilotée par `asyncio.sleep(0.09)`, les sorties intermédiaires étaient des phrases templates. La preuve d'exécution (RUNTIME-AUDIT.md) l'a fixée par chronométrage WebSocket : intervalles `task_update` uniformément à 90–100 ms, dispersion nulle — l'empreinte de sleep ; dans cet enregistrement la fausse cadence occupait ~86 % de la durée totale (valeur diagnostique pour cet enregistrement seulement). Seule la dernière étape `output` était un vrai appel LLM.

Cela a falsifié l'hypothèse optimiste « le progrès existe mais n'est pas montré » : le problème est d'abord P1/P3 (réalité et attribution), ensuite seulement P4 (présentation).

## Le correctif : Route B (déclassement honnête)

Toutes les étapes intermédiaires théâtrales ont été supprimées ; l'exécution a convergé vers un seul appel LLM réel en streaming. Progression = longueur réelle de sortie ; la chaîne d'attribution `["output"]` correspond à la réalité. Re-test : l'empreinte de cadence uniforme a disparu ; le streaming de tokens couvrait 60–70 % du temps d'exécution.

**Limite** : la Route B répare P1/P3, pas automatiquement P2 — pour les tâches d'analyse sans données d'entrée, les chiffres concrets générés par le modèle ne sont pas recalculables, P2 échoue. L'interface doit présenter honnêtement « entrée manquante » au lieu de fabriquer des conclusions.

## Cadre disciplinaire : rupture de lien bidirectionnelle

- Discipline 1 (visualisation du contexte en espace vectoriel) : un vrai changement de structure sémantique ne laissait autrefois aucune différence perceptible dans l'espace de chemin ;
- Discipline 2 (IHM espace de chemin 3D) : une présentation riche avait autrefois des « avances » sans déplacement réel.

Aucune attestation mutuelle = rupture bidirectionnelle — l'hypothèse mécaniste derrière « pas de progrès substantiel » (validation par études humaines en attente).

## Plan d'expérimentation

L'appareil M1 est prêt : A/B (exécution opaque vs transparente), B0/B1 (couplage 3D, attribution unique), B2 (anneau d'empreinte, variable unique), C (fausse exécution décorative en groupe miroir avec debrief) ; trois types de tâches (rédaction / analyse avec données / analyse sans données) ; échelles s1–s7 + f1–f3. **Les études humaines contrôlées M2 et la réflexion à voix haute M0 sont en attente** ; tous les critères côté humain restent non vérifiés jusqu'à l'arrivée des données — aucune déclaration de complétion prématurée.

## Discipline de preuve

Quatre niveaux : audit statique du code → preuve d'exécution → participants proxy → participants réels. Les petits échantillons ne rapportent que la direction, sans affirmation de significativité ; les conclusions des participants proxy sont déclassées et étiquetées ; les observations côté développeur ne se font jamais passer pour des conclusions côté utilisateur.
