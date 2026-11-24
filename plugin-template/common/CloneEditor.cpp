#include "CloneEditor.h"

#include "CloneProcessor.h"

#include <cmath>

namespace
{
    using namespace clonegui;

    juce::Colour colour (uint32_t argb) { return juce::Colour (argb); }

    void fillArea (juce::Graphics& g, const Fill& fill, juce::Rectangle<float> area)
    {
        if (fill.hasGradient)
            g.setGradientFill (juce::ColourGradient (colour (fill.color), area.getX(), area.getY(), colour (fill.gradient), area.getX(), area.getBottom(), false));
        else
            g.setColour (colour (fill.color));
    }

    juce::Font makeFont (float height, bool bold)
    {
        return juce::Font (juce::FontOptions().withHeight (height).withStyle (bold ? "Bold" : "Regular"));
    }

    /** Draws text squeezed or stretched to the measured width of the original text block. */
    void drawFitted (juce::Graphics& g, const juce::String& text, juce::Rectangle<float> box, float capHeight, bool bold, int align, float size = 0.0f)
    {
        auto font = makeFont (size > 0.0f ? size : capHeight / 0.72f, bold);
        const float natural = juce::GlyphArrangement::getStringWidth (font, text);
        if (natural > 0.0f && box.getWidth() > 0.0f)
            font = font.withHorizontalScale (juce::jlimit (0.55f, 1.6f, box.getWidth() / natural));
        g.setFont (font);
        const auto justification = align == 0 ? juce::Justification::centredLeft : align == 2 ? juce::Justification::centredRight : juce::Justification::centred;
        // extra room only on the side the text may grow to – the anchored edge stays where it was measured
        const float extra = box.getWidth() * 0.2f;
        auto area = box.expanded (0.0f, capHeight);
        area = align == 0 ? area.withWidth (area.getWidth() + extra)
             : align == 2 ? area.withLeft (area.getX() - extra)
                          : area.expanded (extra, 0.0f);
        g.drawText (text, area, justification, false);
    }

    juce::Point<float> polar (float cx, float cy, float r, float angle)
    {
        return { cx + std::sin (angle) * r, cy - std::cos (angle) * r };
    }

    // ---- knob ------------------------------------------------------------------------------

    class Knob final : public juce::Slider
    {
    public:
        explicit Knob (const Control& c) : control (c)
        {
            setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
            setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
            const auto& r = control.rotary;
            // (only for JUCE's bookkeeping: the knob is painted below, also when it turns anticlockwise)
            const float lo = std::min (r.start, r.end), hi = std::max (r.start, r.end);
            const float offset = lo < 0 ? juce::MathConstants<float>::twoPi : 0.0f;
            setRotaryParameters (lo + offset, std::max (hi + offset, lo + offset + 0.1f), true);
            setVelocityBasedMode (false);
            setMouseDragSensitivity (220);
        }

