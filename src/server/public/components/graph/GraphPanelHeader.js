import { GraphRendererToggle } from "./GraphRendererToggle.js";

export function GraphPanelHeader({ onReload, onRendererMode, rendererMode, statsText }) {
	return (
		<header class="panel-header graph-header">
			<div>
				<p class="eyebrow">Knowledge Graph</p>
				<h1 id="graph-title">Graph preview</h1>
			</div>
			<div class="header-actions">
				<GraphRendererToggle onRendererMode={onRendererMode} rendererMode={rendererMode} />
				<button type="button" class="compact-button" onClick={onReload}>Reload</button>
				<div class="graph-stats">{statsText}</div>
			</div>
		</header>
	);
}
