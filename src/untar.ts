/**
 * Tar + gzip extraction, host-side in JavaScript.
 *
 * WHY IT LIVES HERE RATHER THAN IN PHP: installing a contrib module at runtime means reading a
 * drupal.org `.tar.gz`, and this wasm build has neither ext-zip nor ext-phar. Adding either is a
 * multi-hour Docker rebuild of the binary. `DecompressionStream('gzip')` is native in workerd and
 * tar is nothing but 512-byte blocks with an octal header, so the whole job fits out here where
 * awaiting is legal and no build flag has to change.
 *
 * A tarball off the network is UNTRUSTED INPUT. Every read is bounds-checked and throws a named
 * error rather than reading past the buffer or looping, and no path becomes a filename until
 * `tarEntryTree()` has refused the ones that escape. `parseTar()` stays faithful to the bytes;
 * `tarEntryTree()` is the layer that decides what is safe to write.
 *
 * The header checksum at offset 148 is deliberately NOT enforced. Writers disagree on whether the
 * field is summed as signed or unsigned bytes, so enforcing it rejects real archives, while the
 * octal and bounds checks below already stop a malformed header from being read.
 */

/** What an entry is, after the several typeflags that mean the same thing are folded together. */
export type TarEntryType = 'file' | 'directory';

/** One archive member. `bytes` is an owned copy, so the archive buffer can be released. */
export interface TarEntry {
	/** full path as the archive names it, ustar prefix and GNU long names already resolved */
	name: string;
	/** size in bytes */
	size: number;
	/** type of the entry */
	type: TarEntryType;
	/** permission bits from the octal `mode` field; 0 when the field is blank */
	mode: number;
	/** the entry's data */
	bytes: Uint8Array;
}

/** A malformed, truncated, or out-of-range archive. Carries the byte offset when one is known. */
export class TarParseError extends Error {
	/** The byte offset where the error occurred, if known. */
	offset: number | undefined;

	/**
	 * Creates a new parse error with a message and optional offset. The message is prefixed with
	 * "untar: " to distinguish it from other errors.
	 *
	 * @param message - The error message.
	 * @param offset - The byte offset where the error occurred, if known.
	 */
	constructor(message: string, offset?: number) {
		super(`untar: ${message}`);
		this.name = 'TarParseError';
		this.offset = offset;
	}
}

/** A member whose path would escape the target directory. Never thrown by `parseTar()`. */
export class TarPathError extends Error {
	/** The path that was refused. */
	path: string;

