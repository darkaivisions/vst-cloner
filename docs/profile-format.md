# `.vcprofile` – profile format v1

A profile holds everything needed to rebuild a clone without the original plugin:
plugin metadata, the parameter description, the description of the test signal and the
recorded responses of the plugin. It contains **no** binaries, samples or
code of the original.

## Container

ZIP archive (deflate). `manifest.json` comes first so that tools can recognise the format quickly.

| File | Required | Content | Schema |
|---|---|---|---|
| `manifest.json` | yes | format, version, plugin, capture settings | `profile/schema/manifest.schema.json` |
| `parameters.json` | yes | all parameters of the plugin | `profile/schema/parameters.schema.json` |
| `test-signals.json` | yes | segments of the input signal + SHA-256 | `profile/schema/test-signals.schema.json` |
| `captures.json` | yes | index of the renders | `profile/schema/captures.schema.json` |
| `captures/<id>.wav` | yes | response of the plugin, WAV 32-bit float | – |
| `model/eq.json` | no | fitted EQ model (from `vch clone`/`vch analyze --save`) | – |
| `report.json` | no | fit and comparison report of the last clone | – |
| `spec.md` | no | functional specification (from milestone 7) | – |
| `checksums.sha256` | yes | `sha256  path` for every other file | – |

On reading, all checksums, the JSON schemas and cross-references are checked
(every capture file present, every parameter index known, no unsafe paths).
Files that are not listed cause the read to fail.

## Parameter values

All values are **normalised (0…1)**, as the plugin host sees them.
`parameters.json` holds display texts (`texts`) for every parameter: for discrete
parameters one per step, otherwise at 11 evenly spaced points.
This allows reconstructing the mapping normalised → display value (e.g. Hz, dB).

## Base state

Every render starts from the state of the plugin right after loading (`value` in
`parameters.json`). `captures.json` lists per render only the parameters that differ from it,
each with the value and display text reported back by the plugin.

Steps per render in the host:
1. Restore the base state, set the render parameters
2. Process one block of silence (deliver the parameters), `reset()`
3. Process `prerollSeconds` of silence (let parameter smoothing settle)
4. Process the test signal + `tailSeconds` of silence; the reported latency is cut off

So every capture file is aligned sample-exactly with the input signal and is
exactly `length + tailSeconds * sampleRate` samples long.

Optional fields per render:
- `mono: true` – all output channels were bit-identical; the file holds only one channel.
- `purpose` – `"train"` (for the fit) or `"validate"` (only as a cross-check).
- `label` – readable description, e.g. "Bell · 1000 Hz · +12.0 dB · Q 0.70".

## Test signal

The input signal is not stored but regenerated from `test-signals.json`
(`vch extract` writes it as `input.wav`). `sha256` is the hash of the generated
WAV file. If it differs (another generator), the segment boundaries still remain valid.

`preset` names the segment sequence: `full` (default) or `eq` (short: impulse with a 1 s window,
1.5 s sweep, for linear effects).

Segments of generator version 1, preset `full` (all channels identical):

| Segment | Kind | Purpose |
|---|---|---|
| `impulse` | single impulse, amplitude 0.5 | impulse response, latency |
| `sweep` | exponential sine sweep 20 Hz…20 kHz, −6 dBFS, 3 s | frequency response, distortion |
| `noise` | white Gaussian noise, −18 dBFS RMS, 2 s | non-linear models |
| `levels` | 1 kHz, −60…0 dBFS in 6 dB steps | static compressor curve |
| `burst` | 1 kHz, −30 → −6 → −30 dBFS | attack/release |
| `lead`, `gap-*` | silence | decay between the segments |

## Versioning

`schemaVersion` is only increased for incompatible changes. Additional optional
fields and files are allowed within a version.