        void paint (juce::Graphics& g) override
        {
            const auto& r = control.rotary;
            // local coordinates: control box origin
            const float cx = r.cx - control.x, cy = r.cy - control.y;
            const float value = (float) valueToProportionOfLength (getValue());
            const float angle = r.start + value * (r.end - r.start);

            if (r.ticks.count > 0)
            {
                g.setColour (colour (r.ticks.color));
                for (int i = 0; i < r.ticks.count; ++i)
                    g.drawLine ({ polar (cx, cy, r.radius * r.ticks.inner, r.ticks.angles[i]), polar (cx, cy, r.radius * r.ticks.outer, r.ticks.angles[i]) }, r.ticks.width);
            }

            if (r.hasArc)
            {
                auto arc = [&] (float from, float to, juce::Colour c)
                {
                    juce::Path p;
                    p.addCentredArc (cx, cy, r.arcRadius, r.arcRadius, 0.0f, std::min (from, to), std::max (from, to), true);
                    g.setColour (c);
                    g.strokePath (p, juce::PathStrokeType (r.arcWidth, juce::PathStrokeType::curved, juce::PathStrokeType::butt));
                };
                if (r.hasTrack)
                    arc (r.start, r.end, colour (r.track));
                const float from = r.start + r.arcOrigin * (r.end - r.start);
                if (std::abs (angle - from) > 0.01f)
                    arc (from, angle, colour (r.arcColor));
            }

            const auto body = juce::Rectangle<float> (cx - r.radius, cy - r.radius, r.radius * 2, r.radius * 2);
            fillArea (g, r.body, body);
            g.fillEllipse (body);
            if (r.hasOutline)
            {
                g.setColour (colour (r.outline));
                g.drawEllipse (body, 1.5f);
            }

            g.setColour (colour (r.pointer));
            if (r.dot)
            {
                const auto p = polar (cx, cy, r.radius * (r.pointerInner + r.pointerOuter) * 0.5f, angle);
                const float d = std::max (3.0f, r.pointerWidth + 2.0f);
                g.fillEllipse (p.x - d / 2, p.y - d / 2, d, d);
            }
            else
            {
                juce::Path p;
                p.startNewSubPath (polar (cx, cy, r.radius * r.pointerInner, angle));
                p.lineTo (polar (cx, cy, r.radius * r.pointerOuter, angle));
                g.strokePath (p, juce::PathStrokeType (r.pointerWidth, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
            }

            if (r.hasCap)
            {
                g.setColour (colour (r.cap));
                g.fillEllipse (cx - r.capRadius, cy - r.capRadius, r.capRadius * 2, r.capRadius * 2);
            }
        }

        bool hitTest (int x, int y) override
        {
            const auto& r = control.rotary;
            return juce::Point<float> ((float) x, (float) y).getDistanceFrom ({ r.cx - control.x, r.cy - control.y }) <= r.radius * 1.3f;
        }

    private:
        const Control& control;
    };

    // ---- linear slider -----------------------------------------------------------------------

    class Fader final : public juce::Slider
    {
    public:
        explicit Fader (const Control& c) : control (c)
        {
            setSliderStyle (c.kind == 2 ? juce::Slider::LinearVertical : juce::Slider::LinearHorizontal);
            setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            const float value = (float) valueToProportionOfLength (getValue());
            const float thumb = control.f1;
            const bool horizontal = control.kind == 1;
            g.setColour (colour (control.c1));
            if (control.trackWidth > 0.0f)
                g.fillRect (horizontal ? b.withSizeKeepingCentre (b.getWidth(), control.trackWidth) : b.withSizeKeepingCentre (control.trackWidth, b.getHeight()));
            else
                g.fillRoundedRectangle (b, std::min (b.getWidth(), b.getHeight()) / 2);
            g.setColour (colour (control.c2));
            const float at = horizontal ? b.getX() + value * (b.getWidth() - thumb) : b.getY() + (1 - value) * (b.getHeight() - thumb);
            if (control.roundThumb)
            {
                const float d = std::min (thumb, horizontal ? b.getHeight() : b.getWidth());
                const juce::Point<float> centre = horizontal ? juce::Point<float> (at + thumb / 2, b.getCentreY()) : juce::Point<float> (b.getCentreX(), at + thumb / 2);
                g.fillEllipse (juce::Rectangle<float> (d, d).withCentre (centre));
            }
            else if (horizontal)
                g.fillRoundedRectangle (at, b.getY(), thumb, b.getHeight(), 2.0f);
            else
                g.fillRoundedRectangle (b.getX(), at, b.getWidth(), thumb, 2.0f);
        }

    private:
        const Control& control;
    };

    // ---- value text (drag up/down to change) -------------------------------------------------

    class ValueText final : public juce::Slider
    {
    public:
        ValueText (const Control& c, juce::RangedAudioParameter& p) : control (c), parameter (p)
        {
            setSliderStyle (juce::Slider::LinearBarVertical);
            setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
            setMouseCursor (juce::MouseCursor::UpDownResizeCursor);
        }

        void paint (juce::Graphics& g) override
        {
            g.setColour (colour (control.c2));
            g.setFont (makeFont (control.f1, false));
            // narrow fields: squeeze the text horizontally instead of cutting it off
            auto text = parameter.getText (parameter.getValue(), 32);
            if (const auto unit = parameter.getLabel(); unit.isNotEmpty() && ! text.endsWithIgnoreCase (unit))
                text << " " << unit;
            g.drawFittedText (text, getLocalBounds(), juce::Justification::centred, 1, 0.6f);
        }

    private:
        const Control& control;
        juce::RangedAudioParameter& parameter;
    };

    // ---- choice (menu) -----------------------------------------------------------------------

    /** Box in the original's colours showing the current option; a click opens the list of options. */
    class Choice final : public juce::Component
    {
    public:
        Choice (const Control& c, juce::RangedAudioParameter& p)
            : control (c), parameter (p), attachment (p, [this] (float) { repaint(); })
        {
            setMouseCursor (juce::MouseCursor::PointingHandCursor);
            attachment.sendInitialUpdate();
        }

        void paint (juce::Graphics& g) override
        {
            auto r = getLocalBounds().toFloat();
            g.setColour (colour (control.c1));
            g.fillRoundedRectangle (r, std::min (r.getHeight() * 0.5f, 6.0f));

            const auto font = makeFont (control.f1, false);
            const auto text = parameter.getCurrentValueAsText();
            g.setFont (font);
            g.setColour (colour (control.c2));
            // an arrow only where the text still fits next to it
            const float arrow = r.getHeight() * 0.5f;
            const bool withArrow = juce::GlyphArrangement::getStringWidth (font, text) + arrow * 2.5f < r.getWidth();
            auto textArea = r.reduced (3.0f, 0.0f);
            if (withArrow)
            {
                auto a = textArea.removeFromRight (arrow).withSizeKeepingCentre (arrow * 0.7f, arrow * 0.4f);
                juce::Path path;
                path.addTriangle (a.getX(), a.getY(), a.getRight(), a.getY(), a.getCentreX(), a.getBottom());
                g.fillPath (path);
            }
            g.drawFittedText (text, textArea.toNearestInt(), juce::Justification::centred, 1, 0.6f);
        }

        void mouseDown (const juce::MouseEvent&) override
        {
            juce::PopupMenu menu;
            const auto options = optionTexts();
            const int current = juce::roundToInt (parameter.getValue() * (float) std::max (options.size() - 1, 1));
            for (int i = 0; i < options.size(); ++i)
                menu.addItem (i + 1, options[i], true, i == current);
            juce::Component::SafePointer<Choice> safe (this);
            menu.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (this), [safe, options] (int result)
            {
                if (safe == nullptr || result <= 0)
                    return;
                const float norm = (float) (result - 1) / (float) std::max (options.size() - 1, 1);
                safe->attachment.setValueAsCompleteGesture (safe->parameter.convertFrom0to1 (norm));
            });
        }

    private:
        juce::StringArray optionTexts() const
        {
            if (auto* choice = dynamic_cast<const juce::AudioParameterChoice*> (&parameter))
                return choice->choices;
            return parameter.getAllValueStrings();
        }

        const Control& control;
        juce::RangedAudioParameter& parameter;
        juce::ParameterAttachment attachment;
    };

    // ---- toggle ------------------------------------------------------------------------------

    class Toggle final : public juce::Button
    {
    public:
        explicit Toggle (const Control& c) : juce::Button ({}), control (c)
        {
            setClickingTogglesState (true);
        }

        void paintButton (juce::Graphics& g, bool highlighted, bool) override
        {
            auto colourOf = colour (getToggleState() ? control.c1 : control.c2);
            if (highlighted)
                colourOf = colourOf.brighter (0.08f);
            g.setColour (colourOf);
            g.fillRoundedRectangle (getLocalBounds().toFloat(), control.f1);
        }

    private:
        const Control& control;
    };

#if VCH_EQ_EDITOR
    // ---- band panel (settings of the selected EQ band) -----------------------------------------

    class BandPanel final : public juce::Component
    {
    public:
        BandPanel (CloneProcessor& p, const Display& d) : processor (p), display (d)
        {
            for (auto* c : std::initializer_list<juce::Component*> { &shape, &slope, &frequency, &gain, &q, &remove, &title })
                addChildComponent (c);
            title.setJustificationType (juce::Justification::centred);
            title.setFont (makeFont (13.0f, true));
            remove.setButtonText (juce::String::fromUTF8 ("\xc3\x97"));
            remove.setTooltip ("Remove band");
            for (auto* slider : { &frequency, &gain, &q })
            {
                slider->setSliderStyle (juce::Slider::LinearBar);
                slider->setTextBoxIsEditable (true);
            }
            styleWith (colour (d.background), colour (d.text), colour (d.curve));
        }

        std::function<void()> onRemove;

        /** Shows the controls of `band` (or hides everything for -1). */
        void setBand (int band)
        {
            if (band == current)
                return;
            current = band;
            attachments.clear();
            if (band < 0)
                return;
            const auto& info = clonemodel::bands[band];
            title.setText (juce::String (band + 1), juce::dontSendNotification);
            title.setVisible (true);
            remove.setVisible (info.enable >= 0);
            attachCombo (shape, info.shape);
            attachCombo (slope, info.slope);
            attachSlider (frequency, info.frequency);
            attachSlider (gain, info.gain);
            attachSlider (q, info.q);
            remove.onClick = [this] { if (onRemove) onRemove(); };
            resized();
        }

