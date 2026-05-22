# DDJ-FLX10 Audio Driver Issue — Agent Briefing

## Problem

Mixxx shows "no audio driver" on startup. The user cannot get audio output working.

## Critical Finding

**The DDJ-FLX10 audio interface IS detected by the kernel.** This is NOT a driver or USB handshake issue. Running `cat /proc/asound/cards` shows:

```
 0 [NVidia         ]: HDA-Intel - HDA NVidia
 1 [Generic        ]: HDA-Intel - HD-Audio Generic
 2 [USB            ]: USB-Audio - Scarlett Solo USB   ← Focusrite interface
 3 [Webcam         ]: USB-Audio - C922 Pro Stream Webcam
 4 [DDJFLX10       ]: USB-Audio - DDJ-FLX10           ← THIS IS PRESENT
                      AlphaTheta Corporation DDJ-FLX10 at usb-0000:03:00.0-3
```

The problem is that Mixxx cannot open an audio device — it is a Mixxx audio backend configuration issue, not a missing kernel driver.

---

## System Environment

- **OS**: CachyOS (Arch-based, Linux kernel 7.0.9-1-cachyos)
- **Audio stack**: PipeWire (standard on modern CachyOS)
- **Mixxx version**: Unknown — check with `mixxx --version`
- **Shell**: fish
- **Other audio devices present**: Focusrite Scarlett Solo USB (card 2), NVidia HDMI, onboard HD-Audio

---

## What to Investigate

### 1. Check Mixxx's audio backend

Mixxx on Linux can use multiple backends: PortAudio (ALSA, PulseAudio, JACK). On PipeWire systems the most common issue is that Mixxx's PortAudio is trying ALSA directly and losing to PipeWire's exclusive lock.

```fish
# Does Mixxx have JACK support compiled in?
mixxx --version

# Is PipeWire running?
pw-cli info 0

# Is pipewire-jack installed?
pacman -Q pipewire-jack
```

### 2. Try launching through PipeWire-JACK

```fish
pw-jack mixxx
```

If this makes the "no audio driver" go away, the fix is to always launch Mixxx this way (via a `.desktop` file or alias).

### 3. Check Mixxx Sound Hardware preferences

**Preferences → Sound Hardware**:
- API should be set to **ALSA** or **PulseAudio** or **JACK** (not blank)
- Master output must have a device selected (e.g., DDJ-FLX10 or Scarlett Solo)
- The "no audio driver" error fires even before track playback if no device is selected

The DDJ-FLX10 should appear in the device list as **DDJ-FLX10** (ALSA card 4) or as a PulseAudio/PipeWire sink.

### 4. Check if another process holds the device

```fish
fuser /dev/snd/pcmC4D0p 2>/dev/null
lsof | grep snd | grep -i ddj
```

Card 4 device 0 playback (`pcmC4D0p`) would be the DDJ-FLX10 main output. If something else owns it, Mixxx can't open it.

### 5. Verify ALSA sees playback channels

```fish
aplay -l
# Should show DDJ-FLX10 with at least one playback subdevice

# Try a raw ALSA test directly to the DDJ-FLX10
aplay -D hw:4,0 /usr/share/sounds/alsa/Front_Center.wav
```

If `aplay` fails with "Device busy", the conflict is confirmed.

### 6. Check Mixxx config file

Mixxx stores its sound hardware config in:
```
~/.mixxx/mixxx.cfg
```

Look for lines like:
```
[Soundcard]
SoundApi=...
Output Master Device=...
```

A blank or invalid device name here will cause "no audio driver" on every startup.

---

## Most Likely Fix

Given PipeWire is running and ALSA card 4 exists, the most likely root causes in order:

1. **No device selected in Mixxx Sound Hardware prefs** — just needs to be set once
2. **PipeWire holds ALSA exclusively** — fix: launch with `pw-jack mixxx` or switch Mixxx API to PulseAudio
3. **Mixxx config has a stale/wrong device name** — fix: delete or edit `~/.mixxx/mixxx.cfg` sound section and reconfigure

---

## What Is NOT the Problem

- The DDJ-FLX10 USB audio driver — kernel recognizes it fine (card 4)
- USB initialization / vendor handshake — `snd-usb-audio` loaded it successfully
- MIDI mapping scripts — those have no effect on audio routing

---

## Context: What Else This Machine Is Used For

This machine is an active DJ setup. Files being worked on:
- `/home/vpinedax/.mixxx/controllers/Pioneer-DDJ-FLX10-scripts.js` — MIDI mapping script
- `/home/vpinedax/.mixxx/controllers/Pioneer-DDJ-FLX10.midi.xml` — MIDI routing XML

The Mixxx controller mapping itself is functional and tested. Audio is the only outstanding issue.
