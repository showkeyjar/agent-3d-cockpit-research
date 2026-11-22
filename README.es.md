<div align="center">

# 🚗 Agent 3D Cockpit

**Colaborar con agentes de IA: pasar de leer respuestas a conducir un viaje.**

[![Version](https://img.shields.io/badge/prototype-v0.9.49.5-5ee0ff)](prototype/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-34f5a0)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español**

![Captura real: una pregunta ilumina letreros candidatos](docs/assets/demo-forecast.gif)

*▲ Captura de ejecución real: escribe una pregunta → aparece el esqueleto de caminos latentes → al llegar la previsión, se iluminan cinco letreros candidatos. El backend de ejecución es un modelo local; la procedencia de la previsión se indica honestamente en la interfaz.*

</div>

---

## ¿Qué es esto?

**Agent 3D Cockpit** es un prototipo de investigación funcional, acompañado de un marco de investigación interdisciplinario. La pregunta central:

> Cuando un agente de IA trabaja por ti, ¿cómo puedes **ver las direcciones, tomar decisiones, verificar el progreso y repasar el historial** — en lugar de mirar una barra de progreso preguntándote «pero ¿qué está haciendo exactamente?»?

La colaboración se representa como una conducción en 3D:

| Pregunta de colaboración | Representación en la cabina | Lo que puedes hacer |
| --- | --- | --- |
| ¿Qué podría pasar después? | **Letreros y bifurcaciones** por delante | Comparar direcciones antes de salir |
| ¿En qué se diferencian las opciones? | Forma de la carretera, disposición espacial, panel de comparación | Entender las opciones en vez de pulsar «continuar» a ciegas |
| ¿Dónde estamos ahora? | **Conducción + salida de tokens en streaming** | Seguir las señales reales de ejecución |
| ¿Qué produjo este paso? | **Letrero de llegada + tarjeta de resultado** (duración / tokens / procedencia) | Abrir y verificar el artefacto, no solo ver una insignia de «hecho» |
| ¿Por qué estamos aquí? | Trayectoria recorrida, línea de tiempo 2D, cadena de trazabilidad de decisiones | Repasar, comparar y volver a bifurcar desde cualquier nodo |

![Captura real: cinco letreros candidatos](docs/assets/screenshot-fork.png)

## ✨ Características

- **Carreteras guiadas por la previsión**: el backend muestrea direcciones candidatas y calcula la divergencia — poca divergencia = carretera recta, mucha = bifurcaciones. La forma de la carretera *es* la visualización de la estructura semántica, no un adorno.
- **Agrupamiento semántico**: plegado de clústeres de sinónimos + relleno por el punto más lejano — cinco letreros corresponden a cinco direcciones realmente distintas.
- **Cadena de ejecución honesta**: una única llamada LLM real, en streaming; el progreso = la longitud real de la salida. Los cuatro estados de `source` (`llm / fast / local / offline`) se indican honestamente en cada ronda — los fallbacks locales nunca se hacen pasar por inferencia del modelo.
- **Procedencia verificable**: las tarjetas de resultado muestran duración, tokens, cadena de ejecución y fuente.
- **Memoria multirronda y reproducción**: registro por ronda, línea de tiempo 2D (repaso / comparación / nueva bifurcación / exportación JSON·CSV), cadena de trazabilidad de decisiones.
- **La interrupción es un tercer estado**: «Detener generación» aborta de verdad el stream del backend. Interrumpido ≠ completado ≠ fallido; el texto parcial ya generado se conserva y se etiqueta honestamente.
- **Vista equivalente por teclado**: `[` `]` para seleccionar, `Enter` para salir, `Tab` para cambiar de grupo — el 3D no es la única vía de control.
- **Aparato experimental integrado**: `?mode=opaque / transparent-nolink / decorative / no-fingerprint` activa los grupos de control A/B/B0/B1/B2/C.
- **Kit de herramientas MCP**: `tools/cockpit_mcp_server.py` expone la cabina como herramientas que un agente puede invocar.
- **Anillo de huella MoE** (línea de investigación): las señales reales de enrutamiento de expertos se codifican en un anillo 3D (mismo prompt r=0.990, temas distintos max=0.079) — permite distinguir si el modelo realmente cambió de enfoque.

## 🛡️ La honestidad como principio de diseño

Auditamos nuestro propio prototipo y descubrimos que los pasos intermedios de la cadena antigua («recuperación», «verificación») eran **teatro** impulsado por `sleep(0.09)` — la barra avanzaba, pero no ocurría ningún trabajo. La auditoría, la evidencia en tiempo de ejecución y el camino hacia la corrección son totalmente públicos en [docs/AUDIT.md](docs/AUDIT.md) y [docs/RUNTIME-AUDIT.md](docs/RUNTIME-AUDIT.md).

El cronometraje en tiempo de ejecución mostró que los intervalos `task_update` de la cadena antigua se situaban uniformemente en 90–100 ms, sin dispersión — la huella de sleep; en ese registro, la cadencia falsa ocupó ~86 % de la duración total (valor diagnóstico solo para ese registro). Tras la corrección: la cadencia uniforme desapareció y el streaming de tokens cubrió 60–70 % del tiempo de ejecución.

De ahí surgieron cuatro **criterios de progreso sustantivo (P1–P4)**, como puerta obligatoria antes de cualquier desarrollo:

| Criterio | Pregunta que debe responder |
| --- | --- |
| **P1 Realidad** | ¿La tarea / el artefacto cambió de verdad? |
| **P2 Verificabilidad** | ¿Puede el usuario verificarlo por sí mismo? |
| **P3 Atribuibilidad** | ¿Qué paso / quién lo hizo? |
| **P4 Perceptibilidad** | ¿Es reconocible en la interfaz? |

Líneas rojas de ingeniería: **nada de señales de finalización inventadas, nada de datos inventados, la interrupción nunca se presenta como finalización, el fallback local nunca como el modelo, el invariante de cámara sobre el riel (`camOffRail≈0`) permanece intacto.**

![Captura real: tarjeta de resultado con procedencia de ejecución](docs/assets/screenshot-result.png)

## 🚀 Inicio rápido

**Requisitos**: Python 3.10+; un endpoint LLM compatible con OpenAI (llama.cpp local / Ollama / API en la nube). El frontend no necesita build.

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

Abre **http://127.0.0.1:8770/**, escribe una pregunta — y a conducir. O con un solo clic:

```bash
python tools/open_cockpit.py
```

> 💡 ¿Sin un modelo local grande? Un modelo pequeño de Ollama (p. ej. `gemma3:1b`) basta para probar toda la interacción; la interfaz indica honestamente la procedencia y los límites del artefacto. El endpoint LLM también se configura **directamente en la interfaz**, sin reiniciar.

Detalles (variables de entorno, teclado, pruebas): [README en inglés](README.en.md#-quick-start) y [prototype/README.md](prototype/README.md).

## 📚 Documentación de investigación

Resumen en español: [docs/i18n/RESEARCH-SUMMARY.es.md](docs/i18n/RESEARCH-SUMMARY.es.md) · Glosario: [GLOSSARY](docs/i18n/GLOSSARY.md)

Documentos clave: [PROBLEM](docs/PROBLEM.md) · [EVIDENCE](docs/EVIDENCE.md) · [AUDIT](docs/AUDIT.md) · [RUNTIME-AUDIT](docs/RUNTIME-AUDIT.md) · [SUBDISCIPLINES](docs/SUBDISCIPLINES.md) · [M-EXPERIMENT](docs/M-EXPERIMENT.md) · [M3-ACCEPTANCE](docs/M3-ACCEPTANCE.md)

*Los documentos de investigación primarios están redactados en chino. Los PR de traducción son muy bienvenidos.*

## 🗺️ Hoja de ruta

- [x] Cadena de ejecución honesta (teatro eliminado)
- [x] Sistema de verificabilidad P2 (barra de procedencia / comparación / línea de tiempo / exportación)
- [x] Interrupción como tercer estado + endurecimiento del ciclo de vida WS
- [x] Anillo de huella MoE
- [x] Aparato experimental M1
- [ ] **M2: estudios controlados con participantes** ← foco actual
- [ ] M0: validación mediante pensamiento en voz alta
- [ ] M3: completar la lista de aceptación
- [ ] Correcciones de problemas de campo ([FIELD-ISSUES](docs/FIELD-ISSUES.md): vínculo conducción↔ejecución, etiquetado de truncamientos, refinamiento por modelo en el bucle de exploración)
- [ ] Segmentos de cadena de herramientas reales (Ruta A)

## 🤝 Contribuir

¡Los PR son bienvenidos! Lee primero [CONTRIBUTING.md](CONTRIBUTING.md) — la regla central: **cada cambio debe responder a la pregunta «¿cuál de los criterios P1–P4 hace avanzar?»**

## 📄 Licencia

[MIT](LICENSE) © 2026 showkeyjar

---

<div align="center">

**El coche puede ser genial. Pero cada camino iluminado debe llevar a algo que realmente ocurrió — y que el usuario pueda verificar.**

</div>
