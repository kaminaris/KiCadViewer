/**
 * Zero-dependency ZIP writer — the write-side counterpart to ZipArchive.ts,
 * used by "Export Project (.zip)" to package the current project's files
 * into a zip a user can hand to real KiCad (or re-import here via "Open
 * Project Archive…", which ZipArchive.ts's own doc comment flagged as a gap:
 * "would mean building a NEW zip and offering it as a download, a separate
 * feature" — this is that feature). Mirrors ZipArchive's own scope
 * decisions: deflate (method 8) via the browser's native CompressionStream
 * (the write-side twin of ZipArchive's DecompressionStream-based
 * `inflateRaw`) with a store (method 0) fallback per entry when deflating
 * didn't actually shrink it, UTF-8 filenames only, no ZIP64 (a KiCad
 * project's handful of small text files never approaches the 4GB/65535-entry
 * ceiling that would require it).
 */

interface PendingEntry {
	name: string;
	data: Uint8Array<ArrayBuffer>;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FILENAME_FLAG = 0x0800;

export class ZipWriter {
	private entries: PendingEntry[] = [];

	addTextFile(name: string, content: string): void {
		this.entries.push({ name, data: new TextEncoder().encode(content) });
	}

	async build(): Promise<Blob> {
		const { dosTime, dosDate } = dosDateTimeNow();
		const localParts: Uint8Array<ArrayBuffer>[] = [];
		const centralParts: Uint8Array<ArrayBuffer>[] = [];
		let offset = 0;

		for (const entry of this.entries) {
			const nameBytes = new TextEncoder().encode(entry.name);
			const crc = crc32(entry.data);
			const deflated = entry.data.length > 0 ? await deflateRaw(entry.data) : entry.data;
			const useStore = deflated.length >= entry.data.length;
			const method = useStore ? 0 : 8;
			const payload = useStore ? entry.data : deflated;

			const localHeader = new Uint8Array(30);
			const lv = new DataView(localHeader.buffer);
			lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
			lv.setUint16(4, 20, true); // version needed to extract
			lv.setUint16(6, UTF8_FILENAME_FLAG, true);
			lv.setUint16(8, method, true);
			lv.setUint16(10, dosTime, true);
			lv.setUint16(12, dosDate, true);
			lv.setUint32(14, crc, true);
			lv.setUint32(18, payload.length, true);
			lv.setUint32(22, entry.data.length, true);
			lv.setUint16(26, nameBytes.length, true);
			lv.setUint16(28, 0, true); // extra field length

			localParts.push(localHeader, nameBytes, payload);

			const centralHeader = new Uint8Array(46);
			const cv = new DataView(centralHeader.buffer);
			cv.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
			cv.setUint16(4, 20, true); // version made by
			cv.setUint16(6, 20, true); // version needed to extract
			cv.setUint16(8, UTF8_FILENAME_FLAG, true);
			cv.setUint16(10, method, true);
			cv.setUint16(12, dosTime, true);
			cv.setUint16(14, dosDate, true);
			cv.setUint32(16, crc, true);
			cv.setUint32(20, payload.length, true);
			cv.setUint32(24, entry.data.length, true);
			cv.setUint16(28, nameBytes.length, true);
			cv.setUint16(30, 0, true); // extra field length
			cv.setUint16(32, 0, true); // file comment length
			cv.setUint16(34, 0, true); // disk number start
			cv.setUint16(36, 0, true); // internal file attributes
			cv.setUint32(38, 0, true); // external file attributes
			cv.setUint32(42, offset, true); // local header offset

			centralParts.push(centralHeader, nameBytes);

			offset += localHeader.length + nameBytes.length + payload.length;
		}

		const centralDirOffset = offset;
		const centralDirSize = centralParts.reduce((sum, part) => sum + part.length, 0);

		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, EOCD_SIGNATURE, true);
		ev.setUint16(4, 0, true); // disk number
		ev.setUint16(6, 0, true); // disk with central directory
		ev.setUint16(8, this.entries.length, true);
		ev.setUint16(10, this.entries.length, true);
		ev.setUint32(12, centralDirSize, true);
		ev.setUint32(16, centralDirOffset, true);
		ev.setUint16(20, 0, true); // comment length

		return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
	}
}

function dosDateTimeNow(): { dosTime: number; dosDate: number } {
	const d = new Date();
	const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
	const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
	return { dosTime, dosDate };
}

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const stream = new CompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	const writePromise = writer.write(data).then(() => writer.close());
	const chunks: Uint8Array<ArrayBuffer>[] = [];
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
	let position = 0;
	for (const chunk of chunks) {
		out.set(chunk, position);
		position += chunk.length;
	}
	return out;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
	if (crcTable) {
		return crcTable;
	}
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[n] = c >>> 0;
	}
	crcTable = table;
	return table;
}

/** Standard CRC-32 (IEEE 802.3 polynomial) — the checksum every zip entry's
 *  local/central headers require regardless of compression method. */
function crc32(data: Uint8Array<ArrayBuffer>): number {
	const table = getCrcTable();
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
