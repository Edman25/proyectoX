# Motor de audio, entrada en vivo y grabación

Código: `src/engine/` (motor), `src/engine/record/` (grabador, cuantizar, note repeat, sesión) y `src/midi/` (router, learn, Web MIDI). Sin React y sin DOM fuera de Web Audio / Web MIDI.

Regla de desempate usada en todas las decisiones: **que suene a tiempo > no perder trabajo > rapidez del flujo > más funciones**.

## Mapa

```
MIDI crudo ─▶ InputRouter ─▶ LiveSession.input ─▶ NoteRepeater ─┬─▶ Engine.handleEvent ─▶ instrumentos ─▶ mixer ─▶ salida
pads/teclado ─┘ (perfil + asignación)                            └─▶ Recorder ─▶ Take ─▶ applyTake(project, take)
                                             Project (snapshots) ─▶ LiveSession.setProject ─▶ Engine.setProject
```

| Archivo | Qué hace |
|---|---|
| `engine/engine.ts` | `Engine`: transporte, scheduler lookahead, despacho de eventos |
| `engine/sequence.ts`, `swing.ts` | Puras: notas del patrón en una ventana de ticks; swing |
| `engine/voice.ts` | Una voz (buffer + envolvente + corte sin click) |
| `engine/instruments/` | Drum Rack y Slicer (`oneShot.ts`), Sampler (`sampler.ts`) |
| `engine/audioClips.ts` | Clips de audio del arreglo (warp) |
| `engine/mixer.ts`, `metronome.ts` | Mixer por pista; clic y count-in |
| `engine/sample.ts` | `BufferProvider`, `resolveSampleRef`, reversa cacheada, micro-fades |
| `engine/renderCache.ts` | Interfaz de la caché de renders + LRU |
| `engine/offline.ts` | `renderOffline` (export y tests) |
| `engine/record/` | `Recorder`, `Take`/`applyTake`, `quantize*`, `NoteRepeater`, `LiveSession` |
| `midi/` | `parseMidi`, `InputRouter`, `learnNext`, relojes, `requestWebMidi` |
| `engine/testing.ts` | Utilidades solo para tests (usa `node-web-audio-api`) |

## Uso desde la UI

### Crear el motor y pasarle el proyecto

```ts
import { Engine, LruRenderCache, LiveSession, applyTake } from './engine'
import { InputRouter, outputTimestampClock, requestWebMidi, learnNext, addControl } from './midi'

const context = new AudioContext({ latencyHint: 'interactive' })

// El motor no carga audio: tú le das los AudioBuffer ya decodificados.
const buffers = { getBuffer: (assetId) => decodedBuffers.get(assetId) } // síncrono

const renders = new LruRenderCache({ maxBytes: 256 * 1024 * 1024 }) // sin provider aún
const engine = new Engine({ context, buffers, renders })
const session = new LiveSession({
  engine,
  latencySec: settings.latencySec, // calibración manual, ajuste global
  onTake: (take) => {
    // UN paso de deshacer:
    store.getState().apply((project) => applyTake(project, take))
  },
  onRecordingChange: (recording) => ui.setRecording(recording),
})

// Cada cambio del store es un objeto nuevo: pásalo siempre (es barato).
session.setProject(store.getState().project)
store.subscribe((s) => session.setProject(s.project))
```

Usa siempre `session.setProject`, no `engine.setProject`: durante una grabación la sesión le pone al motor "proyecto + toma en curso".

`AudioContext` arranca suspendido hasta un gesto del usuario: llama `context.resume()` en el primer click.

### Transporte

```ts
session.play()            // desde el tick 0;  session.play(fromTick)
session.stop()            // si se estaba grabando, entrega la toma por onTake
engine.getPosition()      // { playing, tick, countingIn, bpm } — para el playhead
engine.onStateChange((playing) => …)
engine.panic()            // silencia todo ya
```

