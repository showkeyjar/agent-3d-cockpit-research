# Resumen de investigación (Español)

> Un resumen fiel del marco de investigación. Los argumentos completos están en los documentos primarios ([docs/PROBLEM.md](../PROBLEM.md) etc., en chino).
> Otros idiomas: [中文](RESEARCH-SUMMARY.zh.md) · [English](RESEARCH-SUMMARY.en.md) · [日本語](RESEARCH-SUMMARY.ja.md) · [Deutsch](RESEARCH-SUMMARY.de.md) · [Français](RESEARCH-SUMMARY.fr.md)

## Pregunta de investigación

En una interfaz que representa el trabajo de un agente como una cabina 3D, ¿bajo qué condiciones los usuarios perciben **progreso sustantivo** en lugar de **progreso formal** (movimiento sin cambio)?

El punto de partida es un comentario real de usuario: *«La interfaz da la sensación de que no hay progreso sustantivo.»* Cuatro iteraciones previas (número de candidatos, flota de previsualización, inmersión/estéreo, agrupamiento semántico) quedaron todas en la capa de presentación; el quinto comentario saltó más allá de la presentación hacia la capa de ejecución.

## Definición de trabajo: P1–P4

Progreso sustantivo = la interfaz permite al usuario percibir que *un estado real de su tarea ha cambiado, de forma verificable y trazable, gracias al trabajo del agente*. Cuatro criterios; si falta uno, degrada a progreso formal:

- **P1 Real** — el cambio ocurre en la tarea/artefacto real;
- **P2 Verificable** — el usuario puede confirmar el cambio por sí mismo;
- **P3 Atribuible** — el usuario sabe quién/qué paso lo causó;
- **P4 Perceptible** — el cambio es reconocible en la interfaz.

## Hallazgo clave: teatro en el medio + cola real

La auditoría estática (AUDIT.md) mostró que los pasos intermedios de la cadena antigua nunca llamaban al LLM: `prompt` era un parámetro muerto, el progreso era impulsado por `asyncio.sleep(0.09)`, las salidas intermedias eran frases plantilla. La evidencia en tiempo de ejecución (RUNTIME-AUDIT.md) lo fijó con cronometraje WebSocket: intervalos `task_update` uniformes a 90–100 ms, dispersión cero — la huella de sleep; en ese registro la cadencia falsa ocupó ~86 % de la duración total (valor diagnóstico solo para ese registro). Solo el último paso `output` era una llamada LLM real.

Esto falsó la hipótesis optimista «el progreso existe pero no se muestra»: el problema es primero P1/P3 (realidad y atribución), y solo después P4 (presentación).

## La corrección: Ruta B (degradación honesta)

Se eliminaron todos los pasos intermedios teatrales; la ejecución convergió a una única llamada LLM real en streaming. Progreso = longitud real de salida; la cadena de atribución `["output"]` coincide con la realidad. Re-test: la huella de cadencia uniforme desapareció; el streaming de tokens cubrió 60–70 % del tiempo de ejecución.

**Límite**: la Ruta B repara P1/P3, no automáticamente P2 — para tareas de análisis sin datos de entrada, los números concretos que genera el modelo no son recalculables, P2 falla. La interfaz debe presentar honestamente «falta entrada» en lugar de fabricar conclusiones.

## Marco disciplinario: ruptura de enlace bidireccional

- Disciplina 1 (visualización de contexto en espacio vectorial): un cambio real de estructura semántica antes no dejaba ninguna diferencia perceptible en el espacio de caminos;
- Disciplina 2 (HCI de espacio de caminos 3D): una presentación rica antes tenía «avances» sin desplazamiento real.

Sin atestiguación mutua = ruptura bidireccional — la hipótesis mecanicista detrás de «no hay progreso sustantivo» (validación con estudios humanos pendiente).

## Plan experimental

El aparato M1 está listo: A/B (ejecución opaca vs transparente), B0/B1 (acoplamiento 3D, atribución única), B2 (anillo de huella, variable única), C (falsa ejecución decorativa como grupo espejo con debrief); tres tipos de tarea (redacción / análisis con datos / análisis sin datos); escalas s1–s7 + f1–f3. **Los estudios humanos controlados M2 y el pensamiento en voz alta M0 están pendientes**; todos los criterios del lado humano permanecen sin verificar hasta que lleguen los datos — nada de declarar completitud prematura.

## Disciplina de evidencia

Cuatro niveles: auditoría estática de código → evidencia en tiempo de ejecución → participantes proxy → participantes reales. Las muestras pequeñas solo reportan dirección, sin afirmaciones de significancia; las conclusiones de participantes proxy se degradan y etiquetan; las observaciones del lado desarrollador nunca se hacen pasar por conclusiones del lado usuario.
