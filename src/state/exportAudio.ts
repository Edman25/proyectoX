/**
 * Exportar a WAV: la mezcla completa o una pista por archivo (stems). Usa el
 * mismo motor en offline, así que suena igual que en vivo (sin metrónomo).
 */
import { getRenderCache } from '../audio/engineHost'
import { getBuffer } from '../audio/library'
import { renderOffline, songLengthTicks } from '../engine'
import { encodeWav, type WavFormat } from '../io/wav'
import { writeZip } from '../io/zip'
import { ticksPerBar, ticksToSeconds, type Project, type TrackId } from '../model'
import { download, safeFileName } from './projectFile'
import { useApp } from './store'

export interface ExportOptions {
  stems: boolean
  /** En modo patrón: cuántos compases exportar. */
  bars: number
  tailSec: number
  sampleRate: number
  format: WavFormat
}

/** Duración: en modo canción, hasta el último clip; en modo patrón, los compases pedidos. */
export function exportDurationSec(project: Project, opts: Pick<ExportOptions, 'bars' | 'tailSec'>): number {
  const ticks = project.transportMode === 'song' ? songLengthTicks(project) : opts.bars * ticksPerBar(project.timeSignature)
  return ticksToSeconds(ticks, project.bpm) + opts.tailSec
}

/** Proyecto donde solo suena una pista (para su stem). Mantiene volumen y efectos de esa pista. */
export function soloProject(project: Project, trackId: TrackId): Project {
  const tracks = Object.fromEntries(
    Object.entries(project.tracks).map(([id, t]) => [id, { ...t, mixer: { ...t.mixer, solo: false, mute: id !== trackId } }]),
  ) as Project['tracks']
  return { ...project, tracks }
}

async function render(project: Project, opts: ExportOptions): Promise<Uint8Array<ArrayBuffer>> {
  const fromTick = project.transportMode === 'song' ? 0 : 0
  const audio = await renderOffline(project, { getBuffer }, {
    sampleRate: opts.sampleRate,
    durationSec: exportDurationSec(project, opts),
    fromTick,
    renders: getRenderCache(),
  })
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
  return encodeWav({ sampleRate: audio.sampleRate, channels }, opts.format)
}

export async function exportAudio(opts: ExportOptions, onProgress?: (done: number, total: number) => void): Promise<void> {
  const project = useApp.getState().history.present
  const base = safeFileName(project.name)
  if (!opts.stems) {
    onProgress?.(0, 1)
    download(await render(project, opts), `${base}.wav`, 'audio/wav')
    onProgress?.(1, 1)
    return
  }
  const ids = project.trackOrder.filter((id) => project.tracks[id] && !project.tracks[id]!.mixer.mute)
  const entries = []
  for (let i = 0; i < ids.length; i++) {
    onProgress?.(i, ids.length)
    const id = ids[i]!
    const name = safeFileName(project.tracks[id]!.name)
    entries.push({ name: `${String(i + 1).padStart(2, '0')} ${name}.wav`, data: await render(soloProject(project, id), opts) })
  }
  onProgress?.(ids.length, ids.length)
  download(writeZip(entries), `${base} (stems).zip`, 'application/zip')
}
