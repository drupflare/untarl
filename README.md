# 📦 untarl

> Tar and tar.gz extraction with no dependencies and no Node APIs

[![Build](https://github.com/drupflare/untarl/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/untarl/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/untarl/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/untarl/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/untarl/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/untarl)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Reads a `.tar` or `.tar.gz` on workerd, in the browser, in Bun and in Node, with the same
code and zero dependencies.** Gzip is handled by the platform's own
`DecompressionStream('gzip')` rather than a bundled inflater, which is what keeps the
dependency count at zero and the bundle cost at nothing.

---

## 📋 Table of Contents

- [Why](#-why)
- [Install](#-install)
- [Usage](#-usage)
- [API](#-api)
- [Untrusted Input](#-untrusted-input)
- [Out of Scope](#-out-of-scope)
- [Testing](#-testing)
- [Related Repositories](#-related-repositories)
- [License](#-license)

---

## 🎯 Why

The original problem was installing a Drupal contrib module at runtime, which means reading a
drupal.org `.tar.gz` from inside a Cloudflare Worker. Two obvious answers were both closed:

1. **Do it in PHP.** The wasm build has neither `ext-zip` nor `ext-phar`, and adding either is
   a multi-hour Docker rebuild of the interpreter.
2. **Use a tar library.** Every popular one reaches for `node:zlib`, `node:fs` or `Buffer`.
   workerd has none of those.

What workerd does have is `DecompressionStream('gzip')`, natively. And tar is nothing but
512-byte blocks with an octal header. So the whole job fits in ~320 lines of platform-only
JavaScript, out where `await` is legal and no build flag has to change.

---

## 📥 Install

```sh
bun add @drupflare/untarl
```

**One entry point.** The `exports` map declares `.` and `./package.json` and nothing
else, so every symbol arrives from `@drupflare/untarl` and `@drupflare/untarl/src/untar.ts` is refused
by the resolver. A second name for the only module would be two ways to import the same thing with no
way to say which is canonical; the sibling `cartridge` splits by subpath because its modules have
different dependency costs, and here there are none to differ.

---

## 🚀 Usage

The common case is two calls: inflate and parse, then flatten to the files you want to write.

```ts
import { tarEntryTree, untarGzip } from '@drupflare/untarl';

const response = await fetch('https://ftp.drupal.org/files/projects/token-8.x-1.15.tar.gz');
const entries = await untarGzip(response.body!);

// strip = 1 drops the `token/` wrapper every drupal.org tarball has
for (const [path, bytes] of tarEntryTree(entries, 1)) {
  // write `bytes` to `path` here
}
```

If you already hold the bytes, or the archive is not gzipped, skip straight to the parser:

```ts
import { parseTar } from '@drupflare/untarl';

const entries = parseTar(new Uint8Array(await file.arrayBuffer()));
const names = entries.filter((e) => e.type === 'file').map((e) => e.name);
```

---

## 🔧 API

| Export                            | Signature                                             | What it does                                                             |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `untarGzip(stream)`               | `(ReadableStream<Uint8Array>) => Promise<TarEntry[]>` | gunzips through `DecompressionStream`, then parses                       |
| `parseTar(bytes)`                 | `(Uint8Array) => TarEntry[]`                          | parses a POSIX/ustar archive faithfully; refuses nothing on path grounds |
| `tarEntryTree(entries, strip= 1)` | `(TarEntry[], number) => Map<string, Uint8Array>`     | flattens to the files to write, refusing paths that escape               |
| `TarEntry`                        | `{ name, size, type, mode, bytes }`                   | one member; `bytes` is an owned copy, so the archive can be released     |
| `TarEntryType`                    | `'file' \| 'directory'`                               | the several typeflags that mean the same thing, folded together          |
| `TarParseError`                   | `Error & { offset?: number }`                         | malformed, truncated or out-of-range archive                             |
| `TarPathError`                    | `Error & { path: string }`                            | a member path that would escape the target directory                     |

**The split between the two error types is the design.** `parseTar()` is faithful to the bytes
and will happily hand back an entry whose name climbs out of the target directory with `..`
segments. `tarEntryTree()` decides what is safe to write and is the only layer that throws
`TarPathError`. Separating them lets you inspect a hostile archive without a parser that lies about
its contents.

---

## 🛡 Untrusted Input

A tarball off the network is untrusted, so every read is bounds-checked and every failure is a
**named** error rather than a read past the end of the buffer, an infinite loop, or a plausible
empty result.

| Refused                                           | Error                                           |
| ------------------------------------------------- | ----------------------------------------------- |
| a header cut short by a truncated download        | `TarParseError`, with the byte offset           |
| a `size` field that overruns the buffer           | `TarParseError`                                 |
| a non-octal `size` or `mode`                      | `TarParseError`                                 |
| a nameless entry                                  | `TarParseError`                                 |
| an absolute member path                           | `TarPathError`, from `tarEntryTree()`           |
| a member path containing `..`                     | `TarPathError`, from `tarEntryTree()`           |
| a hostile **directory** name, even though dropped | `TarPathError` — checked before the type filter |
| a negative or non-integer `strip`                 | `RangeError`                                    |

**The header checksum at offset 148 is not enforced.** Writers disagree on whether
that field sums the bytes as signed or unsigned, so enforcing it rejects real archives; the octal
and bounds checks already stop a malformed header from being read. That is a decision, not an
omission.

---

## 🚫 Out of Scope

- **It does not stream the parse.** The archive is buffered whole, because a tar header carries no
  back-pointer: an entry cannot be found without walking every block before it. For a contrib
  module that is a few megabytes, which is the size this was built for.
- **It does not follow links.** Symlinks, hard links and device nodes are consumed and dropped.
  Nothing in a module install should follow one.
- **It does not write files.** `tarEntryTree()` hands you a `Map`; where those bytes land is yours.
- **It does not create archives.** Extraction only.

It does handle the shapes real drupal.org tarballs contain: the ustar `prefix` split, GNU `L` long
names, pax `x`/`g` headers (skipped, though an `x` header's `path=` record renames the entry it
describes), and the v7 habit of writing a directory as typeflag `0` with a trailing slash.

---

## 🧪 Testing

```sh
bun run typecheck
bun run test # 87 assertions across 2 specs
bun run test:coverage
```

**87 passing**, at **98.67% statements**, over archives built in the spec rather than checked-in
fixtures, so every refusal above has a case that trips it.

The one uncovered line is `src/untar.ts:231`, the "does not advance" guard. It is provably
unreachable: `next` is `headerAt + 512 + ceil(size / 512) * 512`, so
`next <= headerAt` cannot hold while a header is a whole block. It stays because the failure it
guards against is a hang rather than an error.

---

## 🔗 Related Repositories

| Repository                                                      | What it is                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)       | the consumer: Drupal 11 on Cloudflare Workers, which reads module tarballs      |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge) | the host side of running a blocking interpreter in a Durable Object             |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb) | the measured limits of Durable Object SQLite, plus the codec that survives them |

---

## 📄 License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
