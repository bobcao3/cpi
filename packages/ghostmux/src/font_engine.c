#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <setjmp.h>

struct ghostmux_scratch {
    unsigned char *data;
    size_t capacity;
    size_t used;
    jmp_buf exhausted;
};

static void *ghostmux_allocate(size_t size, void *userdata)
{
    if (!userdata)
        return malloc(size);

    struct ghostmux_scratch *scratch = userdata;
    const size_t alignment = _Alignof(max_align_t);
    const size_t padding =
        (alignment - ((uintptr_t)(scratch->data + scratch->used) % alignment))
        % alignment;

    if (padding > scratch->capacity - scratch->used ||
        size > scratch->capacity - scratch->used - padding)
        longjmp(scratch->exhausted, 1);

    void *result = scratch->data + scratch->used + padding;
    scratch->used += padding + size;
    return result;
}

static void ghostmux_free(void *pointer, void *userdata)
{
    if (!userdata)
        free(pointer);
}

#define KB_TEXT_SHAPE_IMPLEMENTATION
#include "kb_text_shape.h"
#define STBTT_malloc(size, userdata) ghostmux_allocate(size, userdata)
#define STBTT_free(pointer, userdata) ghostmux_free(pointer, userdata)
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

int ghostmux_rasterize(stbtt_fontinfo *raster, unsigned char *pixels,
                       int width, int height, float scale_x, float scale_y,
                       float shift_x, float shift_y, int glyph,
                       unsigned char *memory, size_t capacity)
{
    struct ghostmux_scratch scratch = {
        .data = memory,
        .capacity = capacity,
        .used = 0
    };
    stbtt_fontinfo face = *raster;
    face.userdata = &scratch;

    if (setjmp(scratch.exhausted))
        return 0;

    stbtt_MakeGlyphBitmapSubpixel(&face, pixels, width, height, width,
                                  scale_x, scale_y, shift_x, shift_y, glyph);
    return 1;
}
