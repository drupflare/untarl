import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as indexModule from '../src/index.js';
import * as untarModule from '../src/untar.js';

describe('the package exports map', () => {
	it('resolves the root entry, which is the whole public surface', () => {
		expect((pkg.exports as Record<string, string>)['.']).toBe('./src/index.ts');
		expect(indexModule.parseTar).toBeDefined();
		expect(indexModule.untarGzip).toBeDefined();
		expect(indexModule.tarEntryTree).toBeDefined();
	});

	it('exposes package.json and NOTHING else besides the root', () => {
		// no ./untar subpath: a second name for the one module is two ways to import it
		expect(Object.keys(pkg.exports as Record<string, string>)).toEqual(['.', './package.json']);
		expect((pkg.exports as Record<string, string>)['./package.json']).toBe('./package.json');
	});

	it('blocks a deep import, which is what makes the surface enforceable', () => {
		// without a map, src/untar.ts would be a second public entry nothing can withdraw
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
		// the only module-scope value is a TextDecoder that nothing outside the module can observe
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
