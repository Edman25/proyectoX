# proyectoX

Sampler de chops para tocar y grabar: cargar → cortar → mapear → tocar → grabar → arreglar.

El plan, la filosofía y las fases están en [`docs/PLAN.md`](docs/PLAN.md).

## Correr en local

Requiere Node 22+ y Chrome o Edge (para Web MIDI).

```sh
npm install
npm run dev      # abre http://localhost:5173
npm run check    # typecheck + lint + tests
```

## Estructura

- `src/model/` — tipos del proyecto (JSON puro), tiempo en ticks, eventos. Es el contrato entre todo lo demás.
