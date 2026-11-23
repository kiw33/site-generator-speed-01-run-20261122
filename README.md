# Build a static site faster — site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as
makefun-site does on every case, and `main.ts` is the program the harness runs
(reads `/input/cases.json`, answers each case alone with `run`, writes
`/output/answers.json`).

## Approach

Written from the makefun-site README (front matter, template dialect, Markdown
subset, slug rule, report), checked against the reference's behaviour — not
copied from it. Same answers, different machinery:

- One line split per source, shared by front matter and Markdown.
- Markdown rendered in a single streaming pass, no token array; inline
  rendering jumps between special characters with one regex and escapes plain
  runs in bulk (`test` then `replace`, the fastest escaping shape measured).
- Slugs memoised per case, with an ASCII fast path (NFKD + `\p{M}` strip only
  for non-ASCII text); link targets memoised the same way.
- Templates compiled once per case into small render functions (codegen from
  the parsed tree); scopes are `{v, p}` chains, includes cap at depth 8.
- Word counts scanned over lines without allocating a match array; each
  post's card is built once and reused by its page.
- `\r\n` normalisation skipped when the source holds no `\r`.

Nothing is cached from one case to the next: every per-case map is rebuilt
inside `run`.

## Practice results (kit practice set, 3 cases)

- **3/3 identical** to the kit's `practice/reference/expected.json`
  (canonical JSON comparison), and 3/3 on each of 5 extra sets drawn from the
  kit's own generator with other seeds (15/15), plus 92/92 hand-built edge
  checks (front-matter refusals, Markdown corners, template parse errors,
  include depth, slug collisions and Unicode, shadowed statics).
- CPU time, whole process, this machine (node v24.22.1, median of 9 runs):
  **mine 1,126 ms vs house baseline 1,679 ms — 1.49x faster** (net of the
  ~150 ms node startup both pay: ~1.57x). The `--no-incremental-marking`
  flag from the house driver is kept; measured ~5% faster with it than
  without on this machine.

## Files

- `solve.js` — the entry: `run(input)` returns the output tree.
- `main.ts` — the driver (same shape as the house baseline's).
- `package.json` — `{"type":"module"}` so node parses `solve.js` as ESM
  without a reparse.
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`).
- `.makefun/owner.json` — the entrant's wallet.
