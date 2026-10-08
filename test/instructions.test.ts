import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BUILTIN_CONTEXT_TEMPLATE,
  BoardError,
  analyzeTemplate,
  auditContextTemplates,
  addComment,
  buildContext,
  contextTemplatePath,
  contextTemplatesDir,
  createIssue,
  createPeriod,
  createResource,
  findIssue,
  flagIssue,
  installContextTemplates,
  instructionsFor,
  linkIssue,
  listContextTemplates,
  moveNode,
  renderTemplate,
  resolveContextTemplate,
  shiftHeadings,
  updateNode,
  writeContextTemplate,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const render = (source: string, data: Record<string, unknown> = {}): string =>
  renderTemplate(source, data).text;

describe('the template language', () => {
  it('prints a value, and stringifies it the way a brief needs', () => {
    expect(render('Hi <%= a.b %>', { a: { b: 'there' } })).toBe('Hi there\n');
    expect(render('<%= tags %>', { tags: ['a', 'b'] })).toBe('a, b\n');
    expect(render('<%= n %> <%= ok %>', { n: 0, ok: false })).toBe('0 false\n');
  });

  it('never prints undefined, null or [object Object]', () => {
    // The three things a person reading a brief should not have to interpret.
    const empty = renderTemplate('[<%= a %>][<%= b %>]', { a: null, b: undefined });
    expect(empty.text).toBe('[][]\n');
    expect(empty.warnings[0]).toContain('came out empty');

    const document = renderTemplate('[<%= node %>]', { node: { title: 'Thing' } });
    expect(document.text).toBe('[]\n');
    expect(document.warnings[0]).toContain('a document was printed where a value was expected');
  });

  it('takes a branch, and loops, in ordinary JavaScript', () => {
    const data = { on: true, off: false, status: 'ready', items: [{ n: 'a' }, { n: 'b' }] };
    expect(render('<% if (on) { %>yes<% } else { %>no<% } %>', data)).toBe('yes\n');
    expect(render('<% if (!off) { %>yes<% } %>', data)).toBe('yes\n');
    expect(render('<% if (status === "ready") { %>go<% } %>', data)).toBe('go\n');
    expect(render('<% for (const i of items) { %><%= i.n %> <% } %>', data)).toBe('a b\n');
    // The whole of JavaScript is available, which is the point of using Eta.
    expect(render('<%= items.map((i) => i.n.toUpperCase()).join("/") %>', data)).toBe('A/B\n');
    expect(render('<% items.forEach((i, x) => { %><%= x %>:<%= i.n %> <% }) %>', data)).toBe(
      '0:a 1:b\n',
    );
  });

  it('drops comments, and the whole line a control tag sits on', () => {
    const source = 'a\n<% /* gone */ %>\n<% if (yes) { %>\nb\n<% } %>\nc\n';
    expect(render(source, { yes: true })).toBe('a\nb\nc\n');
    // …but a tag sharing a line with content leaves that content's spacing alone.
    expect(render('x <% if (yes) { %>y<% } %> z', { yes: true })).toBe('x y z\n');
  });

  it('offers the helpers markdown needs and JavaScript has no opinion about', () => {
    expect(render('<%= join(a, " / ") %>', { a: ['x', 'y'] })).toBe('x / y\n');
    expect(render('<%= truncate(a, 4) %>', { a: 'abcdefg' })).toBe('abc…\n');
    expect(render('<%= def(missing, "—") %>', { missing: null })).toBe('—\n');
    expect(render('<%= text(a) %>', { a: ['x', 'y'] })).toBe('x, y\n');
    expect(render('- <%= indent(a, 2) %>', { a: 'one\ntwo' })).toBe('- one\n  two\n');
    expect(render('<%= heading(a, 3) %>', { a: '# T' })).toBe('### T\n');
    // `def` fills the gap rather than warning about it.
    expect(renderTemplate('<%= def(missing, "—") %>', { missing: null }).warnings).toEqual([]);
  });

  it('warns about a name the board does not answer, rather than failing on it', () => {
    // A layout outlives the vocabulary it was written against: a value the
    // engine used to offer is retired, and every board that installed the
    // starter before that keeps its copy. Such a template has to go on
    // rendering — missing data is a warning, never a failure — or one removal
    // breaks the brief on every board that had already pulled it.
    const gone = renderTemplate('<% if (informs.length) { %>rests on<% } %>ok', {});
    expect(gone.text).toBe('ok\n');
    expect(gone.warnings.join('\n')).toContain('informs');

    // Empty in every way a layout asks about a name: falsy for a plain guard,
    // zero-length for a list guard, nothing to walk, and safe to reach through.
    expect(render('<% if (informs) { %>no<% } %>yes', {})).toBe('yes\n');
    expect(render('<% for (const x of informs) { %><%= x %><% } %>ok', {})).toBe('ok\n');
    expect(render('[<%= informs %>][<%= informs.title %>]', {})).toBe('[][]\n');
    expect(render('<%= def(informs, "—") %>', {})).toBe('—\n');

    // The warning names the identifier, because that is the whole of the fix.
    expect(renderTemplate('<%= informs %><%= mystery %>', {}).warnings).toHaveLength(2);
    // A name the data does answer is never warned about, whatever it holds.
    expect(renderTemplate('<%= here %>', { here: 'x' }).warnings).toEqual([]);
  });

  it('still lets a real global through, so the safety check stays the only gate', () => {
    // Only names that nothing answers become empty. A template naming a global
    // resolves it exactly as before, so what may be reached is `analyze.ts`'s
    // decision and not a side effect of this.
    expect(render('<%= Math.max(1, 2) %>', {})).toBe('2\n');
    expect(render('<%= JSON.stringify(a) %>', { a: { n: 1 } })).toBe('{"n":1}\n');
    expect(renderTemplate('<%= Math.max(1, 2) %>', {}).warnings).toEqual([]);
  });

  it('reports a template it cannot parse or run, naming the file', () => {
    expect(() => render('<% if (a) { %>x')).toThrow(BoardError);
    expect(() => renderTemplate('<% if (a) { %>x', {}, { name: 'one.md' })).toThrow(/one\.md|parse/);
    // Reaching through something that is not there is a JavaScript TypeError,
    // exactly as it would be in EJS. Guard with `<% if %>` or `?.`.
    expect(() => render('<%= a.b.c %>', { a: {} })).toThrow(/Cannot render/);
    expect(render('<%= a.b?.c %>', { a: {} })).toBe('');
  });
});

