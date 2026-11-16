# Plan — App de chops, samples y secuenciación

Estado: **aprobado** — en fase 0.

## Objetivo

Una app que corre en local en el navegador (empaquetable después como app de escritorio con Tauri) para:

- Cargar samples propios, cortarlos en slices, unirlos, reordenarlos y consolidarlos en samples nuevos.
- Tocarlos desde un Drum Rack, un Slicer o un Sampler (instrumento cromático), con el mouse, el teclado de la compu o un **controlador MIDI**.
- **Grabar lo que tocas** con metrónomo, en loop o en la línea de tiempo, y editarlo en grilla o piano roll.
- Arreglar la canción, cambiar BPM y tono con calidad, mezclar y exportar a WAV.

Fuera de alcance por ahora: grabar movimientos de perillas (automatización), plugins VST, Safari.

## Filosofía

**Es un sampler de chops para tocar y grabar, no un DAW completo.** El centro es el flujo **cargar → cortar → mapear → tocar → grabar → arreglar**. Lo que no sirva a ese flujo queda fuera por ahora.

1. **Tocar se siente inmediato.** La latencia manda; si algo de calidad agrega retraso al tocar, se resuelve con pre-render. El audio tiene prioridad sobre lo visual.
2. **Nunca pierdes nada.** Nada es destructivo; todo se deshace; se graba el timing real y cuantizar es aparte.
3. **Un modelo, muchas vistas.** Todo son notas, todo son eventos. Una sola ruta de código para secuenciador, controlador, mouse y teclado.
4. **Las manos en el controlador.** Todo lo importante es mapeable con learn; grabar es un botón.
5. **Calidad donde se escucha, simpleza donde no.** No se construyen funciones antes que el flujo que las necesita.
6. **El motor no depende de la interfaz.** TypeScript puro, igual en vivo que offline; los tiempos los validan los tests, el sonido lo valida el usuario.
7. **Local y tuyo.** Sin cuentas ni nube; los proyectos son archivos portables.
8. **Crecer por capas.** Cada fase deja algo usable.

**Cuando algo choque:** que suene a tiempo > no perder trabajo > rapidez del flujo > más funciones.

**Interfaz:** atajos de teclado para todo, drag & drop, pads grandes, feedback visual de lo que hace el controlador.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Sonidos | Solo samples que carga el usuario (el metrónomo es el único sonido generado, y se puede cambiar por un sample) |
| Slices | No destructivos: marcadores sobre el sample original |
| Merge | Contiguos = quitar marcador. No contiguos = **consolidar** en un sample nuevo |
| Reorganizar | Las tres: tira de chops → loop nuevo, orden libre en patrones, arreglo de canción |
| Tono en Sampler | Ambos modos: **resample** (por defecto) y **mantener duración** |
| Pistas de audio | Sí, clips de audio en la línea de tiempo, ajustados al BPM |
| MIDI | Sí: tocar en vivo, mapear varios samples al controlador y grabar con metrónomo |
| Grabación | Overdub/reemplazo en loop **y** grabación lineal en el arreglo |
| Perillas/faders | Solo control en vivo (MIDI learn), sin grabar automatización |
| Note repeat | Sí |
| Controladores objetivo | Teenage Engineering EP-133 K.O. II y un Akai sencillo (MPK Mini / MPD) |
| Navegador | Chrome / Edge (Web MIDI). Firefox best-effort. Safari no |
| Deploy | No. Se corre en local; CI solo corre tests |

## Stack

- **Vite + React + TypeScript (strict)**, estado con **Zustand + Immer** (los parches de Immer dan undo/redo).
- **Web Audio API** con scheduler *lookahead* para la reproducción programada; disparo inmediato para lo que se toca en vivo.
- **Web MIDI API** para controladores.
- **Signalsmith Stretch (WASM, MIT)** en un Web Worker para tempo/tono con calidad.
- Forma de onda en **canvas propio**.
- Persistencia: **IndexedDB** para el audio y los perfiles de controlador; proyecto exportable como `.zip`.
- Tests: **Vitest** (lógica y render offline) + **Playwright** (humo de UI). CI en GitHub Actions (sin deploy).

## Idea central 1: todo es notas

Un **patrón** es una lista de notas `{ tick, duración, altura, velocity }`. Cada tipo de pista interpreta la altura:

