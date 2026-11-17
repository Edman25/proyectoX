/**
 * Mixer: efectos por pista, master y perillas MIDI (MIDI learn). Los cambios
 * desde la UI son un paso de deshacer; los de una perilla se funden mientras
 * la giras.
 */
import type { Draft } from 'immer'
import { defaultFx, type ChannelFx, type ControlId, type ControllerProfileId, type ParamTarget, type Project, type TrackId } from '../model'
import { useApp } from './store'

const { change } = useApp.getState()

export function updateFx(trackId: TrackId, label: string, patch: (fx: Draft<ChannelFx>) => void): void {
  change(label, (p) => {
    const t = p.tracks[trackId]
    if (!t) return
    t.mixer.fx ??= defaultFx()
    patch(t.mixer.fx)
  })
}

export function setPan(trackId: TrackId, pan: number): void {
  change('Paneo', (p) => {
    const t = p.tracks[trackId]
    if (t) t.mixer.pan = Math.max(-1, Math.min(1, pan))
  })
}

export function setMaster(patch: Partial<Project['master']>, label: string): void {
  change(label, (p) => {
    Object.assign(p.master, patch)
  })
}

export function setKnobTarget(profileId: ControllerProfileId, controlId: ControlId, target: ParamTarget | null): void {
  change('Destino de perilla', (p) => {
    let a = p.controllers.find((c) => c.profileId === profileId)
    if (!a) {
      p.controllers.push({ profileId, padTargets: {}, defaultTrackId: null })
      a = p.controllers.at(-1)!
    }
    a.knobTargets ??= {}
    if (target) a.knobTargets[controlId] = target
    else delete a.knobTargets[controlId]
  })
}

/** Escala de 0–1 (perilla) a cada parámetro. */
export const KNOB_SCALES = {
  volume: (v: number) => Math.round((v * 46 - 40) * 2) / 2, // -40 … +6 dB
  pan: (v: number) => Math.round((v * 2 - 1) * 100) / 100,
  filterCutoff: (v: number) => Math.round(20 * Math.pow(1000, v)), // 20 Hz … 20 kHz, logarítmico
  mix: (v: number) => Math.round(v * 100) / 100,
}

/** Aplica el valor de una perilla (0–1) a su parámetro. */
export function applyKnob(target: ParamTarget, controlId: ControlId, value: number): void {
  useApp.getState().changeMerged('Perilla', `knob:${controlId}`, (p) => {
    if (target.trackId === null) {
      if (target.param === 'volume') p.master.volumeDb = KNOB_SCALES.volume(value)
      return
    }
    const t = p.tracks[target.trackId]
    if (!t) return
    switch (target.param) {
      case 'volume':
        t.mixer.volumeDb = KNOB_SCALES.volume(value)
        break
      case 'pan':
        t.mixer.pan = KNOB_SCALES.pan(value)
        break
      case 'filterCutoff':
        t.mixer.fx ??= defaultFx()
        t.mixer.fx.filter.enabled = true
        t.mixer.fx.filter.cutoffHz = KNOB_SCALES.filterCutoff(value)
        break
      case 'delayMix':
        t.mixer.fx ??= defaultFx()
        t.mixer.fx.delay.enabled = true
        t.mixer.fx.delay.mix = KNOB_SCALES.mix(value)
        break
      case 'reverbMix':
        t.mixer.fx ??= defaultFx()
        t.mixer.fx.reverb.enabled = true
        t.mixer.fx.reverb.mix = KNOB_SCALES.mix(value)
        break
    }
  })
}