        int band() const { return current; }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat().reduced (0.5f);
            g.setColour (colour (display.background).brighter (0.18f).withAlpha (0.94f));
            g.fillRoundedRectangle (b, 6.0f);
            g.setColour (colour (display.curve).withAlpha (0.6f));
            g.drawRoundedRectangle (b, 6.0f, 1.0f);
        }

        void resized() override
        {
            auto area = getLocalBounds().reduced (6, 6);
            title.setBounds (area.removeFromLeft (24));
            remove.setBounds (area.removeFromRight (24));
            juce::Array<juce::Component*> visible;
            for (auto* c : std::initializer_list<juce::Component*> { &shape, &frequency, &gain, &q, &slope })
                if (c->isVisible()) visible.add (c);
            const int width = visible.isEmpty() ? 0 : area.getWidth() / visible.size();
            for (auto* c : visible)
                c->setBounds (area.removeFromLeft (width).reduced (3, 0));
        }

    private:
        void styleWith (juce::Colour background, juce::Colour text, juce::Colour accent)
        {
            for (auto* box : { &shape, &slope })
            {
                box->setColour (juce::ComboBox::backgroundColourId, background.brighter (0.08f));
                box->setColour (juce::ComboBox::textColourId, text.brighter (0.4f));
                box->setColour (juce::ComboBox::outlineColourId, accent.withAlpha (0.4f));
                box->setColour (juce::ComboBox::arrowColourId, accent);
            }
            for (auto* slider : { &frequency, &gain, &q })
            {
                slider->setColour (juce::Slider::trackColourId, accent.withAlpha (0.35f));
                slider->setColour (juce::Slider::backgroundColourId, background.brighter (0.08f));
                slider->setColour (juce::Slider::textBoxTextColourId, text.brighter (0.4f));
                slider->setColour (juce::Slider::textBoxOutlineColourId, accent.withAlpha (0.4f));
            }
            title.setColour (juce::Label::textColourId, accent);
            remove.setColour (juce::TextButton::buttonColourId, background.brighter (0.08f));
            remove.setColour (juce::TextButton::textColourOffId, text.brighter (0.4f));
        }

        void attachCombo (juce::ComboBox& box, int index)
        {
            box.clear (juce::dontSendNotification);
            auto* parameter = index >= 0 ? processor.parameter (index) : nullptr;
            auto* choice = dynamic_cast<juce::AudioParameterChoice*> (parameter);
            box.setVisible (choice != nullptr);
            if (choice == nullptr)
                return;
            box.addItemList (choice->choices, 1);
            box.setTooltip (choice->getName (64));
            attachments.push_back (std::make_shared<juce::ComboBoxParameterAttachment> (*choice, box));
        }

        void attachSlider (juce::Slider& slider, int index)
        {
            auto* parameter = index >= 0 ? processor.parameter (index) : nullptr;
            slider.setVisible (parameter != nullptr);
            if (parameter == nullptr)
                return;
            slider.setTooltip (parameter->getName (64));
            attachments.push_back (std::make_shared<juce::SliderParameterAttachment> (*parameter, slider));
        }

        CloneProcessor& processor;
        const Display& display;
        juce::ComboBox shape, slope;
        juce::Slider frequency, gain, q;
        juce::TextButton remove;
        juce::Label title;
        int current = -1;
        std::vector<std::shared_ptr<void>> attachments; // released before the controls they observe
    };

    // ---- EQ display ----------------------------------------------------------------------------

    class EqDisplay final : public juce::Component, private juce::Timer
    {
    public:
        EqDisplay (CloneProcessor& p, const Display& d) : processor (p), display (d), panel (p, d)
        {
            addChildComponent (panel);
            // a plain display (the original shows only its curve) is turned with the knobs, not on the display
            if (display.plain)
                setInterceptsMouseClicks (false, false);
            panel.onRemove = [this]
            {
                if (selected >= 0)
                    setParam (clonemodel::bands[selected].enable, 0.0f, true);
                select (-1);
                repaint();
            };
            startTimerHz (10);
        }

        void resized() override
        {
            const int width = std::min (getWidth() - 20, 560), height = 34;
            panel.setBounds ((getWidth() - width) / 2, (int) plotHeight() - height - 10, width, height);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            if (display.hasBackgroundRight)
                g.setGradientFill (juce::ColourGradient (colour (display.background), 0, 0, colour (display.backgroundRight), b.getRight(), 0, false));
            else
                g.setGradientFill (juce::ColourGradient (colour (display.background), 0, 0, colour (display.backgroundBottom), 0, b.getBottom(), false));
            g.fillRoundedRectangle (b, display.radius);

            if (display.plain)
            {
                paintCurve (g);
                return;
            }

            // grid: decades and 2/5 steps, dB lines in steps that fit the range
            g.setColour (colour (display.grid));
            for (double decade = 1.0; decade < 1e6; decade *= 10.0)
                for (double m : { 1.0, 2.0, 5.0 })
                    if (const double f = decade * m; f > display.fMin && f < display.fMax)
                        g.drawVerticalLine ((int) xOf (f), b.getY(), b.getY() + plotHeight());

            const double range = std::abs (display.dbTop - display.dbBottom);
            const double step = display.dbStep > 0 ? (double) display.dbStep : range <= 16 ? 3.0 : range <= 40 ? 6.0 : 12.0;
            const double lowest = std::ceil (std::min (display.dbTop, display.dbBottom) / step) * step;
            for (double db = lowest; db <= std::max (display.dbTop, display.dbBottom); db += step)
                g.drawHorizontalLine ((int) yOf (db), b.getX(), b.getRight());

            g.setColour (colour (display.text));
            g.setFont (makeFont (11.0f, false));
            for (double db = lowest; db <= std::max (display.dbTop, display.dbBottom); db += step)
            {
                const auto label = db > 0 ? "+" + juce::String ((int) db) : juce::String ((int) db);
                const float right = display.dbLabelRight > 0 ? b.getX() + display.dbLabelRight : b.getRight() - 4;
                g.drawText (label, juce::Rectangle<float> (right - 30, yOf (db) - 7, 30, 14), juce::Justification::centredRight);
            }
            for (auto [f, label] : { std::pair { 20.0, "20" }, { 50.0, "50" }, { 100.0, "100" }, { 200.0, "200" }, { 500.0, "500" },
                                     { 1000.0, "1k" }, { 2000.0, "2k" }, { 5000.0, "5k" }, { 10000.0, "10k" }, { 20000.0, "20k" } })
                if (f > display.fMin && f < display.fMax)
                    g.drawText (label, display.labelBand > 0 ? juce::Rectangle<float> (xOf (f) - 20, b.getY() + plotHeight() + 2, 40, display.labelBand - 4)
                                                             : juce::Rectangle<float> (xOf (f) - 20, b.getBottom() - 16, 40, 14), juce::Justification::centred);

            paintCurve (g);

            bool anyActive = false;
            for (int band = 0; band < clonemodel::numBands; ++band)
            {
                if (! isActive (band))
                    continue;
                anyActive = true;
                const auto p = nodePosition (band);
                if (band == selected)
                {
                    g.setColour (colour (display.curve).withAlpha (0.35f));
                    g.fillEllipse (p.x - 11, p.y - 11, 22, 22);
                }
                g.setColour (colour (display.curve).withAlpha (band == dragging || band == selected ? 1.0f : 0.85f));
                g.fillEllipse (p.x - 6, p.y - 6, 12, 12);
                g.setColour (colour (display.background));
                g.setFont (makeFont (9.0f, true));
                g.drawText (juce::String (band + 1), juce::Rectangle<float> (p.x - 6, p.y - 6, 12, 12), juce::Justification::centred);
            }

            if (! anyActive)
            {
                g.setColour (colour (display.text).withAlpha (0.8f));
                g.setFont (makeFont (13.0f, false));
                g.drawText (juce::String::fromUTF8 ("Click: add band  \xc2\xb7  Drag: frequency/gain  \xc2\xb7  Mouse wheel: Q  \xc2\xb7  Right-click: remove"),
                            juce::Rectangle<float> (0, plotHeight() * 0.62f, (float) getWidth(), 20), juce::Justification::centred);
            }
        }

