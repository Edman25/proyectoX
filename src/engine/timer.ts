/**
 * Temporizador del scheduler. Es inyectable: en vivo usa setInterval (o un
 * Worker que la UI quiera pasar, para que no lo frene una pestaña en segundo
 * plano); en tests y en render offline se avanza a mano.
 */
export interface SchedulerTimer {
  start(callback: () => void): void
  stop(): void
}

export function intervalTimer(intervalMs = 25): SchedulerTimer {
  let handle: ReturnType<typeof setInterval> | null = null
  return {
    start(callback) {
      if (handle !== null) clearInterval(handle)
      handle = setInterval(callback, intervalMs)
    },
    stop() {
      if (handle !== null) clearInterval(handle)
      handle = null
    },
  }
}

/** Temporizador manual: nada corre hasta que llamas `tick()`. */
export class ManualTimer implements SchedulerTimer {
  private callback: (() => void) | null = null

  start(callback: () => void): void {
    this.callback = callback
  }

  stop(): void {
    this.callback = null
  }

  get running(): boolean {
    return this.callback !== null
  }

  tick(): void {
    this.callback?.()
  }
}
