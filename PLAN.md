# Plan: VST-Cloner (Effekt-Plugins unter Linux nutzbar machen)

Stand: 15.11.2026 (überarbeitet: Abgleich des ursprünglichen Plans mit dem Erreichten)

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
- **Jeder Klon wird gemessen:** Der fertige Klon durchläuft dieselben Messungen wie das Original;
  ein Teil der Messungen (Zufallskombinationen) dient nur zur Gegenprobe und nie zum Fitten.

## Workflow
```
Windows-PC (Plugin lizenziert)         Linux-PC
┌─────────────────────────┐  .vcprofile ┌───────────────────────────┐
│ Capture-Host            │ ──────────► │ App: Analyse + Klonbau    │
│ misst Plugin offline    │             │ (VST3/LV2), Vergleich mit │
└─────────────────────────┘             │ den Messungen             │
                                         └───────────────────────────┘
```

## Architektur
```
┌──────────── UI: Tauri v2 (Rust + Web) ─────────────┐
│ Plugin wählen → Messen → Klonen · Bibliothek · KI  │
└──────────────────────┬─────────────────────────────┘
                       │ JSON-Zeilen (Jobs, Fortschritt, Abbruch)
┌──────────────────────▼─────────────────────────────┐
│ bridge (Node/TS)                                   │
├────────────┬───────────────────────┬───────────────┤
│ capture    │ clone                 │ agent         │
│ Messplan,  │ Weg A: Fit + feste    │ LLM-Anbieter, │
│ Profil     │        C++-Engine     │ Rollen        │
│            │ Weg B: Builder-Agent  │ (für Weg B)   │
│            │        + Faust (M7)   │               │
└─────┬──────┴──────────┬────────────┴───────────────┘
      │ stdio/JSON      │ CMake
┌─────▼──────────┐ ┌────▼─────────────────────────┐
│ vch-host,      │ │ plugin-template/<klasse>     │
│ vch-gui        │ │ C++/JUCE-Engine + Modell als │
│ C++ / JUCE 9   │ │ Daten → VST3 + LV2           │
└────────────────┘ └──────────────────────────────┘
```

### Zwei Wege zum Klon
- **Weg A – feste Engines (gebaut):** Pro Effektklasse gibt es ein parametrisches Modell, einen
  deterministischen Fit in TypeScript (Worker-Threads) und eine C++/JUCE-Engine, die sample-genau wie die
  TypeScript-Referenz rechnet und das Modell als Datendatei erhält. Schnell (Sekunden bis wenige Minuten),
  ohne LLM, reproduzierbar. Deckt EQ, Dynamik, Verzerrer, Delay und Reverb ab.
- **Weg B – Builder-Agent (geplant, Meilenstein 7):** Ein Agent schreibt Faust-Code aus `spec.md` und
  Messdaten und verbessert ihn in einer Schleife. Für alles, was keine feste Engine abdeckt – Plugins ohne
  Klasse, Multiband-Kompressoren, dynamische EQs, Multieffekte – und als Nachbesserung, wenn Weg A nur
  „ungenau“ liefert.

### Komponenten
- **UI:** Tauri v2 (`apps/desktop`): Klonen, Bibliothek, KI-Modelle, Live-Protokoll.
- **bridge:** JSON-Zeilen-Schnittstelle zwischen Oberfläche und den Paketen (Jobs mit Fortschritt/Abbruch).
- **vch-host / vch-gui:** C++20 mit JUCE 9. Bewusst „dumm“: lädt Plugin, liest Parameter, rendert
  WAV-Eingang → WAV-Ausgang pro Parametersatz; `vch-gui` öffnet Editoren unsichtbar (Xvfb) und nimmt sie auf.
- **capture (Node/TS):** Testsignale (deterministisch), Messplan, Ansteuerung von vch-host, Profil, CLI `vch`,
  Plugin-Scanner.
- **clone (Node/TS):** Messpläne, Fits, Vergleich und Codegeneratoren pro Klasse (`eq/`, `dynamics/`,
  `distortion/`, `delay/`, `reverb/`), Oberflächen-Analyse (`gui/`), Klassifizierung und Batch-Lauf.
