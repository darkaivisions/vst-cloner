# Plan: VST-Cloner (Effekt-Plugins unter Linux nutzbar machen)

## Ziel
Gekaufte Windows-Effekt-Plugins unter Linux nutzen:
1. Zuerst prüfen, ob das Original per **yabridge + Wine** läuft (beste Lösung, 100 % Klangtreue).
2. Falls nicht (iLok/PACE, Crashes, CPU, GUI): Plugin per **Black-Box-Capture** vermessen,
   als offenes Profil (`.vcprofile`) speichern und daraus einen **freien Klon** (LV2/VST3/CLAP) bauen.

Privatnutzung. Kein Umschreiben von dekompiliertem Code, keine Extraktion von Samples/Assets.

## Grundprinzipien
- **Black-Box first:** Klon basiert auf gemessenem Klangverhalten, nicht auf Code.
- **Clean-Room-Trennung:** REA liefert nur Metadaten/funktionale Spezifikation (Text, ohne Code).
  Der Code-generierende Agent erhält nie dekompilierten Code im Kontext (technisch erzwungen).
- **Profile sind wiederverwendbar:** Einmal capturen, beliebig oft neu bauen.
- **Plattformen:** Capture auf Windows (Lizenz/Kopierschutz funktionieren nativ) oder Linux via yabridge.
  Analyse, Klonbau und Nutzung auf Linux (Windows ebenfalls unterstützt).

## Workflow
```
Windows-PC (Plugin lizenziert)         Linux-PC
┌─────────────────────────┐  .vcprofile ┌───────────────────────────┐
│ Capture-Host            │ ──────────► │ App: Analyse + Agent      │
│ misst Plugin offline    │             │ baut Klon (LV2/VST3/CLAP) │
└─────────────────────────┘             │ vergleicht mit Captures   │
                                         └───────────────────────────┘
```

## Architektur
```
┌──────────── UI: Tauri v2 (Rust + Web) ─────────────┐
│ Wizard: Plugin wählen → Capture → Analyse → Export │
└──────┬───────────────────┬─────────────────────────┘
       │ stdio/JSON        │ stdio/JSON
┌──────▼────────┐   ┌──────▼──────────────────────────┐
│ vch-host      │   │ Node/TS                         │
│ C++ / JUCE 9  │   │ - capture: Messplan, Profil     │
│ headless      │   │ - agent: AI SDK, MCP → REA      │
│ VST3/LV2      │   │ - Build: Faust / NAM / RTNeural │
└───────────────┘   └─────────────────────────────────┘
```

### Komponenten
- **UI:** Tauri v2, einfacher Wizard im "CD-Ripper"-Stil.
- **vch-host:** C++20 mit JUCE 9 (`juce_audio_processors_headless`, kein X11/GUI nötig).
  Bewusst "dumm": lädt Plugin, liest Parameter, rendert WAV-Eingang → WAV-Ausgang pro Parametersatz.
  Messplanung und Profil-Logik liegen in TypeScript.
- **capture (Node/TS):** Testsignale (deterministisch), Messplan, Ansteuerung von vch-host,
  Schreiben des Profils, CLI `vch`.
- **agent (Node/TS):** Vercel AI SDK für alle LLM-Provider, MCP-Client für REA.
  Zwei getrennte Rollen: `analyst` (darf REA nutzen, erzeugt `spec.md`) und
  `builder` (sieht nur `spec.md`, Parameter, Captures, Metriken).
- **DSP/Build:** Faust → LV2/VST3/CLAP; NAM/RTNeural für Nichtlinearitäten; Python-Tools für Fitting/Training.
- TypeScript läuft ohne Build-Schritt direkt mit Node ≥ 22.18 (Type Stripping).

## LLM-Anbindung
- Provider: OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter (Cloud);
  Ollama, LM Studio, llama.cpp-Server, vLLM (lokal, OpenAI-kompatibel, Auto-Discovery).
- Modellwahl pro Rolle (z. B. Analyse lokal, Codegenerierung in der Cloud).
- Fähigkeitstest beim Einrichten: Tool-Calling, Kontextlänge, strukturierte Ausgabe.
- Token-/Kostenanzeige pro Job, API-Keys im OS-Keychain (libsecret / Windows Credential Manager).
- REA als gepinnte Version gebündelt, Update-Check über `rea update` (REA braucht Node ≥ 22.23.4).

