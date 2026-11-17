/**
 * Mixer: una tira por pista (volumen, paneo, mute/solo, filtro, delay y
 * reverb) y el master. Doble clic en un slider lo regresa a su valor neutro.
 */
import { PPQ, defaultFx, gridTicks, type ChannelFx, type Track } from '../model'
import { setMaster, setPan, updateFx } from '../state/mixerActions'
import { useProject } from '../state/store'
import { setMixer } from '../state/trackActions'
import { Fader } from './Fader'

const DELAY_TIMES = [
  { label: '1/4', ticks: gridTicks(4) },
  { label: '1/8 con punto', ticks: gridTicks(8) * 1.5 },
  { label: '1/8', ticks: gridTicks(8) },
  { label: '1/8T', ticks: gridTicks(8, true) },
  { label: '1/16', ticks: gridTicks(16) },
  { label: '1/2', ticks: PPQ * 2 },
]

const KIND = { drumRack: 'Drum Rack', slicer: 'Slicer', sampler: 'Sampler', audio: 'Audio' } as const

function Strip({ track }: { track: Track }) {
  const fx: ChannelFx = track.mixer.fx ?? defaultFx()
  const id = track.id
  const cutoffLog = Math.log(fx.filter.cutoffHz / 20) / Math.log(1000) // 0–1
  return (
    <div className="strip-ch">
      <header>
        <span className="dot" style={{ background: track.color }} />
        <strong title={track.name}>{track.name}</strong>
        <span className="meta">{KIND[track.kind]}</span>
      </header>

      <section className={`fx ${fx.filter.enabled ? 'on' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={fx.filter.enabled} onChange={(e) => updateFx(id, 'Filtro', (f) => void (f.filter.enabled = e.target.checked))} />
          Filtro
        </label>
        <select className="mini" value={fx.filter.type} onChange={(e) => updateFx(id, 'Tipo de filtro', (f) => void (f.filter.type = e.target.value as 'lowpass' | 'highpass'))}>
          <option value="lowpass">pasa bajos</option>
          <option value="highpass">pasa altos</option>
        </select>
        <div className="fx-row">
          <span className="muted small">{fx.filter.cutoffHz >= 1000 ? `${(fx.filter.cutoffHz / 1000).toFixed(1)} kHz` : `${fx.filter.cutoffHz} Hz`}</span>
          <Fader value={Math.round(cutoffLog * 1000) / 1000} min={0} max={1} step={0.001} title="Corte (doble clic = abierto)" neutral={1} onCommit={(v) => updateFx(id, 'Corte del filtro', (f) => void (f.filter.cutoffHz = Math.round(20 * Math.pow(1000, v))))} />
        </div>
        <div className="fx-row">
          <span className="muted small">Q {fx.filter.q.toFixed(1)}</span>
          <Fader value={fx.filter.q} min={0.1} max={12} step={0.1} title="Resonancia" neutral={0.7} onCommit={(v) => updateFx(id, 'Resonancia', (f) => void (f.filter.q = v))} />
        </div>
      </section>

      <section className={`fx ${fx.delay.enabled ? 'on' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={fx.delay.enabled} onChange={(e) => updateFx(id, 'Delay', (f) => void (f.delay.enabled = e.target.checked))} />
          Delay
        </label>
        <select className="mini" value={fx.delay.timeTicks} onChange={(e) => updateFx(id, 'Tiempo del delay', (f) => void (f.delay.timeTicks = Number(e.target.value)))}>
          {DELAY_TIMES.map((d) => (
            <option key={d.label} value={d.ticks}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="fx-row">
          <span className="muted small">fb {Math.round(fx.delay.feedback * 100)}%</span>
          <Fader value={fx.delay.feedback} min={0} max={0.95} step={0.01} title="Feedback" neutral={0.35} onCommit={(v) => updateFx(id, 'Feedback', (f) => void (f.delay.feedback = v))} />
        </div>
        <div className="fx-row">
          <span className="muted small">mix {Math.round(fx.delay.mix * 100)}%</span>
          <Fader value={fx.delay.mix} min={0} max={1} step={0.01} title="Envío al delay" onCommit={(v) => updateFx(id, 'Envío al delay', (f) => void (f.delay.mix = v))} />
        </div>
      </section>

      <section className={`fx ${fx.reverb.enabled ? 'on' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={fx.reverb.enabled} onChange={(e) => updateFx(id, 'Reverb', (f) => void (f.reverb.enabled = e.target.checked))} />
          Reverb
        </label>
        <div className="fx-row">
          <span className="muted small">{fx.reverb.sizeSec.toFixed(1)} s</span>
          <Fader value={fx.reverb.sizeSec} min={0.3} max={8} step={0.1} title="Tamaño" neutral={2} onCommit={(v) => updateFx(id, 'Tamaño de reverb', (f) => void (f.reverb.sizeSec = v))} />
        </div>
        <div className="fx-row">
          <span className="muted small">mix {Math.round(fx.reverb.mix * 100)}%</span>
          <Fader value={fx.reverb.mix} min={0} max={1} step={0.01} title="Envío a la reverb" onCommit={(v) => updateFx(id, 'Envío a la reverb', (f) => void (f.reverb.mix = v))} />
        </div>
      </section>

      <div className="fx-row">
        <span className="muted small">pan {track.mixer.pan === 0 ? 'C' : track.mixer.pan < 0 ? `L${Math.round(-track.mixer.pan * 100)}` : `R${Math.round(track.mixer.pan * 100)}`}</span>
        <Fader value={track.mixer.pan} min={-1} max={1} step={0.01} title="Paneo (doble clic = centro)" onCommit={(v) => setPan(id, v)} />
      </div>
      <div className="vol">
        <Fader value={track.mixer.volumeDb} min={-40} max={6} step={0.5} title="Volumen (doble clic = 0 dB)" onCommit={(v) => setMixer(id, { volumeDb: v }, 'Volumen')} />
        <span className="db">{track.mixer.volumeDb > 0 ? '+' : ''}{track.mixer.volumeDb} dB</span>
      </div>
      <div className="ms-row">
        <button className={`ms ${track.mixer.mute ? 'on mute' : ''}`} onClick={() => setMixer(id, { mute: !track.mixer.mute }, 'Mute')}>
          M
        </button>
        <button className={`ms ${track.mixer.solo ? 'on solo' : ''}`} onClick={() => setMixer(id, { solo: !track.mixer.solo }, 'Solo')}>
          S
        </button>
      </div>
    </div>
  )
}

export function Mixer() {
  const order = useProject((p) => p.trackOrder)
  const tracks = useProject((p) => p.tracks)
  const master = useProject((p) => p.master)
  return (
    <section className="mixer">
      <header className="editor-head">
        <h2>Mixer</h2>
        <span className="meta">Filtro en la pista; delay y reverb como envíos (se suman a la señal).</span>
      </header>
      <div className="strips">
        {order.map((id) => {
          const t = tracks[id]
          return t ? <Strip key={id} track={t} /> : null
        })}
        <div className="strip-ch master">
          <header>
            <strong>Master</strong>
          </header>
          <label className="check" title="Satura suave en vez de recortar si la mezcla pasa de 0 dB. Sin latencia.">
            <input type="checkbox" checked={master.limiter ?? false} onChange={(e) => setMaster({ limiter: e.target.checked }, 'Protección del master')} />
            Protección
          </label>
          <div className="spacer" />
          <div className="vol">
            <Fader value={master.volumeDb} min={-40} max={6} step={0.5} title="Volumen master" onCommit={(v) => setMaster({ volumeDb: v }, 'Volumen master')} />
            <span className="db">{master.volumeDb > 0 ? '+' : ''}{master.volumeDb} dB</span>
          </div>
        </div>
      </div>
      {order.length === 0 && <p className="muted">Crea pistas para mezclarlas.</p>}
    </section>
  )
}
