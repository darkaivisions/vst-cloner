# vst-cloner

Gekaufte Effekt-Plugins unter Linux nutzen: Plugins werden als Black Box vermessen,
als offenes Profil (`.vcprofile`) gespeichert und daraus als freier Klon (LV2/VST3/CLAP)
neu gebaut. Kein dekompilierter Code, keine extrahierten Samples – nur gemessenes Klangverhalten.

Gesamtplan und Meilensteine: [PLAN.md](PLAN.md) · Profilformat: [docs/profile-format.md](docs/profile-format.md)

**Stand: Meilenstein 1** – Capture-Host, Profilformat und Kommandozeile funktionieren.
Getestet unter Linux mit nativen VST3-Plugins und Windows-Plugins über yabridge.

## Voraussetzungen

- Node.js ≥ 22.18 (TypeScript läuft direkt, kein Build-Schritt)
- CMake ≥ 3.22 und ein C++20-Compiler (GCC/Clang unter Linux, MSVC unter Windows)

## Einrichten

```bash
npm install
npm run host:configure      # lädt JUCE 9.0.5 herunter
npm run host:build
```

Mit vorhandenem JUCE-Checkout: `cmake -S host -B host/build -DVCH_JUCE_DIR=/pfad/zu/JUCE`.

## Benutzung

```bash
# Was steckt im Plugin?
npm run vch -- info ~/.vst3/MeinPlugin.vst3

# Was würde gemessen?
npm run vch -- plan ~/.vst3/MeinPlugin.vst3

# Messen und Profil speichern
npm run vch -- capture ~/.vst3/MeinPlugin.vst3 -o mein-plugin.vcprofile

# Profil prüfen / entpacken
npm run vch -- inspect mein-plugin.vcprofile
npm run vch -- extract mein-plugin.vcprofile ./entpackt
```

Oder direkt: `node capture/bin/vch.ts …`

### Plugins mit vielen Parametern

Multiband-Plugins haben oft hunderte Parameter, deren Bänder erst aktiviert werden müssen.
Mit `--set` werden Werte für alle Renders fest gesetzt, mit `--include` die zu messenden
Parameter ausgewählt:

```bash
npm run vch -- capture ~/.vst3/yabridge/"Mein EQ.vst3" -o eq-band1.vcprofile \
  --set "Band 1 Used=Used" --set "Band 1 Enabled=Enabled" \
  --include "^Band 1 (Frequency|Gain|Q|Shape)$" --points 7 --random 8
```

Werte für `--set` sind normalisierte Zahlen (0…1) oder Anzeigetexte diskreter Parameter.
Ab Meilenstein 3 erzeugt die App solche Messpläne automatisch je nach Effekt-Klasse.

### Windows-Plugins

- **Unter Linux über yabridge:** Den yabridge-Ordner (z. B. `~/.vst3/yabridge/…`) angeben.
- **Unter Windows:** vch-host mit CMake/MSVC bauen und dort capturen, das Profil
  anschließend unter Linux weiterverarbeiten.

## Aufbau

```
host/      vch-host: C++20/JUCE 9, headless. Lädt VST3/LV2, rendert offline.
           Ausgabe als JSON-Zeilen auf stdout (Plugin-Ausgaben werden nach stderr umgeleitet).
profile/   JSON-Schemas, Reader/Writer mit Prüfsummen, WAV-I/O
capture/   Testsignale, Messplan, Ansteuerung von vch-host, CLI `vch`
```

## Tests

```bash
npm run typecheck
npm test
VCH_TEST_PLUGIN=~/.vst3/MeinPlugin.vst3 npm test   # inkl. Capture mit echtem Plugin
```

## Lizenz

GPL-3.0-or-later (vch-host nutzt JUCE unter GPLv3).
