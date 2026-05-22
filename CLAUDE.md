# DDJ-FLX10 Mixxx Mapping — Project Context

## What this repo is
A custom Mixxx controller mapping for the Pioneer/AlphaTheta DDJ-FLX10 on Linux.
Forked from Marc Zischka ("Zim")'s mapping, which was itself adapted from Arnold
Kalambani's DDJ-1000 mapping. My contributions (Victor Pineda / Veezuhz) add
features on top of that base — see the header comment in the JS for the running
list. The FLX10 has no first-party Mixxx mapping; this fills the gap.

## Files
- `Pioneer-DDJ-FLX10-scripts.js` — script logic. Namespace is **`PioneerDDJFLX10.`**
  (not `FLX10.`). Currently at v1.0.5 of the fork.
- `Pioneer-DDJ-FLX10_midi.xml` — bindings. Calls itself "DDJ-FLX10 PROD" v1.0.1.
  Target Mixxx version: 2.3.6+.
- `DDJ-FLX10_MIDI_Message_List_E1.pdf` — official AlphaTheta MIDI spec.
  Authoritative source for any MIDI byte question.
- `flx10_unlock_v2.py` — Linux-only USB unlock tool (see "Linux gotcha" below).
- `common-controller-scripts.js` — stock Mixxx helper library. Reference only,
  not part of this mapping.

## Environment
- OS: CachyOS (Arch-based)
- Mapping install path: `~/.mixxx/controllers/`
- Reload mappings: Preferences → Controllers → uncheck/recheck the device,
  OR restart Mixxx. No hot-reload.

## Linux gotcha — the FLX10 unlock (CRITICAL)
The FLX10 ships in a locked state. Plug it into Linux and `snd-usb-audio` claims
the interfaces but `/proc/asound/cardN/` has no usable PCM substreams until a
vendor handshake runs (seven `ctrl_transfer` OUT commands captured from
rekordbox). `flx10_unlock_v2.py` does this: unbinds `snd-usb-audio` via sysfs,
sends the handshake via pyusb, then rebinds to force a clean re-probe. Must run
as root, with Mixxx closed.

**Implications for any audio/USB troubleshooting:**
- If the user reports "FLX10 isn't producing audio in Mixxx" or "Mixxx doesn't
  see the device as a sound card," the FIRST question is whether the unlock has
  been run this session. MIDI works without the unlock; audio does not.
- The unlock does not persist across replug or reboot — it must run every time
  the device is connected.
- Don't suggest editing the unlock script unless something specific is broken.
  The seven commands are captured constants from a USB sniff; they are not
  parameters to tune.

## Controller facts to remember
- 4 decks, 4 FX units, 2x16 performance pads with 8 pad modes per side.
- Smart CFX / Smart Fader / Merge FX are rekordbox-side DSP features. In MIDI
  mode the buttons just send MIDI; Mixxx can't replicate the DSP. Treat them as
  spare buttons to map however is useful (extra FX, hotcue banks, etc.) rather
  than trying to emulate.
- Jog wheels: touch-sensitive top (scratch) + side (pitch bend). Both touch
  state and ticks are sent.
- LEDs: pads are RGB (color number 1–127, 0x00 = dim). Most other buttons are
  on/off. Confirm a working LED out before assuming a target supports color.
- Default channel layout (deck-to-channel mapping in MIDI status bytes):
  Deck 1/3 use one side, Deck 2/4 the other. See PDF MIDI Channel section.

## Tunable parameters (top of scripts.js)
Three knobs are surfaced as named constants — prefer adjusting these over
patching the math inline:
- `SCRATCH_INTERVALS_PER_REV` — encoder ticks per vinyl revolution
  (higher = slower scratch). Current: 1500.
- `JOG_BEND_DIVISOR` — pitch-bend strength on jog nudge (higher = subtler).
  Current: 16.
- `LOOP_ADJUST_STEP` — samples moved per jog unit in loop-adjust mode.
  Current: 100 (~2.3 ms at 44.1 kHz).

If the user complains about jog feel, ask which of these to nudge first.

