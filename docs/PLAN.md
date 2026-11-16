# Plan — App de chops, samples y secuenciación

Estado: **borrador para revisión** (no hay código todavía).

## Objetivo

Una app en navegador (empaquetable después como app de escritorio con Tauri) para:

- Cargar samples propios, cortarlos en slices, unirlos, reordenarlos y consolidarlos en samples nuevos.
- Tocarlos desde un Drum Rack, un Slicer o un Sampler (instrumento cromático).
- Programarlos en grilla de pasos o piano roll, arreglarlos en una línea de tiempo y mezclarlos.
- Cambiar BPM y tono con calidad, y exportar a WAV.

Fuera de alcance por ahora: tocar en vivo con teclado MIDI (no es prioridad), plugins VST.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Sonidos | Solo samples que carga el usuario (no hay kit integrado) |
| Slices | No destructivos: marcadores sobre el sample original |
| Merge | Contiguos = quitar marcador. No contiguos = **consolidar** en un sample nuevo |
| Reorganizar | Las tres: tira de chops → loop nuevo, orden libre en patrones, arreglo de canción |
| Tono en Sampler | Ambos modos: **resample** (por defecto, tiempo real) y **mantener duración** (pre-render) |
| Pistas de audio | Sí, clips de audio en la línea de tiempo, ajustados al BPM |
| MIDI en vivo | No por ahora |

## Stack

- **Vite + React + TypeScript (strict)**, estado con **Zustand + Immer** (los parches de Immer dan undo/redo gratis).
- **Web Audio API**. Sincronía con scheduler *lookahead* (programar ~100 ms adelante sobre el reloj de audio). AudioWorklet solo cuando haga falta DSP en tiempo real.
- **Signalsmith Stretch (WASM, MIT)** en un Web Worker para tempo/tono con calidad.
- Forma de onda en **canvas propio**.
- Persistencia: **IndexedDB** para el audio, JSON para el proyecto; exportar/importar proyecto como `.zip`.
- Tests: **Vitest** (lógica y render offline) + **Playwright** (humo de UI). CI en GitHub Actions. Deploy en GitHub Pages.

## Idea central: todo es notas

Un **patrón** es una lista de notas `{ tick, duración, altura, velocity }`. Cada tipo de pista interpreta la altura:

| Pista | Altura de la nota significa… |
|---|---|
| **Drum Rack** | Qué pad suena (16 pads, cada uno con un sample o rango de sample) |
| **Slicer** | Qué slice suena (nota base + índice del slice) |
| **Sampler** | Transposición en semitonos respecto a la nota raíz |
| **Audio** | No usa notas: tiene clips de audio en la línea de tiempo |

La **grilla de pasos** y el **piano roll** son dos vistas del mismo patrón.

## Modelo de datos (borrador)

- **Proyecto**: `bpm`, compás, pistas, patrones, arreglo, biblioteca, versión del formato.
- **Tiempo**: en *ticks* (PPQ 960). Conversión ticks↔segundos en un solo lugar.
- **SampleAsset**: id, nombre, referencia al audio en IndexedDB, sampleRate, canales, duración, `bpm?`, `notaRaíz?`, origen (`importado` | `consolidado { desde: SliceRef[] }`).
- **Slice**: id, asset, inicio/fin (en samples), fades, ganancia, reversa, tono.
- **Pista**: id, tipo, nombre, mixer (vol, pan, mute, solo) + configuración del instrumento:
  - *Drum Rack*: 16 pads `{ sampleRef, ganancia, tono, chokeGroup, reversa }`.
  - *Slicer*: asset, slices, nota base, modo one-shot/gate.
  - *Sampler*: sampleRef, nota raíz, modo de tono (`resample` | `mantener`), ADSR, loop (inicio/fin/activo), mono/poly, glide.
- **Patrón**: id, pista, longitud en ticks, notas.
- **Arreglo**: por pista, clips de patrón `{ patrón, inicio, longitud, loop }` y clips de audio `{ rango del asset, inicio, warp: { bpmOrigen, semitonos, modo } }`.
- **Undo/redo** global sobre todo el proyecto, desde el día uno.

