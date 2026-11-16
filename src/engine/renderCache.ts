/**
 * Caché de renders: audio ya procesado (stretch / cambio de tono con
 * duración preservada) listo para dispararse con latencia cero.
 *
 * PUNTO DE ENCHUFE: el motor solo consulta `get` (síncrono) y avisa con
 * `request` de lo que le hizo falta. Quien produce los buffers es un
 * RenderProvider (Signalsmith en un Worker, en un encargo posterior).
 */
import type { AssetId } from '../model'
import type { BufferProvider } from './sample'

export interface RenderKey {
  assetId: AssetId
  /** Rango en frames del asset. */
  start: number
  end: number
  /**
   * Razón de velocidad: BPM destino / BPM origen. 1 = misma duración,
   * 2 = el doble de rápido (la mitad de largo).
   */
  stretchRatio: number
  semitones: number
  /** Hoy solo se renderiza `preserve`; `resample` se hace en tiempo real. */
  mode: 'preserve' | 'resample'
}

/** Redondeo canónico para que claves equivalentes coincidan. */
export function normalizeRenderKey(key: RenderKey): RenderKey {
  return {
    ...key,
    stretchRatio: Math.round(key.stretchRatio * 10000) / 10000,
    semitones: Math.round(key.semitones * 100) / 100,
  }
}

export function renderKeyString(key: RenderKey): string {
  const k = normalizeRenderKey(key)
  return `${k.assetId}|${k.start}|${k.end}|${k.stretchRatio}|${k.semitones}|${k.mode}`
}

/** Lo que el motor necesita de la caché. */
export interface RenderCache {
  /** Síncrono: se llama al disparar una nota. undefined = no hay render. */
  get(key: RenderKey): AudioBuffer | undefined
  /** El motor quiso este render y no estaba: buen momento para producirlo. */
  request?(key: RenderKey): void
}

/** Produce un render a partir del audio original. Lo implementará el Worker de stretch. */
export interface RenderProvider {
  render(key: RenderKey, source: AudioBuffer): Promise<AudioBuffer>
}

/** Caché vacía: todo cae al fallback. */
export const NO_RENDERS: RenderCache = { get: () => undefined }

export interface LruRenderCacheOptions {
  /** Límite de memoria en bytes (float32 por muestra y canal). */
  maxBytes: number
  provider?: RenderProvider
  buffers?: BufferProvider
  /** Se llama cuando un render pedido queda listo (para refrescar la UI). */
  onReady?: (key: RenderKey) => void
}

export function audioBufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4
}

/** Caché LRU con límite de memoria: el que lleva más tiempo sin usarse sale primero. */
export class LruRenderCache implements RenderCache {
  private readonly entries = new Map<string, { buffer: AudioBuffer; bytes: number }>()
  private readonly pending = new Set<string>()
  private total = 0
  private readonly options: LruRenderCacheOptions

  constructor(options: LruRenderCacheOptions) {
    this.options = options
  }

  get bytes(): number {
    return this.total
  }

  get size(): number {
    return this.entries.size
  }

  has(key: RenderKey): boolean {
    return this.entries.has(renderKeyString(key))
  }

  get(key: RenderKey): AudioBuffer | undefined {
    const id = renderKeyString(key)
    const entry = this.entries.get(id)
    if (!entry) return undefined
    // Reinsertar lo mueve al final: Map conserva el orden de inserción.
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.buffer
  }

  set(key: RenderKey, buffer: AudioBuffer): void {
    const id = renderKeyString(key)
    this.delete(key)
    const bytes = audioBufferBytes(buffer)
    this.entries.set(id, { buffer, bytes })
    this.total += bytes
    for (const [oldId, old] of this.entries) {
      if (this.total <= this.options.maxBytes || oldId === id) break
      this.entries.delete(oldId)
      this.total -= old.bytes
    }
  }

  delete(key: RenderKey): void {
    const id = renderKeyString(key)
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.total -= entry.bytes
  }

  /** Olvida todos los renders de un asset (p. ej. si se reemplaza su audio). */
  deleteAsset(assetId: AssetId): void {
    for (const [id, entry] of this.entries) {
      if (id.startsWith(`${assetId}|`)) {
        this.entries.delete(id)
        this.total -= entry.bytes
      }
    }
  }

  clear(): void {
    this.entries.clear()
    this.total = 0
  }

  /** Pide el render al provider (si hay) sin duplicar peticiones en curso. */
  request(key: RenderKey): void {
    const { provider, buffers, onReady } = this.options
    if (!provider || !buffers) return
    const id = renderKeyString(key)
    if (this.entries.has(id) || this.pending.has(id)) return
    const source = buffers.getBuffer(key.assetId)
    if (!source) return
    this.pending.add(id)
    provider
      .render(normalizeRenderKey(key), source)
      .then((buffer) => {
        this.set(key, buffer)
        onReady?.(key)
      })
      .catch(() => {
        // Un render fallido no rompe nada: el motor sigue con su fallback.
      })
      .finally(() => this.pending.delete(id))
  }
}
