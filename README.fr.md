<div align="center">

# 🚗 Agent 3D Cockpit

**Collaborer avec un agent IA : passer de la lecture de réponses à la conduite d'un voyage.**

[![Version](https://img.shields.io/badge/prototype-v0.9.49.3-5ee0ff)](prototype/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-34f5a0)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md)

![Capture réelle : une question illumine des panneaux candidats](docs/assets/demo-forecast.gif)

*▲ Capture d'exécution réelle : saisissez une question → le squelette de chemins latents apparaît → à l'arrivée de la prévision, cinq panneaux candidats s'illuminent. Le backend d'exécution est un modèle local ; la provenance de la prévision est honnêtement indiquée dans l'interface.*

</div>

---

## Qu'est-ce que c'est ?

**Agent 3D Cockpit** est un prototype de recherche fonctionnel, accompagné d'un cadre de recherche interdisciplinaire. La question centrale :

> Quand un agent IA travaille pour vous, comment **voir les directions, faire des choix, vérifier le progrès et retracer l'historique** — au lieu de fixer une barre de progression en vous demandant « mais que fait-il, au juste ? »

La collaboration est représentée comme une conduite en 3D :

| Question de collaboration | Représentation dans le cockpit | Ce que vous pouvez faire |
| --- | --- | --- |
| Que peut-il se passer ensuite ? | **Panneaux et bifurcations** devant vous | Comparer les directions avant de partir |
| En quoi les options diffèrent-elles ? | Forme de la route, disposition spatiale, panneau de comparaison | Comprendre les choix au lieu de cliquer « continuer » à l'aveugle |
| Où en sommes-nous ? | **Conduite + sortie des tokens en streaming** | Suivre les vrais signaux d'exécution |
| Qu'a produit cette étape ? | **Panneau d'arrivée + carte de résultat** (durée / tokens / provenance) | Ouvrir et vérifier l'artefact, pas seulement un badge « terminé » |
| Pourquoi sommes-nous ici ? | Trajectoire parcourue, chronologie 2D, chaîne de traçabilité des décisions | Revenir en arrière, comparer, re-bifurquer depuis n'importe quel nœud |

![Capture réelle : cinq panneaux candidats](docs/assets/screenshot-fork.png)

## ✨ Fonctionnalités

- **Routes guidées par la prévision** : le backend échantillonne des directions candidates et calcule la divergence — faible divergence = route droite, forte divergence = bifurcations. La forme de la route *est* la visualisation de la structure sémantique, pas une décoration.
- **Regroupement sémantique** : fusion des clusters de synonymes + remplissage par le point le plus éloigné — cinq panneaux correspondent à cinq directions réellement différentes.
- **Chaîne d'exécution honnête** : un seul appel LLM réel, en streaming ; la progression = la longueur réelle de la sortie. Les quatre états `source` (`llm / fast / local / offline`) sont indiqués honnêtement à chaque tour — les solutions de repli locales ne se font jamais passer pour une inférence du modèle.
- **Provenance vérifiable** : les cartes de résultat affichent durée, tokens, chaîne d'exécution et source.
- **Mémoire multi-tours et relecture** : registre par tour, chronologie 2D (relecture / comparaison / re-bifurcation / export JSON·CSV), chaîne de traçabilité des décisions.
- **L'interruption est un troisième état** : « Arrêter la génération » interrompt réellement le flux du backend. Interrompu ≠ terminé ≠ échoué ; le texte partiel déjà produit est conservé et honnêtement étiqueté.
- **Vue équivalente au clavier** : `[` `]` pour sélectionner, `Entrée` pour partir, `Tab` pour changer de groupe — la 3D n'est pas le seul mode de pilotage.
- **Dispositif expérimental intégré** : `?mode=opaque / transparent-nolink / decorative / no-fingerprint` active les groupes de contrôle A/B/B0/B1/B2/C.
- **Boîte à outils MCP** : `tools/cockpit_mcp_server.py` expose le cockpit comme des outils appelables par un agent.
- **Anneau d'empreinte MoE** (axe de recherche) : les signaux réels de routage des experts sont encodés dans un anneau 3D (même prompt r=0.990, sujets différents max=0.079) — de quoi distinguer si le modèle a vraiment changé d'approche.

## 🛡️ L'honnêteté comme principe de conception

Nous avons audité notre propre prototype et découvert que les étapes intermédiaires de l'ancienne chaîne (« recherche », « vérification ») étaient du **théâtre** piloté par `sleep(0.09)` — la barre avançait, mais aucun travail n'avait lieu. L'audit, les preuves d'exécution et le chemin vers le correctif sont entièrement publics dans [docs/AUDIT.md](docs/AUDIT.md) et [docs/RUNTIME-AUDIT.md](docs/RUNTIME-AUDIT.md).

Le chronométrage d'exécution a montré que les intervalles `task_update` de l'ancienne chaîne se situaient uniformément à 90–100 ms, sans dispersion — l'empreinte de sleep ; dans cet enregistrement, la fausse cadence occupait ~86 % de la durée totale (valeur diagnostique pour cet enregistrement seulement). Après le correctif : la cadence uniforme a disparu et le streaming de tokens couvrait 60–70 % du temps d'exécution.

Il en est né quatre **critères de progrès substantiel (P1–P4)**, qui servent de point de passage obligé avant tout développement :

| Critère | Question à laquelle il faut répondre |
| --- | --- |
| **P1 Réalité** | La tâche / l'artefact a-t-il vraiment changé ? |
| **P2 Vérifiabilité** | L'utilisateur peut-il le vérifier lui-même ? |
| **P3 Attribuabilité** | Quelle étape / qui l'a fait ? |
| **P4 Perceptibilité** | Est-ce reconnaissable dans l'interface ? |

Lignes rouges d'ingénierie : **aucun signal de complétion inventé, aucune donnée inventée, l'interruption n'est jamais présentée comme une complétion, le repli local jamais comme le modèle, l'invariant de caméra sur rail (`camOffRail≈0`) reste intact.**

![Capture réelle : carte de résultat avec provenance d'exécution](docs/assets/screenshot-result.png)

## 🚀 Démarrage rapide

**Prérequis** : Python 3.10+ ; un endpoint LLM compatible OpenAI (llama.cpp local / Ollama / API cloud). Le frontend ne nécessite aucun build.

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

Ouvrez **http://127.0.0.1:8770/**, saisissez une question — et c'est parti. Ou en un clic :

```bash
python tools/open_cockpit.py
```

> 💡 Pas de gros modèle local ? Un petit modèle Ollama (p. ex. `gemma3:1b`) suffit pour découvrir toute l'interaction ; l'interface indique honnêtement la provenance et les limites de l'artefact. L'endpoint LLM se configure aussi **directement dans l'interface**, sans redémarrage.

Détails (variables d'environnement, clavier, tests) : [README English](README.en.md#-quick-start) et [prototype/README.md](prototype/README.md).

## 📚 Documentation de recherche

Résumé en français : [docs/i18n/RESEARCH-SUMMARY.fr.md](docs/i18n/RESEARCH-SUMMARY.fr.md) · Glossaire : [GLOSSARY](docs/i18n/GLOSSARY.md)

Documents clés : [PROBLEM](docs/PROBLEM.md) · [EVIDENCE](docs/EVIDENCE.md) · [AUDIT](docs/AUDIT.md) · [RUNTIME-AUDIT](docs/RUNTIME-AUDIT.md) · [SUBDISCIPLINES](docs/SUBDISCIPLINES.md) · [M-EXPERIMENT](docs/M-EXPERIMENT.md) · [M3-ACCEPTANCE](docs/M3-ACCEPTANCE.md)

*Les documents de recherche primaires sont rédigés en chinois. Les PR de traduction sont les bienvenues.*

## 🗺️ Feuille de route

- [x] Chaîne d'exécution honnête (théâtre supprimé)
- [x] Système de vérifiabilité P2 (barre de provenance / comparaison / chronologie / export)
- [x] Interruption comme troisième état + durcissement du cycle de vie WS
- [x] Anneau d'empreinte MoE
- [x] Dispositif expérimental M1
- [ ] **M2 : études contrôlées avec participants** ← priorité actuelle
- [ ] M0 : validation par réflexion à voix haute
- [ ] M3 : remplir la liste d'acceptation
- [ ] Correctifs des problèmes de terrain ([FIELD-ISSUES](docs/FIELD-ISSUES.md) : liaison conduite↔exécution, étiquetage des troncatures, affinage par modèle dans la boucle d'exploration)
- [ ] Segments de chaîne d'outils réels (Route A)

## 🤝 Contribuer

Les PR sont bienvenues ! Lisez d'abord [CONTRIBUTING.md](CONTRIBUTING.md) — la règle centrale : **chaque changement doit répondre à la question « lequel des critères P1–P4 fait-il avancer ? »**

## 📄 Licence

[MIT](LICENSE) © 2026 showkeyjar

---

<div align="center">

**La voiture a le droit d'être cool. Mais chaque route illuminée doit mener à quelque chose qui s'est réellement passé — et que l'utilisateur peut vérifier.**

</div>
