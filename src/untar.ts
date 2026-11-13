/** What an entry is. The several typeflags that mean the same thing are folded into these two. */
export type TarEntryType = 'file' | 'directory';

/** One archive member. `bytes` is a copy, so the archive buffer can be released. */
export interface TarEntry {
	/** full path as the archive names it, with the ustar prefix and GNU long names resolved */
	name: string;
	/** size in bytes */
	size: number;
	type: TarEntryType;
	/** permission bits from the octal `mode` field; 0 when the field is blank */
	mode: number;
	bytes: Uint8Array;
}

/**
 * A malformed, truncated, or out-of-range archive. Messages start with `untar: `; `offset` is the
 * byte position when it is known.
 */
export class TarParseError extends Error {
	offset: number | undefined;

	constructor(message: string, offset?: number) {
		super(`untar: ${message}`);
		this.name = 'TarParseError';
		this.offset = offset;
	}
}

/**
 * A member whose path would escape the target directory. Never thrown by `parseTar()`. Messages
 * start with `untar: `; `path` is the refused name.
 */
export class TarPathError extends Error {
	path: string;

	constructor(path: string, reason: string) {
		super(`untar: refused path ${JSON.stringify(path)}: ${reason}`);
		this.name = 'TarPathError';
		this.path = path;
	}
}

const BLOCK = 512;

const NAME_AT = 0;
const NAME_LEN = 100;
const MODE_AT = 100;
const MODE_LEN = 8;
const SIZE_AT = 124;
const SIZE_LEN = 12;
const TYPE_AT = 156;
const PREFIX_AT = 345;
const PREFIX_LEN = 155;
const MAGIC_END_AT = 262;

const NUL = 0x00;
const SPACE = 0x20;

const TYPE_OLD_FILE = 0x00;
const TYPE_FILE = 0x30;
const TYPE_DIR = 0x35;
const TYPE_CONTIGUOUS = 0x37; // some writers still emit it for regular files
const TYPE_PAX = 0x78;
const TYPE_PAX_GLOBAL = 0x67;
const TYPE_LONGNAME = 0x4c;
const TYPE_LONGLINK = 0x4b;

const utf8 = new TextDecoder();

// reads past the end throw here instead of yielding undefined
function byteAt(bytes: Uint8Array, index: number): number {
	const b = bytes[index];
	if (b === undefined)
		throw new TarParseError(`read past end of archive at byte ${index}`, index);
	return b;
}

function isZeroBlock(bytes: Uint8Array, at: number): boolean {
	for (let i = at; i < at + BLOCK; i++) if (byteAt(bytes, i) !== NUL) return false;
	return true;
}

// utf-8 is assumed; the header has no charset field
function readField(bytes: Uint8Array, at: number, len: number): string {
	let end = at;
	while (end < at + len && byteAt(bytes, end) !== NUL) end++;
	return utf8.decode(bytes.subarray(at, end));
}

function readCString(body: Uint8Array): string {
	const end = body.indexOf(NUL);
	return utf8.decode(body.subarray(0, end === -1 ? body.length : end));
}

// nul or space padding may sit before or after the digits; any other byte throws, so random
// bytes never read as a plausible size. A blank field is 0.
function parseOctal(bytes: Uint8Array, at: number, len: number, field: string): number {
	// gnu base-256 only encodes sizes over 8 GiB, too big for a worker; refuse rather than misread
	if ((byteAt(bytes, at) & 0x80) !== 0) {
		throw new TarParseError(
			`${field} field uses GNU base-256 encoding, which is unsupported`,
			at
		);
	}

	let value = 0;
	let digits = 0;
	let terminated = false;

	for (let i = at; i < at + len; i++) {
		const b = byteAt(bytes, i);
		if (b === NUL || b === SPACE) {
			terminated = digits > 0;
			continue;
		}
		if (terminated) {
			throw new TarParseError(`${field} field has junk after its terminator`, at);
		}
		if (b < 0x30 || b > 0x37) {
			throw new TarParseError(`${field} field is not octal (byte 0x${b.toString(16)})`, at);
		}
		value = value * 8 + (b - 0x30);
		digits++;
	}

	return value;
}

// the length prefix, not the newline, delimits a value
// an unreadable record ends the scan; the archive still parses
function paxPath(body: Uint8Array): string | null {
	let found: string | null = null;
	let i = 0;

	while (i < body.length) {
		let sp = i;
		while (sp < body.length && byteAt(body, sp) !== SPACE) sp++;
		const len = Number(utf8.decode(body.subarray(i, sp)));
		if (!Number.isInteger(len) || len <= 0 || i + len > body.length || sp + 1 >= i + len) break;

		// i + len - 1 drops the trailing newline
		const record = utf8.decode(body.subarray(sp + 1, i + len - 1));
		const eq = record.indexOf('=');
		if (eq > 0 && record.slice(0, eq) === 'path') found = record.slice(eq + 1);
		i += len;
	}

	return found;
}

/**
 * Parses a POSIX/ustar tar archive.
 *
 * Handles the ustar `prefix` split, GNU `L` long names, and pax `x`/`g` headers. An `x` header's
 * `path=` record renames the entry it describes; `g` headers are skipped. A v7 directory, written
 * as typeflag `0` with a trailing slash, is read as a directory. Symlinks, hard links and device
 * nodes are consumed and dropped; nothing in a module install should follow one.
 *
 * The header checksum at offset 148 is not verified. Writers disagree on whether it sums bytes as
 * signed or unsigned, so enforcing it rejects real archives, while the octal and bounds checks
 * already stop a malformed header from being read.
 *
 * @throws {TarParseError} on a truncated header or body, a size that overruns the buffer, a
 *   non-octal size or mode, or a nameless entry.
 */
