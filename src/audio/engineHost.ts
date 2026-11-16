/**
 * El motor de la app: una sola instancia, sincronizada con el proyecto del
 * store a través de la LiveSession (que añade la toma en curso al grabar).
 * Todo lo que suena —secuenciador, pads, teclado y MIDI— pasa por aquí.
 */
import { create } from 'zustand'
import { createStretchProvider, createWorkerRunner } from '../dsp'
import {
  Engine,
  LiveSession,
  LruRenderCache,
  applyTake,
  prerenderSampler,
  type PrerenderStatus,
  type RenderKey,
} from '../engine'
import {
  InputRouter,
  ManualMidiSource,
  isWebMidiSupported,
  midiBytes,
  outputTimestampClock,
  requestWebMidi,
  type WebMidiSource,
} from '../midi'
import type { NoteTarget, TrackId } from '../model'
import { useSettings } from '../state/settings'
import { useApp } from '../state/store'
import { getAudioContext, resumeAudio } from './context'
import { getBuffer } from './library'

interface Host {
  engine: Engine
  session: LiveSession
  router: InputRouter
  renders: LruRenderCache
}

/** Memoria máxima para renders de stretch / tono (float32). Al pasarse sale el menos usado. */
const RENDER_CACHE_BYTES = 384 * 1024 * 1024

export type MidiStatus = 'off' | 'connecting' | 'on' | 'unsupported' | 'error'

interface LiveState {
  recording: boolean
  midiStatus: MidiStatus
  midiError: string | null
  devices: string[]
  /** Encendido brevemente con cada mensaje MIDI (indicador de actividad). */
  midiBlink: boolean
  /** Sube en 1 cada vez que queda listo un render de stretch / tono. */
  rendersReady: number
}

export const useLive = create<LiveState>()(() => ({
  recording: false,
  midiStatus: 'off',
  midiError: null,
  devices: [],
  midiBlink: false,
  rendersReady: 0,
}))

const renderListeners = new Set<(key: RenderKey) => void>()

let host: Host | null = null
let midi: WebMidiSource | null = null

function getHost(): Host {
  if (host) return host
  const context = getAudioContext()
  // Renders con duración/tono independientes: Signalsmith Stretch en un Worker.
  const renders = new LruRenderCache({
    maxBytes: RENDER_CACHE_BYTES,
    provider: createStretchProvider({ run: createWorkerRunner().run }),
    buffers: { getBuffer },
    onReady: (key) => {
      useLive.setState((s) => ({ rendersReady: s.rendersReady + 1 }))
      for (const listener of renderListeners) listener(key)
    },
  })
  const engine = new Engine({ context, buffers: { getBuffer }, renders })
  const session = new LiveSession({
    engine,
    latencySec: useSettings.getState().latencyMs / 1000,
    onTake: (take) => {
      const { history, replace } = useApp.getState()
      replace('Grabación', applyTake(history.present, take))
    },
    onRecordingChange: (recording) => useLive.setState({ recording }),
  })
  session.setProject(useApp.getState().history.present)
  useApp.subscribe((s) => session.setProject(s.history.present))
  useSettings.subscribe((s) => {
    session.latencySec = s.latencyMs / 1000
  })
  const router = new InputRouter({
    clock: outputTimestampClock(context),
    getProject: () => useApp.getState().history.present,
    getProfiles: () => useSettings.getState().profiles,
    getSelectedTrackId: () => useApp.getState().ui.selectedTrackId,
    onEvent: (event) => session.input(event),
    onTransport: (action, pressed) => {
      resumeAudio()
      if (action === 'record' && pressed) startOrStopRecording()
      else session.transport(action, pressed)
    },
  })
  host = { engine, session, router, renders }
  return host
}

export function getEngine(): Engine {
  return getHost().engine
}

export function getSession(): LiveSession {
  return getHost().session
}

/** La caché de renders del motor (`has(key)` dice si uno ya está). */
export function getRenderCache(): LruRenderCache {
  return getHost().renders
}

/** Avisa cada vez que un render queda listo. Devuelve la función para dejar de escuchar. */
export function subscribeRenders(listener: (key: RenderKey) => void): () => void {
  renderListeners.add(listener)
  return () => renderListeners.delete(listener)
}

