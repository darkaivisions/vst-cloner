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
            const float offset = r.start < 0 ? juce::MathConstants<float>::twoPi : 0.0f;
            setRotaryParameters (r.start + offset, std::max (r.end + offset, r.start + offset + 0.1f), true);
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
                    p.addCentredArc (cx, cy, r.arcRadius, r.arcRadius, 0.0f, from, to, true);
                    g.setColour (c);
                    g.strokePath (p, juce::PathStrokeType (r.arcWidth, juce::PathStrokeType::curved, juce::PathStrokeType::butt));
                };
                if (r.hasTrack)
                    arc (r.start, r.end, colour (r.track));
                if (value > 0.001f)
                    arc (r.start, angle, colour (r.arcColor));
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
            g.setColour (colour (control.c1));
            g.fillRoundedRectangle (b, std::min (b.getWidth(), b.getHeight()) / 2);
            g.setColour (colour (control.c2));
            if (control.kind == 1)
                g.fillRoundedRectangle (b.getX() + value * (b.getWidth() - thumb), b.getY(), thumb, b.getHeight(), 2.0f);
            else
                g.fillRoundedRectangle (b.getX(), b.getY() + (1 - value) * (b.getHeight() - thumb), b.getWidth(), thumb, 2.0f);
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
            remove.setTooltip ("Band entfernen");
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
            g.setGradientFill (juce::ColourGradient (colour (display.background), 0, 0, colour (display.backgroundBottom), 0, b.getBottom(), false));
            g.fillRect (b);

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

            juce::Path curve;
            for (int x = 0; x <= getWidth(); x += 2)
            {
                const float y = juce::jlimit (-4.0f, plotHeight() + 4.0f, yOf (processor.responseDb (frequencyOf ((float) x))));
                if (x == 0) curve.startNewSubPath ((float) x, y);
                else curve.lineTo ((float) x, y);
            }
            g.setColour (colour (display.curve));
            g.strokePath (curve, juce::PathStrokeType (2.0f));

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
                g.drawText (juce::String::fromUTF8 ("Klicken: Band anlegen  \xc2\xb7  Ziehen: Frequenz/Gain  \xc2\xb7  Mausrad: G\xc3\xbcte  \xc2\xb7  Rechtsklick: entfernen"),
                            juce::Rectangle<float> (0, plotHeight() * 0.62f, (float) getWidth(), 20), juce::Justification::centred);
            }
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
            if (d.kind == 0 && clonemodel::numBands > 0)
                component = std::make_unique<EqDisplay> (processor, d);
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
                auto box = std::make_unique<juce::ComboBox>();
                if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (parameter))
                    box->addItemList (choice->choices, 1);
                box->setColour (juce::ComboBox::backgroundColourId, colour (c.c1));
                box->setColour (juce::ComboBox::textColourId, colour (c.c2));
                box->setColour (juce::ComboBox::outlineColourId, juce::Colours::transparentBlack);
                box->setColour (juce::ComboBox::arrowColourId, colour (c.c2));
                attachments.push_back (std::make_unique<juce::ComboBoxParameterAttachment> (*parameter, *box));
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

        for (int i = 0; i < clonegui::numControls; ++i)
        {
            const auto& c = clonegui::controls[i];
            const auto& r = c.readout;
            auto* parameter = processor.parameter (c.param);
            if (! r.present || parameter == nullptr)
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
            g.setColour (colour (r.color));
            g.setFont (makeFont (r.size, false));
            g.drawText (parameter->getCurrentValueAsText(), box, juce::Justification::centred, false);
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
        constrainer->setFixedAspectRatio ((double) clonegui::width / clonegui::height);
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
