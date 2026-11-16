/**
 * RenderProvider de stretch: recorta la porción de la clave, la manda a
 * procesar (normalmente a un Worker) y devuelve un AudioBuffer.
 *
 * Este archivo no importa el WASM: es seguro en el hilo principal.
 */
import type { RenderKey, RenderProvider } from '../engine/renderCache'
import type { StretchJob, StretchRequest, StretchResponse } from './stretchCore'

/** Ejecuta un trabajo de stretch. Puede quedarse con (transferir) `job.channels`. */
export type StretchRunner = (job: StretchJob) => Promise<Float32Array[]>

/** Lo que se usa de un Worker (para poder sustituirlo en tests). */
export interface StretchWorkerLike {
  postMessage(message: StretchRequest, transfer: Transferable[]): void
  onmessage: ((event: { data: StretchResponse }) => void) | null
  onerror: ((event: unknown) => void) | null
  terminate(): void
}

export function createStretchWorker(): StretchWorkerLike {
  // Vite reconoce este patrón y empaqueta el Worker (con el WASM dentro) aparte.
  return new Worker(new URL('./stretchWorker.ts', import.meta.url), {
    type: 'module',
    name: 'stretch',
  }) as unknown as StretchWorkerLike
}

export interface WorkerRunner {
  run: StretchRunner
  /** Trabajos enviados que aún no han vuelto. */
  readonly pending: number
  dispose(): void
}

/**
 * Transporte por Worker. El Worker se crea con el primer trabajo; si muere,
 * los trabajos en curso fallan (el motor sigue con su fallback) y el
 * siguiente crea uno nuevo.
 */
export function createWorkerRunner(createWorker: () => StretchWorkerLike = createStretchWorker): WorkerRunner {
  let worker: StretchWorkerLike | null = null
  let nextId = 1
  const waiting = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }>()

  const failAll = (error: Error): void => {
    for (const w of waiting.values()) w.reject(error)
    waiting.clear()
    worker?.terminate()
    worker = null
  }

  const ensure = (): StretchWorkerLike => {
    if (worker) return worker
    const created = createWorker()
    created.onmessage = (event) => {
      const data = event.data
      const w = waiting.get(data.id)
      if (!w) return
      waiting.delete(data.id)
      if ('error' in data) w.reject(new Error(data.error))
      else w.resolve(data.channels)
    }
    created.onerror = () => failAll(new Error('El Worker de stretch falló'))
    worker = created
    return created
  }

  return {
    run: (job) =>
      new Promise<Float32Array[]>((resolve, reject) => {
        const id = nextId++
        try {
          const target = ensure()
          waiting.set(id, { resolve, reject })
          target.postMessage(
            {
              id,
              channels: job.channels,
              sampleRate: job.sampleRate,
              stretchRatio: job.stretchRatio,
              semitones: job.semitones,
            },
            job.channels.map((c) => c.buffer),
          )
        } catch (err) {
          waiting.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }),
    get pending() {
      return waiting.size
    },
    dispose: () => failAll(new Error('Worker de stretch cerrado')),
  }
}

export interface StretchProviderOptions {
  run: StretchRunner
  /** Por defecto `new AudioBuffer(...)`. En Node se pasa el de un contexto. */
  createBuffer?: (channels: number, length: number, sampleRate: number) => AudioBuffer
}

export function createStretchProvider(options: StretchProviderOptions): RenderProvider {
  const createBuffer =
    options.createBuffer ??
    ((numberOfChannels, length, sampleRate) => new AudioBuffer({ numberOfChannels, length, sampleRate }))

  return {
    async render(key: RenderKey, source: AudioBuffer): Promise<AudioBuffer> {
      // `resample` se hace en tiempo real con la velocidad de reproducción.
      if (key.mode !== 'preserve') throw new Error(`Modo sin render: ${key.mode}`)
      const start = Math.max(0, Math.floor(key.start))
      const end = Math.min(source.length, Math.floor(key.end))
      if (end <= start) throw new Error('Rango de render vacío')
      // Única copia: la porción pedida. De aquí en adelante se transfiere.
      const channels: Float32Array[] = []
      for (let c = 0; c < source.numberOfChannels; c++) {
        channels.push(source.getChannelData(c).slice(start, end))
      }
      const rendered = await options.run({
        channels,
        sampleRate: source.sampleRate,
        stretchRatio: key.stretchRatio,
        semitones: key.semitones,
      })
      const length = rendered[0]?.length ?? 0
      if (length === 0) throw new Error('Render vacío')
      const buffer = createBuffer(rendered.length, length, source.sampleRate)
      rendered.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c))
      return buffer
    },
  }
}