export function parseTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let zeroBlocks = 0;
	// from an 'L' body or pax `path=`; consumed by the next real entry
	let pendingName: string | null = null;

	while (offset < bytes.length) {
		const remaining = bytes.length - offset;
		if (remaining < BLOCK) {
			// a partial block is a cut-off download, unless it follows the end-of-archive marker
			if (zeroBlocks > 0) break;
			throw new TarParseError(
				`truncated header: ${remaining} of ${BLOCK} bytes at offset ${offset}`,
				offset
			);
		}

		if (isZeroBlock(bytes, offset)) {
			offset += BLOCK;
			zeroBlocks++;
			if (zeroBlocks >= 2) break;
			continue;
		}
		zeroBlocks = 0;

		const headerAt = offset;
		const rawName = readField(bytes, offset + NAME_AT, NAME_LEN);
		// gnu magic ("ustar " with a space) keeps atime in the prefix slot
		const gnu = byteAt(bytes, offset + MAGIC_END_AT) === SPACE;
		const prefix = gnu ? '' : readField(bytes, offset + PREFIX_AT, PREFIX_LEN);
		const mode = parseOctal(bytes, offset + MODE_AT, MODE_LEN, 'mode');
		const size = parseOctal(bytes, offset + SIZE_AT, SIZE_LEN, 'size');
		const flag = byteAt(bytes, offset + TYPE_AT);

		const dataAt = offset + BLOCK;
		const available = bytes.length - dataAt;
		if (size > available) {
			throw new TarParseError(
				`entry ${JSON.stringify(pendingName ?? rawName)} claims ${size} bytes but ${available} remain`,
				headerAt
			);
		}

		const next = dataAt + Math.ceil(size / BLOCK) * BLOCK;
		// unreachable with whole-block headers; kept because the failure mode is a hang
		if (next <= headerAt) {
			throw new TarParseError(`entry ${JSON.stringify(rawName)} does not advance`, headerAt);
		}

		const body = bytes.subarray(dataAt, dataAt + size);
		offset = next;

		if (flag === TYPE_LONGNAME) {
			pendingName = readCString(body);
			continue;
		}
		if (flag === TYPE_LONGLINK) continue;
		if (flag === TYPE_PAX || flag === TYPE_PAX_GLOBAL) {
			// a global header is metadata we do not carry, so only the per-file form renames
			const path = flag === TYPE_PAX ? paxPath(body) : null;
			if (path !== null) pendingName = path;
			continue;
		}

		const name = pendingName ?? (prefix === '' ? rawName : `${prefix}/${rawName}`);
		pendingName = null;

		const isFile = flag === TYPE_OLD_FILE || flag === TYPE_FILE || flag === TYPE_CONTIGUOUS;
		if (!isFile && flag !== TYPE_DIR) continue;

		if (name === '') {
			throw new TarParseError(`entry at offset ${headerAt} has no name`, headerAt);
		}

		// v7 tar had no directory typeflag and marked one with a trailing slash instead
		const type: TarEntryType = flag === TYPE_DIR || name.endsWith('/') ? 'directory' : 'file';

		entries.push({
			name,
			size,
			type,
			mode,
			bytes: type === 'directory' ? new Uint8Array(0) : body.slice()
		});
	}

	return entries;
}

/**
 * Gunzips a stream and parses the tar inside it.
 *
 * The archive is buffered whole. A tar header has no back-pointer, so an entry is found only by
 * walking every block before it.
 *
 * @throws {TarParseError} for the same reasons as `parseTar()`. A corrupt gzip member rejects with
 *   the `DecompressionStream` error instead.
 */
export async function untarGzip(stream: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
	const gunzip = new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>;
	const inflated = stream.pipeThrough(gunzip);
	const buffer = await new Response(inflated).arrayBuffer();
	return parseTar(new Uint8Array(buffer));
}

// absolute paths and '..' segments are refused; '.' and empty segments are dropped
function safeParts(name: string): string[] {
	if (name.startsWith('/')) throw new TarPathError(name, 'absolute paths are refused');
	const parts = name.split('/').filter((p) => p !== '' && p !== '.');
	for (const p of parts) {
		if (p === '..') throw new TarPathError(name, '".." would escape the target directory');
	}
	return parts;
}

/**
 * Flattens entries into the file tree to write, with the leading `strip` path components removed.
 *
 * `strip = 1` is the default because a drupal.org tarball wraps everything in one `modulename/`
 * directory. Directories are dropped, since a file's path implies them. A file with nothing left
 * after the strip is dropped too, as tar's `--strip-components` does. A later entry with the same
 * path wins, as in tar.
 *
 * @throws {RangeError} when `strip` is not a non-negative integer.
 * @throws {TarPathError} on a member path that is absolute or contains a `..` component.
 */
export function tarEntryTree(entries: TarEntry[], strip = 1): Map<string, Uint8Array> {
	if (!Number.isInteger(strip) || strip < 0) {
		throw new RangeError(`untar: strip must be a non-negative integer, got ${strip}`);
	}

	const out = new Map<string, Uint8Array>();
	for (const entry of entries) {
		// before the type filter, so a hostile directory name still fails
		const parts = safeParts(entry.name);
		if (entry.type !== 'file') continue;
		if (parts.length <= strip) continue;
		out.set(parts.slice(strip).join('/'), entry.bytes);
	}
	return out;
}
