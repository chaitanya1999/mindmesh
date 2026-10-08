
const APP_ROUTES = [
	{ href: "/", label: "Ask/Ingest" },
	{ href: "/hitl", label: "HITL" },
	{ href: "/jobs", label: "Jobs" },
	{ href: "/schema", label: "Schema" },
];
function normalizedRoutePath(pathname = window.location.pathname) {
	return pathname.replace(/\/+$/, "") || "/";
}

export function RouteSwitcher() {
	const currentPath = normalizedRoutePath();
	const activeRoute = APP_ROUTES.find((route) => route.href === currentPath) ?? APP_ROUTES[0];
	const renderRouteLinks = () => APP_ROUTES.map((route) => (
		<a
			class={`route-switcher-link${route.href === activeRoute.href ? " active" : ""}`}
			href={route.href}
			key={route.href}
			aria-current={route.href === activeRoute.href ? "page" : undefined}
		>
			{route.label}
		</a>
	));

	return (
		<nav class="route-switcher" aria-label="Workspace navigation">
			<div class="route-switcher-links">
				{renderRouteLinks()}
			</div>
			<details class="route-switcher-menu">
				<summary>{activeRoute.label}</summary>
				<div>
					{renderRouteLinks()}
				</div>
			</details>
		</nav>
	);
}