## Effekt-Klassen und Methoden
Klassifizierung durch LLM (Parameternamen, REA-Metadaten, erste Probe-Messungen):

| Klasse | Messung | Klon-Methode |
|---|---|---|
| EQ / Filter / Cab | Log-Sweeps, IRs pro Parameter | Faust-Biquads (gefittet) oder Faltung |
| Kompressor / Gate | Pegeltreppen, Sprungantworten | Faust-Kompressor, gefittete Kennlinie + Attack/Release |
| Distortion / Amp / Tape | Rauschen + Musik über Parameterraster | NAM / RTNeural-LSTM, Parameter-konditioniert |
| Delay / Chorus | Impulse, lange Sweeps | Faust (Delayzeit- und LFO-Erkennung) |
| Reverb | IRs pro Preset/Parameter | Faltung oder gefittetes FDN in Faust |

- **Parameterraster:** Einzelparameter-Sweeps + Stichprobe von Kombinationen,
  dazwischen Interpolation bzw. parametrisches Modell.
- **Klassenspezifische Messpläne** (ab M3): z. B. bei Multiband-EQs erst Band aktivieren, dann sweepen.
- **DAW-Kompatibilität:** Klon übernimmt Parameternamen und -bereiche (Automation/Projekte übertragbar).

## Agent-Schleife (Builder)
1. Faust-Code (bzw. Modell-Config) aus `spec.md` + Messdaten generieren
2. Kompilieren (Fehler zurück an Agent)
3. Mit identischen Testsignalen rendern
4. Metriken pro Parameterpunkt: ESR, spektrale Distanz (Multi-Resolution STFT), Pegel-/Latenzabgleich
5. Iterieren bis Schwellwert oder max. Iterationen; Qualitätsbericht ins Profil

## Profilformat `.vcprofile`
Details: [docs/profile-format.md](docs/profile-format.md). ZIP-Container, versioniertes JSON-Schema:
```
manifest.json        Schema-Version, Plugin-Info, Capture-Einstellungen, Host/OS
parameters.json      Parameter, Bereiche, Defaults, Wertetexte
test-signals.json    Segmente + Seeds der Testsignale (reproduzierbar statt gespeichert) + SHA-256
captures.json        Index: Render-ID → Datei, Parameterwerte, Latenz, Pegel
captures/*.wav       Antworten als WAV float32 (verlustfrei, ZIP-komprimiert)
spec.md              Funktionale Spezifikation (ohne Code)            (ab M7)
model/               Faust .dsp, .nam, RTNeural .json                  (ab M3)
report.json          Qualitätsmetriken des letzten Builds              (ab M3)
checksums.sha256
```
- Import → Neubau des Klons ohne Original-Plugin.
- Keine Binärteile, Samples oder Code des Originals im Profil.

## Projektstruktur (Monorepo)
```
vst-cloner/
├─ apps/desktop/   Tauri v2 UI                                   (M4)
├─ host/           C++/JUCE vch-host (CMake, Win + Linux)
├─ capture/        Node/TS: Testsignale, Messplan, CLI `vch`
├─ profile/        JSON-Schema + Reader/Writer + WAV-I/O (TS)
├─ agent/          Node/TS: AI SDK, MCP→REA, Analyst-/Builder-Agent (M2/M7)
├─ dsp/            Faust-Templates, Fit-Tools, NAM-Training      (M3+)
└─ docs/
```

## Meilensteine
1. **Profilformat + Capture-Host** ✔
   - JSON-Schema v1, Reader/Writer, Prüfsummen
   - vch-host: Plugin laden (VST3/LV2), Parameter auslesen, Offline-Rendering
   - CLI: `vch info`, `vch capture <plugin> -o out.vcprofile`, `vch inspect`
   - Abnahme: Profil eines Plugins auf Linux erzeugbar (Windows-Build über CMake/MSVC)
2. **LLM-Layer** ✔
   - Provider-Einstellungen, Auto-Discovery lokal, Fähigkeitstest, Keychain, Kostenanzeige
   - CLI `vch llm …`; Metadaten aus Anbieter-APIs + models.dev-Katalog (24 h Cache, offline nutzbar)
