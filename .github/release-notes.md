Measure audio effect plugins as a black box and rebuild them as free LV2/VST3 clones.

**Downloads**
- **Linux:** `vst-cloner_*_amd64.AppImage` – make it executable (`chmod +x`) and start it. The runtime (Node,
  measurement host, templates) is unpacked on the first start.
- **Windows:** `vst-cloner_*_x64-setup.exe` – the installer brings the runtime.

**To build clones** the app needs CMake and a C++ compiler on the system (on Windows: the Visual Studio Build
Tools with "Desktop development with C++", which include CMake). The app checks this at start and says what is
missing and how to install it. Optional: Xvfb (rebuilding the original's editor on Linux), Tesseract (reading
its texts), yabridge (Windows plugins on Linux).

**This is an early version.** Windows builds are tested on GitHub Actions only (tests and an end-to-end clone
build), not yet on a real Windows machine. See the README for what each effect class reaches today.
