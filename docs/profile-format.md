# `.vcprofile` – Profilformat v1

Ein Profil enthält alles, um einen Klon ohne das Original-Plugin neu zu bauen:
Plugin-Metadaten, Parameterbeschreibung, die Beschreibung des Testsignals und die
aufgenommenen Antworten des Plugins. Es enthält **keine** Binärdateien, Samples oder
Code des Originals.

## Container

ZIP-Archiv (Deflate). `manifest.json` steht zuerst, damit Werkzeuge das Format schnell erkennen.

| Datei | Pflicht | Inhalt | Schema |
|---|---|---|---|
| `manifest.json` | ja | Format, Version, Plugin, Capture-Einstellungen | `profile/schema/manifest.schema.json` |
| `parameters.json` | ja | Alle Parameter des Plugins | `profile/schema/parameters.schema.json` |
| `test-signals.json` | ja | Segmente des Eingangssignals + SHA-256 | `profile/schema/test-signals.schema.json` |
| `captures.json` | ja | Index der Renders | `profile/schema/captures.schema.json` |
| `captures/<id>.wav` | ja | Antwort des Plugins, WAV 32-bit float | – |
| `spec.md`, `model/…`, `report.json` | nein | Ab späteren Meilensteinen | – |
| `checksums.sha256` | ja | `sha256  pfad` für jede andere Datei | – |

Beim Lesen werden alle Prüfsummen, die JSON-Schemas und Querverweise geprüft
(jede Capture-Datei vorhanden, jeder Parameterindex bekannt, keine unsicheren Pfade).
Nicht gelistete Dateien führen zum Abbruch.

## Parameterwerte

Alle Werte sind **normalisiert (0…1)**, so wie der Plugin-Host sie sieht.
`parameters.json` enthält zu jedem Parameter Anzeigetexte (`texts`): bei diskreten
Parametern für jeden Schritt, sonst an 11 gleichmäßig verteilten Punkten.
Damit lässt sich die Zuordnung normalisiert → Anzeigewert (z. B. Hz, dB) rekonstruieren.

## Grundzustand

Jeder Render startet vom Zustand des Plugins direkt nach dem Laden (`value` in
`parameters.json`). `captures.json` listet pro Render nur die davon abweichenden
Parameter, jeweils mit dem vom Plugin zurückgemeldeten Wert und Anzeigetext.

Ablauf pro Render im Host:
1. Grundzustand wiederherstellen, Render-Parameter setzen
2. Einen Block Stille verarbeiten (Parameter zustellen), `reset()`
3. `prerollSeconds` Stille verarbeiten (Parameter-Glättung einschwingen lassen)
4. Testsignal + `tailSeconds` Stille verarbeiten; die gemeldete Latenz wird abgeschnitten

Damit ist jede Capture-Datei sampelgenau zum Eingangssignal ausgerichtet und
genau `length + tailSeconds * sampleRate` Samples lang.

## Testsignal

Das Eingangssignal wird nicht gespeichert, sondern aus `test-signals.json` neu erzeugt
(`vch extract` schreibt es als `input.wav`). `sha256` ist der Hash der erzeugten
WAV-Datei. Weicht er ab (anderer Generator), bleiben die Segmentgrenzen trotzdem gültig.

Segmente der Generator-Version 1 (alle Kanäle identisch):

| Segment | Art | Zweck |
|---|---|---|
| `impulse` | Einzelimpuls, Amplitude 0,5 | Impulsantwort, Latenz |
| `sweep` | Exponentieller Sinus-Sweep 20 Hz…20 kHz, −6 dBFS, 3 s | Frequenzgang, Klirrfaktor |
| `noise` | Weißes Gauß-Rauschen, −18 dBFS RMS, 2 s | Nichtlineare Modelle |
| `levels` | 1 kHz, −60…0 dBFS in 6-dB-Stufen | Statische Kompressor-Kennlinie |
| `burst` | 1 kHz, −30 → −6 → −30 dBFS | Attack/Release |
| `lead`, `gap-*` | Stille | Abklingen zwischen den Segmenten |

## Versionierung

`schemaVersion` wird nur bei inkompatiblen Änderungen erhöht. Zusätzliche optionale
Felder und Dateien sind innerhalb einer Version erlaubt.
