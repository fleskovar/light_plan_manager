import { mount } from 'svelte';
import Viewer from './Viewer.svelte';
import '../app.css';

/**
 * The read-only viewer's entry point.
 *
 * A second bundle of the same sources, built by `web/vite.viewer.config.ts` with
 * relative asset paths so it runs from any subdirectory. It talks to no server:
 * `lpm export` puts a board.json beside it and this reads that.
 */
const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');

export default mount(Viewer, { target });
