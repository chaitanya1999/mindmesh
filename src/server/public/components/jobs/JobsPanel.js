import { formatHitlDate } from "../../lib/hitlProposal.js";
import { RouteSwitcher } from "../common/RouteSwitcher.js";

export function jobTitle(jobType) {
	return jobType === "scanner" ? "Graph Scanner" : "Knowledge Nugget";
}

export function JobsPanel({
	depth,
	errorMessage,
	isBusy,
	onDepthChange,
	onRunJob,
	result,
	statusMessage,
}) {
	const activeJobTitle = result?.jobType ? jobTitle(result.jobType) : "No job has run yet";
	const anchorLabel = result?.anchorNode?.label || result?.anchorNode?.name || result?.anchorNode?.id || "";

	return (
		<aside class="jobs-panel" aria-label="Graph jobs workspace">
			<header class="hitl-header">
				<div>
					<p class="eyebrow">Graph jobs</p>
					<h2>Manual intelligence jobs</h2>
				</div>
				<div class="hitl-header-actions">
					<RouteSwitcher />
				</div>
			</header>
			<div class="jobs-content">
				<section class="jobs-section">
					<div class="hitl-section-header">
						<h3>Run a job</h3>
						<span>{isBusy ? "Running" : "Ready"}</span>
					</div>
					<label class="field">
						<span>Neighborhood depth</span>
						<select
							value={depth}
							disabled={isBusy}
							onChange={(event) => onDepthChange(Number(event.currentTarget.value))}
						>
							{[0, 1, 2, 3, 4].map((value) => (
								<option value={value} key={value}>{value}</option>
							))}
						</select>
					</label>
					<div class="job-action-grid">
						<button
							type="button"
							class="primary"
							disabled={isBusy}
							onClick={() => onRunJob("scanner")}
						>
							Run Scanner
						</button>
						<button
							type="button"
							disabled={isBusy}
							onClick={() => onRunJob("nugget")}
						>
							Generate Knowledge Nugget
						</button>
					</div>
					{statusMessage && <div class="status-line">{statusMessage}</div>}
					{errorMessage && <div class="status-line error-status">{errorMessage}</div>}
				</section>

				<section class="jobs-section jobs-result-section">
					<div class="hitl-section-header">
						<h3>{activeJobTitle}</h3>
						<span>{result ? `${result.graph?.nodes?.length ?? 0}N / ${result.graph?.relations?.length ?? 0}R` : ""}</span>
					</div>
					{result ? (
						<>
							<div class="detail-kv">
								<span>Anchor</span>
								<strong>{anchorLabel}</strong>
							</div>
							<div class="detail-kv">
								<span>Completed</span>
								<strong>{formatHitlDate(result.completedAt)}</strong>
							</div>
							<pre class="job-output">{result.outputMarkdown || "No output returned."}</pre>
						</>
					) : (
						<div class="empty-review-state">Run a job to inspect a random graph neighborhood.</div>
					)}
				</section>
			</div>
		</aside>
	);
}
