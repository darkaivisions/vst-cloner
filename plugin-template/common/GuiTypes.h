#pragma once

// Data types of the generated CloneGui.h (see clone/src/gui/model.ts and clone/src/gui/codegen.ts).

#include <cstdint>

namespace clonegui
{

struct Fill { uint32_t color; uint32_t gradient; bool hasGradient; };
struct Panel { float x, y, w, h, radius; Fill fill; uint32_t border; bool hasBorder; };
struct Line { float x1, y1, x2, y2, thickness; uint32_t color; };
/** align: 0 left, 1 centre, 2 right; size: font size in px (0 = derived from the box height) */
struct Text { float x, y, w, h; const char* text; uint32_t color; bool bold; int align; float size; };
struct Ticks { int count; const float* angles; float inner, outer, width; uint32_t color; };

struct Rotary
{
    float cx, cy, radius, start, end;
    Fill body;
    bool hasOutline; uint32_t outline;
    uint32_t pointer; float pointerInner, pointerOuter, pointerWidth; bool dot;
    bool hasArc; uint32_t arcColor; float arcRadius, arcWidth; bool hasTrack; uint32_t track;
    Ticks ticks;
};

struct Readout
{
    bool present; float x, y, w, h, size;
    uint32_t color; bool hasBackground; uint32_t background; bool hasBorder; uint32_t border;
};

/** kind: 0 rotary, 1 horizontal slider, 2 vertical slider, 3 toggle, 4 choice, 5 value text.
    c1/c2/f1: slider track/thumb/thumb size, toggle on/off/corner radius, choice and value background/text/text size */
struct Control
{
    int param; int kind; float x, y, w, h;
    Rotary rotary;
    uint32_t c1, c2; float f1;
    Readout readout;
};

/** kind: 0 EQ curve, 1 generic area. EQ axes: log frequency fMin…fMax (left→right), linear dB dbTop…dbBottom;
    dbStep: grid distance in dB (0 = derived from the range); labelBand: strip for frequency labels below the plot;
    dbLabelRight: right edge of the dB labels relative to the display (0 = right edge) */
/** Gain reduction needle (editor coordinates; angles in radians clockwise from 12 o'clock): angle = angleZero + radiansPerDb · reduction */
struct Needle { float pivotX, pivotY, length, width; uint32_t color; float angleZero, radiansPerDb; float capRadius; uint32_t capColor; Ticks ticks; };

/** kind 2: gain reduction meter (needle) */
struct Display { int kind; float x, y, w, h; uint32_t background, backgroundBottom, grid, curve, text; float fMin, fMax, dbTop, dbBottom, dbStep, labelBand, dbLabelRight; Needle needle; };

} // namespace clonegui
