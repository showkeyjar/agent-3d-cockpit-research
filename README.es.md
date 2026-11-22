<div align="center">

# 🚗 Agent 3D Cockpit

**La colaboración con agentes de IA: de leer respuestas a conducir un viaje.**

[![Version](https://img.shields.io/badge/prototype-v0.9.49.2-5ee0ff)](prototype/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-34f5a0)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español**

![Captura real: una pregunta ilumina letreros candidatos](docs/assets/demo-forecast.gif)

*▲ Captura de ejecución real: escribe una pregunta → aparece el esqueleto de caminos latentes → la previsión ilumina cinco letreros candidatos. El backend de ejecución es un modelo local; la procedencia de la previsión se etiqueta honestamente en la interfaz.*

</div>

---

## ¿Qué es esto?

**Agent 3D Cockpit** es un prototipo de investigación ejecutable más un marco de investigación interdisciplinario. La pregunta central:

> Cuando un agente de IA trabaja por ti, ¿cómo puedes **ver las direcciones, tomar decisiones, verificar el progreso y revisar el historial** — en lugar de mirar una barra de progreso adivinando «qué está haciendo realmente»?

La colaboración se proyecta sobre una conducción 3D:

| Pregunta de colaboración | Expresión en la cabina | Tu capacidad |
| --- | --- | --- |
| ¿Qué podría pasar después? | **Letreros y bifurcaciones** por delante | Comparar direcciones antes de salir |
| ¿En qué difieren las opciones? | Forma de carretera, disposición espacial, panel de comparación | Entender las opciones en vez de clicar «continuar» a ciegas |
| ¿Dónde estamos ahora? | **Conducción + salida de tokens en streaming** | Seguir señales reales de ejecución |
| ¿Qué produjo este paso? | **Letrero de llegada + tarjeta de resultado** (duración/tokens/procedencia) | Abrir y verificar el artefacto, no solo un badge «hecho» |
| ¿Por qué estamos aquí? | Trayectoria recorrida, línea de tiempo 2D, cadena de decisiones | Revisar, comparar, re-bifurcar desde cualquier nodo |

![Captura real: cinco letreros candidatos](docs/assets/screenshot-fork.png)

## ✨ Características

- **Carreteras guiadas por previsión**: el backend muestrea direcciones candidatas y calcula la divergencia — baja divergencia = carretera recta, alta = bifurcaciones. La forma de la carretera *es* la visualización de la estructura semántica, no decoración.
- **Agrupamiento semántico**: plegado de clústeres sinónimos + relleno por punto más lejano — cinco letreros son cinco direcciones genuinamente distintas.
- **Cadena de ejecución honesta**: una única llamada LLM real en streaming; progreso = longitud real de salida. Cuatro estados `source` (`llm / fast / local / offline`) etiquetados por ronda — los fallbacks locales nunca se hacen pasar por inferencia del modelo.
- **Procedencia verificable**: tarjetas de resultado con duración, tokens, cadena de ejecución y fuente.
- **Memoria multi-ronda y replay**: registro por ronda, línea de tiempo 2D (revisar / comparar / re-bifurcar / exportar JSON·CSV), cadena de trazabilidad de decisiones.
- **La interrupción es un tercer estado**: «Detener generación» aborta realmente el stream del backend. Interrumpido ≠ completado ≠ fallido; el texto parcial se preserva y etiqueta honestamente.
- **Vista equivalente por teclado**: `[` `]` seleccionar, `Enter` salir, `Tab` cambiar de grupo.
- **Aparato experimental integrado**: `?mode=opaque / transparent-nolink / decorative / no-fingerprint` para grupos A/B/B0/B1/B2/C.
- **Kit de herramientas MCP**: `tools/cockpit_mcp_server.py` expone la cabina como herramientas invocables por agentes.
- **Anillo de huella MoE** (rama de investigación): señales reales de enrutamiento de expertos codificadas como anillo 3D (mismo prompt r=0.990, temas distintos max=0.079).

## 🛡️ Honestidad como principio de diseño

Auditamos nuestro propio prototipo y descubrimos que los pasos intermedios de la cadena antigua («recuperación», «verificación») eran **teatro** impulsado por `sleep(0.09)` — la barra avanzaba, no ocurría trabajo. La auditoría, la evidencia en tiempo de ejecución y la corrección son totalmente públicas en [docs/AUDIT.md](docs/AUDIT.md) y [docs/RUNTIME-AUDIT.md](docs/RUNTIME-AUDIT.md).

De ahí surgieron cuatro **criterios de progreso sustantivo (P1–P4)** como puerta previa a todo desarrollo:

| Criterio | Debe responder |
| --- | --- |
| **P1 Real** | ¿La tarea/artefacto cambió realmente? |
| **P2 Verificable** | ¿Puede el usuario verificarlo por sí mismo? |
| **P3 Atribuible** | ¿Qué paso / quién lo hizo? |
| **P4 Perceptible** | ¿Es reconocible en la interfaz? |

Líneas rojas de ingeniería: **nada de señales de finalización fabricadas, nada de datos fabricados, la interrupción nunca se hace pasar por finalización, el fallback local nunca por el modelo.**

## 🚀 Inicio rápido

**Requisitos**: Python 3.10+; un endpoint LLM compatible con OpenAI (llama.cpp local / Ollama / API en la nube). Frontend sin build.

```bash
git clone https://github.com/showkeyjar/agent-3d-cockpit-research.git
cd agent-3d-cockpit-research/prototype
pip install -r requirements.txt

cd backend
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model \
  uvicorn server:app --host 127.0.0.1 --port 8770
```

Abre **http://127.0.0.1:8770/** y escribe una pregunta. O en un clic:

```bash
python tools/open_cockpit.py
```

> 💡 ¿Sin modelo local grande? Un modelo pequeño de Ollama (p. ej. `gemma3:1b`) basta para la interacción completa; la interfaz etiqueta honestamente la procedencia y los límites. El endpoint LLM también se configura **directamente en la interfaz** (sin reiniciar).

Detalles (variables de entorno, teclado, pruebas): [README English](README.en.md#-quick-start) y [prototype/README.md](prototype/README.md).

## 📚 Documentación de investigación

Resumen en español: [docs/i18n/RESEARCH-SUMMARY.es.md](docs/i18n/RESEARCH-SUMMARY.es.md)

Documentos clave: [PROBLEM](docs/PROBLEM.md) · [EVIDENCE](docs/EVIDENCE.md) · [AUDIT](docs/AUDIT.md) · [RUNTIME-AUDIT](docs/RUNTIME-AUDIT.md) · [SUBDISCIPLINES](docs/SUBDISCIPLINES.md) · [M-EXPERIMENT](docs/M-EXPERIMENT.md) · [M3-ACCEPTANCE](docs/M3-ACCEPTANCE.md)

*Los documentos de investigación primarios están en chino. Los PR de traducción son muy bienvenidos.*

## 🗺️ Hoja de ruta

- [x] Cadena de ejecución honesta (teatro eliminado)
- [x] Sistema de verificabilidad P2
- [x] Tercer estado de interrupción + endurecimiento del ciclo de vida WS
- [x] Anillo de huella MoE
- [x] Aparato experimental M1
- [ ] **M2 estudios humanos controlados** ← foco actual
- [ ] M0 validación con pensamiento en voz alta
- [ ] M3 lista de aceptación
- [ ] Segmentos de cadena de herramientas reales (Ruta A)

## 🤝 Contribuir

¡PR bienvenidos! Lee primero [CONTRIBUTING.md](CONTRIBUTING.md) — regla central: **cada cambio debe responder «¿cuál de P1–P4 hace avanzar?»**

## 📄 Licencia

[MIT](LICENSE) © 2026 showkeyjar

---

<div align="center">

**El coche puede ser genial. Pero cada camino iluminado debe llevar a algo que realmente ocurrió — y que el usuario pueda verificar.**

</div>