        /** the clone's response, from where the original's curve begins to where it ends */
        void paintCurve (juce::Graphics& g)
        {
            const float left = display.curveLeft, right = display.curveRight > 0 ? display.curveRight : (float) getWidth();
            juce::Path curve;
            for (float x = left; x <= right + 0.01f; x += 2.0f)
            {
                const float px = std::min (x, right);
                const float y = juce::jlimit (-4.0f, plotHeight() + 4.0f, yOf (processor.responseDb (frequencyOf (px))));
                if (x == left) curve.startNewSubPath (px, y);
                else curve.lineTo (px, y);
            }
            g.saveState();
            g.reduceClipRegion (getLocalBounds());
            g.setColour (colour (display.curve));
            g.strokePath (curve, juce::PathStrokeType (2.0f));
            g.restoreState();
        }

        void mouseDown (const juce::MouseEvent& e) override
        {
            dragging = nodeAt (e.position);
            if (dragging >= 0 && e.mods.isPopupMenu())
            {
                setParam (clonemodel::bands[dragging].enable, 0.0f, true);
                if (dragging == selected)
                    select (-1);
                dragging = -1;
                repaint();
                return;
            }
            // click on a free spot: new band there (like the original)
            if (dragging < 0 && ! e.mods.isPopupMenu() && e.position.y < plotHeight())
                dragging = createBand (e.position);
            select (dragging);
            if (dragging >= 0)
                for (int index : { clonemodel::bands[dragging].frequency, clonemodel::bands[dragging].gain })
                    if (auto* p = processor.parameter (index)) p->beginChangeGesture();
            repaint();
        }

        void mouseDrag (const juce::MouseEvent& e) override
        {
            if (dragging < 0)
                return;
            const auto& band = clonemodel::bands[dragging];
            setParam (band.frequency, (float) frequencyOf (e.position.x), false);
            if (band.gain >= 0)
                setParam (band.gain, dbOf (e.position.y), false);
            repaint();
        }

        void mouseUp (const juce::MouseEvent&) override
        {
            if (dragging >= 0)
                for (int index : { clonemodel::bands[dragging].frequency, clonemodel::bands[dragging].gain })
                    if (auto* p = processor.parameter (index)) p->endChangeGesture();
            dragging = -1;
        }

        /** Switches on the first free band at `position`; returns its index or -1 if all bands are in use. */
        int createBand (juce::Point<float> position)
        {
            for (int band = 0; band < clonemodel::numBands; ++band)
            {
                if (isActive (band) || clonemodel::bands[band].enable < 0)
                    continue;
                const auto& info = clonemodel::bands[band];
                setParam (info.frequency, (float) frequencyOf (position.x), true);
                if (info.gain >= 0) setParam (info.gain, dbOf (position.y), true);
                setParam (info.enable, 1.0f, true);
                return band;
            }
            return -1;
        }

        void select (int band)
        {
            selected = band;
            panel.setBand (band);
            panel.setVisible (band >= 0);
        }

        void timerCallback() override
        {
            // the host may switch the selected band off (automation, undo)
            if (selected >= 0 && ! isActive (selected))
            {
                select (-1);
                repaint();
            }
        }

        void mouseWheelMove (const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) override
        {
            const int band = nodeAt (e.position);
            if (band < 0 || clonemodel::bands[band].q < 0)
                return;
            auto* p = processor.parameter (clonemodel::bands[band].q);
            p->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, p->getValue() + wheel.deltaY * 0.05f));
            repaint();
        }

    private:
        float xOf (double f) const { return (float) (std::log (f / display.fMin) / std::log ((double) display.fMax / display.fMin) * getWidth()); }
        double frequencyOf (float x) const { return display.fMin * std::pow ((double) display.fMax / display.fMin, juce::jlimit (0.0, 1.0, (double) x / std::max (1, getWidth()))); }
        /** height of the plot (without the frequency label strip below it) */
        float plotHeight() const { return std::max (1.0f, (float) getHeight() - display.labelBand); }
        float yOf (double db) const { return (float) ((display.dbTop - db) / (display.dbTop - display.dbBottom) * plotHeight()); }
        float dbOf (float y) const { return (float) (display.dbTop - y / plotHeight() * (display.dbTop - display.dbBottom)); }

        bool isActive (int band) const
        {
            const auto& info = clonemodel::bands[band];
            return info.enable < 0 || processor.physicalValue (info.enable) > 0.5f;
        }

        juce::Point<float> nodePosition (int band) const
        {
            const auto& info = clonemodel::bands[band];
            const double f = info.frequency >= 0 ? processor.physicalValue (info.frequency) : 1000.0;
            const double db = info.gain >= 0 ? processor.physicalValue (info.gain) : 0.0;
            return { xOf (f), juce::jlimit (6.0f, plotHeight() - 6.0f, yOf (db)) };
        }

        int nodeAt (juce::Point<float> position) const
        {
            for (int band = clonemodel::numBands - 1; band >= 0; --band)
                if (isActive (band) && nodePosition (band).getDistanceFrom (position) < 10.0f)
                    return band;
            return -1;
        }

        void setParam (int index, float physical, bool gesture)
        {
            auto* p = processor.parameter (index);
            if (p == nullptr)
                return;
            if (gesture) p->beginChangeGesture();
            p->setValueNotifyingHost (p->convertTo0to1 (physical));
            if (gesture) p->endChangeGesture();
        }

        CloneProcessor& processor;
        const Display& display;
        BandPanel panel;
        int dragging = -1;
        int selected = -1;
    };