- **plugin-template:** C++/JUCE-Engines pro Klasse, gemeinsame Parameter-Logik und Klon-Editor in `common/`.
- **agent (Node/TS):** Vercel AI SDK für alle LLM-Anbieter, später MCP-Client für REA.
  Zwei getrennte Rollen: `analyst` (darf REA nutzen, erzeugt `spec.md`) und
  `builder` (sieht nur `spec.md`, Parameter, Captures, Metriken). Bisher nur Einrichtung, noch nicht in der
  Klon-Pipeline.
- **dsp/:** Faust-Templates (Weg B) und NAM-Training (Meilenstein 5c) – noch leer.
- TypeScript läuft ohne Build-Schritt direkt mit Node ≥ 22.18 (Type Stripping).

## LLM-Anbindung
- Provider: OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter (Cloud);
  Ollama, LM Studio, llama.cpp-Server, vLLM (lokal, OpenAI-kompatibel, Auto-Discovery).
- Modellwahl pro Rolle (z. B. Analyse lokal, Codegenerierung in der Cloud).
- Fähigkeitstest beim Einrichten: Tool-Calling, Kontextlänge, strukturierte Ausgabe.
- Token-/Kostenanzeige pro Job, API-Keys im OS-Keychain (libsecret / Windows Credential Manager).
- REA als gepinnte Version gebündelt, Update-Check über `rea update` (REA braucht Node ≥ 22.23.4).

## Effekt-Klassen und Methoden
Klassifizierung über Regeln (`classifyPlugin`: Parameternamen, Kategorie, Name), eine Stelle für App und Batch.
Instrumente, Multiband-Kompressoren und dynamische EQs erhalten bewusst keine Klasse. Wo die Regeln nichts
finden, entscheidet später das LLM (Meilenstein 7).

| Klasse | Messung | Modell (Weg A) | Stand |
|---|---|---|---|
| EQ / Filter | Impulsantwort pro Filterform × Frequenz × Gain × Güte | Biquad-Kette, elliptische Brickwall-Flanken, gefittete Q-Kennlinie | ✔ – offen: linearphasig |
| Kompressor / Limiter | Pegeltreppe, Bursts, lange Pausen, 100-Hz-Stufen, Rauschen | Detektor (RMS/Peak, FF/FB), Kennlinie mit Knick, Attack/Release, Opto-Speicher, Sättigung | ✔ |
| Gate / Expander / Ducker | wie Kompressor | Expander-Kennlinie mit Range, invertierte Kennlinie | ✔ |
| Verzerrer (Pedale) | Sinus-Pegeltreppen bei mehreren Frequenzen, Rauschen, leiser Sweep | Wiener-Hammerstein (Vorfilter → Begrenzung → Nachfilter) | ✔ an einem Plugin – Batch-Lauf offen |
| Amp / Tape | Rauschen + Musik über Parameterraster | NAM / RTNeural-LSTM, Parameter-konditioniert | offen (5c) |
| Delay / Echo | Impuls mit langer Stille, Rauschburst | Delay-Line mit Feedback, Tief-/Hochpass in der Schleife und im Wet-Pfad | erste Fassung |
| Reverb | Impuls und Ausklang | FDN hinter Pre-Delay; Pegel und Nachhallzeit in drei Bändern | erste Fassung |
| Modulation (Chorus, Flanger, Phaser, Tremolo) | lange Sweeps, LFO-Erkennung | – | offen (6b) |
| alles andere | allgemeiner Messplan | Weg B (Faust) | offen (7) |

- **Parameterraster:** Einzelparameter-Sweeps + Zufallskombinationen zur Gegenprobe; pro Regler eine Tabelle
  auf die Modellwerte (PCHIP), Wechselwirkungen (z. B. automatisches Makeup) als eigene Terme.
- **Schalter:** bis vier Stellungen bekommen bei Bedarf ein eigenes Modell samt Struktur.
- **Arbeitspunkt-Probe:** Der Messplan sucht eine Einstellung, in der der Effekt hörbar arbeitet
  (Kompressor komprimiert, Delay hat ein Echo).
- **DAW-Kompatibilität:** Klon übernimmt Parameternamen und -bereiche (Automation/Projekte übertragbar).

## Agent-Schleife (Builder, Weg B)
1. Faust-Code (bzw. Modell-Config) aus `spec.md` + Messdaten generieren
2. Kompilieren (Fehler zurück an Agent)
3. Mit identischen Testsignalen rendern
4. Metriken pro Parameterpunkt: ESR, spektrale Distanz (Multi-Resolution STFT), Pegel-/Latenzabgleich;
   für Plugins mit Klasse zusätzlich die Kennzahl der Klasse (wie Weg A, damit beide Wege vergleichbar sind)
