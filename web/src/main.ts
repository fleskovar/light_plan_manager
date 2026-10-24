import { mount } from 'svelte';
import type { HubInfoDto } from '$shared';
import App from './App.svelte';
import ProjectsApp from './features/projects/ProjectsApp.svelte';
import { PROJECTS_PATH } from './lib/app/projects-link.js';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');

/**
 * `lpm ui` serves one of two servers. A board server serves one board, and
 * the editor (`App`) shows it. The hub, which `lpm ui` serves outside a board
 * when a central store is set, serves no board. Only the hub answers
 * `GET /api/hub`, so that request decides which app to mount.
 *
 * The page "All projects" (`ProjectsApp`) is the landing page of the hub, and
 * the page at `/projects` on a board server (File > All projects…).
 */
async function hubInfo(): Promise<HubInfoDto | null> {
  try {
    const response = await fetch('/api/hub');
    return response.ok ? ((await response.json()) as HubInfoDto) : null;
  } catch {
    return null;
  }
}

export default hubInfo().then((hub) =>
  hub || window.location.pathname === PROJECTS_PATH
    ? mount(ProjectsApp, { target, props: { hub } })
    : mount(App, { target }),
);