#endif // VCH_EQ_EDITOR

#if VCH_GAIN_REDUCTION_METER
    // ---- gain reduction meter (in the display areas of a compressor) ----------------------------

    /** Needle meter: pivot at the bottom centre, 0 dB on the left, `maxDb` on the right. */
    class MeterDisplay final : public juce::Component, private juce::Timer
    {
    public:
        MeterDisplay (CloneProcessor& p, const Display& d) : processor (p), display (d)
        {
            setInterceptsMouseClicks (false, false);
            startTimerHz (30);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            const juce::Point<float> pivot (b.getCentreX(), b.getBottom() - b.getHeight() * 0.12f);
            const float length = std::min (b.getWidth() * 0.45f, b.getHeight() * 0.8f);
            constexpr float sweep = 0.9f; // radians each side of vertical

            g.setColour (colour (display.text).withAlpha (0.8f));
            g.setFont (makeFont (std::max (9.0f, b.getHeight() * 0.07f), false));
            for (int db = 0; db <= (int) maxDb; db += 5)
            {
                const float a = -sweep + 2 * sweep * db / maxDb;
                const auto outer = polar (pivot.x, pivot.y, length * 1.02f, a), inner = polar (pivot.x, pivot.y, length * 0.92f, a);
                g.drawLine ({ inner, outer }, 1.5f);
                const auto label = polar (pivot.x, pivot.y, length * 0.82f, a);
                g.drawText (juce::String (db), juce::Rectangle<float> (label.x - 12, label.y - 6, 24, 12), juce::Justification::centred);
            }

            const float a = -sweep + 2 * sweep * juce::jlimit (0.0f, 1.0f, shown / maxDb);
            g.setColour (colour (display.curve));
            g.drawLine ({ pivot, polar (pivot.x, pivot.y, length, a) }, 2.0f);
            g.fillEllipse (pivot.x - 5, pivot.y - 5, 10, 10);
        }

    private:
        void timerCallback() override
        {
            // ballistics of a VU-style needle: about 300 ms to settle
            const float target = processor.getGainReduction();
            shown += (target - shown) * 0.25f;
            repaint();
        }

        static constexpr float maxDb = 30.0f;
        CloneProcessor& processor;
        const Display& display;
        float shown = 0.0f;
    };

    /** Needle measured on the original (kind 2): only the needle is drawn, scale and housing are in the layout. */
    class NeedleMeter final : public juce::Component, private juce::Timer
    {
    public:
        NeedleMeter (CloneProcessor& p, const Display& d) : processor (p), needle (d.needle)
        {
            setInterceptsMouseClicks (false, false);
            startTimerHz (30);
        }

        void paint (juce::Graphics& g) override
        {
            const auto& t = needle.ticks;
            g.setColour (colour (t.color));
            for (int i = 0; i < t.count; ++i)
                g.drawLine ({ polar (needle.pivotX, needle.pivotY, t.inner, t.angles[i]), polar (needle.pivotX, needle.pivotY, t.outer, t.angles[i]) }, t.width);

            const float a = needle.angleZero + needle.radiansPerDb * shown;
            const auto tip = polar (needle.pivotX, needle.pivotY, needle.length, a);
            g.setColour (colour (needle.color));
            g.drawLine ({ { needle.pivotX, needle.pivotY }, tip }, needle.width);

            if (needle.capRadius > 0)
            {
                g.setColour (colour (needle.capColor));
                g.fillEllipse (needle.pivotX - needle.capRadius, needle.pivotY - needle.capRadius, 2 * needle.capRadius, 2 * needle.capRadius);
            }
        }

    private:
        void timerCallback() override
        {
            shown += (processor.getGainReduction() - shown) * 0.25f;
            repaint();
        }

        CloneProcessor& processor;
        const Needle& needle;
        float shown = 0.0f;
    };

    /** Level bar: filled from the bottom (`dbBottom`) up to the input peak level, the top edge is `dbTop`. */
    /** What a meter shows, in dB: input or output peak, or gain reduction (see Display::meterSource). */
    struct MeterSource
    {
        explicit MeterSource (CloneProcessor& p, float fallDbPerSecond = 0.0f) : processor (p), fall (fallDbPerSecond > 0.0f ? fallDbPerSecond : 20.0f) {}

        /** called 30 times a second: peaks rise at once and fall as fast as the original's (20 dB/s if unknown), gain reduction glides */
        float next (int source)
        {
            if (source == 2)
            {
                shown += (processor.getGainReduction() - shown) * 0.35f;
                return shown;
            }
            const float inputDb = 20.0f * std::log10 (processor.takeInputPeak() + 1e-9f);
            const float db = source == 1 ? processor.transferOutputDb (inputDb) : inputDb;
            shown = std::max (db, shown - fall / 30.0f);
            return shown;
        }

        CloneProcessor& processor;
        float fall;
        float shown = -120.0f;
    };

    /** Level bar or LED chain (kind 3) growing from the end the original's meter grows from. */
    class LevelBar final : public juce::Component, private juce::Timer
    {
    public:
        LevelBar (CloneProcessor& p, const Display& d) : source (p, d.fallDbPerSecond), display (d)
        {
            setInterceptsMouseClicks (false, false);
            startTimerHz (30);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            const float t = juce::jlimit (0.0f, 1.0f, (shownDb - display.dbBottom) / (display.dbTop - display.dbBottom));
            const bool vertical = display.meterOrigin <= 1;
            const float length = vertical ? b.getHeight() : b.getWidth();
            // position along the meter, measured from its origin
            const auto stretch = [&] (float from, float to) {
                switch (display.meterOrigin)
                {
                    case 0:  return juce::Rectangle<float> (b.getX(), b.getBottom() - to, b.getWidth(), to - from);
                    case 1:  return juce::Rectangle<float> (b.getX(), b.getY() + from, b.getWidth(), to - from);
                    case 2:  return juce::Rectangle<float> (b.getX() + from, b.getY(), to - from, b.getHeight());
                    default: return juce::Rectangle<float> (b.getRight() - to, b.getY(), to - from, b.getHeight());
                }
            };
            if (display.segments > 0)
            {
                // LEDs: lit up to the level, the rest in their unlit colour
                const int n = display.segments;
                const float pitch = length / (float) n;
                // measured thresholds where known (meter scales are rarely linear)
                int lit = juce::roundToInt (t * (float) n);
                if (display.ledDb != nullptr)
                {
                    lit = 0;
                    while (lit < n && display.ledDb[lit] <= shownDb) ++lit;
                }
                for (int k = 0; k < n; ++k)
                {
                    auto led = stretch (k * pitch + pitch * 0.1f, (k + 1) * pitch - pitch * 0.1f);
                    led = vertical ? led.reduced (led.getWidth() * 0.08f, 0.0f) : led.reduced (0.0f, led.getHeight() * 0.08f);
                    g.setColour (colour (k < lit ? display.curve : display.offColor));
                    if (display.round)
                    {
                        const float d = std::min (led.getWidth(), led.getHeight());
                        g.fillEllipse (led.withSizeKeepingCentre (d, d));
                    }
                    else
                        g.fillRect (led);
                }
                return;
            }
            g.setColour (colour (display.offColor));
            g.fillRect (b);
            if (t > 0.0f)
            {
                g.setColour (colour (display.curve));
                g.fillRect (stretch (0.0f, t * length));
            }
        }

    private:
        void timerCallback() override
        {
            const float next = source.next (display.meterSource);
            if (std::abs (next - shownDb) > 0.01f)
            {
                shownDb = next;
                repaint();
            }
        }

        MeterSource source;
        const Display& display;
        float shownDb = -120.0f;
    };

    /** The original's scale numbers, where they stood (the component lies at the display's box). */
    void drawScaleLabels (juce::Graphics& g, const Display& d)
    {
        for (int i = 0; i < d.numScaleLabels; ++i)
        {
            const auto& l = d.scaleLabels[i];
            g.setColour (colour (l.color));
            g.setFont (makeFont (l.h * 1.05f, false));
            g.drawText (juce::String::fromUTF8 (l.text), juce::Rectangle<float> (l.x - d.x - 4.0f, l.y - d.y, l.w + 8.0f, l.h), juce::Justification::centred, false);
        }
    }

    /** a step of 1, 2, 3, 5, 6, 10, 12, 20 … dB that gives about `lines` grid lines over `range` */
    float niceStep (float range, int lines)
    {
        static constexpr float steps[] = { 1, 2, 3, 5, 6, 10, 12, 20, 24, 30, 50 };
        for (const float s : steps)
            if (range / s <= (float) lines)
                return s;
        return 100.0f;
    }

    /** Transfer curve of the clone (generic area with role 1): output against input level on the original's scale
        where it was read (else −60…0 dB on both axes, with numbers of its own), drawn from the curve the clone
        computes now, with a dot at the current input level. */
    class TransferCurve final : public juce::Component, private juce::Timer
    {
    public:
        TransferCurve (CloneProcessor& p, const Display& d) : processor (p), display (d), source (p)
        {
            setInterceptsMouseClicks (false, false);
            // the original's axes: dB at the left and right edge (x), at the bottom and top (y); a transfer
            // curve is square, so one read axis serves for both
            if (d.hasXAxis)
            {
                lowDb = d.xAxisA + d.xAxisB * d.x;
                highDb = d.xAxisA + d.xAxisB * (d.x + d.w);
            }
            if (d.hasYAxis)
            {
                lowY = d.yAxisA + d.yAxisB * (d.y + d.h);
                highY = d.yAxisA + d.yAxisB * d.y;
                if (! d.hasXAxis) { lowDb = lowY; highDb = highY; }
            }
            else { lowY = lowDb; highY = highDb; }
            if (! (highDb > lowDb + 1.0f && highY > lowY + 1.0f)) { lowDb = lowY = -60.0f; highDb = highY = 0.0f; }
            startTimerHz (30);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            g.setColour (colour (display.background));
            g.fillRect (b);
            const auto x = [this, &b] (float db) { return b.getX() + (db - lowDb) / (highDb - lowDb) * b.getWidth(); };
            const auto y = [this, &b] (float db) { return b.getBottom() - (db - lowY) / (highY - lowY) * b.getHeight(); };
            const auto grid = [&] {
                g.setColour (colour (display.grid));
                const float step = niceStep (highDb - lowDb, 8);
                for (float db = std::ceil (lowDb / step) * step; db <= highDb + 0.1f; db += step)
                    g.drawLine (x (db), b.getY(), x (db), b.getBottom(), 1.0f);
                const float stepY = niceStep (highY - lowY, 8);
                for (float db = std::ceil (lowY / stepY) * stepY; db <= highY + 0.1f; db += stepY)
                    g.drawLine (b.getX(), y (db), b.getRight(), y (db), 1.0f);
                g.setColour (colour (display.text).withAlpha (0.5f));
                const float dashes[] = { 3.0f, 3.0f };
                const float from = std::max (lowDb, lowY), to = std::min (highDb, highY);
                g.drawDashedLine ({ x (from), y (from), x (to), y (to) }, dashes, 2, 1.0f);
                // numbers: the original's where they were read, else the clone's own along the left and bottom edge
                if (display.numScaleLabels > 0)
                    drawScaleLabels (g, display);
                else
                {
                    g.setColour (colour (display.text).withAlpha (0.75f));
                    g.setFont (makeFont (10.0f, false));
                    const float labelStep = niceStep (highDb - lowDb, 4);
                    for (float db = std::ceil (lowDb / labelStep) * labelStep; db < highDb - 0.1f; db += labelStep)
                    {
                        g.drawText (juce::String (juce::roundToInt (db)), juce::Rectangle<float> (x (db) + 2.0f, b.getBottom() - 13.0f, 28.0f, 12.0f), juce::Justification::centredLeft, false);
                        // (the lowest value stands at the corner once, on the bottom axis)
                        if (db > lowDb + 0.1f)
                            g.drawText (juce::String (juce::roundToInt (db)), juce::Rectangle<float> (b.getX() + 2.0f, y (db) - 13.0f, 28.0f, 12.0f), juce::Justification::centredLeft, false);
                    }
                }
            };

            juce::Path curve;
            for (int i = 0; i <= 120; ++i)
            {
                const float in = lowDb + (highDb - lowDb) * (float) i / 120.0f;
                const float out = juce::jlimit (lowDb - 20.0f, highDb + 20.0f, processor.transferOutputDb (in));
                if (i == 0) curve.startNewSubPath (x (in), y (out));
                else curve.lineTo (x (in), y (out));
            }
            g.saveState();
            g.reduceClipRegion (getLocalBounds());
            if (display.hasFill)
            {
                juce::Path area (curve);
                area.lineTo (x (highDb), b.getBottom() + 1.0f);
                area.lineTo (x (lowDb), b.getBottom() + 1.0f);
                area.closeSubPath();
                g.setColour (colour (display.fill));
                g.fillPath (area);
            }
            // the grid over the filled area, the curve over both
            grid();
            g.setColour (colour (display.curve));
            g.strokePath (curve, juce::PathStrokeType (2.0f));
            if (levelDb > lowDb)
            {
                const float out = processor.transferOutputDb (levelDb);
                g.fillEllipse (x (levelDb) - 4.0f, y (out) - 4.0f, 8.0f, 8.0f);
            }
            g.restoreState();
        }

    private:
        void timerCallback() override
        {
            levelDb = source.next (0);
            repaint();
        }

        float lowDb = -60.0f, highDb = 0.0f, lowY = -60.0f, highY = 0.0f;
        CloneProcessor& processor;
        const Display& display;
        MeterSource source;
        float levelDb = -120.0f;
    };

    /** Analyzer or time graph (generic area with role 2): the last seconds of input level and gain reduction. */
    class LevelHistory final : public juce::Component, private juce::Timer
    {
    public:
        LevelHistory (CloneProcessor& p, const Display& d) : processor (p), display (d), input (p)
        {
            setInterceptsMouseClicks (false, false);
            // as many seconds as the original's time axis spans (5 s where it was not read)
            const float seconds = d.hasXAxis ? std::abs (d.xAxisB * d.w) : 5.0f;
            history.assign ((size_t) juce::jlimit (30, 1800, juce::roundToInt (seconds * 30.0f)), { -120.0f, 0.0f });
            startTimerHz (30);
        }

        void paint (juce::Graphics& g) override
        {
            const auto b = getLocalBounds().toFloat();
            g.setColour (colour (display.background));
            g.fillRect (b);
            g.setColour (colour (display.grid));
            for (int k = 1; k < 6; ++k)
                g.drawHorizontalLine (juce::roundToInt (b.getY() + b.getHeight() * (float) k / 6.0f), b.getX(), b.getRight());
            // the original's level axis where it was read, else 0 … −72 dB
            const auto y = [this, &b] (float db) {
                const float at = display.hasYAxis && std::abs (display.yAxisB) > 1e-6f ? (db - display.yAxisA) / display.yAxisB - display.y : -db / 72.0f * b.getHeight();
                return b.getY() + juce::jlimit (0.0f, b.getHeight(), at);
            };
            juce::Path level, reduction;
            for (size_t i = 0; i < history.size(); ++i)
            {
                const auto& h = history[(next + i) % history.size()];
                const float x = b.getX() + b.getWidth() * (float) i / (float) (history.size() - 1);
                if (i == 0) { level.startNewSubPath (x, y (h.first)); reduction.startNewSubPath (x, y (-h.second)); }
                else { level.lineTo (x, y (h.first)); reduction.lineTo (x, y (-h.second)); }
            }
            g.setColour (colour (display.curve));
            g.strokePath (level, juce::PathStrokeType (1.5f));
            g.setColour (colour (display.text));
            g.strokePath (reduction, juce::PathStrokeType (1.5f));
            if (display.numScaleLabels > 0)
                drawScaleLabels (g, display);
            else
            {
                g.setColour (colour (display.text).withAlpha (0.75f));
                g.setFont (makeFont (10.0f, false));
                for (int k = 1; k < 6; ++k)
                    g.drawText (juce::String (-12 * k), juce::Rectangle<float> (b.getX() + 2.0f, b.getY() + b.getHeight() * (float) k / 6.0f - 12.0f, 28.0f, 11.0f), juce::Justification::centredLeft, false);
            }
        }

    private:
        void timerCallback() override
        {
            history[next] = { input.next (0), processor.getGainReduction() };
            next = (next + 1) % history.size();
            repaint();
        }

        CloneProcessor& processor;
        const Display& display;
        MeterSource input;
        std::vector<std::pair<float, float>> history;
        size_t next = 0;
    };
