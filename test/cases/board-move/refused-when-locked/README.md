# Case: a move is refused while another process writes the board

The project `project` has a local board. Another process holds the board lock
`project/.lpm/lock`: it is in the middle of "a long import". The command is
`lpm store move --to central`.

## The folder tree before the move

`inputs/case.json` lists the files. The runner writes them to a temporary
folder, called `<tmp>` below. In the lock file it replaces `{{pid}}` with the
id of the test process, `{{host}}` with this computer and `{{now}}` with the
current time. The lock therefore looks held by a live process, not left behind
by a crash.

```
<tmp>/
├── home/settings.json        { "central_store": "<tmp>/store" }
├── project/.lpm/
│   ├── config.yml
│   ├── lock                  held by "someone", doing "a long import"
│   ├── state.json
│   └── board/LP-1/_issue.md
└── store/                    the central store, empty
```

## The expected result, step by step

1. `relocateBoard` takes the board lock before it copies anything.
2. The lock is held, and it is not older than `LPM_LOCK_STALE_MS`. The runner
   sets `LPM_LOCK_TIMEOUT_MS=150`, so the move waits 150 ms.
3. The lock is still held, so the move throws a `BoardError`. The message
   names the holder: `someone is doing "a long import"`
   (`outputs/error.txt`).
4. No file changed. The central store holds no folder, not even an empty
   `.lpm_central`.

`outputs/tree.txt` lists every file after the refused move, without `home/`.
It equals the tree before the move.

## Run it

```bash
npx vitest run test/board-move-cases.test.ts -t refused-when-locked
```