5. Iterieren bis Schwellwert oder max. Iterationen; Qualitätsbericht ins Profil

Erfahrung aus Meilenstein 3: Faust übersetzt langsam (≈ 11 s pro EQ-Band). Die Schleife braucht deshalb
kleine Übersetzungseinheiten und einen Cache.

## Qualitätssicherung
- **`vch batch --class <klasse>`** misst und klont jedes installierte Plugin einer Klasse (derzeit 339 Plugins,
  Zeitlimit 15 min pro Plugin, Bericht `report.md`/`report.json`, Fortsetzen nach Abbruch). Dient als
  Regressionstest: Jede Änderung an Fit oder Modell wird am ganzen Bestand geprüft.
- **Kennzahlen:** „Klon vs. Original“ (alle Messungen) und „unbekannte Kombinationen“ (nur Gegenprobe).
  Bewertung in fünf Stufen von „ausgezeichnet“ bis „ungenau“; Schwellen je Klasse.
- Klone, die NaN ausgeben oder deren Messung den Effekt gar nicht zeigt („keine Kompression gemessen“),
  werden ausgewiesen statt gut bewertet.
- Tests zunächst mit freien/Open-Source-Plugins, bei denen das Ergebnis überprüfbar ist.

Stand der Batch-Läufe (12./13.11.):

| Klasse | Plugins | Ergebnis |
|---|---|---|
| Dynamik | 9 Kompressoren/Limiter + ZamGate | 0,27–2,32 dB; 2× ausgezeichnet, 4× sehr gut, 2× gut, 1× brauchbar, 1× „keine Kompression gemessen“; unbekannte Kombinationen 0,43–9,72 dB |
| Delay | 12 | 1× sehr gut, 3× gut, 3× brauchbar, 5× ungenau; unbekannte Kombinationen meist 11–26 dB |
| Reverb | 18 (+1 Fehler beim Messen) | 5× sehr gut, 6× gut, 6× brauchbar, 1× ungenau; unbekannte Kombinationen 2–30 dB |
| EQ, Verzerrer | – | noch kein Batch-Lauf |

## Profilformat `.vcprofile`
Details: [docs/profile-format.md](docs/profile-format.md). ZIP-Container, versioniertes JSON-Schema:
```
manifest.json        Schema-Version, Plugin-Info, Capture-Einstellungen, Host/OS
parameters.json      Parameter, Bereiche, Defaults, Wertetexte
test-signals.json    Segmente + Seeds der Testsignale (reproduzierbar statt gespeichert) + SHA-256
captures.json        Index: Render-ID → Datei, Parameterwerte, Latenz, Pegel
captures/*.wav       Antworten als WAV float32 (verlustfrei, ZIP-komprimiert)
model/               Modell der Klasse (eq.json, …), gui.json; später Faust .dsp, .nam
report.json          Qualitätsmetriken des letzten Builds
spec.md              Funktionale Spezifikation (ohne Code)            (ab M7)
checksums.sha256
```
- Import → Neubau des Klons ohne Original-Plugin.
- Keine Binärteile, Samples oder Code des Originals im Profil.

## Projektstruktur (Monorepo)
```
vst-cloner/
├─ apps/desktop/      Tauri v2 UI
├─ bridge/            JSON-Zeilen-Schnittstelle UI ↔ Pakete
├─ host/              C++/JUCE vch-host und vch-gui (CMake, Win + Linux)
├─ capture/           Node/TS: Testsignale, Messplan, Plugin-Scanner, CLI `vch`
├─ profile/           JSON-Schema + Reader/Writer + WAV-I/O (TS)
├─ clone/             Node/TS: Fits, Modelle, Vergleich, GUI-Analyse, Batch
├─ plugin-template/   C++/JUCE-Engines: eq, dynamics, distortion, delay, reverb, common
├─ agent/             Node/TS: AI SDK, Rollen; MCP→REA, Analyst-/Builder-Agent (M7)
├─ dsp/               Faust-Templates, NAM-Training (M5c, M7)
└─ docs/
```

## Meilensteine
1. **Profilformat + Capture-Host** ✔
2. **LLM-Layer** ✔ – Anbieter, Auto-Discovery, Fähigkeitstest, Keychain, Kosten, Rollen; CLI `vch llm …`
3. **EQ/Filter** ✔ – Pro-Q 3: 0,10 dB über 149 Einstellungen
   - Offen: linearphasiger Modus