- **Modo patrón** (`transportMode: 'pattern'`): cada pista loopea su `activePatternId` con su propio largo, todos alineados al tick 0 del transporte.
- **Modo canción**: clips del arreglo; `songLoop` hace la vuelta.
- BPM, mute/solo/volumen/paneo, notas, clips, swing, compás y metrónomo se cambian en el proyecto y se aplican en caliente.
- `tick` es negativo (menor que `fromTick`) durante el count-in.

### Tocar en vivo

```ts
const clock = outputTimestampClock(context)
const router = new InputRouter({
  clock,
  getProject: () => store.getState().project,
  getProfiles: () => controllerProfiles,           // globales (IndexedDB)
  getSelectedTrackId: () => ui.selectedTrackId,
  onEvent: (event) => session.input(event),
  onTransport: (action, pressed) => session.transport(action, pressed),
  onControl: ({ controlId, value }) => { /* perillas: MIDI learn de parámetros, fase 7 */ },
})

const midi = await requestWebMidi()   // el navegador puede pedir permiso
router.connect(midi)

// Pads en pantalla y teclado de la compu: misma ruta, con el timeStamp del evento del DOM.
padElement.onpointerdown = (e) => router.localNoteOn({ trackId, pitch }, 127, e.timeStamp)
padElement.onpointerup = (e) => router.localNoteOff({ trackId, pitch }, e.timeStamp)

// Feedback visual de todo lo que suena (secuenciador y en vivo):
engine.onEvent((event) => { if (event.type === 'noteOn') ui.flashPad(event.target) })
```

### Armar y grabar

```ts
// Armar = track.armed en el proyecto. Modo = project.recordMode. Count-in = project.metronome.countInBars.
session.toggleRecord()   // parado: count-in y a grabar · sonando: punch-in · grabando: punch-out
session.stop()           // para y entrega la toma
// onTake(take) → applyTake(project, take) en el store → llega de vuelta por setProject.
```

El botón de grabar del controlador hace lo mismo vía `onTransport('record')`.

### Cuantizar

```ts
import { quantizePattern } from './engine'
store.apply((p) => quantizePattern(p, patternId, { gridTicks: gridTicks(16), strength: 0.6, swing: 0, quantizeEnds: false }))
// Opcional: cuarto argumento con los NoteId seleccionados.
```

### Learn

```ts
const abort = new AbortController()
const { control, deviceName } = await learnNext(midi, { kind: 'pad', label: 'Pad 1', signal: abort.signal })
profile = addControl(profile, control)                 // puro; re-aprender conserva el id
// Destino del pad en el proyecto:  assignment.padTargets[control.id] = { trackId, pitch }
// Botón de transporte:             profile.transport.record = control.id
```

### Export / render offline

```ts
import { renderOffline, songDurationSec } from './engine'
const audio = await renderOffline(project, buffers, { sampleRate: 48000, durationSec: songDurationSec(project) })
```

## API pública (resumen)

**`Engine`** — `setProject`, `play({ fromTick, countInBars })`, `stop`, `panic`, `handleEvent`, `getPosition`, `tickAtTime`, `linearTickAtTime`, `gridTimesBetween`, `onEvent`, `onStateChange`, `onPump`, `advanceTo`, `pump`, `now`, `dispose`.
Opciones: `context`, `buffers`, `renders?`, `timer?`, `lookaheadSec?` (0.1), `startDelaySec?` (0.05), `metronomeOutput?`, `now?`.

**`BufferProvider`** — `getBuffer(assetId): AudioBuffer | undefined`. Síncrono. Si falta el buffer, la nota no suena.

**`resolveSampleRef(assets, ref, extra?)`** — pura: `SampleRef` → `{ assetId, start, end, playback }`. Los ajustes del slice y los de quien lo usa se combinan: ganancias y tonos se suman, dos reversas se cancelan, de cada fade gana el más largo.

**`SchedulerTimer`** — `{ start(cb), stop() }`. `intervalTimer(25)` por defecto; `ManualTimer` para tests. Punto de enchufe para un temporizador en Worker.

**`RenderCache` / `LruRenderCache` / `RenderProvider`** — ver "Puntos de enchufe".

