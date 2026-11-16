/**
 * Pads: 16 por banco. El pad 1 está abajo a la izquierda (como en una MPC) y
 * el teclado sigue la misma forma:
 *
 *   1 2 3 4   → pads 13–16
 *   Q W E R   → pads 9–12
 *   A S D F   → pads 5–8
 *   Z X C V   → pads 1–4
 */
import type { SampleAsset } from '../model'
import { selectSlice } from '../state/actions'
import { previewSlice } from './preview'

export const PADS_PER_BANK = 16
export const PAD_KEYS = ['z', 'x', 'c', 'v', 'a', 's', 'd', 'f', 'q', 'w', 'e', 'r', '1', '2', '3', '4'] as const

export function triggerPad(asset: SampleAsset, bank: number, pad: number): void {
  const index = bank * PADS_PER_BANK + pad
  const slice = asset.slices[index]
  if (!slice) return
  selectSlice(slice.id)
  previewSlice(asset.id, slice, index, false)
}