4. **Desktop-Oberfläche** ✔ – Klonen, Bibliothek, KI-Modelle, Protokoll; Modi EQ, Dynamik, Verzerrer, Allgemein
   - **4b Oberflächen-Nachbau** (läuft) – Wiggle-Test, OCR, Nadeln, Pegelbalken, Schalter-Erkennung;
     74–82 % Struktur-, 95–98 % Farbähnlichkeit an vier Plugins
     - Offen: XY-Punkte, farbige Vollringe um Regler, Regler mit Verlauf und kleinem Zeiger (DS1), Skalen der
       Pegelmesser, Schriftstärken innerhalb eines Titels, Logos, Rahmen/Dekor; Bänder direkt in der Kurve
       bedienen im Klon-Editor prüfen; Oberflächen im Batch-Lauf mitprüfen
5. **Dynamik + Verzerrer**
   - **5a Dynamik** ✔ – Kompressor, Limiter, Gate, Expander, Ducker; Arbeitspunkt-Probe, Wechselwirkungen,
     Modelle pro Schalterstellung
     - Offen: Fit-Zeit (1–4 min pro Plugin), GxCompressor und DirectionalCompressor bei unbekannten
       Kombinationen (7–10 dB)
   - **5b Verzerrer (Pedale)** ✔ – Wiener-Hammerstein; GxBoss DS1: Grundton 0,68 dB, Oberwellen 1,8 dB
     - Offen: Batch-Lauf, Erkennung schärfen (97 Treffer, darunter Decoder, Tuner, Balance-Regler),
       Zeitbereichs-Term im Fit
   - **5c Amps mit NAM** – lokales Training (CPU/GPU), Swanky Amp, TONE3000
6. **Delay + Reverb + Modulation**
   - **6a Delay + Reverb** ← als Nächstes – erste Fassung in CLI und Batch ✔
     - Offen: Modi in App und Bridge, unbekannte Kombinationen (Delay), Oberfläche, Batch-Lauf für EQ
   - **6b Modulation** – Chorus, Flanger, Phaser, Tremolo
7. **Builder-Agent (Weg B)** – Faust-Schleife, Analyst-Agent mit REA und `spec.md`, Clean-Room-Trennung,
   Klassifizierung durch LLM für Plugins ohne Klasse
8. **yabridge-Check** – App prüft zuerst, ob das Original über yabridge läuft
9. **Distribution** – Installer, Updates, Profilbibliothek, CLAP, Windows-Build prüfen

## Abweichungen vom ursprünglichen Plan
- **Feste Engines statt generiertem Faust-Code** für die bekannten Klassen (pro Klon generierter Faust-Code war
  zu langsam zu übersetzen). Faust bleibt für Weg B.
- **Fits in TypeScript** statt Python-Tools.
- **Klassifizierung über Regeln** statt LLM; das LLM übernimmt erst die Fälle ohne Klasse.
- **Verzerrer als Wiener-Hammerstein-Modell** statt NAM; NAM bleibt für Amps.
- **Reverb als FDN in C++** statt Faltung oder Faust.
- **Klassenspezifische Kennzahlen in dB** statt ESR/MR-STFT; diese bleiben für Weg B.
- **Batch-Lauf** und **Oberflächen-Nachbau** waren nicht geplant und sind dazugekommen.
- Delay und Reverb wurden vor Amps/NAM begonnen.

## Risiken / Erwartungen
- Sehr gut klonbar: EQs, Kompressoren, Limiter, einfache Verzerrer.
- Brauchbar, aber noch nicht treu über alle Reglerkombinationen: Delays, Reverbs.
- Nur angenähert: stark zeitvariante/zufällige Effekte, komplexe Multieffekte.
- Erst mit Weg B: Multiband-Kompressoren, dynamische EQs, Plugins ohne Klasse.
- Fehlklassifizierung führt zu Klonen mit falschem Modell; die Bewertung fängt das nur teilweise ab.
- GUI wird als Layout nachgebaut (Formen, Farben, Regler), nicht pixelgenau; Grafiken des Originals werden nicht übernommen.
- NAM-Training ohne GPU langsam (Minuten bis Stunden pro Modell).
- yabridge löst viele Fälle ohne Klon; App soll das zuerst anbieten.