**`LiveSession`** — `setProject`, `input(event)`, `transport(action, pressed)`, `play`, `stop`, `toggleRecord(fromTick?)`, `isRecording`, `latencySec`, `recorder`, `repeater`.

**`Recorder`** — `start(project, { startTick, startLinearTick })`, `capture(event, exact?)`, `snapshot()`, `finish(time)`, `cancel()`. La sesión ya lo maneja; se expone para usos a medida.

**`applyTake(project, take): Project`** — pura y determinista (los ids vienen en la toma).

**`quantizeNote` / `quantizeNotes` / `quantizePattern` / `nearestGridTick`** — puras.

**`InputRouter`** — `connect(source)`, `handleMidi(raw)`, `localNoteOn/Off`. **`resolvePadTarget`**, **`trackBaseNote`** puras.

**`learnNext`**, **`addControl`**, **`parseMidi`**, **`ManualMidiSource`**, **`requestWebMidi`**, **`outputTimestampClock`**, **`fixedClock`**.

## Decisiones

### Motor

1. **Scheduler y posición por segmentos.** La posición es una lista de segmentos (tiempo de audio → tick, con su BPM). El scheduler programa ventanas contiguas `[cursor, horizonte)`; una nota pertenece a la ventana donde empieza, así que no se pierde ni se duplica (tests con ventanas irregulares y varios tamaños de paso).
2. **El cambio de BPM entra en el horizonte**, no en "ahora": lo ya programado (≤ 100 ms) no se mueve y lo siguiente continúa desde el mismo tick. Efecto: el cambio se oye hasta 100 ms después; a cambio no hay golpes reordenados ni salto de fase.
3. **Note-offs en ticks, guardados al emitir el note-on.** Si borras una nota mientras suena, su note-off llega igual (nada colgado). En la vuelta del `songLoop`, al cambiar de modo y al parar, se sueltan todas.
4. **Swing = deformación continua del tiempo** por pares de pasos (0 → 50 %, 0.5 → 66.7 %, 1 → 83.3 %). Lo que está fuera de la rejilla se desplaza proporcionalmente: el orden nunca cambia.
5. **Notas más largas que el patrón** suenan con duración = largo del patrón. **Notas con `tick` fuera del largo** no suenan (no se borran: reaparecen si alargas el patrón).
6. **Micro-fade solo en cortes.** `EDGE_FADE_MS` se aplica en los bordes que son un corte dentro del audio. El inicio y el final reales del archivo se respetan: un bombo que empieza en el frame 0 conserva su ataque. Choke, gate, robo de voz y entrar a medio clip usan un fade de 5 ms.
7. **Velocity → ganancia cuadrática** (`velocityToGain`, único lugar donde se decide).
8. **Parar** suelta las notas con gate/sampler y quita lo programado que aún no sonó; los one-shots que ya suenan terminan solos. `panic()` corta todo.
9. **Sampler mono**: con `glideMs > 0` es legato (desliza el tono sin re-disparar; al soltar vuelve a la nota anterior que siga pulsada). Con `glideMs = 0` cada nota re-dispara. El glide es exponencial en velocidad (= lineal en tono).
10. **Sampler poly**: repetir una altura que sigue sonando la re-dispara; al pasar de `maxVoices` se roba la más antigua.
11. **Fallback de `preserve`** (Sampler y clips): si la caché no tiene el render, se llama `renders.request(key)` y suena en `resample`. Nunca silencio ni pitch-shift en tiempo real.
12. **Warp de clips**: `off` = tal cual (`semitones` actúa como varispeed); `resample` = velocidad `bpm / sourceBpm`, y `semitones`/pitch del slice se ignoran porque romperían la sincronía; sin BPM de origen (ni en el clip ni en el asset) se comporta como `off`. Un cambio de BPM a medio clip ajusta la velocidad en el acto.
13. **Metrónomo directo a la salida**, sin pasar por el master: no entra en el export. Durante el count-in suena aunque `metronome.enabled` sea false.
14. **Paneo de igual potencia** (`StereoPannerNode`): una fuente mono al centro queda a −3 dB por canal.
15. **Golpes del secuenciador que llegan > 100 ms tarde** (pestaña dormida) no se tocan, para no soltar una ráfaga.