#endif // VCH_GAIN_REDUCTION_METER
}

// ---- content: everything at the original size -------------------------------------------------

class CloneEditor::Content final : public juce::Component
{
public:
    explicit Content (CloneProcessor& p) : processor (p)
    {
        setSize (clonegui::width, clonegui::height);
        setOpaque (true);

        for (int i = 0; i < clonegui::numDisplays; ++i)
        {
            const auto& d = clonegui::displays[i];
            std::unique_ptr<juce::Component> component;
#if VCH_EQ_EDITOR
            if (d.kind == 0 && clonemodel::numBands > 0)
                component = std::make_unique<EqDisplay> (processor, d);
#endif
#if VCH_GAIN_REDUCTION_METER
            if (d.kind == 3)
            {
                auto bar = std::make_unique<LevelBar> (processor, d);
                bar->setBounds (juce::Rectangle<float> (d.x, d.y, d.w, d.h).toNearestInt());
                addAndMakeVisible (*bar);
                children.push_back (std::move (bar));
                continue;
            }
            if (d.kind == 2)
            {
                // the needle may swing outside the measured area: the component covers the whole editor
                auto needle = std::make_unique<NeedleMeter> (processor, d);
                needle->setBounds (0, 0, clonegui::width, clonegui::height);
                addAndMakeVisible (*needle);
                children.push_back (std::move (needle));
                continue;
            }
            if (d.role == 1)
                component = std::make_unique<TransferCurve> (processor, d);
            else if (d.role == 2)
                component = std::make_unique<LevelHistory> (processor, d);
            else
                component = std::make_unique<MeterDisplay> (processor, d);
#endif
            if (component != nullptr)
            {
                component->setBounds (juce::Rectangle<float> (d.x, d.y, d.w, d.h).toNearestInt());
                addAndMakeVisible (*component);
                children.push_back (std::move (component));
            }
        }

        for (int i = 0; i < clonegui::numControls; ++i)
        {
            const auto& c = clonegui::controls[i];
            auto* parameter = processor.parameter (c.param);
            if (parameter == nullptr)
                continue;

            std::unique_ptr<juce::Component> component;
            if (c.kind == 0)
            {
                auto knob = std::make_unique<Knob> (c);
                attachments.push_back (std::make_unique<juce::SliderParameterAttachment> (*parameter, *knob));
                component = std::move (knob);
            }
            else if (c.kind == 1 || c.kind == 2)
            {
                auto fader = std::make_unique<Fader> (c);
                attachments.push_back (std::make_unique<juce::SliderParameterAttachment> (*parameter, *fader));
                component = std::move (fader);
            }
            else if (c.kind == 3)
            {
                auto toggle = std::make_unique<Toggle> (c);
                attachments.push_back (std::make_unique<juce::ButtonParameterAttachment> (*parameter, *toggle));
                component = std::move (toggle);
            }
            else if (c.kind == 5)
            {
                auto text = std::make_unique<ValueText> (c, *parameter);
                attachments.push_back (std::make_unique<juce::SliderParameterAttachment> (*parameter, *text));
                component = std::move (text);
            }
            else if (c.kind == 4)
            {
                auto box = std::make_unique<Choice> (c, *parameter);
                component = std::move (box);
            }

            if (component != nullptr)
            {
                // value texts get some room: the clone's text may be a little longer than the original's
                const auto bounds = juce::Rectangle<float> (c.x, c.y, c.w, c.h);
                component->setBounds ((c.kind == 5 ? bounds.expanded (6.0f, 2.0f) : bounds).toNearestInt());
                addAndMakeVisible (*component);
                children.push_back (std::move (component));
            }
        }
    }