3. **Erster Klon-Typ: EQ/Filter** ✔
   - EQ-Messplan (Formen × Frequenz × Gain × Güte), Frequenzgang-Analyse, Filter-Fit,
     JUCE-Plugin (VST3/LV2), Vergleich Klon ↔ Original
   - Abweichung zur ursprünglichen Planung: EQs nutzen eine feste C++-Engine, die das Modell als
     Daten erhält. Pro Klon generierter Faust-Code war zu langsam zu übersetzen (≈ 11 s pro Band).
     Faust bleibt für Effektklassen, deren DSP-Code der Agent schreibt.
   - Nachgetragen: „Flat Tilt“ (Kette aus Kuhschwänzen 1. Ordnung, konstante Steigung), „Brickwall“-Flanken
     (elliptischer Prototyp, Ordnung/Welligkeit/Sperrdämpfung gefittet; Pro-Q 3: Ordnung 12, 0,03 dB, 90 dB),
     Parameter-Glättung (20 ms) und Ein-/Ausblenden bei Strukturwechseln; Pro-Q 3: alle 149 Messungen exakt, 0,10 dB
   - Offen: linearphasiger Modus, CLAP
4. **Desktop-Oberfläche:** Tauri, schlank und übersichtlich: Plugin wählen → Messen → Klonen,
   KI-Einstellungen, gut lesbares Live-Log aller Schritte ✔
   - Architektur: Web-Oberfläche ↔ Rust-Hülle ↔ Node-Bridge (`bridge/`, JSON-Zeilen, Jobs mit
     Fortschritt/Protokoll/Abbruch); Bibliothek mit Import/Export der Profile
4b. **Oberflächen-Nachbau** (in Arbeit)
   - `vch-gui` öffnet den Original-Editor unsichtbar (Xvfb), „Wiggle-Test“: jeden Parameter verstellen,
     Aufnahmen vergleichen → Regler/Schalter/Anzeigen, Farben, Flächen, Beschriftungen → `model/gui.json`
     (nur Layout-Daten, keine Grafiken des Originals im Profil); Klon-Editor zeichnet daraus, Vergleich per SSIM
   - Erledigt: Erkennung Drehregler/Schalter/Anzeigen, Parameter mit Anzeige + Regler, Schalter, die Regler
     abdunkeln, Ausgangswerte der Regler, plausibilitätsgeprüfte Beschriftungen, mehrfarbige Titel,
     fremde Fenster werden aus dem Aufnahmebereich geschoben, Testversions-Hinweis von FabFilter wird per
     Klick auf „Evaluate“ geschlossen; EQ-Anzeige: Frequenzachse an Rasterlinien eingerastet, Plotgrenzen aus
     den Rasterlinien, dB-Schrittweite, Lage/Farbe der dB-Beschriftung, Kurvenfarbe; Wertanzeigen (Typ „value“)
   - Pro-Q 3: Klon-Editor 76 % Struktur-, 98 % Farbähnlichkeit
   - Texterkennung mit tesseract (optional, eng+deu): Beschriftungen, Titel und freie Texte werden gelesen
     statt aus Parameternamen geraten; Schriftgröße aus Tintenhöhe und Buchstabenformen
   - Nachgetragen: Pegelreduktions-Nadeln und Pegelbalken (mit Testton im Original gefunden und kalibriert),
     runde Flächen (Kreis-Fit am Außenrand, radiales Farbprofil, Speichen), senkrechte Wörter, Texte unter
     beweglichen Teilen (in den Aufnahmen gelesen, in denen sie frei sind), unsichere OCR-Lesungen gegen
     Parameternamen abgeglichen; Schalter/Menüs, die als stufenlose Parameter gemeldet werden, an
     Werttext-Plateaus erkannt und im Klon als Auswahl-Parameter angelegt (Werte zurück auf die des Originals)
   - IEM Directional Compressor: 75 % Struktur-, 96 % Farbähnlichkeit
   - Offen: XY-Punkte (z. B. Richtung auf der Kugel), farbige Vollringe um Regler, Regler mit Verlauf und
     kleinem Zeiger (DS1), Skalen der Pegelmesser, Schriftstärken innerhalb eines Titels, Logos;
     Bänder direkt in der Kurve bedienen (Pro-Q-Stil) im Klon-Editor prüfen