### Entrada y grabación

16. **El `time` de un evento en vivo es el punto del audio que se oía al tocar.** `outputTimestampClock` lo obtiene de `getOutputTimestamp()`; si no está disponible usa `currentTime − outputLatency`. Un golpe sobre el clic recibe el tiempo del clic. Como siempre queda un poco atrás de `currentTime`, el motor lo toca "ya".
17. **`latencySec` es calibración manual adicional** (ajuste global): positivo = las notas se graban más temprano. Cubre lo que el navegador no mide (Bluetooth, drivers, retardo del controlador).
18. **Note-off después de dar la vuelta al loop**: la nota conserva su inicio y su duración real aunque pase del final del patrón; el secuenciador la termina en la vuelta siguiente. Tope: el largo del patrón.
19. **Golpes adelantados al tiempo 1**: se acepta lo tocado hasta `preRollTicks` (una corchea) antes del inicio; lo anterior del count-in se descarta. En un patrón en loop el golpe queda justo antes del final (suena tal como se tocó) y al cuantizar da la vuelta al tick 0. En un clip nuevo se pega al inicio del clip.
20. **`replace`**: se borran las notas *anteriores* de las pistas armadas en la zona recorrida (todo el patrón si se dio una vuelta completa), también en pistas armadas donde no tocaste. Lo grabado en vueltas sucesivas de la misma toma **se acumula**: dejar correr el loop no borra lo recién grabado. Lo anterior deja de sonar en cuanto empieza la grabación.
21. **Notas pulsadas al parar** se cierran en el punto de parada.
22. **Pedal de sustain al grabar**: el modelo no guarda eventos de pedal, así que la nota se graba con la duración que sonó (hasta levantar el pedal).
23. **Pista armada sin patrón (modo patrón)**: se crea uno. Largo = el del patrón activo más largo de las otras pistas; si no hay ninguno, lo que duró la toma redondeado a compases.
24. **`linear`** crea Pattern + PatternClip (de compás a compás) **por cada pista armada en la que se tocó algo**; no crea clips vacíos. No borra ni recorta clips existentes: si se enciman, suenan ambos.
25. **Modo canción + overdub/replace**: la nota va al patrón del clip que hay debajo; si no hay clip, a un clip nuevo (no se pierde).
26. **Durante la grabación el motor suena con "proyecto + toma en curso"** para oír lo grabado en la siguiente vuelta; el store de la UI no cambia hasta `onTake`.
27. **Cuantizar parte siempre de `recorded`.** Si la nota no lo tiene, su posición actual se guarda ahí al cuantizar (así re-cuantizar no acumula). Por defecto conserva la duración.
28. **Note repeat como en MPC**: con el transporte en marcha el pad suena en el siguiente punto de la rejilla (si pulsas hasta 30 ms tarde, ese punto cuenta y suena de inmediato). Parado, suena al pulsar y repite desde ahí. Las repeticiones se graban exactas en la rejilla, sin compensar latencia. Aplica a toda nota en vivo. El botón `noteRepeat` del controlador es momentáneo y se suma al ajuste del proyecto.
29. **Router**: el note-off va siempre al destino de su note-on. Notas del canal de pads que no son un control aprendido se ignoran si `keysChannel` es otro canal. Un equipo sin perfil se trata como teclado. Controles por CC sirven como pad o botón (valor > 0 = pulsar).

## Límites conocidos

