# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/putrisilsi213-boop/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/putrisilsi213-boop/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` is a command-line tool that applies AI-written edits to a tree of text files, in four
formats, to one written specification (`SPEC.md`): unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. Every file is changed
or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory; when absent or `-`,
  the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the
  default) detects it.
- `--check` does everything but write: the same output and exit code, no file created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits are found at the first of three matching tiers: exact lines, lines equal once trailing
spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are
removed. A patch that changes nothing prints only `ok: 0 files`.

## Files

- `main.ts`: the CLI. Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.
