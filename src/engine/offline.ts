/**
 * Render offline: el mismo motor sobre un OfflineAudioContext. Sirve para
 * exportar y para los tests de alineación (los golpes caen en el frame
 * esperado). Sin temporizador ni metrónomo.
 */
import { ticksToSeconds, type Project } from '../model'
import { Engine } from './engine'
import type { RenderCache } from './renderCache'
import type { BufferProvider } from './sample'

export interface OfflineRenderOptions {
  sampleRate: number
  durationSec: number
  channels?: number
  fromTick?: number
  renders?: RenderCache
  /** Para entornos sin OfflineAudioContext global (Node en tests). */
  createContext?: (channels: number, length: number, sampleRate: number) => OfflineAudioContext
}

/** Final del último clip del arreglo, en ticks. */
export function songLengthTicks(project: Project): number {
  let end = 0
  for (const clip of Object.values(project.clips)) {
    end = Math.max(end, clip.startTick + clip.lengthTicks)
  }
  return end
}

/** Duración de la canción en segundos al BPM actual, más una cola para que terminen los samples. */
export function songDurationSec(project: Project, tailSec = 2): number {
  return ticksToSeconds(songLengthTicks(project), project.bpm) + tailSec
}

export async function renderOffline(
  project: Project,
  buffers: BufferProvider,
  options: OfflineRenderOptions,
): Promise<AudioBuffer> {
  const channels = options.channels ?? 2
  const length = Math.max(1, Math.ceil(options.durationSec * options.sampleRate))
  const context = options.createContext
    ? options.createContext(channels, length, options.sampleRate)
    : new OfflineAudioContext(channels, length, options.sampleRate)
  const engine = new Engine({
    context,
    buffers,
    ...(options.renders ? { renders: options.renders } : {}),
    timer: { start() {}, stop() {} },
    startDelaySec: 0,
    metronomeOutput: null,
  })
  engine.setProject(project)
  engine.play({ fromTick: options.fromTick ?? 0 })
  engine.advanceTo(options.durationSec)
  return context.startRendering()
}