/**
 * Deja listos los semitonos de un Sampler en `preserve` (±`range` desde la
 * raíz). Llamar al armar o seleccionar la pista, o al cambiar su sample:
 * no repite lo que ya está. En cualquier otra pista no hace nada.
 */
export function prerenderTrack(trackId: TrackId, range = 24): PrerenderStatus {
  return prerenderSampler(useApp.getState().history.present, trackId, getHost().renders, range)
}

/** Nota en vivo desde la pantalla o el teclado de la compu. `timeStamp` es el del evento del DOM. */
export function liveNoteOn(target: NoteTarget, velocity = 100, timeStamp = performance.now()): void {
  resumeAudio()
  getHost().router.localNoteOn(target, velocity, timeStamp)
}

export function liveNoteOff(target: NoteTarget, timeStamp = performance.now()): void {
  getHost().router.localNoteOff(target, timeStamp)
}

export function togglePlay(): void {
  resumeAudio()
  const { engine, session } = getHost()
  if (engine.isPlaying) session.stop()
  else session.play(0)
}

/**
 * Botón de grabar. Si no hay ninguna pista armada, arma la seleccionada
 * (grabar "a donde estoy tocando" es lo que uno espera).
 */
export function startOrStopRecording(): void {
  resumeAudio()
  const { session } = getHost()
  if (!session.isRecording) {
    const { history, ui, change } = useApp.getState()
    const project = history.present
    const anyArmed = Object.values(project.tracks).some((t) => t.armed)
    const selected = ui.selectedTrackId ? project.tracks[ui.selectedTrackId] : undefined
    if (!anyArmed && selected && selected.kind !== 'audio') {
      change('Armar pista', (p) => {
        const t = p.tracks[selected.id]
        if (t) t.armed = true
      })
    }
  }
  session.toggleRecord(0)
}

// --- MIDI ---------------------------------------------------------------

export function midiSupported(): boolean {
  return isWebMidiSupported()
}

export function getMidiSource(): WebMidiSource | null {
  return midi
}

export async function connectMidi(): Promise<void> {
  if (midi) return
  if (!isWebMidiSupported()) {
    useLive.setState({ midiStatus: 'unsupported' })
    return
  }
  useLive.setState({ midiStatus: 'connecting', midiError: null })
  try {
    attachMidiSource(await requestWebMidi())
  } catch (err) {
    useLive.setState({ midiStatus: 'error', midiError: err instanceof Error ? err.message : String(err) })
  }
}

/** Conecta una fuente MIDI (la real de Web MIDI, o una simulada en desarrollo). */
export function attachMidiSource(source: WebMidiSource): void {
  midi = source
  const { router } = getHost()
  router.connect(source)
  let blinkTimer: ReturnType<typeof setTimeout> | undefined
  source.subscribe(() => {
    if (!useLive.getState().midiBlink) useLive.setState({ midiBlink: true })
    clearTimeout(blinkTimer)
    blinkTimer = setTimeout(() => useLive.setState({ midiBlink: false }), 90)
  })
  source.onDevicesChange((devices) => useLive.setState({ devices }))
  useLive.setState({ midiStatus: 'on', midiError: null, devices: source.inputNames() })
}

// Solo en desarrollo: un controlador simulado para probar sin hardware.
//   const pad = window.__px.fakeController('Mi controlador')
//   pad.hit(36)   // nota 36 canal 1
if (import.meta.env.DEV) {
  ;(window as unknown as { __px: unknown }).__px = {
    fakeController(name = 'Controlador simulado') {
      const source = new ManualMidiSource()
      attachMidiSource({
        subscribe: (l) => source.subscribe(l),
        inputNames: () => [name],
        onDevicesChange: () => () => {},
        dispose: () => {},
      })
      const send = (data: number[]) => source.send({ data: new Uint8Array(data), timeStamp: performance.now(), deviceName: name })
      return {
        send,
        down: (note: number, velocity = 100, channel = 0) => send(midiBytes.noteOn(channel, note, velocity)),
        up: (note: number, channel = 0) => send(midiBytes.noteOff(channel, note)),
        cc: (cc: number, value: number, channel = 0) => send(midiBytes.cc(channel, cc, value)),
      }
    },
    host: () => getHost(),
  }
}
