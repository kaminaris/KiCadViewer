/*
 * Thin browser bridge for the same vendored Zint revision KiCad uses.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <cstdlib>
#include <cstring>

#include <emscripten/emscripten.h>
#include <backend/zint.h>

extern "C" EMSCRIPTEN_KEEPALIVE int zint_encode(
    int symbology, int error_correction, const unsigned char* text, int text_length,
    float** output, int* output_length)
{
    if (!text || text_length < 0 || !output || !output_length)
        return ZINT_ERROR_INVALID_DATA;

    *output = nullptr;
    *output_length = 0;

    zint_symbol* symbol = ZBarcode_Create();
    if (!symbol)
        return ZINT_ERROR_MEMORY;

    symbol->input_mode = UNICODE_MODE;
    symbol->show_hrt = 0;
    symbol->symbology = symbology;
    if (symbology == BARCODE_QRCODE || symbology == BARCODE_MICROQR)
        symbol->option_1 = error_correction;

    bool non_ascii = false;
    for (int index = 0; index < text_length; ++index) {
        if (text[index] & 0x80) {
            non_ascii = true;
            break;
        }
    }
    if (non_ascii && (symbology == BARCODE_QRCODE || symbology == BARCODE_DATAMATRIX))
        symbol->eci = 26; // UTF-8, exactly as PCB_BARCODE::ComputeBarcode().

    int result = ZBarcode_Encode(symbol, text, text_length);
    if (result < ZINT_ERROR)
        result = ZBarcode_Buffer_Vector(symbol, 0);
    if (result >= ZINT_ERROR) {
        ZBarcode_Delete(symbol);
        return result;
    }

    int count = 0;
    for (zint_vector_rect* rect = symbol->vector->rectangles; rect; rect = rect->next)
        ++count;
    const int floats = 2 + count * 4;
    float* values = static_cast<float*>(std::malloc(sizeof(float) * floats));
    if (!values) {
        ZBarcode_Delete(symbol);
        return ZINT_ERROR_MEMORY;
    }

    values[0] = symbol->vector->width * symbol->scale;
    values[1] = symbol->vector->height * symbol->scale;
    int index = 2;
    for (zint_vector_rect* rect = symbol->vector->rectangles; rect; rect = rect->next) {
        values[index++] = rect->x * symbol->scale;
        values[index++] = rect->y * symbol->scale;
        values[index++] = rect->width * symbol->scale;
        values[index++] = rect->height * symbol->scale;
    }

    ZBarcode_Delete(symbol);
    *output = values;
    *output_length = floats;
    return 0;
}
