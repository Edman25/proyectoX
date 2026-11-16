import type { SampleAsset } from '../model'
import { useApp } from '../state/store'
import { PAD_KEYS, PADS_PER_BANK, triggerPad } from './pads'
import { usePreview } from './preview'

/** Filas de arriba a abajo, cada una de izquierda a derecha (pad 1 abajo a la izquierda). */
const LAYOUT = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]

export function Pads({ asset }: { asset: SampleAsset | null }) {
  const bank = useApp((s) => s.ui.padBank)
  const setUi = useApp((s) => s.setUi)
  const selected = useApp((s) => s.ui.selectedSliceIds)
  const lit = usePreview((s) => s.lit)

  const slices = asset?.slices ?? []
  const banks = Math.max(1, Math.ceil(slices.length / PADS_PER_BANK))

  return (
    <section className="pads">
      <header>
        <h2>Pads</h2>
        {banks > 1 && (
          <div className="banks">
            {Array.from({ length: banks }, (_, b) => (
              <button key={b} className={b === bank ? 'active' : ''} onClick={() => setUi({ padBank: b })}>
                {String.fromCharCode(65 + b)}
              </button>
            ))}
          </div>
        )}
        {slices.length === 0 && asset && <span className="muted small">Corta el sample para llenar los pads.</span>}
      </header>
      <div className="pad-grid">
        {LAYOUT.map((pad) => {
          const index = bank * PADS_PER_BANK + pad
          const slice = slices[index]
          const classes = ['pad']
          if (!slice) classes.push('off')
          if (slice && selected.includes(slice.id)) classes.push('selected')
          if (index === lit) classes.push('lit')
          return (
            <button
              key={pad}
              className={classes.join(' ')}
              disabled={!slice || !asset}
              onPointerDown={() => asset && triggerPad(asset, bank, pad)}
            >
              <span className="pad-num">{slice ? index + 1 : ''}</span>
              <span className="pad-key">{PAD_KEYS[pad]!.toUpperCase()}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
