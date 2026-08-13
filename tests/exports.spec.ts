import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as indexModule from '../src/index.js';
import * as untarModule from '../src/untar.js';

/**
 * The subpath map, checked against the modules it names.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW ITEM. An `exports` map is the one part of a package that
 * nothing else in the repository reads: `tsc` resolves relative specifiers, vitest resolves
 * relative specifiers, and the map is only exercised the first time a CONSUMER installs the
 * package. So a typo in it is invisible until publication, which is the worst possible moment.
 *
 * The targets are checked by IMPORTING each one rather than by stat'ing the file, and that is a
 * measured constraint rather than a preference: `tsconfig.json` sets `types: ["@cloudflare/workers-types"]`
 * and there is no `@types/node`, so `import { readFileSync } from 'node:fs'` in this directory is a
 * TS2307 -- verified, not assumed. Importing proves the same thing anyway, because a target naming a
 * file that does not exist would fail this file's own imports.
 */

describe('the package exports map', () => {
	it('resolves the root entry, which is the whole public surface', () => {
		expect((pkg.exports as Record<string, string>)['.']).toBe('./src/index.ts');
		expect(indexModule.parseTar).toBeDefined();
		expect(indexModule.untarGzip).toBeDefined();
		expect(indexModule.tarEntryTree).toBeDefined();
	});

	it('exposes package.json and NOTHING else besides the root', () => {
		// deliberately no `./untar` subpath. There is one module, so a second name for it would be
		// two ways to import the same thing and no way to tell a consumer which is canonical.
		// cartridge splits by subpath because its modules have different dependency costs (./gate
		// and ./mask import nothing, the root pulls fflate); here every symbol is in one file with
		// no dependencies at all, so there is nothing to split
		expect(Object.keys(pkg.exports as Record<string, string>)).toEqual(['.', './package.json']);
		expect((pkg.exports as Record<string, string>)['./package.json']).toBe('./package.json');
	});

	it('blocks a deep import, which is what makes the surface enforceable', () => {
		// with a map present, `@drupflare/untarl/src/untar.ts` is refused by the resolver. That is
		// the point of declaring one for a single-module package: without it, src/untar.ts is a
		// second public entry that nothing documents and nothing can withdraw
		const targets = Object.values(pkg.exports as Record<string, string>);
		expect(targets).not.toContain('./src/untar.ts');
		expect(targets).not.toContain('./src/*');
	});

	it('keeps main and types pointing at the root entry', () => {
		expect(pkg.main).toBe('./src/index.ts');
		expect(pkg.types).toBe('./src/index.ts');
		expect((pkg.exports as Record<string, string>)['.']).toBe(pkg.main);
	});

	it('declares NO side effect, which is a claim about every module and not a default', () => {
		// `false` says a bundler may drop these modules whole when nothing imports from them. The
		// one line worth checking against that claim is `const utf8 = new TextDecoder()` at module
		// scope in untar.ts: it allocates, but nothing outside the module can observe it, so
		// dropping the module is safe. It is NOT the answer everywhere -- cartridge writes an ARRAY
		// naming its worker shim, because dropping that module deletes a globalThis patch
		expect(pkg.sideEffects).toBe(false);
	});

	it('ships src, the licence and the README, and nothing else', () => {
		expect(pkg.files).toEqual(['src', 'LICENSE', 'README.md']);
	});

	it('is in the 0.x beta window the rest of the project sits in', () => {
		expect(pkg.version).toMatch(/^0\./);
	});

	it('has NO runtime dependency, which is the product rather than a preference', () => {
		// zero dependencies is what makes this usable on workerd at all: every popular tar library
		// reaches for node:zlib, node:fs or Buffer, and gzip here is the platform's own
		// DecompressionStream. A `dependencies` field appearing is the regression
		expect((pkg as Record<string, unknown>).dependencies).toBeUndefined();
	});
});

describe('the root entry', () => {
	it('re-exports every symbol untar.ts declares', () => {
		for (const name of Object.keys(untarModule)) {
			if (name === 'default') continue;
			expect(indexModule).toHaveProperty(name);
		}
	});

	it('resolves the error classes to one class each, not a copy', () => {
		// index.ts is a single `export *`; a consumer catching TarPathError from the root has to get
		// the same constructor an `instanceof` inside the module would compare against
		expect(indexModule.TarParseError).toBe(untarModule.TarParseError);
		expect(indexModule.TarPathError).toBe(untarModule.TarPathError);
		expect(indexModule.parseTar).toBe(untarModule.parseTar);
	});
});
