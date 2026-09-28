# os-eco CLI brand standard

[Back to the README](../README.md)

Every os-eco CLI (seeds, mulch, roots, ...) looks and behaves the same way.
This file is the target state. Each tool implements it with its own code:
there is no shared runtime package (roots stays zero-dependency).

`trellis brand <repo-path>` checks the static rules (marked **checked**). It
reports findings and exits `0`; `--fail-on findings` exits `2`. It never
feeds the sloppiness index.

## Package

- **Bin pair** (checked, `bin-pair`). `package.json` `bin` has the long name
  and a short alias. The long name is the package name without the scope and
  `-cli`: `seeds`/`sd`, `mulch`/`ml`, `roots`/`<short>`.
- **Description** (checked, `description`). One plain line, no emoji, in the
  style `<Git-native noun> for AI agents`.

## README

- **Badges** (checked, `readme-badges`). npm version, CI workflow, and
  license badges at the top:

  ```md
  [![npm](https://img.shields.io/npm/v/@os-eco/<tool>-cli)](https://www.npmjs.com/package/@os-eco/<tool>-cli)
  [![CI](https://github.com/jayminwest/<tool>/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/<tool>/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  ```

## Commands

- **Agent commands** (checked, `commands`). The CLI registers `prime`,
  `onboard`, and `setup` (with a `setup claude` subcommand). The check looks
  for commander `.command("<name>")` calls in `src/` (tests excluded); it
  does not verify the `claude` subcommand.
- **Guard hooks.** `setup claude` installs agent hooks that block hand-edits
  of the tool's JSONL files. Agents change data through the CLI only.

## Output

- **Color.** One accent color per tool for its brand (seeds green
  `rgb(124,179,66)`, mulch brown `rgb(139,90,43)`). IDs use the shared amber
  `rgb(255,183,77)`. Color is off for `NO_COLOR`, a non-TTY stdout, and
  `--json`.
- **Errors.** `Error: <msg>` on stderr, then an optional `Hint: <fix>` line.
  Exit code `1`.
- **JSON.** `--json` prints one envelope:
  `{ "success": boolean, "command": string, "error"?: string, "code"?: string }`
  plus the command's own fields.