## What's already in place (don't re-add)
Veezuhz additions, all credited inline in the header. Selected list:
- Beatgrid nudge (Shift + Jog)
- Waveform zoom (Shift + CH trim knob)
- Memory cue navigation (Shift + Hot Cue pads)
- Beat Jump + Beat Jump Size (Shift + CUE/LOOP CALL arrows)
- Sound Color FX (Shift + Pad FX1/2)
- Per-channel crossfader assign A/THRU/B (Shift + Channel Fader)
- Pioneer-like Play/Cue LED policy (with blink states)
- BeatFX diagnostic scanner (Shift + BeatFX ON) — prints effect indices to log
- Loop In/Out half/double (Shift + Loop In/Out)

## Out of scope (intentionally not implemented)
From the "To develop?" header section:
- CUE/LOOP CALL memory & delete — complex, hot cues cover the need.
- Keyboard mode and Keyshift mode pad layouts — tried, too experimental.
- -4BEAT auto loop from a previous position — no clean Mixxx-side API for it.

Don't propose these unless I explicitly ask.

## Code conventions
- Namespace: everything under `PioneerDDJFLX10.` — no globals.
- Internal-only state and helpers use a leading underscore (`_jogTouches`,
  `_getDeckFromGroup`). Public handlers don't.
- Deck number is extracted from the group string with a regex
  (`group.match(/\d+/)`) — there's a helper, use it.
- Comment every magic MIDI byte with the FLX10 control name it refers to.
- New feature → add a line to the header comment with `- Veezuhz` suffix.
- Effect routing pattern in use: channel→FX-unit assign button rather than the
  FX unit's own enable, so reverb/echo tails decay naturally on disengage.

## Mixxx Controller API — what to use
- `engine.setValue(group, key, v)` / `engine.getValue` — raw control values.
- `engine.setParameter(group, key, v)` / `engine.getParameter` — normalized 0–1.
  Prefer this for continuous controls (volume, EQ, gain).
- `engine.softTakeover(group, key, true)` for any continuous control that has
  Mixxx-side state, to prevent jumps on deck switch.
- `engine.connectControl(group, key, "PioneerDDJFLX10.callbackName")` is the
  pattern used in this codebase for LED feedback. Newer `makeConnection` is
  also valid but stick with `connectControl` for consistency.
- `midi.sendShortMsg(status, no, value)` / `midi.sendSysexMsg([...], len)`.
- Script-bound XML controls: `<options><script-binding/></options>` with
  `<key>PioneerDDJFLX10.functionName</key>`.

## Workflow expectations for the agent
- Read the official MIDI spec PDF (or `docs/` notes derived from it) before
  proposing new bindings — don't guess MIDI numbers.
- When changing XML or JS, remind me to reload the mapping in Mixxx; don't
  assume changes are live.
- Test plan for any new binding:
  1. Confirm MIDI in via `mixxx --controllerDebug --developer`
  2. Verify the engine call in Mixxx Developer Tools' script console
  3. Confirm LED feedback round-trips (Mixxx state → controller LED state)
- Don't fabricate Mixxx API methods. If unsure whether something exists, say
  so and check the wiki / Mixxx source rather than guessing.
- Don't open PRs upstream or contact maintainers on my behalf. I'll handle
  upstreaming when ready.
- Audio issues that look like driver problems: ask first whether the unlock
  has been run this session.

## Debugging
- `mixxx --controllerDebug --developer` from terminal — see every MIDI message
  and `print()` from the script.
- Script console: View → Developer Tools (with `--developer` flag).
- If LEDs go stale across sessions, check that `shutdown` disconnects everything
  it should. Orphaned `connectControl` handles can survive into the next session.
- USB-level issues: `lsusb`, `dmesg | tail`, `cat /proc/asound/cards`, and the
  output of `flx10_unlock_v2.py` itself, which prints `/proc/asound/cardN/`
  contents at the end.

## Resources
- Mixxx Controller mapping docs: https://github.com/mixxxdj/mixxx/wiki/Contributing-Mappings
- Mixxx JS API reference: https://github.com/mixxxdj/mixxx/wiki/Mixxx-Controls
- Stock Pioneer mappings under `/usr/share/mixxx/controllers/` (DDJ-1000,
  DDJ-SX, DDJ-400) — useful prior art, and the direct ancestor of this file.

## Current focus
<update this section as work progresses>
- Effect tail decay: Dry+Wet mode behavior with channel→FX-unit routing.
- <next thing>