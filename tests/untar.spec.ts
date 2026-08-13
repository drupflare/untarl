import { describe, expect, it } from 'vitest';
import { TarParseError, TarPathError, parseTar, tarEntryTree, untarGzip } from '../src/untar.js';

/**
 * The fixtures are built here rather than checked in as binaries, because the interesting cases
 * are exactly the ones no `tar` will produce for you: a size field that overruns the buffer, junk
 * where the octal belongs, a body cut in half, a member called `../escape.txt`. A generator can
 * write those; a recorded archive cannot.
 *
 * `makeTar()` writes a real ustar header including a correct checksum at 148, so the fixtures are
 * archives an actual tar would accept -- the parser does not verify that field, and a fixture that
 * skipped it could not tell the difference.
 *
 * `CompressionStream` and `DecompressionStream` are both declared in `@cloudflare/workers-types`
 * and present in workerd, so the gzip round trip runs in this lane rather than needing the node
 * project.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Member {
	name: string;
	body?: string | Uint8Array;
	/** typeflag character; '0' is a regular file */
	type?: string;
	mode?: number;
	prefix?: string;
	/** raw bytes for the 12-byte size field, for headers a real tar would never write */
	rawSize?: string | Uint8Array;
}

function put(block: Uint8Array, at: number, value: string | Uint8Array, max: number): void {
	const raw = typeof value === 'string' ? enc.encode(value) : value;
	if (raw.length > max) throw new Error(`fixture field too long: ${raw.length} > ${max}`);
	block.set(raw, at);
}

const octal = (value: number, width: number) => value.toString(8).padStart(width, '0');

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const bodyBytes = (body: string | Uint8Array | undefined): Uint8Array =>
	typeof body === 'string' ? enc.encode(body) : (body ?? new Uint8Array(0));

/** @param endBlocks how many zero blocks close the archive; two is what tar writes */
function makeTar(members: Member[], endBlocks = 2): Uint8Array {
	const blocks: Uint8Array[] = [];

	for (const m of members) {
		const body = bodyBytes(m.body);
		const header = new Uint8Array(512);
		put(header, 0, m.name, 100);
		put(header, 100, `${octal(m.mode ?? 0o644, 7)}\0`, 8);
		put(header, 108, '0000000\0', 8);
		put(header, 116, '0000000\0', 8);
		put(header, 124, m.rawSize ?? `${octal(body.length, 11)}\0`, 12);
		put(header, 136, `${octal(0, 11)}\0`, 12);
		// the checksum is defined as the sum with this field read as eight spaces
		header.fill(0x20, 148, 156);
		put(header, 156, m.type ?? '0', 1);
		put(header, 257, 'ustar\0', 6);
		put(header, 263, '00', 2);
		if (m.prefix !== undefined) put(header, 345, m.prefix, 155);
		let sum = 0;
		for (const b of header) sum += b;
		put(header, 148, `${octal(sum, 6)}\0 `, 8);
		blocks.push(header);

		if (body.length > 0) {
			const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
			padded.set(body);
			blocks.push(padded);
		}
	}

	for (let i = 0; i < endBlocks; i++) blocks.push(new Uint8Array(512));
	return concat(blocks);
}

