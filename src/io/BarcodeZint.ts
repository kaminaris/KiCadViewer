import {
	registerBoardBarcodeEncoderLoader,
	type BoardBarcodeEncoder,
	type BoardBarcodeRequest,
} from '@kicad-render/paint/BarcodeEncoder';

type ZintModule = {
	HEAPF32: Float32Array;
	HEAPU8: Uint8Array;
	HEAPU32: Uint32Array;
	_malloc(bytes: number): number;
	_free(pointer: number): void;
	_zint_encode(symbology: number, errorCorrection: number, text: number, textLength: number, output: number, outputLength: number): number;
};

type ZintFactory = (options: { locateFile(file: string): string }) => Promise<ZintModule>;

const symbologyByType: Record<BoardBarcodeRequest['type'], number> = {
	code39: 8,
	code128: 20,
	datamatrix: 71,
	qr: 58,
	microqr: 97,
};

const errorCorrectionByName: Record<BoardBarcodeRequest['errorCorrection'], number> = {
	L: 1,
	M: 2,
	Q: 3,
	H: 4,
};

/** Wires the Docker-built Zint module into the renderer. This merely
 * registers a loader: the browser fetch happens only when a PCB barcode is
 * encountered or placed. */
export function configureZintBarcodeEncoder(): void {
	registerBoardBarcodeEncoderLoader(async () => {
		const moduleUrl = new URL(`${ import.meta.env.BASE_URL }vendor/zint/zint.mjs`, window.location.href).href;
		const imported = await import(/* @vite-ignore */ moduleUrl) as { default: ZintFactory };
		const module = await imported.default({ locateFile: file => new URL(file, moduleUrl).href });
		return createEncoder(module);
	});
}

function createEncoder(module: ZintModule): BoardBarcodeEncoder {
	return {
		encode(request) {
			const text = new TextEncoder().encode(request.text);
			const input = module._malloc(text.length || 1);
			const outputPointer = module._malloc(4);
			const outputLength = module._malloc(4);
			try {
				module.HEAPU8.set(text, input);
				const result = module._zint_encode(
					symbologyByType[request.type], errorCorrectionByName[request.errorCorrection],
					input, text.length, outputPointer, outputLength,
				);
				if (result !== 0) {
					throw new Error(`Zint failed to encode ${ request.type } (error ${ result }).`);
				}
				const dataPointer = module.HEAPU32[outputPointer >>> 2]!;
				const floatLength = module.HEAPU32[outputLength >>> 2]!;
				if (!dataPointer || floatLength < 2) {
					throw new Error('Zint returned an empty barcode.');
				}
				const data = module.HEAPF32.slice(dataPointer >>> 2, (dataPointer >>> 2) + floatLength);
				module._free(dataPointer);
				const rectangles = [];
				for (let index = 2; index + 3 < data.length; index += 4) {
					rectangles.push({ x: data[index]!, y: data[index + 1]!, width: data[index + 2]!, height: data[index + 3]! });
				}
				return { width: data[0]!, height: data[1]!, rectangles };
			}
			finally {
				module._free(input);
				module._free(outputPointer);
				module._free(outputLength);
			}
		},
	};
}