## Motor de audio (requisitos)

- Independiente de React (`src/engine/`), y **agnóstico del contexto**: el mismo motor corre sobre `AudioContext` (reproducción) y `OfflineAudioContext` (export y tests).
- Transporte: play/stop, loop, posición, cambio de BPM en vivo sin perder sincronía.
- Voces por tipo de pista; choke groups; ADSR y loop nativo (`loopStart/loopEnd`) en el Sampler.
- **Caché de renders**: clave = (asset, rango, ratio de stretch, semitonos, modo) → buffer procesado; invalida al cambiar parámetros; límite de memoria (LRU).
- Micro-fades en bordes de slice y snap a cruce por cero para evitar clicks.
- Verificación objetiva: renders offline cuyos golpes caen en el sample esperado (±1 sample).

## Fases

| # | Fase | Contenido | Al terminar puedes… |
|---|---|---|---|
| 0 | Base | Scaffold, lint, typecheck, Vitest, CI, deploy a Pages, **tipos del modelo de datos** | Abrir la app desde un link |
| 1 | Biblioteca y editor de slices | Importar (drag & drop, varios), IndexedDB, panel de biblioteca, onda con zoom, slices manuales/automáticos (transientes, divisiones, grilla), mover/partir/unir contiguos, cruce por cero, fades, reversa, preview con teclado, undo/redo | Cortar samples y tocarlos |
| 2 | Núcleo y secuenciador | Modelo de notas, transporte, scheduler, Drum Rack, Slicer, vista de grilla, metrónomo, loop | **Batería + slices sincronizados** |
| 3 | Piano roll y Sampler | Piano roll, Sampler en modo resample (ADSR, loop, mono/poly, glide), "Enviar a Sampler / a pad" | Usar cualquier sample como instrumento |
| 4 | Tempo y tono | Worker con Signalsmith, caché de renders, detección de BPM y nota raíz, modo "mantener duración", ajuste de samples al BPM del proyecto | Meter un sample de 90 en un beat de 140 sin cambiar el tono |
| 5 | Arreglo y consolidación | Línea de tiempo con clips de patrón y pistas de audio, tira de chops → loop nuevo, consolidar slices no contiguos | Armar la canción completa |
| 6 | Mixer, export y proyectos | Vol/pan/mute/solo, filtros, reverb, delay, exportar WAV (mezcla y stems), guardar/abrir `.zip` | Sacar la rola terminada |
| 7 | Extras | Separación de stems (Demucs, backend local), tonalidad, Tauri | — |

## Uso de Fable (subagente)

Para piezas donde un bug sutil cuesta caro. Corre en paralelo, en un *worktree* aislado, contra los tipos del modelo definidos en la fase 0.

**Encargo 1 — Núcleo del motor (fase 2):**
- Conversión de tiempo, transporte, scheduler lookahead, voces de Drum Rack / Slicer / Sampler-resample, mixer básico, interfaz de la caché de renders (sin stretch todavía).
- Sin React ni UI; sin dependencias nuevas sin acordar.
- Entregables: `src/engine/` con API documentada + tests: matemática de tiempo, bordes de loop (ni notas perdidas ni duplicadas), cambio de BPM en reproducción, choke groups, render offline con golpes en el sample esperado.
- Mientras tanto, yo hago la fase 1 (biblioteca y editor de slices).

**Encargo 2 — Tempo y tono (fase 4):** integración de Signalsmith en Worker, caché de renders y modo "mantener duración".

**Revisión:** Fable revisa el motor completo antes de la fase 5.

## Riesgos

- Stretch en transientes de batería puede "embarrar": afinar parámetros o no estirar one-shots de batería.
- Safari tiene diferencias en Web Audio: objetivo inicial Chrome/Edge/Firefox.
- La calidad sonora la valida el usuario de oído; los tests cubren tiempos y alineación.