/** One pax record, `"<len> <key>=<value>\n"`, where len counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array {
	const tail = enc.encode(` ${key}=${value}\n`);
	let len = tail.length + 1;
	while (String(len).length + tail.length !== len) len = String(len).length + tail.length;
	return concat([enc.encode(String(len)), tail]);
}

function streamOf(bytes: Uint8Array, chunk = bytes.length): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let at = 0; at < bytes.length; at += chunk) {
				controller.enqueue(bytes.subarray(at, Math.min(at + chunk, bytes.length)));
			}
			controller.close();
		}
	});
}

const gzip = (bytes: Uint8Array, chunk?: number): ReadableStream<Uint8Array> =>
	streamOf(bytes, chunk).pipeThrough(new CompressionStream('gzip'));

const text = (bytes: Uint8Array | undefined) => dec.decode(bytes);

describe('parseTar: a single file round-trips byte for byte', () => {
	const bytes = new Uint8Array([0, 1, 2, 255, 128, 10, 13, 0]);
	const entries = parseTar(makeTar([{ name: 'mod/raw.bin', body: bytes }]));

	it('yields exactly one entry', () => {
		expect(entries).toHaveLength(1);
	});

	it('recovers the name, size, type and mode', () => {
		expect(entries[0]).toMatchObject({
			name: 'mod/raw.bin',
			size: 8,
			type: 'file',
			mode: 0o644
		});
	});

	it('recovers every byte, including NUL and high bytes', () => {
		expect(entries[0]?.bytes).toEqual(bytes);
	});

	it('reads a mode other than the default', () => {
		const exe = parseTar(makeTar([{ name: 'mod/run.sh', body: 'x', mode: 0o755 }]));
		expect(exe[0]?.mode).toBe(0o755);
	});

	it('hands back an owned copy, so mutating an entry cannot corrupt the archive', () => {
		const archive = makeTar([{ name: 'mod/a.txt', body: 'hello' }]);
		const first = parseTar(archive);
		const entry = first[0];
		if (entry === undefined) throw new Error('no entry');
		entry.bytes[0] = 0x5a;
		expect(text(parseTar(archive)[0]?.bytes)).toBe('hello');
	});
});

describe('parseTar: several members and the ones that are not files', () => {
	const entries = parseTar(
		makeTar([
			{ name: 'mod/', type: '5', body: '' },
			{ name: 'mod/a.txt', body: 'aaa' },
			{ name: 'mod/src/', type: '5', body: '' },
			{ name: 'mod/src/b.txt', body: 'bbb' }
		])
	);

	it('keeps all four members in order', () => {
		expect(entries.map((e) => e.name)).toEqual([
			'mod/',
			'mod/a.txt',
			'mod/src/',
			'mod/src/b.txt'
		]);
	});

	it('marks the two directory members as directories with no bytes', () => {
		const dirs = entries.filter((e) => e.type === 'directory');
		expect(dirs).toHaveLength(2);
		expect(dirs.every((d) => d.bytes.length === 0)).toBe(true);
	});

	it('gives the tree only the files', () => {
		const tree = tarEntryTree(entries);
		expect([...tree.keys()]).toEqual(['a.txt', 'src/b.txt']);
		expect(text(tree.get('src/b.txt'))).toBe('bbb');
	});

	it('treats a v7 directory -- typeflag 0 with a trailing slash -- as a directory', () => {
		const old = parseTar(makeTar([{ name: 'mod/sub/', type: '0' }]));
		expect(old[0]?.type).toBe('directory');
	});

	it('treats typeflag \\0 as a regular file, which is what v7 wrote', () => {
		const old = parseTar(makeTar([{ name: 'mod/a.txt', type: '\0', body: 'aaa' }]));
		expect(old[0]).toMatchObject({ name: 'mod/a.txt', type: 'file' });
	});

	it("treats typeflag 7 -- 'contiguous' -- as a regular file", () => {
		const cont = parseTar(makeTar([{ name: 'mod/a.txt', type: '7', body: 'aaa' }]));
		expect(text(cont[0]?.bytes)).toBe('aaa');
	});

	it('drops a symlink member rather than emitting an empty file', () => {
		const link = parseTar(
			makeTar([
				{ name: 'mod/link', type: '2' },
				{ name: 'mod/real.txt', body: 'r' }
			])
		);
		expect(link.map((e) => e.name)).toEqual(['mod/real.txt']);
	});
});

describe('parseTar: the three ways a long path is encoded', () => {
	it('joins a ustar prefix onto the name with a slash', () => {
		const entries = parseTar(
			makeTar([{ name: 'file.txt', prefix: 'verylongmodule/src/Plugin', body: 'p' }])
		);
		expect(entries[0]?.name).toBe('verylongmodule/src/Plugin/file.txt');
	});

	it('leaves the name alone when the prefix is empty', () => {
		const entries = parseTar(makeTar([{ name: 'mod/file.txt', prefix: '', body: 'p' }]));
		expect(entries[0]?.name).toBe('mod/file.txt');
	});

	it("resolves a GNU 'L' long name onto the entry that follows it", () => {
		const long = `mod/src/${'deeply_nested_'.repeat(8)}name.txt`;
		expect(long.length).toBeGreaterThan(100);
		const entries = parseTar(
			makeTar([
				{ name: '././@LongLink', type: 'L', body: `${long}\0` },
				{ name: long.slice(0, 100), body: 'long' }
			])
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe(long);
		expect(text(entries[0]?.bytes)).toBe('long');
	});

	it("consumes a GNU 'K' long link name without emitting anything", () => {
		const entries = parseTar(
			makeTar([
				{ name: '././@LongLink', type: 'K', body: `${'a'.repeat(120)}\0` },
				{ name: 'mod/a.txt', body: 'aaa' }
			])
		);
		expect(entries.map((e) => e.name)).toEqual(['mod/a.txt']);
	});

	it('applies a pax path record to the entry it describes', () => {
		const long = `mod/${'pax_component_'.repeat(9)}z.txt`;
		const entries = parseTar(
			makeTar([
				{ name: 'PaxHeaders/mod', type: 'x', body: paxRecord('path', long) },
				{ name: 'mod/truncated.txt', body: 'paxed' }
			])
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe(long);
	});
});

describe('parseTar: metadata headers are skipped, not emitted as files', () => {
	it('skips a pax header carrying no path', () => {
		const entries = parseTar(
			makeTar([
				{
					name: 'PaxHeaders/mod/a.txt',
					type: 'x',
					body: concat([paxRecord('mtime', '1700000000.0'), paxRecord('uid', '1000')])
				},
				{ name: 'mod/a.txt', body: 'aaa' }
			])
		);
		expect(entries.map((e) => e.name)).toEqual(['mod/a.txt']);
	});

	it("skips a global 'g' header, and its path never renames anything", () => {
		const entries = parseTar(
			makeTar([
				{
					name: 'pax_global_header',
					type: 'g',
					body: paxRecord('path', 'mod/hijacked.txt')
				},
				{ name: 'mod/a.txt', body: 'aaa' }
			])
		);
		expect(entries.map((e) => e.name)).toEqual(['mod/a.txt']);
	});

	it('ignores a pax body it cannot parse rather than failing the archive', () => {
		const entries = parseTar(
			makeTar([
				{ name: 'PaxHeaders/mod', type: 'x', body: 'not a pax record at all' },
				{ name: 'mod/a.txt', body: 'aaa' }
			])
		);
		expect(entries.map((e) => e.name)).toEqual(['mod/a.txt']);
	});
});

describe('parseTar: UTF-8 names and content', () => {
	const name = 'módulo/ünïcode-☃.txt';
	const content = 'contenido en español, 世界, 🌍';
	const entries = parseTar(makeTar([{ name, body: content }]));

	it('decodes a multi-byte name', () => {
		expect(entries[0]?.name).toBe(name);
	});

	it('reports size in bytes, not characters', () => {
		expect(entries[0]?.size).toBe(enc.encode(content).length);
		expect(entries[0]?.size).toBeGreaterThan(content.length);
	});

	it('recovers the content unchanged', () => {
		expect(text(entries[0]?.bytes)).toBe(content);
	});

	it('carries a multi-byte name through a pax path record', () => {
		const long = `módulo/${'ünïcode_'.repeat(12)}z.txt`;
		const paxed = parseTar(
			makeTar([
				{ name: 'PaxHeaders/mod', type: 'x', body: paxRecord('path', long) },
				{ name: 'módulo/truncated.txt', body: 'x' }
			])
		);
		expect(paxed[0]?.name).toBe(long);
	});
});

describe('parseTar: sizes that are not a whole block', () => {
	it.each([1, 511, 512, 513, 1023, 1024, 1025, 2000])(
		'reads a %i-byte body and finds the next header after the padding',
		(size) => {
			const body = new Uint8Array(size);
			for (let i = 0; i < size; i++) body[i] = i % 251;
			const entries = parseTar(
				makeTar([
					{ name: 'mod/a.bin', body },
					{ name: 'mod/b.txt', body: 'after' }
				])
			);
			expect(entries.map((e) => e.name)).toEqual(['mod/a.bin', 'mod/b.txt']);
			expect(entries[0]?.bytes).toEqual(body);
			expect(text(entries[1]?.bytes)).toBe('after');
		}
	);

	it('reads a zero-byte file as an empty entry, not as a missing one', () => {
		const entries = parseTar(
			makeTar([
				{ name: 'mod/empty.txt', body: '' },
				{ name: 'mod/b.txt', body: 'after' }
			])
		);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ name: 'mod/empty.txt', size: 0, type: 'file' });
		expect(entries[0]?.bytes.length).toBe(0);
	});

	it('keeps a zero-byte file in the tree', () => {
		const tree = tarEntryTree(parseTar(makeTar([{ name: 'mod/empty.txt', body: '' }])));
		expect(tree.has('empty.txt')).toBe(true);
		expect(tree.get('empty.txt')?.length).toBe(0);
	});
});

describe('parseTar: where the archive ends', () => {
	it('stops at the two zero blocks and ignores whatever follows', () => {
		const archive = concat([
			makeTar([{ name: 'mod/a.txt', body: 'aaa' }]),
			makeTar([{ name: 'mod/never-read.txt', body: 'x' }])
		]);
		expect(parseTar(archive).map((e) => e.name)).toEqual(['mod/a.txt']);
	});

	it('does not end on a single zero block that has another header behind it', () => {
		const archive = concat([
			makeTar([{ name: 'mod/a.txt', body: 'aaa' }], 1),
			makeTar([{ name: 'mod/b.txt', body: 'bbb' }])
		]);
		expect(parseTar(archive).map((e) => e.name)).toEqual(['mod/a.txt', 'mod/b.txt']);
	});

	it('accepts a single zero block at the end of the buffer', () => {
		expect(parseTar(makeTar([{ name: 'mod/a.txt', body: 'aaa' }], 1))).toHaveLength(1);
	});

	it('accepts an archive that ends on a block boundary with no marker at all', () => {
		expect(parseTar(makeTar([{ name: 'mod/a.txt', body: 'aaa' }], 0))).toHaveLength(1);
	});

	it('ignores trailing padding that comes after the marker', () => {
		const archive = concat([makeTar([{ name: 'mod/a.txt', body: 'aaa' }]), new Uint8Array(37)]);
		expect(parseTar(archive)).toHaveLength(1);
	});

	it('reads a partial block after a single marker as padding, not as truncation', () => {
		// the same 37 bytes are an error BEFORE any marker and padding after one, which is the whole
		// reason the truncation check consults zeroBlocks
		const archive = concat([
			makeTar([{ name: 'mod/a.txt', body: 'aaa' }], 1),
			new Uint8Array(37)
		]);
		expect(parseTar(archive)).toHaveLength(1);
	});

	it('reads an empty buffer as an empty archive', () => {
		expect(parseTar(new Uint8Array(0))).toEqual([]);
	});
});

describe('parseTar: refusals, each with its own error', () => {
	const oneFile = makeTar([{ name: 'mod/a.txt', body: 'a'.repeat(600) }]);

	it('throws TarParseError on a header cut in half', () => {
		expect(() => parseTar(oneFile.slice(0, 300))).toThrow(TarParseError);
		expect(() => parseTar(oneFile.slice(0, 300))).toThrow(/truncated header: 300 of 512 bytes/);
	});

	it('throws TarParseError on a body cut in half, naming what is missing', () => {
		expect(() => parseTar(oneFile.slice(0, 512 + 300))).toThrow(
			/claims 600 bytes but 300 remain/
		);
	});

	it('throws TarParseError on a size that overruns the buffer', () => {
		const lying = makeTar([{ name: 'mod/a.txt', body: 'hi', rawSize: `${octal(4096, 11)}\0` }]);
		expect(() => parseTar(lying)).toThrow(TarParseError);
		expect(() => parseTar(lying)).toThrow(/claims 4096 bytes but 1536 remain/);
	});

	it('throws TarParseError on a size that is not octal', () => {
		const garbage = makeTar([{ name: 'mod/a.txt', body: 'hi', rawSize: '99999999999\0' }]);
		expect(() => parseTar(garbage)).toThrow(TarParseError);
		expect(() => parseTar(garbage)).toThrow(/size field is not octal \(byte 0x39\)/);
	});

	it('throws TarParseError on digits after the size terminator', () => {
		const garbage = makeTar([{ name: 'mod/a.txt', body: 'hi', rawSize: '0000012 4' }]);
		expect(() => parseTar(garbage)).toThrow(/size field has junk after its terminator/);
	});

	it('throws TarParseError on a GNU base-256 size rather than misreading it', () => {
		const wide = new Uint8Array(12);
		wide[0] = 0x80;
		wide[11] = 0x01;
		expect(() => parseTar(makeTar([{ name: 'mod/a.txt', rawSize: wide }]))).toThrow(
			/base-256 encoding/
		);
	});

	it('carries the header offset on the error, so a bad entry can be located', () => {
		const lying = makeTar([
			{ name: 'mod/a.txt', body: 'ok' },
			{ name: 'mod/b.txt', body: 'hi', rawSize: `${octal(9999, 11)}\0` }
		]);
		try {
			parseTar(lying);
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(TarParseError);
			expect((e as TarParseError).offset).toBe(1024);
		}
	});

	it('throws TarParseError on a nameless entry rather than emitting one', () => {
		const archive = makeTar([{ name: 'mod/a.txt', body: 'a' }]);
		archive.fill(0, 0, 100);
		// keep it out of the all-zero-block path, which would legitimately end the archive
		archive[156] = 0x30;
		expect(() => parseTar(archive)).toThrow(/has no name/);
	});

	it('reads no bytes past the end even when the last header is the truncation', () => {
		const archive = makeTar([{ name: 'mod/a.txt', body: 'a' }]);
		// 1024 lands mid-way through the first end-of-archive block
		expect(() => parseTar(archive.slice(0, 1024 + 40))).toThrow(/truncated header/);
	});
});

describe('tarEntryTree: paths that escape are refused', () => {
	it.each([
		['a parent-relative member', '../escape.txt'],
		['a parent-relative member below the wrapper', 'mod/../../escape.txt'],
		['a parent-relative directory component', 'mod/../etc/passwd']
	])('throws TarPathError for %s', (_label, name) => {
		const entries = parseTar(makeTar([{ name, body: 'x' }]));
		expect(() => tarEntryTree(entries)).toThrow(TarPathError);
		expect(() => tarEntryTree(entries)).toThrow(/would escape the target directory/);
	});

	it('throws TarPathError for an absolute member', () => {
		const entries = parseTar(makeTar([{ name: '/etc/passwd', body: 'root:x:0:0' }]));
		expect(() => tarEntryTree(entries)).toThrow(TarPathError);
		expect(() => tarEntryTree(entries)).toThrow(/absolute paths are refused/);
	});

	it('carries the offending path on the error', () => {
		try {
			tarEntryTree(parseTar(makeTar([{ name: '/etc/passwd', body: 'x' }])));
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(TarPathError);
			expect((e as TarPathError).path).toBe('/etc/passwd');
		}
	});

	it('refuses an escape hidden behind a GNU long name', () => {
		const long = `../${'escape_'.repeat(15)}.txt`;
		const entries = parseTar(
			makeTar([
				{ name: '././@LongLink', type: 'L', body: `${long}\0` },
				{ name: long.slice(0, 100), body: 'x' }
			])
		);
		expect(() => tarEntryTree(entries)).toThrow(TarPathError);
	});

	it('refuses an escape hidden in a ustar prefix', () => {
		const entries = parseTar(makeTar([{ name: 'passwd', prefix: '/etc', body: 'x' }]));
		expect(() => tarEntryTree(entries)).toThrow(TarPathError);
	});

	it('refuses a hostile directory member even though directories produce no file', () => {
		const entries = parseTar(makeTar([{ name: '../evil/', type: '5' }]));
		expect(() => tarEntryTree(entries)).toThrow(TarPathError);
	});

	it('parseTar itself stays faithful and does NOT refuse the path', () => {
		// the split is deliberate: parsing reports what the archive says, the tree decides what is
		// safe to write, so a caller cannot get an unchecked path by accident
		expect(parseTar(makeTar([{ name: '../escape.txt', body: 'x' }]))[0]?.name).toBe(
			'../escape.txt'
		);
	});

	it('allows a filename that merely starts with dots', () => {
		const tree = tarEntryTree(parseTar(makeTar([{ name: 'mod/..hidden', body: 'x' }])));
		expect([...tree.keys()]).toEqual(['..hidden']);
	});
});

describe('tarEntryTree: strip', () => {
	const entries = parseTar(
		makeTar([
			{ name: 'mod/', type: '5' },
			{ name: 'mod/mod.info.yml', body: 'name: Mod' },
			{ name: 'mod/src/Plugin/Block.php', body: '<?php' },
			{ name: 'mod/README.md', body: '# Mod' }
		])
	);

	it('strips one component by default, which unwraps a drupal.org tarball', () => {
		expect([...tarEntryTree(entries).keys()]).toEqual([
			'mod.info.yml',
			'src/Plugin/Block.php',
			'README.md'
		]);
	});

	it('keeps the full path at strip 0', () => {
		expect([...tarEntryTree(entries, 0).keys()]).toEqual([
			'mod/mod.info.yml',
			'mod/src/Plugin/Block.php',
			'mod/README.md'
		]);
	});

	it('drops members with nothing left after the strip', () => {
		expect([...tarEntryTree(entries, 2).keys()]).toEqual(['Plugin/Block.php']);
	});

	it('yields an empty map when strip exceeds every path depth', () => {
		expect(tarEntryTree(entries, 9).size).toBe(0);
	});

	it('does not spend a strip component on a leading ./', () => {
		const dotted = parseTar(makeTar([{ name: './mod/a.txt', body: 'a' }]));
		expect([...tarEntryTree(dotted).keys()]).toEqual(['a.txt']);
	});

	it('collapses a doubled slash rather than producing an empty component', () => {
		const doubled = parseTar(makeTar([{ name: 'mod//a.txt', body: 'a' }]));
		expect([...tarEntryTree(doubled).keys()]).toEqual(['a.txt']);
	});

	it('lets a later member win on a duplicate path, matching tar', () => {
		const dupes = parseTar(
			makeTar([
				{ name: 'mod/a.txt', body: 'first' },
				{ name: 'mod/a.txt', body: 'second' }
			])
		);
		expect(text(tarEntryTree(dupes).get('a.txt'))).toBe('second');
	});

	it.each([-1, 1.5, NaN, Infinity])('throws RangeError for strip %s', (strip) => {
		expect(() => tarEntryTree(entries, strip)).toThrow(RangeError);
	});
});

describe('untarGzip: gunzips and parses in one pass', () => {
	const members: Member[] = [
		{ name: 'mod/', type: '5' },
		{ name: 'mod/mod.info.yml', body: 'name: Mod\ntype: module\n' },
		{ name: 'mod/src/Plugin/Block.php', body: '<?php\n// nothing\n' },
		{ name: 'mod/empty', body: '' }
	];

	it('recovers every member of a gzipped archive', async () => {
		const entries = await untarGzip(gzip(makeTar(members)));
		expect(entries.map((e) => e.name)).toEqual([
			'mod/',
			'mod/mod.info.yml',
			'mod/src/Plugin/Block.php',
			'mod/empty'
		]);
	});

	it('feeds straight into tarEntryTree', async () => {
		const tree = tarEntryTree(await untarGzip(gzip(makeTar(members))));
		expect([...tree.keys()]).toEqual(['mod.info.yml', 'src/Plugin/Block.php', 'empty']);
		expect(text(tree.get('mod.info.yml'))).toBe('name: Mod\ntype: module\n');
	});

	it('does not care where the stream chunk boundaries fall', async () => {
		const entries = await untarGzip(gzip(makeTar(members), 100));
		expect(entries).toHaveLength(4);
		expect(text(entries[1]?.bytes)).toBe('name: Mod\ntype: module\n');
	});

	it('survives a body larger than one gzip chunk', async () => {
		const big = new Uint8Array(200_000);
		for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
		const entries = await untarGzip(gzip(makeTar([{ name: 'mod/big.bin', body: big }]), 4096));
		expect(entries[0]?.size).toBe(big.length);
		expect(entries[0]?.bytes).toEqual(big);
	});

	it('rejects when the stream is not gzip at all', async () => {
		await expect(untarGzip(streamOf(makeTar(members)))).rejects.toThrow();
	});

	it('propagates a TarParseError from inside the gzip', async () => {
		const lying = makeTar([{ name: 'mod/a.txt', body: 'hi', rawSize: `${octal(4096, 11)}\0` }]);
		await expect(untarGzip(gzip(lying))).rejects.toThrow(TarParseError);
	});
});