| Pista | Altura de la nota significa… |
|---|---|
| **Drum Rack** | Qué pad suena (número de pads variable: 12 como el EP-133, 16, etc.) |
| **Slicer** | Qué slice suena (nota base + índice del slice) |
| **Sampler** | Transposición en semitonos respecto a la nota raíz |
| **Audio** | No usa notas: tiene clips de audio en la línea de tiempo |

La **grilla de pasos** y el **piano roll** son dos vistas del mismo patrón.

## Idea central 2: todo son eventos

Los instrumentos reciben `noteOn(tiempo, altura, velocity)` y `noteOff(tiempo, altura)`, vengan del secuenciador, de un controlador MIDI, de los pads en pantalla o del teclado de la compu. Una sola ruta de código, probable sin hardware.

## MIDI y grabación

**Mapa del controlador** (propuesta):
- Cada entrada del controlador (dispositivo + canal + nota) apunta a un **destino**: pista + altura. Ejemplos: pad 1 → kick del Drum Rack; pad 5 → slice 3 de una rola en el Slicer; teclas → Sampler.
- Se asigna con **learn**: clicas el destino, tocas el pad. No dependemos de saber de antemano qué nota manda cada pad.
- Los botones del controlador también se pueden mapear a transporte: play, stop, **grabar**, note repeat.
- Los mapas se guardan como **perfiles por controlador** (no se rehacen en cada proyecto). Se incluyen plantillas iniciales para EP-133 y Akai que se ajustan con learn.

**Grabar con un clic:**
1. Botón de grabar (en pantalla, en el teclado o en el controlador).
2. Count-in de 1–2 compases con metrónomo.
3. Graba **en todas las pistas que el mapa toca a la vez**; toda la toma es un solo paso de deshacer.
4. Modos: **overdub** y **reemplazo** en loop (sobre el patrón), y **lineal** en el arreglo.

**Timing:**
- Se graba el timing real; **cuantizar** es un comando aparte con intensidad y swing (deshacible).
- Compensación de la latencia de salida + calibración manual.
- **Note repeat**: mantener un pad + activar repeat → se repite a 1/4…1/32 (y tresillos), con la velocity del pad.
- Pads en modo **one-shot** o **gate**; choke groups; pedal de sustain para el Sampler.

**Perillas (MIDI learn, solo en vivo):** volumen, paneo, filtros, ADSR, parámetros de pads.

**"Mantener duración" en vivo:** al armar un Sampler en ese modo se pre-renderiza el rango de semitonos (p. ej. ±24) en segundo plano, para tocar con latencia cero sin pitch-shift en tiempo real.

## Modelo de datos (borrador)

- **Proyecto**: `bpm`, compás, pistas, patrones, arreglo, biblioteca, versión del formato.
- **Tiempo**: en *ticks* (PPQ 960). Conversión ticks↔segundos en un solo lugar.
- **SampleAsset**: id, nombre, audio en IndexedDB, sampleRate, canales, duración, `bpm?`, `notaRaíz?`, origen (`importado` | `consolidado { desde: SliceRef[] }`).
- **Slice**: id, asset, inicio/fin (en samples), fades, ganancia, reversa, tono.
- **Pista**: id, tipo, nombre, mixer (vol, pan, mute, solo), armada para grabar + configuración del instrumento:
  - *Drum Rack*: N pads `{ sampleRef, ganancia, tono, chokeGroup, reversa, modo one-shot|gate }`.
  - *Slicer*: asset, slices, nota base, modo one-shot|gate.
  - *Sampler*: sampleRef, nota raíz, modo de tono (`resample` | `mantener`), ADSR, loop, mono/poly, glide.
- **Patrón**: id, pista, longitud en ticks, notas.
- **Arreglo**: por pista, clips de patrón y clips de audio (`warp: { bpmOrigen, semitonos, modo }`).
- **Perfil de controlador** (global, fuera del proyecto): dispositivo, mapeos de notas → destino, mapeos de botones → transporte, mapeos de perillas → parámetro.
- **Undo/redo** global desde el día uno.

## Motor de audio (requisitos)

