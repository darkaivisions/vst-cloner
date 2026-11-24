#pragma once

// Data types of the generated CloneGui.h (see clone/src/gui/model.ts and clone/src/gui/codegen.ts).

#include <cstdint>

namespace clonegui
{

struct Fill { uint32_t color; uint32_t gradient; bool hasGradient; };
struct Panel { float x, y, w, h, radius; Fill fill; uint32_t border; bool hasBorder; };
/** Disc with a radial colour profile (stops from the centre 0 to the edge 1) and optional spokes from the centre. */
struct Circle { float cx, cy, r; int numStops; const float* stopAt; const uint32_t* stopColor; int numSpokes; const float* spokes; uint32_t spokeColor; float spokeWidth; };
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
    float arcOrigin;   // where the value arc starts, 0…1 of the travel (0.5: centre position)
    Ticks ticks;
    bool hasCap; float capRadius; uint32_t cap;   // small disc on the axis
};

struct Readout
{
    bool present; float x, y, w, h, size;
    uint32_t color; bool hasBackground; uint32_t background; bool hasBorder; uint32_t border;
    /** onKnob: written on the knob (drawn over it); decimals: digits after the point the original shows (−1: as the parameter's text) */
    bool onKnob; int decimals;
};

/** kind: 0 rotary, 1 horizontal slider, 2 vertical slider, 3 toggle, 4 choice, 5 value text.
    c1/c2/f1: slider track/thumb/thumb size, toggle on/off/corner radius, choice and value background/text/text size */
struct Control
{
    int param; int kind; float x, y, w, h;
    Rotary rotary;
    uint32_t c1, c2; float f1;
    Readout readout;
    /** slider: track as a line this thick along the middle (0: the whole box), thumb as a disc */
    float trackWidth; bool roundThumb;
};

/** kind: 0 EQ curve, 1 generic area. EQ axes: log frequency fMin…fMax (left→right), linear dB dbTop…dbBottom;
    dbStep: grid distance in dB (0 = derived from the range); labelBand: strip for frequency labels below the plot;
    dbLabelRight: right edge of the dB labels relative to the display (0 = right edge) */
/** Gain reduction needle (editor coordinates; angles in radians clockwise from 12 o'clock): angle = angleZero + radiansPerDb · reduction */
struct Needle { float pivotX, pivotY, length, width; uint32_t color; float angleZero, radiansPerDb; float capRadius; uint32_t capColor; Ticks ticks; };

/** a number of the original's scale, where it stands (editor coordinates) */
struct ScaleLabel { const char* text; float x, y, w, h; uint32_t color; };

/** kind 2: gain reduction meter (needle); kind 3: level bar or LED chain – dbBottom at its origin, dbTop at the far end;
    meterSource: 0 input, 1 output, 2 gain reduction; meterOrigin: 0 bottom, 1 top, 2 left, 3 right;
    segments: number of LEDs (0: a plain bar); offColor: unlit LED or empty bar;
    role of a generic area (kind 1): 0 unknown, 1 transfer curve, 2 analyzer or time graph */
struct Display
{
    int kind; float x, y, w, h; uint32_t background, backgroundBottom, grid, curve, text;
    float fMin, fMax, dbTop, dbBottom, dbStep, labelBand, dbLabelRight; Needle needle;
    int meterSource, meterOrigin, segments; bool round; uint32_t offColor; int role;
    /** LED chains: value at which each LED lights up, from the origin (nullptr: evenly from dbBottom to dbTop) */
    const float* ledDb;
    /** how fast a peak meter falls back (dB per second; 0: 20 dB/s) */
    float fallDbPerSecond;
    /** transfer curve: area below it filled with fill (hasFill) */
    bool hasFill; uint32_t fill;
    /** scale of a curve or graph as read from the original: its numbers, and each axis as
        value = a + b · position (editor pixels; hasXAxis/hasYAxis where one was read) */
    int numScaleLabels; const ScaleLabel* scaleLabels;
    bool hasXAxis; float xAxisA, xAxisB;
    bool hasYAxis; float yAxisA, yAxisB;
    /** EQ: only the curve, no grid, numbers or band handles (plain); where the curve begins and ends (display
        coordinates, curveRight 0: to the right edge); background as a gradient from left to right; corner radius */
    bool plain; float curveLeft, curveRight;
    bool hasBackgroundRight; uint32_t backgroundRight; float radius;
};

} // namespace clonegui
