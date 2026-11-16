/**
 * Pads encendidos. Se encienden en el momento en que suenan (los golpes del
 * secuenciador llegan con anticipación y se programan a su tiempo).
 */
import { create } from 'zustand'
import { getAudioContext } from '../audio/context'
import { getEngine } from '../audio/engineHost'
import { useApp } from '../state/store'

const LIT_MS = 120

interface Lights {
  lit: ReadonlySet<number>
}

export const usePadLights = create<Lights>()(() => ({ lit: new Set<number>() }))

const offTimers = new Map<number, ReturnType<typeof setTimeout>>()

export function lightPad(index: number, delayMs = 0): void {
  setTimeout(() => {
    const lit = new Set(usePadLights.getState().lit)
    lit.add(index)
    usePadLights.setState({ lit })
    clearTimeout(offTimers.get(index))
    offTimers.set(
      index,
      setTimeout(() => {
        const next = new Set(usePadLights.getState().lit)
        next.delete(index)
        usePadLights.setState({ lit: next })
      }, LIT_MS),
    )
  }, Math.max(0, delayMs))
}

let started = false

/** Escucha al motor: enciende los pads de la pista seleccionada cuando suenan. */
export function startPadLights(): void {
  if (started) return
  started = true
  getEngine().onEvent((event) => {
    if (event.type !== 'noteOn') return
    const { ui, history } = useApp.getState()
    if (ui.view !== 'track' || event.target.trackId !== ui.selectedTrackId) return
    const track = history.present.tracks[event.target.trackId]
    if (!track || track.kind === 'audio' || track.kind === 'sampler') return
    const index = event.target.pitch - track.baseNote
    lightPad(index, (event.time - getAudioContext().currentTime) * 1000)
  })
}