	/**
	 * Creates a new path error with a message and the refused path. The message is prefixed with
	 * "untar: " to distinguish it from other errors.
	 *
	 * @param path - The path that was refused.
	 * @param reason - The reason why the path was refused.
	 */
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

const NUL = 0x00;
const SPACE = 0x20;

const TYPE_OLD_FILE = 0x00;
const TYPE_FILE = 0x30; // '0'
const TYPE_DIR = 0x35; // '5'
const TYPE_CONTIGUOUS = 0x37; // '7', a regular file everywhere that still emits it
const TYPE_PAX = 0x78; // 'x'
const TYPE_PAX_GLOBAL = 0x67; // 'g'
const TYPE_LONGNAME = 0x4c; // 'L'
const TYPE_LONGLINK = 0x4b; // 'K'

const utf8 = new TextDecoder();

/** Every byte read goes through here, so a short buffer throws instead of yielding undefined. */
function byteAt(bytes: Uint8Array, index: number): number {
	const b = bytes[index];
	if (b === undefined)
		throw new TarParseError(`read past end of archive at byte ${index}`, index);
	return b;
}

/** returns false at the first non-zero byte, which for a real header is byte 0 */
function isZeroBlock(bytes: Uint8Array, at: number): boolean {
	for (let i = at; i < at + BLOCK; i++) if (byteAt(bytes, i) !== NUL) return false;
	return true;
}

/** Reads a NUL-terminated header field. Names are UTF-8 in every archive that matters. */
function readField(bytes: Uint8Array, at: number, len: number): string {
	let end = at;
	while (end < at + len && byteAt(bytes, end) !== NUL) end++;
	return utf8.decode(bytes.subarray(at, end));
}

/** Reads a NUL-terminated string out of an entry body (GNU long name). */
function readCString(body: Uint8Array): string {
	let end = 0;
	while (end < body.length && byteAt(body, end) !== NUL) end++;
	return utf8.decode(body.subarray(0, end));
}

/**
 * Parses one octal header field.
 *
 * Padding is NUL or space and may come before or after the digits; anything else is garbage and
 * throws, which is what stops a random buffer from producing a plausible size. A blank field is 0.
 */
function parseOctal(bytes: Uint8Array, at: number, len: number, field: string): number {
	// GNU stores a size above 8 GiB as base-256 with the high bit set; nothing that large can be
	// held in a Worker's memory anyway, so refuse it loudly instead of misreading it as octal
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

/**
 * Pulls the `path` override out of a pax extended header body.
 *
 * Records are `"<len> <key>=<value>\n"` where `len` counts itself, so the length prefix is what
 * makes a value containing a newline unambiguous. Anything unparseable ends the scan; a pax header
 * we cannot read is not a reason to fail an otherwise good archive.
 */
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
 * Handles the shapes real drupal.org tarballs contain: the ustar `prefix` split, GNU `L` long
 * names, pax `x`/`g` headers (skipped, though an `x` header's `path=` record renames the entry it
 * describes), and the v7 habit of writing a directory as typeflag `0` with a trailing slash.
 * Symlinks, hard links and device nodes are consumed and dropped -- nothing in a module install
 * should follow one.
 *
 * @throws {TarParseError} on a truncated header or body, a size that overruns the buffer, a
 *   non-octal size or mode, or a nameless entry.
 */
export function parseTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let zeroBlocks = 0;
	// set by an 'L' body or a pax `path=` record, consumed by the next real entry
	let pendingName: string | null = null;

	while (offset < bytes.length) {
		const remaining = bytes.length - offset;
		if (remaining < BLOCK) {
			// tar pads the archive out to whole blocks, so a partial one is a cut-off download; after
			// the end-of-archive marker it is only padding and can be ignored
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
		const prefix = readField(bytes, offset + PREFIX_AT, PREFIX_LEN);
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
		// unreachable while a header is a whole block, asserted because the cost of being wrong is a
		// hang rather than an error
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
			// a global header applies to the rest of the archive, which is a claim about metadata we
			// do not carry, so only the per-file form can rename anything
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
 * The archive is buffered whole because a tar header carries no back-pointer, so an entry cannot
 * be found without walking every block before it. For a contrib module that is a few megabytes.
 *
 * @throws {TarParseError} for the same reasons as `parseTar()`; a corrupt gzip member rejects from
 *   `DecompressionStream` itself.
 */
export async function untarGzip(stream: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
	const inflated = stream.pipeThrough(new DecompressionStream('gzip'));
	const buffer = await new Response(inflated).arrayBuffer();
	return parseTar(new Uint8Array(buffer));
}

/** Splits a member path, refusing the two forms that escape the target directory. */
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
 * `strip = 1` is the useful default because a drupal.org tarball wraps everything in one
 * `modulename/` directory. Directories are dropped -- a file's own path implies them -- and so is
 * any file left with nothing after the strip, which is what tar's own `--strip-components` does.
 * A later entry with the same resulting path wins, also matching tar.
 *
 * @throws {TarPathError} on a member path that is absolute or contains a `..` component.
 */
export function tarEntryTree(entries: TarEntry[], strip = 1): Map<string, Uint8Array> {
	if (!Number.isInteger(strip) || strip < 0) {
		throw new RangeError(`untar: strip must be a non-negative integer, got ${strip}`);
	}

	const out = new Map<string, Uint8Array>();
	for (const entry of entries) {
		// checked for every entry, not just files, so a hostile directory name still fails
		const parts = safeParts(entry.name);
		if (entry.type !== 'file') continue;
		if (parts.length <= strip) continue;
		out.set(parts.slice(strip).join('/'), entry.bytes);
	}
	return out;
}