- Un cambio de BPM o una nota añadida dentro de los próximos 100 ms no afecta a lo ya programado.
- Un golpe en vivo no corta (choke) una voz del secuenciador programada para los próximos 100 ms, y viceversa.
- Al soltar un pad con note repeat puede sonar una repetición más (horizonte de 50 ms).
- Al parar, los note-off del secuenciador pueden soltar una nota en vivo de la misma altura que sigas pulsando.
- Sampler con glide: tras deslizar, el fade del final natural queda donde estaba programado.
- Clips con warp `resample`: sin fade programado en el final natural del audio.
- Clips de patrón encimados en la misma pista suenan a la vez.
- No hay auto-stop al final de la canción.
- El "snap a cruce por cero" del plan es de edición de slices; el motor solo pone los micro-fades.
- `setInterval` se frena con la pestaña en segundo plano: para eso está el `timer` inyectable.
- `asset.frames` debe coincidir con el largo del buffer; si no, se recorta al menor.

## Tempo y tono (fase 5)

Código: `src/dsp/` (stretch), `src/engine/prerender.ts`, `src/analysis/tempo.ts` y `pitch.ts`. Conexión en `src/audio/engineHost.ts`.

### API para la UI

```ts
import { prerenderTrack, getRenderCache, subscribeRenders, useLive } from '../audio/engineHost'
import { estimateBpm } from '../analysis/tempo'
import { detectRootNote } from '../analysis/pitch'

// Al armar / seleccionar un Sampler en `preserve`, o al cambiar su sample o su raíz:
const { total, ready } = prerenderTrack(trackId) // ±24 semitonos; idempotente y barato si ya están

// Saber cuándo hay renders listos:
useLive((s) => s.rendersReady)        // contador, sube con cada render (para re-dibujar)
subscribeRenders((key) => { ... })    // lo mismo, fuera de React
getRenderCache().has(key)             // ¿está este render?
prerenderTrack(trackId)               // volver a llamarla da el { total, ready } actual

// Análisis (puro, sobre getLoadedAudio(id).mono):
estimateBpm(mono, sampleRate)         // { bpm, confidence }
detectRootNote(mono, sampleRate)      // { midi, cents, confidence } | null
```

Sin motor: `prerenderSampler(project, trackId, cache, range = 24)` y `samplerRenderKeys(...)` (en `src/engine`), `createStretchProvider({ run })` y `createWorkerRunner()` (en `src/dsp`). Los clips de audio con warp `preserve` no necesitan nada: el motor pide su render al sonar y la siguiente vez ya suena estirado.

### Decisiones

30. **Paquete: `signalsmith-stretch` 1.3.2 (MIT), versión fija.** El paquete solo expone un AudioWorkletNode (tiempo real); para renderizar offline se usa el WASM que lleva dentro. `workletShim.ts` define los globales de AudioWorklet antes de importarlo, el paquete registra su procesador y de él se toma el módulo WASM. No se copia ni se modifica el paquete, pero depende de su estructura interna: por eso la versión va sin `^`, y si cambia, `loadSignalsmith` falla con un mensaje claro (y el motor sigue con su fallback).
31. **Núcleo puro + transporte.** `stretchCore.ts` es `Float32Array[] → Float32Array[]` y se prueba en Node. `stretchWorker.ts` es el Worker (cola en orden de llegada); `stretchProvider.ts` recorta la porción de la clave (la única copia), transfiere los buffers al Worker y recibe el resultado transferido. El hilo principal no carga el WASM. Vite empaqueta el Worker solo con `new Worker(new URL(...))`: no hizo falta tocar `vite.config.ts` (el WASM va en base64 dentro del JS del paquete; el chunk del Worker pesa ~100 kB y se descarga con el primer render).
32. **Configuración: preset por defecto de Signalsmith** (bloque 120 ms, salto 30 ms, límite tonal 8 kHz). Se midió el pre-eco de un golpe de ruido sobre una nota grave con bloques de 120, 80, 60 y 40 ms: el ataque sale igual (< 0.5 dB de diferencia), así que no hay motivo para sacrificar resolución en graves. Con `stretchRatio = 1` y `semitones = 0` se devuelve una copia exacta.
33. **Latencia compensada.** Pre-roll de `inputLatency` muestras con `seek` y descarte de las primeras `outputLatency` de salida: el frame 0 del render es el frame 0 de la porción. Largo del render = `round(frames / stretchRatio)`, con el sample rate del original.
34. **Solo `preserve`.** Una clave `resample` se rechaza (el motor la hace en tiempo real). `stretchRatio` válido: 0.125–8.
35. **Pre-render del Sampler**: ±24 semitonos desde `rootNote` (dentro de 0–127), las notas más cercanas a la raíz primero. Usa exactamente las claves del motor (incluye el `pitch` de la pista y del slice). Cambiar sample, rango, raíz o pitch produce claves nuevas: hay que volver a llamarla.
36. **Caché de 384 MB** (LRU). 48 renders de un sample estéreo de 2 s a 48 kHz son ~37 MB.
37. **`estimateBpm`**: envolvente de ataques (energía + derivada, 200 cuadros/s) → autocorrelación → tempo cuyo pulso y sus múltiplos (hasta 4) mejor encajan, de 60 a 180. Doble/mitad: decide la evidencia y, si empata (lo normal entre un tempo y su mitad), gana el más cercano a 120; por eso > ~165 BPM sale a la mitad y un loop lento con corcheas marcadas puede salir al doble. Si con ese tempo el audio dura casi (±1.5 %) un número entero de compases de 4/4, se ajusta al valor exacto (`snapToLoop`, activo por defecto).
38. **`detectRootNote`**: McLeod (NSDF) en hasta 16 ventanas de 85 ms; se descartan las de poco nivel o tono poco claro y la primera (ataque), y se promedia alrededor de la mediana. Rango 27.5–2100 Hz. `null` si no hay tono.

