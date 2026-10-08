
export const GRAPH_RENDERERS = {
	sigma: "sigma",
	neovis: "neovis",
};
export function GraphRendererToggle({ onRendererMode, rendererMode }) {
	return (
		<div class="renderer-toggle" aria-label="Graph renderer" role="group">
			<button
				type="button"
				class={rendererMode === GRAPH_RENDERERS.sigma ? "active" : ""}
				onClick={() => onRendererMode(GRAPH_RENDERERS.sigma)}
			>
				Sigma
			</button>
			<button
				type="button"
				class={rendererMode === GRAPH_RENDERERS.neovis ? "active" : ""}
				onClick={() => onRendererMode(GRAPH_RENDERERS.neovis)}
			>
				NeoVis
			</button>
		</div>
	);
}
