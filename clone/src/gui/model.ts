/** Layout description of a plugin editor, derived from screenshots (no original artwork is stored). */

export interface Fill {
  color: string;
  /** bottom colour of a vertical gradient */
  gradient?: string;
}

export interface Panel {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: Fill;
  radius: number;
  border?: string;
}

/** Round area (disc) with a radial colour profile: stops from the centre (0) to the edge (1). */
export interface Circle {
  cx: number;
  cy: number;
  r: number;
  stops: { at: number; color: string }[];
  /** straight lines from the centre to the edge (angle 0 = up, clockwise) */
  spokes?: { angles: number[]; color: string; width: number };
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: number;
}

export interface TextItem {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  /** font height in pixels */
  size: number;
  bold: boolean;
  align: "left" | "center" | "right";
  /** title, label of a control, or other static text */
  role: "title" | "label" | "text";
}

export interface RotaryStyle {
  cx: number;
  cy: number;
  /** radius of the knob body */
  radius: number;
  /** angles in radians, clockwise from 12 o'clock; endAngle < startAngle for a knob turning anticlockwise */
  startAngle: number;
  endAngle: number;
  body: Fill;
  outline?: string;
  pointer: string;
  /** pointer from inner to outer radius (fractions of `radius`) */
  pointerInner: number;
  pointerOuter: number;
  pointerWidth: number;
  pointerDot: boolean;
  /** value arc; `origin` (0…1 of the travel) where it starts when that is not the start, e.g. 0.5 for ±values */
  arc?: { color: string; radius: number; width: number; track?: string; origin?: number };
  ticks?: { angles: number[]; inner: number; outer: number; color: string; width: number };
  /** a small disc of its own colour on the axis (radius in pixels) */
  cap?: { radius: number; color: string };
}

export interface SliderStyle {
  track: string;
  fill?: string;
  thumb: string;
  thumbSize: number;
}

export interface ToggleStyle {
  on: string;
  off: string;
  onText?: string;
  offText?: string;
  radius: number;
}

export interface ChoiceStyle {
  background: string;
  text: string;
  size: number;
}

export interface Readout {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  background?: string;
  border?: string;
  size: number;
}

/** value: text showing the parameter value (changed by dragging), style in `choice` */
export type ControlKind = "rotary" | "slider-h" | "slider-v" | "toggle" | "choice" | "value";

export interface Control {
  /** original parameter index */
  param: number;
  name: string;
  kind: ControlKind;
  /** normalized parameter value when the editor was captured */
  value?: number;
  /** value text of the original at that value (previews; the plugin shows its own) */
  valueText?: string;
  /** options of a choice or switch (labels in step order) */
  options?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  rotary?: RotaryStyle;
  slider?: SliderStyle;
  toggle?: ToggleStyle;
  choice?: ChoiceStyle;
  readout?: Readout;
}

/** Needle of a gain reduction meter (angles in radians, clockwise from 12 o'clock). */
export interface Needle {
  pivotX: number;
  pivotY: number;
  length: number;
  width: number;
  color: string;
  /** angle at 0 dB gain reduction */
  angleZero: number;
  radiansPerDb: number;
  /** hub at the pivot */
  cap?: { radius: number; color: string };
  /** scale marks: angles and radial extent (px from the pivot) */
  ticks?: { angles: number[]; inner: number; outer: number; width: number; color: string };
}

export interface Display {
  /** meter: gain reduction needle (see `needle`); bar: level bar (see `bar`) */
  kind: "eq" | "generic" | "meter" | "bar";
  x: number;
  y: number;
  w: number;
  h: number;
  background: string;
  /** vertical gradient of the plot background */
  backgroundTop?: string;
  backgroundBottom?: string;
  grid: string;
  curve: string;
  text: string;
  /** EQ: frequency at the left/right edge (log axis), gain at the top/bottom edge (linear) */
  fMin?: number;
  fMax?: number;
  dbTop?: number;
  dbBottom?: number;
  /** distance of the horizontal grid lines in dB */
  dbStep?: number;
  /** strip at the bottom (px) holding the frequency labels; dB axis and grid cover only the area above */
  labelBand?: number;
  /** x of the right edge of the dB labels (default: right edge of the plot) */
  dbLabelRight?: number;
  needle?: Needle;
  bar?: LevelBar;
  /** what a generic display shows, where it is known: a compressor's transfer curve, an analyzer or time graph */
  role?: "curve" | "analyzer";
  /** transfer curve: colour of the area below the curve, where the original fills it */
  fill?: string;
}

/** Vertical level bar: filled from the bottom of the display box (`fromDb`) to the level, the top is `toDb`. */
export interface LevelBar {
  /** what the bar shows: input or output peak level (dBFS), or gain reduction (dB) */
  source: "input" | "output" | "reduction";
  /** value at the origin and at the far end */
  fromDb: number;
  toDb: number;
  color: string;
  /** where the bar starts and grows from (missing: a vertical bar from the bottom) */
  origin?: "bottom" | "top" | "left" | "right";
  /** LED chain: number of segments over the whole length */
  segments?: number;
  /** colour of an unlit LED or of the empty bar */
  offColor?: string;
  /** round LEDs (otherwise rectangles) */
  round?: boolean;
  /** LED chain: the value at which each LED lights up, from the origin (measured; scales are often not linear) */
  ledDb?: number[];
  /** how fast the shown value falls back when the signal stops (dB per second, measured) */
  fallDbPerSecond?: number;
}

export interface GuiModel {
  type: "gui-layout";
  version: 1;
  width: number;
  height: number;
  background: Fill;
  panels: Panel[];
  /** discs drawn after the panels (older models have none) */
  circles?: Circle[];
  lines: Line[];
  texts: TextItem[];
  controls: Control[];
  displays: Display[];
  /** parameters that did not visibly change the editor */
  hidden: number[];
}