describe('the safety check', () => {
  const findings = (source: string): string[] =>
    analyzeTemplate(source)
      .findings.filter((finding) => finding.severity === 'danger')
      .map((finding) => finding.rule);

  it('passes a template that only lays an issue out', () => {
    const safe =
      '# <%= issue.title %>\n<% if (epic) { %><%= heading(epic.body, 3) %><% } %>\n' +
      '<% for (const c of children) { %>- <%= c.title %>\n<% } %>\n<%= children[0].id %>';
    expect(analyzeTemplate(safe).findings).toEqual([]);
    expect(analyzeTemplate('# <%= issue.title %>').codeTags).toBe(1);
    expect(analyzeTemplate('# just markdown').inert).toBe(true);
  });

  it('refuses the ways out of the template and into the host', () => {
    expect(findings('<%= process.env.HOME %>')).toEqual(['host-global']);
    expect(findings('<% require("fs") %>')).toEqual(['host-global']);
    expect(findings('<% eval("x") %>')).toEqual(['host-global']);
    expect(findings('<% new Function("return 1")() %>')).toEqual(['host-global']);
    expect(findings('<% globalThis.x %>')).toEqual(['host-global']);
    expect(findings('<% fetch("http://evil.test") %>')).toEqual(['host-global']);
    expect(findings('<% import("node:fs") %>')).toEqual(['dynamic-import']);
    expect(findings('<% with (x) { } %>')).toContain('with-statement');
  });

  it('refuses the escape that needs none of those names spelled', () => {
    // `this` is the Eta instance, so this is a real sandbox escape.
    expect(findings('<%= this.constructor.constructor("return process")() %>')).toEqual([
      'this-expression',
      'escape-property',
      'escape-property',
    ]);
    expect(findings('<%= issue.__proto__ %>')).toEqual(['escape-property']);
    expect(findings('<%= issue["constructor"] %>')).toEqual(['escape-property']);
  });

  it('refuses a computed key, because that is how a name check is evaded', () => {
    expect(findings('<%= issue["cons" + "tructor"] %>')).toEqual(['computed-member']);
    expect(findings('<%= issue[key] %>')).toEqual(['computed-member']);
    // A literal index or key is as readable as a dotted one, so it is allowed.
    expect(findings('<%= children[0].title %>')).toEqual([]);
    expect(findings('<%= issue.attributes["story_points"] %>')).toEqual([]);
  });

  it('refuses Eta’s own file-reading helpers', () => {
    expect(findings('<%~ include("../../../../etc/passwd") %>')).toEqual(['host-global']);
    expect(findings('<% layout("/tmp/x") %>')).toEqual(['host-global']);
  });

  it('finds code hidden where a regex scanner would not look', () => {
    // Eta's lexer treats `%>` inside a string as content, so a scanner that did
    // not use it would stop the tag early and miss everything after it.
    expect(findings('<%= "a %> b" + process.pid %>')).toEqual(['host-global']);
    expect(findings('<%= /* c */ process.pid %>')).toEqual(['host-global']);
  });

  it('cautions about what hangs rather than escapes', () => {
    const analysis = analyzeTemplate('<% while (true) { %>x<% } %>');
    expect(analysis.findings.map((finding) => finding.severity)).toEqual(['caution']);
    expect(analysis.findings[0]!.rule).toBe('unbounded-loop');
    // A bounded walk over the board is the normal thing and stays clean.
    expect(analyzeTemplate('<% for (const c of children) { %>x<% } %>').findings).toEqual([]);
  });

  it('points at the line in the template, not in the generated code', () => {
    const [finding] = analyzeTemplate('# Title\n\nsome prose\n\n<%= process.pid %>\n').findings;
    expect(finding!.line).toBe(5);
    expect(finding!.column).toBe(5);
    expect(finding!.snippet).toBe('process');
  });

  it('refuses to render what it refuses, unless explicitly told otherwise', () => {
    expect(() => renderTemplate('<%= process.pid %>', {}, { name: 'evil.md' })).toThrow(
      /Refusing to render evil\.md/,
    );
    // The escape hatch is for a template you wrote and meant.
    const forced = renderTemplate('<%= typeof process %>', {}, { allowUnsafe: true });
    expect(forced.text).toBe('object\n');
    expect(forced.findings.map((finding) => finding.rule)).toEqual(['host-global']);
  });

  it('is applied to every layout, including the built-in one', () => {
    expect(analyzeTemplate(BUILTIN_CONTEXT_TEMPLATE).findings).toEqual([]);
  });
});

