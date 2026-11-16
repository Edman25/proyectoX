/**
 * AudioContext único de la app. Los navegadores lo crean suspendido hasta
 * que hay un gesto del usuario; `resumeAudio` se llama en cada interacción.
 */
let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' })
  return ctx
}

export function resumeAudio(): void {
  const c = getAudioContext()
  if (c.state === 'suspended') void c.resume()
}
