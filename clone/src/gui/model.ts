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
  /** angles in radians, clockwise from 12 o'clock */
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
  arc?: { color: string; radius: number; width: number; track?: string };
  ticks?: { angles: number[]; inner: number; outer: number; color: string; width: number };
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

export interface Display {
  kind: "eq" | "generic";
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
}

export interface GuiModel {
  type: "gui-layout";
  version: 1;
  width: number;
  height: number;
  background: Fill;
  panels: Panel[];
  lines: Line[];
  texts: TextItem[];
  controls: Control[];
  displays: Display[];
  /** parameters that did not visibly change the editor */
  hidden: number[];
}
