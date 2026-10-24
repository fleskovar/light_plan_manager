import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasWindow, openIssueWindow } from '$lib/app/issue-window.js';
import { issueHash, parseRoute } from '$lib/app/router.svelte.js';

/** A window with the parts that `issue-window.ts` reads and writes. */
interface FakeWindow {
  name: string;
  opener: FakeWindow | null;
  location: { href: string; hash: string };
  focus: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
}

function fakeWindow(name: string, hash = '', opener: FakeWindow | null = null): FakeWindow {
  return {
    name,
    opener,
    location: { href: `http://localhost:4000/${hash}`, hash },
    focus: vi.fn(),
    open: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('issueHash', () => {
  it('gives a hash that parseRoute reads back', () => {
    expect(parseRoute(issueHash('LP-3', 'road map'))).toEqual({ name: 'issue', nodeId: 'LP-3', viewId: 'road map' });
  });
});

describe('openIssueWindow', () => {
  it('loads the issue into a new window that has the name issue-<id>', () => {
    const main = fakeWindow('', '#/view/v');
    const opened = fakeWindow('issue-LP-3');
    main.open.mockReturnValue(opened);
    vi.stubGlobal('window', main);

    openIssueWindow('LP-3', 'v');

    expect(main.open).toHaveBeenCalledWith('', 'issue-LP-3', expect.any(String));
    expect(opened.location.href).toBe('http://localhost:4000/#/issue/LP-3?view=v');
    expect(opened.focus).toHaveBeenCalled();
  });

  it('brings a window that already shows the issue to the front without loading it again', () => {
    const main = fakeWindow('', '#/view/v');
    const existing = fakeWindow('issue-LP-3', '#/issue/LP-3?view=v');
    const before = existing.location.href;
    main.open.mockReturnValue(existing);
    vi.stubGlobal('window', main);

    openIssueWindow('LP-3', 'v');

    expect(existing.location.href).toBe(before);
    expect(existing.focus).toHaveBeenCalled();
  });

  it('does nothing when the browser blocks the popup', () => {
    const main = fakeWindow('');
    main.open.mockReturnValue(null);
    vi.stubGlobal('window', main);

    expect(() => openIssueWindow('LP-3', 'v')).not.toThrow();
  });
});

describe('canvasWindow', () => {
  it('is the opener of an issue window that the canvas opened', () => {
    const main = fakeWindow('');
    vi.stubGlobal('window', fakeWindow('issue-LP-3', '', main));
    expect(canvasWindow()).toBe(main);
  });

  it('skips each issue window in the chain of openers', () => {
    const main = fakeWindow('');
    const first = fakeWindow('issue-LP-3', '', main);
    const second = fakeWindow('issue-LP-4', '', first);
    vi.stubGlobal('window', fakeWindow('issue-LP-5', '', second));
    expect(canvasWindow()).toBe(main);
  });

  it('stops at a detached view window, which has a canvas of its own', () => {
    const main = fakeWindow('');
    const detached = fakeWindow('lpm-view-abc', '', main);
    vi.stubGlobal('window', fakeWindow('issue-LP-3', '', detached));
    expect(canvasWindow()).toBe(detached);
  });

  it('is null for a window that no window opened', () => {
    vi.stubGlobal('window', fakeWindow('issue-LP-3'));
    expect(canvasWindow()).toBeNull();
  });
});
