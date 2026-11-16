/**
 * El motor de la app: una sola instancia, sincronizada con el proyecto del
 * store a través de la LiveSession (que añade la toma en curso al grabar).
 * Todo lo que suena —secuenciador, pads, teclado y MIDI— pasa por aquí.
 */
import { create } from 'zustand'
import { Engine, LiveSession, applyTake } from '../engine'
import {
  InputRouter,
  ManualMidiSource,
  isWebMidiSupported,
  midiBytes,
  outputTimestampClock,
  requestWebMidi,
  type WebMidiSource,
} from '../midi'
import type { NoteTarget } from '../model'
import { useSettings } from '../state/settings'
import { useApp } from '../state/store'
import { getAudioContext, resumeAudio } from './context'
import { getBuffer } from './library'

interface Host {
  engine: Engine
  session: LiveSession
  router: InputRouter
}

export type MidiStatus = 'off' | 'connecting' | 'on' | 'unsupported' | 'error'

interface LiveState {
  recording: boolean
  midiStatus: MidiStatus
  midiError: string | null
  devices: string[]
  /** Encendido brevemente con cada mensaje MIDI (indicador de actividad). */
  midiBlink: boolean
}

export const useLive = create<LiveState>()(() => ({
  recording: false,
  midiStatus: 'off',
  midiError: null,
  devices: [],
  midiBlink: false,
}))

let host: Host | null = null
let midi: WebMidiSource | null = null

function getHost(): Host {
  if (host) return host
  const context = getAudioContext()
  const engine = new Engine({ context, buffers: { getBuffer } })
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
  host = { engine, session, router }
  return host
}

export function getEngine(): Engine {
  return getHost().engine
}

export function getSession(): LiveSession {
  return getHost().session
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