    void paint (juce::Graphics& g) override
    {
        const auto all = getLocalBounds().toFloat();
        fillArea (g, clonegui::background, all);
        g.fillRect (all);

        for (int i = 0; i < clonegui::numPanels; ++i)
        {
            const auto& p = clonegui::panels[i];
            const juce::Rectangle<float> r (p.x, p.y, p.w, p.h);
            fillArea (g, p.fill, r);
            g.fillRoundedRectangle (r, p.radius);
            if (p.hasBorder)
            {
                g.setColour (colour (p.border));
                g.drawRoundedRectangle (r, p.radius, 1.0f);
            }
        }

        for (int i = 0; i < clonegui::numCircles; ++i)
        {
            const auto& c = clonegui::circles[i];
            if (c.numStops == 0)
                continue;
            juce::ColourGradient gradient (colour (c.stopColor[0]), c.cx, c.cy, colour (c.stopColor[c.numStops - 1]), c.cx + c.r, c.cy, true);
            for (int k = 1; k < c.numStops - 1; ++k)
                gradient.addColour (juce::jlimit (0.0, 1.0, (double) c.stopAt[k]), colour (c.stopColor[k]));
            g.setGradientFill (gradient);
            g.fillEllipse (c.cx - c.r, c.cy - c.r, 2 * c.r, 2 * c.r);
            g.setColour (colour (c.spokeColor));
            for (int k = 0; k < c.numSpokes; ++k)
                g.drawLine ({ { c.cx, c.cy }, polar (c.cx, c.cy, c.r * 0.97f, c.spokes[k]) }, c.spokeWidth);
        }

        for (int i = 0; i < clonegui::numLines; ++i)
        {
            const auto& l = clonegui::lines[i];
            g.setColour (colour (l.color));
            g.drawLine (l.x1, l.y1, l.x2, l.y2, l.thickness);
        }

        for (int i = 0; i < clonegui::numTexts; ++i)
        {
            const auto& t = clonegui::texts[i];
            g.setColour (colour (t.color));
            drawFitted (g, juce::String::fromUTF8 (t.text), { t.x, t.y, t.w, t.h }, t.h, t.bold, t.align, t.size);
        }

        drawReadouts (g, false);
    }

