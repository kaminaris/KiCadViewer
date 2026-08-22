/**
 * Zero-dependency ZIP reader — parses the container format (End Of Central
 * Directory record, Central Directory, Local File Headers) by hand, but
 * leans on the browser's native `DecompressionStream('deflate-raw')`
 * (Streams API, Chrome 80+/Firefox 113+/Safari 16.4+) for the actual
 * decompression, so no INFLATE implementation is needed either. ZIP's
 * per-entry compressed data is raw DEFLATE with no zlib/gzip wrapper —
 * 'deflate-raw' is exactly that, not 'deflate' (which expects a zlib header)
 * or 'gzip' (which expects a gzip header+trailer).
 *
 * Deliberately read-only (extraction only, matching "load zip... extract" —
 * no zip creation) and deliberately narrow in format support, deferring
 * anything a normal KiCad-project zip (made by GitHub's zip download,
 * Windows "Compress to zip", 7-Zip, macOS Archive Utility, or `zip`/
 * `Compress-Archive`) wouldn't need:
 * - Compression methods: only 0 (stored) and 8 (deflate) — covers every
 *   common zip tool's default. Anything else (deflate64, bzip2, LZMA,
 *   AES-encrypted entries, ...) throws a clear error instead of silently
 *   producing garbage.
 * - No ZIP64 (archives/entries whose size or entry-count sentinel fields
 *   read as the ZIP64 escape value 0xFFFF/0xFFFFFFFF) — KiCad projects are
 *   small; ZIP64 is a >4GB/>65535-entries extension, throws a clear error.
 * - Filenames are decoded as UTF-8 unconditionally (not the legacy CP437
 *   fallback for archives without the UTF-8 flag bit set) — every modern
 *   zip tool now defaults to UTF-8, and KiCad project filenames are
 *   overwhelmingly plain ASCII in practice anyway.
 * - No multi-disk (spanned) archives.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** EOCD is 22 fixed bytes + up to a 65535-byte comment — this is the
 *  largest window that could possibly contain it, scanning from the end. */
const MAX_EOCD_SEARCH_WINDOW = 22 + 65535;

interface ZipEntryMeta {
	name: string;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	isDirectory: boolean;
}

export class ZipArchive {
	protected entries = new Map<string, ZipEntryMeta>();

	protected constructor(protected readonly blob: Blob) {}

	static async open(blob: Blob): Promise<ZipArchive> {
		const archive = new ZipArchive(blob);
		await archive.readCentralDirectory();
		return archive;
	}

	/** Full in-archive paths (ZIP entries always use '/', regardless of the
	 *  OS that created the archive), directories included (trailing '/'). */
	listEntries(): string[] {
		return [...this.entries.keys()];
	}

	/** Returns debugging metadata for every entry discovered in the central
	 *  directory. Useful for reporting diagnostics when a project import
	 *  fails; callers should limit how much of this they surface to users. */
	debugEntriesMeta(): ZipEntryMeta[] {
		return [...this.entries.values()].map(e => ({ ...e }));
	}

	has(path: string): boolean {
		return this.entries.has(path);
	}

	async readText(path: string): Promise<string> {
		const bytes = await this.readBytes(path);
		return new TextDecoder('utf-8').decode(bytes);
	}

	protected async readBytes(path: string): Promise<Uint8Array> {
		const entry = this.entries.get(path);
		if (!entry) {
			throw new Error(`Not found in zip: "${ path }"`);
		}
		if (entry.isDirectory) {
			throw new Error(`"${ path }" is a directory entry, not a file.`);
		}
		// Central directory has the authoritative sizes (local headers can
		// legitimately read 0/0 when the "data descriptor" bit is set), but
		// the LOCAL header's own name/extra-field lengths are still needed to
		// find where the actual compressed bytes start (they're occasionally
		// a few bytes different from the central directory's copy).
		const headerBuf = await this.blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer();
		const headerView = new DataView(headerBuf);
		if (headerView.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
			throw new Error(`Corrupt zip: bad local file header for "${ path }".`);
		}
		const nameLen = headerView.getUint16(26, true);
		const extraLen = headerView.getUint16(28, true);
		const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
		const compressed = new Uint8Array(
			await this.blob.slice(dataStart, dataStart + entry.compressedSize).arrayBuffer());

		if (entry.compressionMethod === 0) {
			return compressed;
		}
		if (entry.compressionMethod === 8) {
			return inflateRaw(compressed);
		}
		throw new Error(
			`"${ path }" uses zip compression method ${ entry.compressionMethod } — only store (0) and deflate (8) are supported.`);
	}

	protected async readCentralDirectory(): Promise<void> {
		const size = this.blob.size;
		const windowSize = Math.min(size, MAX_EOCD_SEARCH_WINDOW);
		const tail = new Uint8Array(await this.blob.slice(size - windowSize, size).arrayBuffer());

		let eocdOffset = -1;
		for (let i = tail.length - 22; i >= 0; i--) {
			if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
				eocdOffset = i;
				break;
			}
		}
		if (eocdOffset === -1) {
			throw new Error('Not a valid zip file (no End Of Central Directory record found).');
		}
		const eocdView = new DataView(tail.buffer, tail.byteOffset + eocdOffset, tail.length - eocdOffset);
		if (eocdView.getUint32(0, true) !== EOCD_SIGNATURE) {
			throw new Error('Not a valid zip file (End Of Central Directory signature mismatch).');
		}
		const totalEntries = eocdView.getUint16(10, true);
		const centralDirSize = eocdView.getUint32(12, true);
		const centralDirOffset = eocdView.getUint32(16, true);
		if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
			throw new Error('This zip uses the ZIP64 format (very large archive), which is not supported.');
		}

		const cdBuf = await this.blob.slice(centralDirOffset, centralDirOffset + centralDirSize).arrayBuffer();
		const cdView = new DataView(cdBuf);
		const decoder = new TextDecoder('utf-8');
		let pos = 0;
		for (let i = 0; i < totalEntries; i++) {
			if (pos + 46 > cdBuf.byteLength || cdView.getUint32(pos, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
				throw new Error('Corrupt zip: bad central directory entry.');
			}
			const compressionMethod = cdView.getUint16(pos + 10, true);
			const compressedSize = cdView.getUint32(pos + 20, true);
			const uncompressedSize = cdView.getUint32(pos + 24, true);
			const nameLen = cdView.getUint16(pos + 28, true);
			const extraLen = cdView.getUint16(pos + 30, true);
			const commentLen = cdView.getUint16(pos + 32, true);
			const localHeaderOffset = cdView.getUint32(pos + 42, true);
			if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
				throw new Error('This zip uses the ZIP64 format (a very large entry), which is not supported.');
			}
			const nameBytes = new Uint8Array(cdBuf, pos + 46, nameLen);
			const name = decoder.decode(nameBytes);
			this.entries.set(name, {
				name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset,
				isDirectory: name.endsWith('/')
			});
			pos += 46 + nameLen + extraLen + commentLen;
		}
	}
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const stream = new DecompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	const writePromise = writer.write(data).then(() => writer.close());
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.readable.getReader();
	for (; ;) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		total += value.length;
	}
	await writePromise;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
