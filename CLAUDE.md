# untarl

Dependency-free tar extraction that runs on **workerd**. Extracted from `drupflare/worker`, where it
exists so that PHP's `ext-zip` and `ext-phar` could stay dropped from the wasm build.

## Why it exists at all, which is the constraint to preserve

**No Node APIs.** Not `node:zlib`, not `Buffer`, not `node:fs`. workerd does not have them, and the
whole point of this package is being usable where they are absent. If a change needs a Node builtin,
the change is wrong.

It also must not grow a dependency for decompression. Gzip handling belongs to the caller
(`DecompressionStream` is available on the platform); this package parses tar.

## Rules

- Zero runtime dependencies. This is the product, not a preference.
- Refuse with a named error rather than guessing on a malformed header. A tar reader that silently
  produces a partial tree is worse than one that stops.
- Path traversal (`../`, absolute paths) must be rejected, not normalised. In the parent project an
  entry escaping the mount root was a real hazard, and the mount layer refuses absolute paths for the
  same reason.
- Build fixtures with `makeTar()`, which emits a correct checksum, and never loosen a parser check to
  make a hand-built one pass. Synthetic fixtures have agreed with the implementation while both were
  wrong more than once in this project's history, so a fixture and a parser must never be changed in
  the same edit; if a real archive is needed as a control, read it in the consumer.
- The `exports` map is the whole public surface. `.` and `./package.json`, no deep import, no second
  name for `src/untar.ts` — `tests/exports.spec.ts` pins that, along with `files` and `sideEffects`.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files. bun resolves this; `node` does not.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.
- Every behaviour change ships with its test in the same change.
