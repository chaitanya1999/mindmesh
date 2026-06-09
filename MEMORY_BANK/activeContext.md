# Active Context

## Task Complete: NeoVis/Sigma Graph Drag Behavior Fixes

Fixed two issues with node dragging in the graph UI (both Sigma and NeoVis renderers), plus a visual flicker regression.

### Changes Made (all in `src/server/public/app.js`)

**1. NeoVis: Multi-node drag on hover (main fix)**
- Problem: `previewSelection()` called `syncNeoVisSelection()` which invoked `network.setSelection()` during hover. This set a multi-node selection (hovered node + neighbors). vis.js's built-in drag moved all selected nodes as a single unit.
- Fix: `previewSelection()` now uses only `applyNeoVisSelectionStyles()` for visual-only highlighting (colors, sizes, dimming) without calling `network.setSelection()`. The `network.setSelection()` is retained only for click-based focus events via `syncNeoVisSelection()`.

**2. Sigma: Force layout re-application after drag**
- Problem: After dragging a node in the Sigma renderer, neighbors remained frozen — no force settling occurred.
- Fix: Added `forceLayout.assign()` with 80 iterations on `mouseup` after drag ends, using same force parameters as initial layout (attraction 0.0008, repulsion 0.18, gravity 0.04, inertia 0.6, maxMove 12).

**3. NeoVis: Drag flicker suppression**
- Problem: During drag, the mouse moves faster than the physics-tied node, causing rapid `hoverNode`/`blurNode` toggle. Each `blurNode` called `restoreSelection()` → `syncNeoVisSelection()` with `network.setSelection()`, causing visual flickering.
- Fix: Added `isDragging` flag in `bindNetworkEvents()`, toggled via vis.js `dragStart`/`dragEnd` events. All `handleHoverNode`, `handleBlurNode`, `handleHoverEdge`, `handleBlurEdge` handlers skip their logic when `isDragging` is true.

**4. NeoVis: Multi-node drag on click-then-drag**
- Problem: When clicking a node (which highlights its neighborhood via `syncNeoVisSelection()`), `network.setSelection()` was called with the full neighborhood (focused node + all neighbors). vis.js then treated all those nodes as a group, so dragging moved the entire neighborhood as a single unit.
- Fix: `syncNeoVisSelection()` now separates visual highlighting from programmatic selection. Two sets are maintained:
  - `styleNodeVisIds`/`styleRelationVisIds`: full neighborhood for visual dimming/highlighting via `applyNeoVisSelectionStyles()`
  - `selectionNodeVisIds`/`selectionRelationVisIds`: only the directly focused item (single node or relation endpoints) for `network.setSelection()`
  - `addConnectedNeighborhood()` now accepts a target sets parameter so it can populate the style sets independently from the selection sets.
- This ensures vis.js only considers the single focused node as "selected" for interaction, so dragging only moves that one node while the visual neighborhood highlighting remains intact.

### Artifacts Changed
- `src/server/public/app.js` — `previewSelection()` rewritten (visual-only); `mouseup` handler enhanced with force layout; `bindNetworkEvents()` has `isDragging` flag and new `dragStart`/`dragEnd` event handlers with guards on hover/blur handlers; `syncNeoVisSelection()` separates visual style sets from interaction selection sets.
- `src/server/public/app.bundle.js` — rebuilt.

### Verification
- `npm run kg:web:build` — bundle compiles successfully (3.2mb, done in ~104ms).

### Comprehensive Code Review: NeoVis Drag/Highlight/Flicker Paths

All NeoVis interaction code paths verified correct:

| Path | Action | Selection (network.setSelection) | Visual Style (applyNeoVisSelectionStyles) |
|---|---|---|---|
| Hover node | visual-only | none | node + neighborhood (via previewSelection) |
| Click node | single node | focused node only | node + neighborhood (via syncNeoVisSelection) |
| Click edge (link) | single relation edge | relation edge only | relation + endpoint nodes (via syncNeoVisSelection) |
| Hover edge | visual-only | none | relation + endpoints (via previewSelection) |
| Blur (hover end) | restore focus | focused item only | full focus state (via restoreSelection → syncNeoVisSelection) |
| Drag start | `isDragging=true` | — (all hover/blur skipped) | — |
| Drag end | `isDragging=false` | — (restoreSelection) | — |

Key invariants:
- `previewSelection()` never calls `network.setSelection()` — visual only.
- `syncNeoVisSelection()` uses separate style sets (full neighborhood) and selection sets (minimal focused item only).
- Relation focus: endpoint nodes are in `styleNodeVisIds` only, not `selectionNodeVisIds` — avoids group drag.
- `isDragging` flag prevents rapid hover/blur toggles during drag — no flicker.