- Independiente de React (`src/engine/`) y **agnóstico del contexto** (`AudioContext` para tocar, `OfflineAudioContext` para export y tests).
- Instrumentos basados en eventos `noteOn`/`noteOff` con timestamp.
- Transporte: play/stop, loop, posición, cambio de BPM en vivo, metrónomo y count-in.
- Grabador: convierte eventos con timestamp a ticks (compensando latencia), maneja el borde del loop en overdub y escribe en varias pistas en una sola toma.
- **Caché de renders** (asset, rango, ratio, semitonos, modo) con límite de memoria (LRU).
- Micro-fades en bordes de slice y snap a cruce por cero.
- Verificación objetiva: renders offline con golpes en el sample esperado (±1 sample); eventos MIDI sintéticos para probar la grabación.

## Fases

| # | Fase | Contenido | Al terminar puedes… |
|---|---|---|---|
| 0 | Base | Scaffold, lint, typecheck, Vitest, CI, **tipos del modelo de datos** | Correr la app en local |
| 1 | Biblioteca y editor de slices | Importar, IndexedDB, biblioteca, onda con zoom, slices manuales/automáticos, mover/partir/unir contiguos, cruce por cero, fades, reversa, preview, undo/redo | Cortar samples y tocarlos con el mouse/teclado |
| 2 | Núcleo y secuenciador | Motor de eventos, transporte, scheduler, metrónomo + count-in, Drum Rack (pads variables, one-shot/gate, choke), Slicer, vista de grilla, teclado de la compu como controlador | Batería + slices sincronizados |
| 3 | MIDI y grabación | Web MIDI, mapa del controlador con learn, perfiles EP-133/Akai, grabación multi-pista en loop (overdub/reemplazo), cuantizar, note repeat, calibración de latencia, botón de grabar mapeable, **piano roll** | **Mapear samples al controlador y grabar tus secuencias con metrónomo** |
| 4 | Sampler | Sampler en modo resample (ADSR, loop, mono/poly, glide, sustain), "Enviar a Sampler / a pad" | Tocar cualquier sample como instrumento |
| 5 | Tempo y tono | Worker con Signalsmith, caché de renders, detección de BPM y nota raíz, modo "mantener duración" (con pre-render al armar), ajuste de samples al BPM | Meter un sample de 90 en un beat de 140 sin cambiar el tono |
| 6 | Arreglo y consolidación | Línea de tiempo, pistas de audio, **grabación lineal**, tira de chops → loop nuevo, consolidar slices no contiguos | Armar la canción completa |
| 7 | Mixer, export y proyectos | Vol/pan/mute/solo, filtros, reverb, delay, **MIDI learn de perillas**, exportar WAV (mezcla y stems), guardar/abrir `.zip` | Sacar la rola terminada |
| 8 | Extras | Separación de stems (Demucs), tonalidad, MIDI clock (enviar y seguir), Tauri con MIDI nativo | — |

## Uso de Fable (subagente, esfuerzo **medium**)

Corre en paralelo en un *worktree* aislado, contra los tipos del modelo definidos en la fase 0.

**Encargo 1 — Núcleo del motor y grabador (fases 2–3, sin UI):**
- Entrega A: tiempo, transporte, scheduler, metrónomo/count-in, instrumentos por eventos (Drum Rack, Slicer, Sampler-resample básico), mixer básico, interfaz de caché de renders.
- Entrega B: grabador (latencia, ticks, borde de loop, toma multi-pista), cuantizar, note repeat, router de entradas (abstracción sobre Web MIDI / teclado / pantalla).
- Sin React; sin dependencias nuevas sin acordar.
- Tests: tiempo, bordes de loop (ni notas perdidas ni duplicadas), cambio de BPM en vivo, choke, render offline con golpes en el sample esperado, grabación con eventos sintéticos (incluido overdub cruzando el loop), cuantizar.
- Mientras tanto, yo hago la fase 1.

**Encargo 2 — Tempo y tono (fase 5).**

**Revisión:** Fable revisa el motor completo antes de la fase 6.

## Riesgos

- Jitter de eventos MIDI si la UI está ocupada: UI ligera durante la reproducción, usar los timestamps de los eventos.
- Latencia de salida variable según sistema; audífonos Bluetooth no sirven para tocar en vivo.
- Stretch en transientes de batería puede "embarrar": afinar parámetros o no estirar one-shots.
- No damos por hecho qué notas/canales manda cada controlador: todo se asigna con learn.
- La calidad sonora la valida el usuario de oído; los tests cubren tiempos y alineación.