### Límites

- Un solo Worker, en orden de llegada: con un pre-render en curso (48 renders), el render de un clip recién pedido espera su turno. No hay cancelación ni prioridades.
- Si la caché se llena, salen los renders menos usados y esas notas vuelven al fallback hasta pedirlos otra vez.
- Los renders no se guardan en disco: se rehacen en cada sesión.
- Transponer muchos semitonos cambia el timbre (no hay corrección de formantes activada).
- Los puntos de loop del Sampler se escalan al largo del render; con `stretchRatio = 1` coinciden.
- `estimateBpm` supone tempo constante y compás de 4/4 para el ajuste; `detectRootNote` es monofónico (un acorde da un resultado poco fiable, con confianza baja).

## Puntos de enchufe

- **Stretch (Signalsmith)**: hecho, ver "Tempo y tono".
- **Temporizador en Worker**: implementa `SchedulerTimer`.
- **Perillas / faders**: `InputRouter.onControl` ya entrega `(controlId, valor 0–1)`; falta el mapa control → parámetro.
- **Calibración de latencia**: `session.latencySec`. Falta la pantalla de calibración.
- **Export a WAV / stems**: `renderOffline` devuelve el `AudioBuffer`; falta el codificador y el render por pista.
- **Efectos del mixer** (filtros, reverb, delay): se insertan entre el paneo de la pista y el master en `mixer.ts`.

## Tests

`npm test`. Web Audio en Node vía `node-web-audio-api` (devDependency): permite usar el `OfflineAudioContext` real, así los tests de alineación miden audio renderizado y no un simulacro. Cubren: tiempo y swing, bordes de loop, patrones de largos distintos, cambio de BPM, modo canción y `songLoop`, count-in, choke, one-shot/gate, slicer, sampler, mixer, clips de audio, render offline con golpes en el frame esperado (±1), router y learn, grabación con MIDI sintético, cuantizar y note repeat. Fase 5: stretch (duración, tono, alineación del inicio, transporte por Worker simulado, caché + proveedor, pre-render), tempo y nota raíz sobre señales sintéticas; el WASM real corre en Node.

Dos rarezas de `node-web-audio-api` encontradas: `setTargetAtTime` sobre `playbackRate` deja la fuente en silencio (por eso el glide usa rampas explícitas, que además se oyen mejor), y un inicio en posición fraccionaria de frame se interpola (de ahí el ±1).
