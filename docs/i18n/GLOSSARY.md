# Terminology Glossary / 术语对照表

> Canonical translations for project terms across all README languages and `docs/i18n/` summaries.
> When translating or editing any language version, use these terms consistently. Code identifiers
> (`source`, `llm/fast/local/offline`, `?mode=…`, `camOffRail`, file names) are **never translated**.
>
> 本表是全仓库多语言文档的术语基准。翻译或修订任何语言版本时以此为准；代码标识符一律不翻译。

| Canonical (EN) | 简体中文 | 日本語 | Deutsch | Français | Español |
| --- | --- | --- | --- | --- | --- |
| cockpit | 驾驶舱 | コックピット | Cockpit | cockpit | cabina |
| road sign (candidate) | 路牌 | 道しるべ | Wegweiser | panneau | letrero |
| fork | 岔路 / 分岔 | 分岐 | Abzweigung | bifurcation | bifurcación |
| arrival sign | 到达牌 | 到達パネル | Ankunftsschild | panneau d'arrivée | letrero de llegada |
| result card | 结果卡 | 結果カード | Ergebniskarte | carte de résultat | tarjeta de resultado |
| driving | 行驶 | 走行 | Fahrt | conduite | conducción |
| trajectory (traveled) | 轨迹 | 走行軌跡 | zurückgelegte Strecke | trajectoire parcourue | trayectoria recorrida |
| rear-view (history) | 后视镜 | バックミラー | Rückspiegel | rétroviseur | retrovisor |
| re-fork | 分叉重走 | 再分岐 | neu abzweigen | re-bifurquer | volver a bifurcar |
| forecast / forecaster | 推演 / 推演器 | 展望 / 展望器 | Vorausschau | prévision | previsión |
| divergence | 分歧度 | 分歧度 | Divergenz | divergence | divergencia |
| semantic bucketing | 语义分桶 | セマンティック・バケット化 | semantisches Bucketing | regroupement sémantique | agrupamiento semántico |
| synonym-cluster folding | 同义簇折叠 | 同義クラスタの折りたたみ | Synonym-Cluster-Faltung | fusion des clusters de synonymes | plegado de clústeres de sinónimos |
| farthest-point backfill | 最远回填 | 最遠点バックフィル | Farthest-Point-Backfill | remplissage par point le plus éloigné | relleno por punto más lejano |
| execution chain | 执行链 | 実行チェーン | Ausführungskette | chaîne d'exécution | cadena de ejecución |
| streaming | 流式 | ストリーミング | Streaming | streaming | streaming |
| provenance | 凭据 / 来源 | 出所 | Herkunft | provenance | procedencia |
| source badge (`llm/fast/local/offline`) | 来源标注 | 出所ラベル | Herkunftslabel | étiquette de provenance | etiqueta de procedencia |
| local fallback | 本地兜底 | ローカルフォールバック | lokaler Fallback | solution de repli locale | fallback local |
| theater (fake steps) | 剧场 | 劇場 | Theater | théâtre | teatro |
| substantive progress | 实质进展 | 実質的な進捗 | substanzieller Fortschritt | progrès substantiel | progreso sustantivo |
| formal progress | 形式进展 | 形式的な進捗 | formaler Fortschritt | progrès formel | progreso formal |
| P1 Real | P1 真实性 | P1 真実性 | P1 Realität | P1 Réalité | P1 Realidad |
| P2 Verifiable | P2 可核对 | P2 検証可能性 | P2 Überprüfbarkeit | P2 Vérifiabilité | P2 Verificabilidad |
| P3 Attributable | P3 可追溯 | P3 追跡可能性 | P3 Zuordenbarkeit | P3 Attribuabilité | P3 Atribuibilidad |
| P4 Perceivable | P4 可感知 | P4 知覚可能性 | P4 Wahrnehmbarkeit | P4 Perceptibilité | P4 Perceptibilidad |
| interruption (third state) | 中断（第三态） | 中断（第3の状態） | Unterbrechung (dritter Zustand) | interruption (troisième état) | interrupción (tercer estado) |
| per-round ledger | 逐轮账本 | ラウンドごとの台帳 | Rundenprotokoll | registre par tour | registro por ronda |
| timeline | 时间线 | タイムライン | Timeline | chronologie | línea de tiempo |
| decision trace chain | 决策溯源链 | 決定トレースチェーン | Entscheidungs-Trace | chaîne de traçabilité des décisions | cadena de trazabilidad de decisiones |
| bidirectional broken link | 双向断链 | 双方向の断絶 | bidirektionaler Bruch | rupture de lien bidirectionnelle | ruptura de enlace bidireccional |
| honest downgrade (Route B) | 诚实降级（路线 B） | 正直なダウングレード（ルートB） | ehrliches Downgrade (Route B) | déclassement honnête (Route B) | degradación honesta (Ruta B) |
| MoE fingerprint ring | MoE 指纹环 | MoEフィンガープリント・リング | MoE-Fingerprint-Ring | anneau d'empreinte MoE | anillo de huella MoE |
| think-aloud | 出声思维 | 発話思考法 | lautes Denken | réflexion à voix haute | pensamiento en voz alta |
| proxy participants | 代理被试 | 代理被験者 | Proxy-Teilnehmende | participants proxy | participantes proxy |
| red lines (engineering) | 工程红线 | エンジニアリング・レッドライン | unverhandelbare Grenzen | lignes rouges d'ingénierie | líneas rojas de ingeniería |
| acceptance checklist | 验收清单 | 受け入れチェックリスト | Abnahme-Checkliste | liste d'acceptation | lista de aceptación |

## Style rules / 文风约定

1. **Honesty caveats are load-bearing** — never soften or drop them in translation (e.g. "local fallback never impersonates the model", "~86% is a diagnostic figure for that record only").
   诚实性限定语在翻译中不得弱化或删除。
2. Keep the driving metaphor consistent: a *sign* is read, a *fork* is chosen, a *drive* happens, an *arrival* is verified. Do not mix vehicle metaphors (no "flight", no "train").
   驾驶隐喻保持一致：读路牌、选岔路、行驶、到达核对；不混用其他交通工具隐喻。
3. `P1–P4` labels stay as short nouns in tables (Real / Verifiable / …), matching this glossary's row forms.
   表格中 P1–P4 用名词短形式，与本表一致。
4. Numbers, version tags, URLs, and statistical values (r=0.990, max=0.079, 90–100 ms, ~86%, 60–70%) are identical across languages.
   数字、版本号、URL、统计值各语言完全一致。
5. Language switcher order is fixed: 简体中文 · English · 日本語 · Deutsch · Français · Español.
   语言切换栏顺序固定。
