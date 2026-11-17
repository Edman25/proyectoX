/**
 * Audio de la biblioteca: importar archivos, guardarlos en IndexedDB y
 * tenerlos decodificados en memoria (AudioBuffer + mono + picos).
 *
 * Se guarda el PCM ya decodificado (no el mp3), a la frecuencia del
 * AudioContext: abrir el proyecto es instantáneo y no hay re-muestreos.
 */
import { computePeaks, mixToMono, type Peaks } from '../analysis/peaks'
import { newId, type AssetId, type SampleAsset } from '../model'
import { dbGet, dbPut } from '../storage/db'
import { getAudioContext } from './context'

interface StoredAudio {
  sampleRate: number
  channels: Float32Array<ArrayBuffer>[]
}

export interface LoadedAudio {
  buffer: AudioBuffer
  /** Mezcla mono para análisis (transientes, cruces por cero). */
  mono: Float32Array
  peaks: Peaks
}

const loaded = new Map<AssetId, LoadedAudio>()
const listeners = new Set<() => void>()

export function getLoadedAudio(id: AssetId): LoadedAudio | undefined {
  return loaded.get(id)
}

/** Para el motor: AssetId → AudioBuffer. */
export function getBuffer(id: AssetId): AudioBuffer | undefined {
  return loaded.get(id)?.buffer
}

/** Avisa cuando cambia qué audio está cargado (para re-dibujar). */
export function subscribeLoadedAudio(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function register(id: AssetId, buffer: AudioBuffer): LoadedAudio {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const mono = mixToMono(channels)
  const entry = { buffer, mono, peaks: computePeaks(mono) }
  loaded.set(id, entry)
  listeners.forEach((fn) => fn())
  return entry
}

function toBuffer(stored: StoredAudio): AudioBuffer {
  const first = stored.channels[0]
  const buffer = getAudioContext().createBuffer(stored.channels.length, first?.length ?? 1, stored.sampleRate)
  stored.channels.forEach((data, c) => buffer.copyToChannel(data, c))
  return buffer
}

const AUDIO_EXT = /\.(wav|wave|mp3|ogg|oga|flac|m4a|aac|aif|aiff|webm|opus)$/i

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)
}

/** Decodifica, guarda y registra un archivo. Devuelve el asset listo para el proyecto. */
export async function importFile(file: File): Promise<SampleAsset> {
  const ctx = getAudioContext()
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
  const id = newId<AssetId>()
  const storageKey = `audio:${id}`
  const stored: StoredAudio = {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()),
  }
  await dbPut('audio', storageKey, stored)
  register(id, buffer)
  return {
    id,
    name: file.name.replace(/\.[^.]+$/, ''),
    storageKey,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
    bpm: null,
    rootNote: null,
    origin: { kind: 'imported', fileName: file.name },
    slices: [],
  }
}

/** Carga desde IndexedDB los assets que aún no están en memoria. */
export async function ensureLoaded(assets: readonly SampleAsset[]): Promise<AssetId[]> {
  const missing: AssetId[] = []
  await Promise.all(
    assets
      .filter((a) => !loaded.has(a.id))
      .map(async (a) => {
        const stored = await dbGet<StoredAudio>('audio', a.storageKey)
        if (stored) register(a.id, toBuffer(stored))
        else missing.push(a.id)
      }),
  )
  return missing
}

/** Guarda y registra audio generado en la app (p. ej. al consolidar). */
export async function createAsset(
  name: string,
  channels: Float32Array<ArrayBuffer>[],
  sampleRate: number,
  origin: SampleAsset['origin'],
): Promise<SampleAsset> {
  const id = newId<AssetId>()
  const storageKey = `audio:${id}`
  await dbPut('audio', storageKey, { sampleRate, channels } satisfies StoredAudio)
  register(id, toBuffer({ sampleRate, channels }))
  return {
    id,
    name,
    storageKey,
    sampleRate,
    channels: channels.length,
    frames: channels[0]?.length ?? 0,
    bpm: null,
    rootNote: null,
    origin,
    slices: [],
  }
}

/** Guarda y registra el audio de un asset que ya tiene id (al abrir un proyecto). */
export async function storeAssetAudio(asset: SampleAsset, sampleRate: number, channels: Float32Array<ArrayBuffer>[]): Promise<void> {
  await dbPut('audio', asset.storageKey, { sampleRate, channels } satisfies StoredAudio)
  register(asset.id, toBuffer({ sampleRate, channels }))
}
