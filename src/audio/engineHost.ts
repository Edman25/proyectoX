/**
 * El motor de la app: una sola instancia, sincronizada con el proyecto del
 * store a través de la LiveSession (que añade la toma en curso al grabar).
 * Todo lo que suena —secuenciador, pads, teclado y MIDI— pasa por aquí.
 */
import { Engine, LiveSession, applyTake } from '../engine'
import { InputRouter, outputTimestampClock } from '../midi'
import type { NoteTarget } from '../model'
import { useApp } from '../state/store'
import { getAudioContext, resumeAudio } from './context'
import { getBuffer } from './library'

interface Host {
  engine: Engine
  session: LiveSession
  router: InputRouter
}

let host: Host | null = null

function getHost(): Host {
  if (host) return host
  const context = getAudioContext()
  const engine = new Engine({ context, buffers: { getBuffer } })
  const session = new LiveSession({
    engine,
    onTake: (take) => {
      const { history, replace } = useApp.getState()
      replace('Grabación', applyTake(history.present, take))
    },
  })
  session.setProject(useApp.getState().history.present)
  useApp.subscribe((s) => session.setProject(s.history.present))
  const router = new InputRouter({
    clock: outputTimestampClock(context),
    getProject: () => useApp.getState().history.present,
    getProfiles: () => [],
    getSelectedTrackId: () => useApp.getState().ui.selectedTrackId,
    onEvent: (event) => session.input(event),
    onTransport: (action, pressed) => session.transport(action, pressed),
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