5. **Kompressor + Distortion** (inkl. lokalem NAM-Training, CPU/GPU) ← in Arbeit
   - Messfolge `dynamics` (`--class dynamics`): lange Ruhephasen, steigende Pegeltreppe, Bursts (lang/kurz/klein),
     100-Hz-Stufen für Sättigung, Rauschen, leiser Sweep; Erkennung von Kompressoren an Parameternamen
   - Modell im Steuertakt (32 Samples, kausal): RMS/Peak-Detektor, Feed-forward/Feedback, Kennlinie mit Knick,
     Attack, schnelles Release, programmabhängiger Speicher (lädt bei anhaltender Kompression, baut dB-linear ab)
   - Fit: Struktur + Grundeinstellung voll, Sweeps statisch (Zeitwerte nur bei genug Kompression), Tabellen pro
     Plugin-Parameter, additiv kombiniert; Open Optical: Training 0,51 dB, Vorhersage unbekannter Kombinationen 0,96 dB
   - C++-Vorlage `plugin-template/dynamics` (Engine sample-genau wie die TS-Referenz), gemeinsame Parameter-Logik
     in `plugin-template/common`; `vch clone` erkennt Dynamik-Profile; Open Optical Clone: 0,72 dB zum Original
   - Programmabhängige Attack (Detektor mittelt Energie), dichtere Sweeps, PCHIP-Tabellen: 0,50 dB
   - Klangfarbe: tanh-Sättigung zwischen Pegelreduktion und Ausgangspegel + Detektor-Welligkeit (schneller
     Energiepfad, erzeugt die Oberwellen komprimierter Signale); Drive gemeinsam über alle Messungen gefittet
     (Änderungen nur wo die Messung sie verlangt); Open Optical: H3/H5 meist innerhalb 1–2 dB
   - Oberfläche: gemeinsamer Klon-Editor (`plugin-template/common`), Pegelreduktions-Nadel wird mit Audio im
     Original gefunden (Drehpunkt, Länge, Nabe, Skalenstriche) und am Kompressor-Modell kalibriert;
     Wertformat wie im Original; Open Optical: 82 % Struktur-, 95 % Farbähnlichkeit
   - Desktop-App: Kompressor-Messung als eigener Modus, Vorschau des Klons und Profil-Details in der Bibliothek
   - IEM Directional Compressor (25 Parameter, Menüs als stufenlose Parameter): 0,71 dB über 224 Einstellungen
   - **Distortion** (`--class distortion`): Sinus-Pegeltreppen bei mehreren Frequenzen, Rauschen, leiser Sweep;
     Wiener-Hammerstein-Modell (Vorfilter → asymmetrische weiche Begrenzung + harte Schienen → Nachfilter),
     pro Regler automatisch gewählt, welche Modellteile er verändert; Laufzeit des Originals übernommen;
     Fit parallel in Worker-Threads (~110 s); C++-Vorlage `plugin-template/distortion` sample-genau
   - GxBoss DS1: Grundton 0,68 dB, Oberwellen 1,8 dB, Kleinsignal 1,23 dB, Fehler/Signal −6,8 dB
   - Offen: Distortion-Modus in der App, Zeitbereichs-Term im Fit (Fehler/Signal), Fit-Zeit Kompressor (~60 s),
     Rahmen/Dekor; danach Amps mit NAM (Swanky Amp, TONE3000)
6. **Delay + Reverb**
7. **REA-Integration** (Analyst-Agent, `spec.md`, Clean-Room-Trennung) + **yabridge-Check**
8. **Distribution:** Installer, Updates, Profilbibliothek

## Risiken / Erwartungen
- Sehr gut klonbar: lineare Effekte, Kompressoren, Amps/Verzerrer.
- Nur angenähert: stark zeitvariante/zufällige Effekte, komplexe Multieffekte.
- GUI wird als Layout nachgebaut (Formen, Farben, Regler), nicht pixelgenau; Grafiken des Originals werden nicht übernommen.
- NAM-Training ohne GPU langsam (Minuten bis Stunden pro Modell).
- yabridge löst viele Fälle ohne Klon; App soll das zuerst anbieten.
- Tests zunächst mit freien/Open-Source-Plugins, bei denen das Ergebnis überprüfbar ist.