describe('the heading helper', () => {
  it('re-levels a body so its shallowest heading lands where asked', () => {
    expect(shiftHeadings('## A\n### B', 4)).toBe('#### A\n##### B');
    expect(shiftHeadings('# A\n## B', 3)).toBe('### A\n#### B');
    expect(shiftHeadings('#### A', 2)).toBe('## A');
  });

  it('leaves a fenced block alone', () => {
    const body = '## A\n\n```sh\n# not a heading\n```\n\n## B';
    expect(shiftHeadings(body, 3)).toBe('### A\n\n```sh\n# not a heading\n```\n\n### B');
  });

  it('leaves text with no headings untouched', () => {
    expect(shiftHeadings('just prose\n', 4)).toBe('just prose\n');
  });
});

/** `createIssue` always writes the type's scaffold body; this replaces it. */
function withBody(paths: BoardPaths, id: string, body: string): void {
  const board = reload(paths);
  updateNode(board, findIssue(board, id)!, { body });
}

/** program > epic > feature > story, with a sprint, a person and a blocker. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), {
    type: 'user_story',
    title: 'Pay as a guest',
    parentId: 'LP-3',
    attributes: { story_points: 5, priority: 'high' },
  });
  createIssue(reload(paths), { type: 'user_story', title: 'Card vaulting', parentId: 'LP-3' });
  createIssue(reload(paths), { type: 'research', title: 'Which PSP?', parentId: 'LP-3' });

  withBody(paths, 'LP-1', '## Vision\n\nGet paid.');
  withBody(paths, 'LP-2', '## Summary\n\nBuy things.');
  withBody(paths, 'LP-3', '## Summary\n\nNo account needed.');
  withBody(paths, 'LP-4', '## Acceptance Criteria\n\n- [ ] It works');
  withBody(paths, 'LP-6', '## Findings\n\nStripe.');

  createPeriod(reload(paths), {
    type: 'increment',
    title: 'PI-1',
    starts: '2026-08-01',
    ends: '2026-10-31',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Sprint 1',
    parentId: 'TL-1',
    starts: '2026-08-03',
    ends: '2026-08-14',
  });
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });

  linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-5'] });
  moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
    period: 'TL-2',
    assignee: 'RS-1',
  });
  return paths;
}

describe('the context a template sees', () => {
  it('carries the ancestry, outermost first, and the relations around it', () => {
    const board = reload(seed());
    const context = buildContext(board, findIssue(board, 'LP-4')!);

    expect(context.ancestors.map((node) => node.id)).toEqual(['LP-1', 'LP-2', 'LP-3']);
    expect(context.issue.title).toBe('Pay as a guest');
    expect(context.parent?.id).toBe('LP-3');
    expect(context.siblings.map((node) => node.id)).toEqual(['LP-5', 'LP-6']);
    expect(context.blocked_by.map((node) => node.id)).toEqual(['LP-5']);
    expect(context.period?.title).toBe('Sprint 1');
    expect(context.assignee?.title).toBe('Alice Smith');
  });

  it('names each ancestor by its type, on the issue and at the root', () => {
    const board = reload(seed());
    const context = buildContext(board, findIssue(board, 'LP-4')!);

    expect((context.epic as { id: string }).id).toBe('LP-2');
    expect((context.feature as { id: string }).id).toBe('LP-3');
    expect((context.issue.epic as { id: string }).id).toBe('LP-2');
    // A type the board declares but this issue has no ancestor of resolves to
    // null rather than nothing, so `{% if bug %}` is answerable.
    expect(context.bug).toBeNull();
  });

  it('derives the inverse relation, so a blocker lists what waits on it', () => {
    const board = reload(seed());
    const context = buildContext(board, findIssue(board, 'LP-5')!);
    expect(context.blocks.map((node) => node.id)).toEqual(['LP-4']);
    expect(context.blocked_by).toEqual([]);
  });

  it('lists attributes in config order, drops the empty ones, and labels them', () => {
    const board = reload(seed());
    const fields = buildContext(board, findIssue(board, 'LP-4')!).issue.attribute_list;
    expect(fields.map((field) => field.name)).toEqual(['story_points', 'priority']);
    expect(fields[0]!.label).toBe('Story points');
    expect(fields[1]!.value).toBe('high');
  });

  it('carries the files an issue names, and the files the work before it named', () => {
    const paths = seed();
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      relatedFiles: ['docs/prd.md#L10-L42', 'src/checkout/pay.ts'],
    });
    updateNode(reload(paths), findIssue(reload(paths), 'LP-5')!, {
      relatedFiles: ['src/checkout/session.ts'],
    });

    const board = reload(paths);
    const context = buildContext(board, findIssue(board, 'LP-4')!);
    expect(context.related_files).toEqual(['docs/prd.md#L10-L42', 'src/checkout/pay.ts']);

    // The blocker (LP-5) named a file; the research it rests on (LP-6) did not,
    // so only the one with something to say gets an entry.
    expect(context.upstream_files).toHaveLength(1);
    expect(context.upstream_files[0]!.issue.id).toBe('LP-5');
    expect(context.upstream_files[0]!.files).toEqual(['src/checkout/session.ts']);

    // Every document carries its own list, so a layout can print a blocker's.
    expect(context.blocked_by[0]!.related_files).toEqual(['src/checkout/session.ts']);
  });

  it('gives an unflagged issue empty strings, so `if (issue.flag)` reads right', () => {
    const board = reload(seed());
    const context = buildContext(board, findIssue(board, 'LP-4')!);
    expect(context.issue.flag).toBe('');
    expect(context.issue.flag_label).toBe('');
  });

  it('carries the flag and its label when there is one', () => {
    const paths = seed();
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'help',
      comment: 'Need a number',
    });
    const board = reload(paths);
    const context = buildContext(board, findIssue(board, 'LP-4')!);
    expect(context.issue.flag).toBe('help');
    expect(context.issue.flag_label).toBe('Needs help');
  });

  it('reads the work log for the issue only, and only when asked', () => {
    const paths = seed();
    addComment(reload(paths), 'LP-4', { body: 'Started this', author: 'Alice' });
    addComment(reload(paths), 'LP-3', { body: 'Parent note', author: 'Bob' });

    const board = reload(paths);
    const context = buildContext(board, findIssue(board, 'LP-4')!);
    expect(context.comments.map((comment) => comment.body)).toEqual(['Started this']);
    // The ancestry is not opened: a brief would pay for reads nobody asked for.
    expect(context.ancestors.at(-1)!.comments).toEqual([]);

    const without = buildContext(board, findIssue(board, 'LP-4')!, { includeComments: false });
    expect(without.comments).toEqual([]);
  });
});

describe('which template an issue is rendered with', () => {
  it('falls back to the built-in layout when the board has none', () => {
    const paths = makeBoard('scrum', 'LP');
    rmSync(contextTemplatesDir(paths), { recursive: true, force: true });

    const source = resolveContextTemplate(paths, 'user_story');
    expect(source.kind).toBe('builtin');
    expect(source.text).toBe(BUILTIN_CONTEXT_TEMPLATE);
    expect(listContextTemplates(paths)).toEqual([]);
  });

  it('prefers the type, then default, then the built-in', () => {
    const paths = makeBoard('scrum', 'LP');
    rmSync(contextTemplatesDir(paths), { recursive: true, force: true });

    writeContextTemplate(paths, 'default', 'D');
    expect(resolveContextTemplate(paths, 'user_story').name).toBe('default');

    writeContextTemplate(paths, 'user_story', 'U');
    expect(resolveContextTemplate(paths, 'user_story').name).toBe('user_story');
    expect(resolveContextTemplate(paths, 'bug').name).toBe('default');
  });

  it('takes an override as a board template first and as a path second', () => {
    const paths = makeBoard('scrum', 'LP');
    const file = path.join(paths.root, 'mine.md');
    writeFileSync(file, 'from a file', 'utf8');

    expect(resolveContextTemplate(paths, 'bug', 'user_story').kind).toBe('board');
    expect(resolveContextTemplate(paths, 'bug', file).kind).toBe('file');
    expect(() => resolveContextTemplate(paths, 'bug', 'nope')).toThrow(/No context template/);
  });
});

describe('the starter templates', () => {
  it('are written by init for the types this board declares', () => {
    const scrum = makeBoard('scrum', 'LP');
    const names = listContextTemplates(scrum);
    expect(names).toContain('default');
    expect(names).toContain('user_story');
    expect(names).toContain('research');
    // `story` and `task` belong to the kanban hierarchy, which this board has not.
    expect(names).not.toContain('story');

    const kanban = makeBoard('kanban', 'KB');
    expect(listContextTemplates(kanban)).toContain('story');
    expect(listContextTemplates(kanban)).not.toContain('user_story');
  });

  it('never overwrite an edited layout unless forced', () => {
    const paths = makeBoard('scrum', 'LP');
    const file = contextTemplatePath(paths, 'user_story');
    writeFileSync(file, 'mine', 'utf8');

    const kept = installContextTemplates(paths, reload(paths).config);
    expect(kept.written).toEqual([]);
    expect(kept.skipped).toContain('user_story');
    expect(readFileSync(file, 'utf8')).toBe('mine');

    const forced = installContextTemplates(paths, reload(paths).config, { force: true });
    expect(forced.written).toContain('user_story');
    expect(readFileSync(file, 'utf8')).not.toBe('mine');
  });

  it('keep default.md and the built-in layout in step', () => {
    const paths = makeBoard('scrum', 'LP');
    // The starters are an *ejection* of the built-in layout: writing them must
    // change nothing until somebody edits one. Strip the starter's leading
    // comment block, which exists only to tell a reader where they are.
    const shipped = resolveContextTemplate(paths, 'no_such_type').text;
    expect(shipped.replace(/^(<% \/\*[\s\S]*?\*\/ %>\r?\n)+/, '')).toBe(BUILTIN_CONTEXT_TEMPLATE);
  });

  it('every shipped starter parses, and none of them can reach the host', () => {
    for (const template of ['scrum', 'kanban', 'blank'] as const) {
      const paths = makeBoard(template, 'LP');
      const board = reload(paths);
      for (const type of Object.keys(board.config.issue_types)) {
        const source = resolveContextTemplate(paths, type);
        // `analyzeTemplate` parses without running, which is the only way to
        // check a layout that needs a board to render.
        expect(() => analyzeTemplate(source.text), `${template}/${type}`).not.toThrow();
        expect(analyzeTemplate(source.text).findings, `${template}/${type}`).toEqual([]);
      }
    }
  });

  it('are audited as a set, so a poisoned one fails the whole board', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(auditContextTemplates(reload(paths)).flatMap((audit) => audit.findings)).toEqual([]);

    writeContextTemplate(paths, 'bug', '<%= require("fs").readFileSync("/etc/passwd") %>', true);
    const audit = auditContextTemplates(reload(paths));
    const dangers = audit.flatMap((entry) =>
      entry.findings.filter((finding) => finding.severity === 'danger'),
    );
    expect(dangers).toHaveLength(1);
    expect(dangers[0]!.rule).toBe('host-global');
    // Reachable-but-unused layouts are audited too, not just the ones a type resolves to.
    writeContextTemplate(paths, 'spare', '<%= process.pid %>', true);
    expect(auditContextTemplates(reload(paths)).some((entry) => entry.source.name === 'spare')).toBe(
      true,
    );
  });
});

describe('the brief itself', () => {
  it('is the ancestors’ titles and bodies, then the issue’s own', () => {
    const paths = seed();
    rmSync(contextTemplatesDir(paths), { recursive: true, force: true });
    const { text, source } = instructionsFor(reload(paths), 'LP-4');

    expect(source.kind).toBe('builtin');
    for (const fragment of ['Payments', 'Get paid.', 'Checkout', 'Buy things.', 'Guest flow']) {
      expect(text).toContain(fragment);
    }
    // Outermost body first, innermost last, the issue's own after all of them.
    expect(text.indexOf('Get paid.')).toBeLessThan(text.indexOf('Buy things.'));
    expect(text.indexOf('Buy things.')).toBeLessThan(text.indexOf('No account needed.'));
    expect(text.indexOf('No account needed.')).toBeLessThan(text.indexOf('- [ ] It works'));
  });

  it('carries the blockers and the fields, but not an unlinked sibling', () => {
    const paths = seed();
    rmSync(contextTemplatesDir(paths), { recursive: true, force: true });
    const { text } = instructionsFor(reload(paths), 'LP-4');
    expect(text).toContain('**LP-5** Card vaulting');
    expect(text).toContain('**Story points**: 5');
    // LP-6 sits in the same feature and nothing links the two. A brief is the
    // ancestry plus the graph, not everything that happens to be nearby.
    expect(text).not.toContain('Stripe.');
  });

  it('shows the files, both directions along the graph, and a flag if there is one', () => {
    const paths = seed();
    rmSync(contextTemplatesDir(paths), { recursive: true, force: true });
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      relatedFiles: ['docs/prd.md#L10-L42'],
    });
    updateNode(reload(paths), findIssue(reload(paths), 'LP-5')!, {
      relatedFiles: ['src/checkout/session.ts'],
    });
    // Something waiting on LP-4, so the downstream section has content. It has
    // to be a fresh story: LP-4 already rests on the research in LP-6 and is
    // already blocked by LP-5, and both edges gate, so either would be a cycle.
    createIssue(reload(paths), { type: 'user_story', title: 'Refund flow', parentId: 'LP-3' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-7')!, { dependsOn: ['LP-4'] });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'Waiting on the sandbox key',
    });

    const { text } = instructionsFor(reload(paths), 'LP-4');

    expect(text).toContain('Files this is about');
    expect(text).toContain('`docs/prd.md#L10-L42`');
    // Where it comes from, and what that work touched.
    expect(text).toContain('Where this comes from');
    expect(text).toContain('**LP-5**: src/checkout/session.ts');
    // Where it is going.
    expect(text).toContain('Where this is going');
    expect(text).toContain('Refund flow (LP-7');
    // The flag leads, and the reason is in the log below it.
    expect(text).toContain('flagged: Blocked');
    expect(text.indexOf('flagged: Blocked')).toBeLessThan(text.indexOf('## The work'));
    expect(text).toContain('Waiting on the sandbox key');
  });

  it('renders with the board’s own layout when it has one, warning about nothing', () => {
    const paths = seed();
    const brief = instructionsFor(reload(paths), 'LP-4');
    expect(brief.source.kind).toBe('board');
    expect(brief.source.path).toContain('user_story.md');
    expect(brief.warnings).toEqual([]);
    expect(brief.text).toContain('## Epic: Checkout (LP-2)');
  });

  it('renders a layout left over from a vocabulary the engine has retired', () => {
    // The regression: `informed_by` was removed, and with it the `informs`
    // value the shipped `research.md` printed. The starter was updated, but an
    // install never overwrites what is already there — so every board that had
    // installed the old one held a layout naming a value that no longer
    // existed, and every brief rendered from it died on a ReferenceError. That
    // took `lpm queue agent` down mid-run, after it had already claimed a task.
    const paths = seed();
    writeContextTemplate(
      paths,
      'user_story',
      [
        '# <%= issue.id %> — <%= issue.title %>',
        '',
        '<% if (informs.length) { %>',
        '## What already rests on this',
        '<% for (const built of informs) { %>',
        '- <%= built.id %>',
        '<% } %>',
        '<% } %>',
        'The work: <%= issue.title %>',
      ].join('\n'),
      true,
    );

    const brief = instructionsFor(reload(paths), 'LP-4');
    expect(brief.text).toContain('LP-4 — Pay as a guest');
    expect(brief.text).toContain('The work: Pay as a guest');
    // The section the retired value fed is dropped, not half-printed.
    expect(brief.text).not.toContain('What already rests on this');
    // And the board is told which name to take out of its layout.
    expect(brief.warnings.join('\n')).toContain('informs');
  });

  it('takes an override, and resolves ids case-insensitively', () => {
    const paths = seed();
    const file = path.join(paths.root, 'tiny.md');
    writeFileSync(file, 'Do <%= issue.id %>: <%= issue.title %>', 'utf8');
    const brief = instructionsFor(reload(paths), 'lp-4', { template: file });
    expect(brief.text).toBe('Do LP-4: Pay as a guest\n');
  });

  it('says which issue it cannot find', () => {
    expect(() => instructionsFor(reload(seed()), 'LP-999')).toThrow(/No issue with id/);
  });

  it('never leaves a hole where an empty section was', () => {
    const paths = seed();
    const board = reload(paths);
    updateNode(board, findIssue(board, 'LP-5')!, { body: '' });
    const { text } = instructionsFor(reload(paths), 'LP-5');
    expect(text).not.toMatch(/\n{3}/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is a file the board can hold, not board truth', () => {
    const paths = makeBoard('scrum', 'LP');
    // Templates live under `.lpm/templates`, which `load.ts` never walks.
    expect(existsSync(path.join(paths.lpmDir, 'templates', 'context', 'default.md'))).toBe(true);
    expect(reload(paths).problems).toEqual([]);
  });
});
