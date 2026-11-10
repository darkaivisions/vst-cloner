#include "ScreenCapture.h"

#include <algorithm>
#include <cstdio>

#if defined(__linux__)
 #include <X11/Xlib.h>
 #include <X11/Xutil.h>
 #include <X11/extensions/XTest.h>
#endif

namespace vch
{

#if defined(__linux__)

namespace
{
    int shiftOf (unsigned long mask)
    {
        int shift = 0;
        while (mask != 0 && (mask & 1) == 0) { mask >>= 1; ++shift; }
        return shift;
    }

    int bitsOf (unsigned long mask)
    {
        int bits = 0;
        while (mask != 0) { bits += (int) (mask & 1); mask >>= 1; }
        return bits;
    }

    uint8_t channel (unsigned long pixel, unsigned long mask)
    {
        const int bits = bitsOf (mask);
        if (bits == 0) return 0;
        const unsigned long value = (pixel & mask) >> shiftOf (mask);
        return (uint8_t) ((value * 255) / ((1ul << bits) - 1));
    }
}

namespace
{
    Display* sharedDisplay()
    {
        static Display* display = XOpenDisplay (nullptr);
        return display;
    }
}

namespace
{
    int ignoreXError (Display*, XErrorEvent* event)
    {
        fprintf (stderr, "[vch-gui] ignored X error %d (request %d)\n", (int) event->error_code, (int) event->request_code);
        return 0;
    }
}

void installXErrorHandler()
{
    XSetErrorHandler (ignoreXError);
}

void prepareDisplay()
{
    auto* display = sharedDisplay();
    if (display == nullptr)
        return;

    // A bare X server (Xvfb) has no window manager, so these atoms do not exist yet.
    // JUCE looks them up "if exists" and would otherwise use atom 0, which aborts the program.
    const char* names[] = {
        "WM_STATE", "_NET_WM_WINDOW_TYPE", "_NET_WM_WINDOW_TYPE_NORMAL", "_NET_WM_WINDOW_TYPE_DIALOG",
        "_NET_WM_STATE", "_NET_WM_STATE_HIDDEN", "_NET_WM_STATE_MAXIMIZED_HORZ", "_NET_WM_STATE_MAXIMIZED_VERT",
        "_NET_WM_STATE_FULLSCREEN", "_NET_WM_STATE_SKIP_TASKBAR", "_NET_WM_STATE_ABOVE", "_NET_WM_MOVERESIZE",
        "_NET_FRAME_EXTENTS", "_NET_WORKAREA", "_MOTIF_WM_HINTS", "_NET_WM_ALLOWED_ACTIONS",
        "_NET_WM_ACTION_RESIZE", "_NET_WM_ACTION_FULLSCREEN", "_NET_WM_ACTION_MINIMIZE", "_NET_WM_ACTION_MAXIMIZE_HORZ",
        "_NET_WM_ACTION_MAXIMIZE_VERT", "_NET_WM_ACTION_CLOSE", "_NET_WM_PID", "_NET_WM_ICON", "_NET_WM_NAME",
        "_NET_SUPPORTED", "_NET_ACTIVE_WINDOW", "_WIN_HINTS", "KWM_WIN_DECORATION", "_KDE_NET_WM_WINDOW_TYPE_OVERRIDE",
        "_NET_WM_WINDOW_TYPE_UTILITY", "_NET_WM_WINDOW_TYPE_TOOLTIP", "_NET_WM_WINDOW_TYPE_POPUP_MENU",
        "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU", "_NET_WM_WINDOW_TYPE_COMBO", "_NET_WM_WINDOW_TYPE_SPLASH",
        "_NET_WM_PING", "_NET_WM_USER_TIME", "_XEMBED", "_XEMBED_INFO", "UTF8_STRING",
    };

    for (auto* name : names)
        XInternAtom (display, name, False);

    XSync (display, False);
}

std::vector<std::string> moveOtherWindowsAway (unsigned long ownWindow, int x, int y, int width, int height)
{
    std::vector<std::string> moved;
    auto* display = sharedDisplay();
    if (display == nullptr)
        return moved;

    XSync (display, False);
    Window rootReturn = 0, parentReturn = 0;
    Window* children = nullptr;
    unsigned int count = 0;
    if (XQueryTree (display, DefaultRootWindow (display), &rootReturn, &parentReturn, &children, &count) == 0)
        return moved;

    const int screenWidth = DisplayWidth (display, DefaultScreen (display));
    int nextY = 0;

    for (unsigned int i = 0; i < count; ++i)
    {
        const Window window = children[i];
        if (window == (Window) ownWindow)
            continue;

        XWindowAttributes attributes {};
        if (XGetWindowAttributes (display, window, &attributes) == 0 || attributes.map_state != IsViewable
            || attributes.c_class == InputOnly || attributes.width < 40 || attributes.height < 30)
            continue;

        const bool intersects = attributes.x < x + width && attributes.x + attributes.width > x
                             && attributes.y < y + height && attributes.y + attributes.height > y;
        if (! intersects)
            continue;

        // park it to the right of the editor (the virtual screen is much larger than any editor)
        const int targetX = std::max (x + width + 40, screenWidth - attributes.width - 10);
        XMoveWindow (display, window, targetX, nextY);
        nextY += attributes.height + 10;

        char* name = nullptr;
        std::string title = "(untitled)";
        if (XFetchName (display, window, &name) != 0 && name != nullptr)
        {
            title = name;
            XFree (name);
        }
        moved.push_back (title);
    }

    if (children != nullptr)
        XFree (children);

    XSync (display, False);
    return moved;
}

bool pressKey (unsigned long ownWindow, const char* keyName)
{
    auto* display = sharedDisplay();
    int eventBase = 0, errorBase = 0, major = 0, minor = 0;
    if (display == nullptr || ! XTestQueryExtension (display, &eventBase, &errorBase, &major, &minor))
        return false;

    XWindowAttributes attributes {};
    if (XGetWindowAttributes (display, (Window) ownWindow, &attributes) == 0)
        return false;

    // descend to the deepest window under the centre (the embedded plugin window)
    int cx = attributes.width / 2, cy = attributes.height / 2;
    Window target = (Window) ownWindow;
    for (int depth = 0; depth < 16; ++depth)
    {
        Window child = 0;
        int tx = 0, ty = 0;
        if (! XTranslateCoordinates (display, target, target, cx, cy, &tx, &ty, &child) || child == 0)
            break;
        XWindowAttributes childAttributes {};
        if (XGetWindowAttributes (display, child, &childAttributes) == 0)
            break;
        cx -= childAttributes.x;
        cy -= childAttributes.y;
        target = child;
    }

    int rootX = 0, rootY = 0;
    Window ignored = 0;
    XTranslateCoordinates (display, (Window) ownWindow, DefaultRootWindow (display), attributes.width / 2, attributes.height / 2, &rootX, &rootY, &ignored);
    XTestFakeMotionEvent (display, DefaultScreen (display), rootX, rootY, CurrentTime);
    XSetInputFocus (display, target, RevertToParent, CurrentTime);

    const KeyCode code = XKeysymToKeycode (display, XStringToKeysym (keyName));
    if (code == 0)
        return false;
    XTestFakeKeyEvent (display, code, True, CurrentTime);
    XTestFakeKeyEvent (display, code, False, CurrentTime);
    XSync (display, False);
    return true;
}

bool clickAt (unsigned long ownWindow, int x, int y)
{
    auto* display = sharedDisplay();
    int eventBase = 0, errorBase = 0, major = 0, minor = 0;
    if (display == nullptr || ! XTestQueryExtension (display, &eventBase, &errorBase, &major, &minor))
        return false;

    int rootX = 0, rootY = 0;
    Window ignored = 0;
    if (! XTranslateCoordinates (display, (Window) ownWindow, DefaultRootWindow (display), x, y, &rootX, &rootY, &ignored))
        return false;

    const int screen = DefaultScreen (display);
    XTestFakeMotionEvent (display, screen, rootX, rootY, CurrentTime);
    XSync (display, False);
    XTestFakeButtonEvent (display, 1, True, CurrentTime);
    XSync (display, False);
    XTestFakeButtonEvent (display, 1, False, CurrentTime);
    XTestFakeMotionEvent (display, screen, DisplayWidth (display, screen) - 1, DisplayHeight (display, screen) - 1, CurrentTime);
    XSync (display, False);
    return true;
}

bool captureScreen (int x, int y, int width, int height, std::vector<uint8_t>& rgba, std::string& error)
{
    auto* display = sharedDisplay();

    if (display == nullptr)
    {
        error = "cannot open X display (set DISPLAY, e.g. run under Xvfb)";
        return false;
    }

    XSync (display, False);
    const Window root = DefaultRootWindow (display);
    XImage* image = XGetImage (display, root, x, y, (unsigned) width, (unsigned) height, AllPlanes, ZPixmap);

    if (image == nullptr)
    {
        error = "XGetImage failed";
        return false;
    }

    rgba.resize ((size_t) width * (size_t) height * 4);

    for (int row = 0; row < height; ++row)
    {
        for (int col = 0; col < width; ++col)
        {
            const unsigned long pixel = XGetPixel (image, col, row);
            auto* out = &rgba[((size_t) row * (size_t) width + (size_t) col) * 4];
            out[0] = channel (pixel, image->red_mask);
            out[1] = channel (pixel, image->green_mask);
            out[2] = channel (pixel, image->blue_mask);
            out[3] = 255;
        }
    }

    XDestroyImage (image);
    return true;
}

#else

void prepareDisplay() {}
void installXErrorHandler() {}
std::vector<std::string> moveOtherWindowsAway (unsigned long, int, int, int, int) { return {}; }
bool pressKey (unsigned long, const char*) { return false; }
bool clickAt (unsigned long, int, int) { return false; }

bool captureScreen (int, int, int, int, std::vector<uint8_t>&, std::string& error)
{
    error = "screen capture is not implemented on this platform yet";
    return false;
}

#endif

} // namespace vch