    /** values written on knobs lie over the knob components */
    void paintOverChildren (juce::Graphics& g) override
    {
        drawReadouts (g, true);
    }

    void drawReadouts (juce::Graphics& g, bool onKnob)
    {
        for (int i = 0; i < clonegui::numControls; ++i)
        {
            const auto& c = clonegui::controls[i];
            const auto& r = c.readout;
            auto* parameter = processor.parameter (c.param);
            if (! r.present || parameter == nullptr || r.onKnob != onKnob)
                continue;
            const juce::Rectangle<float> box (r.x, r.y, r.w, r.h);
            if (r.hasBackground)
            {
                g.setColour (colour (r.background));
                g.fillRect (box);
            }
            if (r.hasBorder)
            {
                g.setColour (colour (r.border));
                g.drawRect (box, 1.0f);
            }
            auto text = parameter->getCurrentValueAsText().trim();
            // the digits after the point the original shows ("10.0" where the parameter says 10.000000 ms); a value
            // on a knob is the bare number, as the original writes it there
            const auto number = text.initialSectionContainingOnly ("0123456789.-+");
            if (r.decimals >= 0 && number.containsAnyOf ("0123456789"))
                text = juce::String (number.getDoubleValue(), r.decimals) + (r.onKnob ? juce::String() : text.substring (number.length()));
            g.setColour (colour (r.color));
            g.setFont (makeFont (r.size, false));
            // (a value on a knob may be wider than the band measured on the narrow digits of the original font)
            g.drawText (text, r.onKnob ? box.expanded (r.h, r.h * 0.5f) : box, juce::Justification::centred, false);
        }
    }

private:
    CloneProcessor& processor;
    std::vector<std::unique_ptr<juce::Component>> children;
    std::vector<std::shared_ptr<void>> attachments; // destroyed before the components they observe
};

CloneEditor::CloneEditor (CloneProcessor& p) : AudioProcessorEditor (p), processor (p)
{
    content = std::make_unique<Content> (p);
    addAndMakeVisible (*content);
    setResizable (true, true);
    setResizeLimits (clonegui::width / 2, clonegui::height / 2, clonegui::width * 3, clonegui::height * 3);
    if (auto* constrainer = getConstrainer())
        constrainer->setFixedAspectRatio ((double) clonegui::width / juce::jmax (1, clonegui::height)); // 0 × 0 without a rebuilt editor
    setSize (clonegui::width, clonegui::height);

    lastValues.resize ((size_t) clonemodel::numParams, -1.0f);
    startTimerHz (30);
}

CloneEditor::~CloneEditor() = default;

void CloneEditor::resized()
{
    const float scale = (float) getWidth() / (float) clonegui::width;
    content->setTransform (juce::AffineTransform::scale (scale));
}

void CloneEditor::timerCallback()
{
    bool changed = false;
    for (int i = 0; i < clonemodel::numParams; ++i)
    {
        const float v = processor.parameter (i)->getValue();
        if (v != lastValues[(size_t) i])
        {
            lastValues[(size_t) i] = v;
            changed = true;
        }
    }
    if (changed)
        content->repaint();
}
