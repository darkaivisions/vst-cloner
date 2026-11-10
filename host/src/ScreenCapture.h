#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace vch
{

/** Captures a region of the screen as RGBA (8 bit per channel). Linux: X11 (run under Xvfb for headless use).
    Returns false and sets `error` if capturing is not possible. */
bool captureScreen (int x, int y, int width, int height, std::vector<uint8_t>& rgba, std::string& error);

/** Moves every other visible top-level window (e.g. a licence or welcome dialog opened by the plugin) out of the
    capture area so that it cannot cover the editor. Nothing is clicked. Returns the titles of moved windows. */
std::vector<std::string> moveOtherWindowsAway (unsigned long ownWindow, int x, int y, int width, int height);

/** Focuses the window under the centre of `ownWindow` (the plugin's own editor window) and presses `keyName`
    (an X keysym name such as "Escape"). Used to close dialogs that plugins draw inside their editor. */
bool pressKey (unsigned long ownWindow, const char* keyName);

/** Clicks the left mouse button at (x, y) relative to `ownWindow`, then parks the pointer outside of the editor
    (so that no hover effect remains in the captures). Used to close notices drawn inside the editor. */
bool clickAt (unsigned long ownWindow, int x, int y);

/** Prepares a bare X server (no window manager) for JUCE windows. Call before JUCE initialises. */
void prepareDisplay();

/** Plugins with older JUCE versions trigger harmless X errors on a bare X server; log instead of aborting. */
void installXErrorHandler();

} // namespace vch
