#!/usr/bin/env python3
"""
flx10_rekordbox_proto.py — replicate rekordbox's FLX10 jog-wheel screen protocol.

Decoded from /home/vpinedax/Downloads/flx10-4decks-loaded.pcapng (rekordbox, 4 decks
loaded). Rekordbox uses a DIFFERENT command set from VirtualDJ:

  - xx 3D heartbeat (broadcast, deck=0x00) — burst of 5 every ~20 ms, runs continuously
  - xx 21 metadata    — per-deck state, ~50 Hz, byte layout differs from VirtualDJ
  - xx 2C overview    — 35 packets, byte[4]=0x23, byte[5]=0x00 (no marker)
  - xx 2E waveform    — PWV5 LE16 color, byte[4]=0xB9, byte[5]=0x03 marker
  - xx 39 hot-cue label text — burst of 3 packets, ASCII text in seg 1 (not required)

Critical observation from the capture: rekordbox sends ONLY heartbeats for the first
~4.8 seconds before any metadata or waveform. This script does the same: 2 seconds of
heartbeats first, then metadata/upload, then sustained heartbeats + metadata + small
playhead packets to mimic active playback.

Run with Mixxx closed:
  sudo python3 flx10_rekordbox_proto.py --deck 2 --playing

PWV5 LE16 entry encoding (Pioneer half-frame waveform, 150 entries/sec):
  v = (r<<13) | (g<<10) | (b<<7) | (h<<2)        # r/g/b in 0..7, h in 0..31
  bytes = (v & 0xff, v >> 8)                      # little-endian
"""

import argparse
import math
import re
import subprocess
import sys
import time
import threading

try:
    import usb.core
    import usb.util
except ImportError:
    sys.exit("pyusb not found.  pip install pyusb")

VID = 0x2B73
PID = 0x0041
SCREEN_INTERFACE = 5

DECK_BYTES      = {1: 0x10, 2: 0x20, 3: 0x30, 4: 0x40}
ENTRIES_PER_SEC = 150
SEG_PAYLOAD     = 122      # bytes[6..127]

# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def find_device():
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        sys.exit("DDJ-FLX10 not found (VID 2B73 / PID 0041). Is it plugged in?")
    print(f"Found DDJ-FLX10 — bus {dev.bus}, device {dev.address}")
    return dev


def get_screen_endpoints(dev):
    cfg  = dev.get_active_configuration()
    intf = cfg[(SCREEN_INTERFACE, 0)]
    ep_out = usb.util.find_descriptor(
        intf,
        custom_match=lambda e: (
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
            and usb.util.endpoint_type(e.bmAttributes) == usb.util.ENDPOINT_TYPE_INTR
        ))
    ep_in = usb.util.find_descriptor(
        intf,
        custom_match=lambda e: (
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
            and usb.util.endpoint_type(e.bmAttributes) == usb.util.ENDPOINT_TYPE_INTR
        ))
    if ep_out is None or ep_in is None:
        sys.exit(f"Could not find interrupt IN/OUT endpoints on interface {SCREEN_INTERFACE}.")
    print(f"Endpoints — OUT: 0x{ep_out.bEndpointAddress:02X}, IN: 0x{ep_in.bEndpointAddress:02X}")
    return ep_out, ep_in


def build_pkt(b0, b1, seg, sub, b4):
    pkt = bytearray(128)
    pkt[0] = b0 & 0xFF
    pkt[1] = b1 & 0xFF
    pkt[2] = seg & 0xFF
    pkt[3] = sub & 0xFF
    pkt[4] = b4 & 0xFF
    return pkt


# A single lock makes pyusb writes serialized — needed because the heartbeat
# runs on a background thread and we don't want it interleaving mid-upload.
_send_lock = threading.Lock()

def send_pkt(ep_out, pkt):
    with _send_lock:
        ep_out.write(bytes(pkt), timeout=1000)


def drain_acks(ep_in, count=10, timeout_ms=50, label=""):
    got = 0
    for _ in range(count):
        try:
            data = ep_in.read(64, timeout=timeout_ms)
            print(f"  ACK{(' (' + label + ')') if label else ''}: {bytes(data).hex()}")
            got += 1
        except usb.core.USBTimeoutError:
            break
    return got


# ---------------------------------------------------------------------------
# xx 3D heartbeat — broadcast (deck=0x00), burst of 5 every ~20 ms
# ---------------------------------------------------------------------------

def heartbeat_burst(ep_out):
    """One 5-segment heartbeat burst, exactly like rekordbox."""
    for seg in range(1, 6):
        pkt = build_pkt(0x00, 0x3D, seg, 0x00, 0x05)
        send_pkt(ep_out, pkt)


class HeartbeatThread(threading.Thread):
    """Send heartbeat bursts at ~50 Hz in the background."""
    def __init__(self, ep_out, interval_s=0.02):
        super().__init__(daemon=True)
        self.ep_out  = ep_out
        self.interval = interval_s
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            try:
                heartbeat_burst(self.ep_out)
            except usb.core.USBError as e:
                print(f"  heartbeat error: {e}")
                break
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# ---------------------------------------------------------------------------
# MIDI SysEx polling — rekordbox sends `f0 00 40 05 00 00 04 01 00 50 00 f7`
# every ~200 ms on MIDI OUT (EP3) before the first screen heartbeat.  Hypothesis:
# this is a "host alive" / connection-establishment ping that puts the firmware
# into a mode where screen writes are honored.
# ---------------------------------------------------------------------------

SYSEX_PING = "F0 00 40 05 00 00 04 01 00 50 00 F7"


def find_flx10_midi_port():
    """Return the amidi port name for the FLX10 (e.g. 'hw:4,0,0'), or None."""
    try:
        out = subprocess.check_output(["amidi", "-l"], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None
    for line in out.splitlines():
        if "FLX10" in line and "hw:" in line:
            m = re.search(r"(hw:[0-9,]+)", line)
            if m:
                return m.group(1)
    return None


class SysExPingThread(threading.Thread):
    """Send the rekordbox `50 00` ping every 200 ms via amidi."""
    def __init__(self, port, interval_s=0.2):
        super().__init__(daemon=True)
        self.port = port
        self.interval = interval_s
        self._stop = threading.Event()
        self.sent = 0
        self.errors = 0

    def run(self):
        while not self._stop.is_set():
            try:
                subprocess.run(
                    ["amidi", "-p", self.port, "-S", SYSEX_PING],
                    check=False, timeout=1,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                self.sent += 1
            except (OSError, subprocess.TimeoutExpired):
                self.errors += 1
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# ---------------------------------------------------------------------------
# xx 21 metadata — rekordbox layout (decoded from capture)
# ---------------------------------------------------------------------------

def _make_metadata_pkt(deck_byte, track_loaded=True, playing=False):
    """Rekordbox xx 21 metadata.  Byte positions verified from capture frames
    around `1021000a2001000280100000000e0000000000000000003bff...800d`.
    """
    pkt = bytearray(128)
    pkt[0]  = deck_byte
    pkt[1]  = 0x21
    pkt[3]  = 0x0a
    pkt[4]  = 0x20            # rekordbox playing-state byte (VirtualDJ used 0x0c)
    pkt[5]  = 0x01
    pkt[7]  = 0x02 if track_loaded else 0x01
    pkt[8]  = 0x80            # rekordbox-specific (was 0x00 in VirtualDJ)
    pkt[9]  = 0x10            # rekordbox-specific
    pkt[13] = 0x0e if track_loaded else 0x00  # active flag — appears once track recognized
    if track_loaded:
        pkt[23] = 0x3b
        pkt[24] = 0xff
        pkt[27] = 0x80
        pkt[40] = 0xff
        pkt[41] = 0xff
    pkt[58] = 0x80
    pkt[59] = 0x0d            # rekordbox uses 0x0d, not 0x1e (still not fully decoded)
    return pkt


def send_metadata(ep_out, deck, track_loaded=True, playing=False):
    db = DECK_BYTES.get(deck)
    if not db:
        return
    send_pkt(ep_out, _make_metadata_pkt(db, track_loaded, playing))


def metadata_burst(ep_out, loaded_deck, cycles=20, interval_s=0.02, playing=False):
    """Send xx 21 for all 4 decks at 50 Hz for `cycles` rounds."""
    for _ in range(cycles):
        for d in range(1, 5):
            send_metadata(ep_out, d,
                          track_loaded=(d == loaded_deck),
                          playing=(playing and d == loaded_deck))
        time.sleep(interval_s)


# ---------------------------------------------------------------------------
# xx 2C overview — 35 packets, byte[4]=0x23, byte[5]=0x00
# ---------------------------------------------------------------------------

def upload_overview(ep_out, deck):
    """xx 2C overview: 35 packets × 122 bytes payload.  Inner entry format isn't
    fully decoded; we send a sine-wave pattern that uses byte values across the
    full 0..255 range to maximize chance of visible output if any byte is height.
    """
    db = DECK_BYTES[deck]
    TOTAL = 35
    payload_bytes = TOTAL * SEG_PAYLOAD   # 35 * 122 = 4270
    stream = bytearray(payload_bytes)
    for i in range(payload_bytes):
        # smooth sine wave so we get visible variation regardless of how the
        # firmware interprets the bytes
        phase = i / payload_bytes
        stream[i] = int(127 + 127 * math.sin(phase * 2 * math.pi * 8))

    for seg in range(1, TOTAL + 1):
        pkt = build_pkt(db, 0x2C, seg, 0x00, 0x23)
        # byte[5] stays 0x00 (rekordbox does not use a marker on xx 2C)
        start = (seg - 1) * SEG_PAYLOAD
        for j in range(SEG_PAYLOAD):
            pkt[6 + j] = stream[start + j]
        send_pkt(ep_out, pkt)
    print(f"Overview (xx 2C): sent {TOTAL} packets to deck {deck}")


# ---------------------------------------------------------------------------
# xx 2E PWV5 color waveform
# ---------------------------------------------------------------------------

def encode_pwv5_le(r, g, b, h):
    """PWV5 LE16 entry.  r,g,b ∈ 0..7, h ∈ 0..31."""
    v = ((r & 7) << 13) | ((g & 7) << 10) | ((b & 7) << 7) | ((h & 0x1F) << 2)
    return v & 0xFF, (v >> 8) & 0xFF


def _generate_pwv5_entries(duration_sec):
    """Visible test pattern: rhythmic kick-drum feel with color sweeps.
    Returns a flat list of bytes (already LE16-encoded)."""
    n = int(duration_sec * ENTRIES_PER_SEC)
    out = bytearray(2 * n)
    for i in range(n):
        t   = i / ENTRIES_PER_SEC
        env = 0.3 + 0.7 * abs(((i // 75) % 4 - 1.5) / 1.5)
        # Bass-kick on the 1: pulse height
        if (t % 1.0) < 0.05:
            h = int(31 * env)
            r, g, b = 7, 2, 1
        elif (t % 0.5) < 0.04:
            h = int(22 * env)
            r, g, b = 2, 7, 2
        elif (t % 2.0) < 0.15:
            h = int(18 * env)
            r, g, b = 2, 3, 7
        else:
            h = int(8 * env)
            r, g, b = 3, 3, 3
        lo, hi = encode_pwv5_le(r, g, b, h)
        out[2*i] = lo
        out[2*i + 1] = hi
    return out


def upload_waveform(ep_out, deck, duration_sec):
    """xx 2E PWV5 color upload.

    seg 1 sub 0: bytes[6..9] = 4-byte track header (duration BE24 + 0x00),
                 bytes[10..127] = 59 PWV5 entries (118 bytes)
    other segs:  bytes[6..127] = 61 PWV5 entries (122 bytes)
    """
    db = DECK_BYTES[deck]
    entries_bytes = _generate_pwv5_entries(duration_sec)
    n_entries = len(entries_bytes) // 2

    # 4-byte header for first packet: duration BE24 + 0x00.
    # Rekordbox captured: `12 e3 00 00`.  0x12e3 = 4835.  Not obviously duration
    # in seconds or ms, may be a track hash.  We'll try BE24 of total entries.
    h0 = (n_entries >> 16) & 0xFF
    h1 = (n_entries >> 8) & 0xFF
    h2 =  n_entries        & 0xFF
    track_header = bytes([h0, h1, h2, 0x00])

    pos = 0          # index into entries_bytes
    seg = 1
    sub = 0
    total_packets = 0

    # ----- First packet (seg 1, sub 0): 4-byte header + 118 bytes entries
    pkt = build_pkt(db, 0x2E, seg, sub, 0xB9)
    pkt[5] = 0x03                              # color marker
    pkt[6:10] = track_header                   # 4-byte track header
    take = min(118, len(entries_bytes) - pos)
    pkt[10:10 + take] = entries_bytes[pos:pos + take]
    send_pkt(ep_out, pkt)
    pos += take
    seg += 1
    total_packets += 1

    # ----- Remaining packets: byte[5]=0x03, bytes[6..127] = 122 bytes entries
    while pos < len(entries_bytes):
        pkt = build_pkt(db, 0x2E, seg, sub, 0xB9)
        pkt[5] = 0x03
        take = min(122, len(entries_bytes) - pos)
        pkt[6:6 + take] = entries_bytes[pos:pos + take]
        send_pkt(ep_out, pkt)
        pos += take
        seg += 1
        total_packets += 1
        if seg > 255:
            seg = 1
            sub += 1

    print(f"Waveform (xx 2E PWV5): sent {total_packets} packets, "
          f"{n_entries} entries ({duration_sec:.1f}s) to deck {deck}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def find_flx10_alsa_card():
    """Return the ALSA card number for the DDJ-FLX10 (e.g. 4), or None."""
    try:
        out = subprocess.check_output(["aplay", "-l"], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"^card (\d+): DDJFLX10", out, re.MULTILINE)
    return int(m.group(1)) if m else None


def start_silent_audio(card_num):
    """Pump silence to the FLX10 EP1 OUT in the background.  The hypothesis is
    that the screen-rendering pipeline is gated on active audio streaming.
    Format from /proc/asound/card{N}/stream0: S24_3LE, 4ch, 44100 Hz.
    """
    cmd = ["aplay", "-q", "-D", f"hw:{card_num},0",
           "-f", "S24_3LE", "-c", "4", "-r", "44100",
           "/dev/zero"]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deck",     type=int, default=2, choices=[1, 2, 3, 4])
    ap.add_argument("--duration", type=float, default=30.0,
                    help="Seconds of test waveform (default: 30)")
    ap.add_argument("--warmup",   type=float, default=2.0,
                    help="Seconds of heartbeats before sending metadata (default: 2.0)")
    ap.add_argument("--hold",     type=float, default=10.0,
                    help="Seconds to keep heartbeats+metadata running after upload (default: 10)")
    ap.add_argument("--playing",  action="store_true", default=True,
                    help="Send metadata in playing state (default: True)")
    ap.add_argument("--no-audio", action="store_true",
                    help="Skip the background aplay /dev/zero audio stream. "
                         "By default we pump silence to EP1 because rekordbox's full-init capture "
                         "shows audio starts ~50s before any screen write — likely a precondition.")
    ap.add_argument("--no-sysex", action="store_true",
                    help="Skip the MIDI SysEx polling (`50 00` ping every 200ms) that rekordbox "
                         "sends before its first screen write.")
    args = ap.parse_args()

    dev = find_device()
    detached = False
    try:
        dev.detach_kernel_driver(SCREEN_INTERFACE)
        detached = True
        print(f"Detached kernel HID driver from interface {SCREEN_INTERFACE}")
    except usb.core.USBError as e:
        if e.errno == 61:
            print(f"No kernel driver on interface {SCREEN_INTERFACE} (OK)")
        else:
            print(f"detach_kernel_driver warning: {e}")

    try:
        dev.set_configuration()
    except usb.core.USBError as e:
        if e.errno not in (16, 6):
            raise

    print(f"Claiming interface {SCREEN_INTERFACE} …")
    try:
        usb.util.claim_interface(dev, SCREEN_INTERFACE)
    except usb.core.USBError as e:
        sys.exit(f"\nERROR: Cannot claim interface {SCREEN_INTERFACE}: {e}\n"
                 "Make sure Mixxx and any other FLX10 software is fully closed.")

    ep_out, ep_in = get_screen_endpoints(dev)
    hb = None
    audio_proc = None
    sysex = None

    # ===== Phase 0a: start MIDI SysEx polling (rekordbox sends this first) ==
    if not args.no_sysex:
        midi_port = find_flx10_midi_port()
        if midi_port is None:
            print("WARNING: FLX10 MIDI port not found in `amidi -l`, skipping SysEx ping")
        else:
            print(f"\nPhase 0a: SysEx polling on {midi_port} every 200 ms …")
            sysex = SysExPingThread(midi_port)
            sysex.start()
            time.sleep(1.2)   # 5+ pings, matching rekordbox's pre-heartbeat warm-up

    # ===== Phase 0b: start silent audio streaming on EP1 ====================
    if not args.no_audio:
        card = find_flx10_alsa_card()
        if card is None:
            print("WARNING: FLX10 not in `aplay -l`, skipping audio stream")
        else:
            print(f"\nPhase 0b: streaming silence to hw:{card},0 (EP1 OUT) …")
            try:
                audio_proc = start_silent_audio(card)
                time.sleep(0.5)
                if audio_proc.poll() is not None:
                    print(f"  aplay died immediately (exit {audio_proc.returncode}); continuing without audio")
                    audio_proc = None
                else:
                    print("  audio is streaming (pid {})".format(audio_proc.pid))
            except OSError as e:
                print(f"  could not start aplay: {e}; continuing without audio")

    try:
        # ===== Phase 1: heartbeats only (rekordbox warm-up) =================
        print(f"\nPhase 1: heartbeats-only warm-up ({args.warmup:.1f}s) …")
        hb = HeartbeatThread(ep_out)
        hb.start()
        time.sleep(args.warmup)
        drain_acks(ep_in, count=10, label="post-warmup")

        # ===== Phase 2: metadata burst (all decks, ~20 cycles at 50 Hz) =====
        print(f"\nPhase 2: metadata burst (deck {args.deck} loaded, "
              f"{'playing' if args.playing else 'stopped'}) …")
        metadata_burst(ep_out, loaded_deck=args.deck, cycles=20, playing=args.playing)
        drain_acks(ep_in, count=10, label="post-metadata")

        # ===== Phase 3: overview upload =====================================
        print(f"\nPhase 3: overview (xx 2C) upload to deck {args.deck} …")
        upload_overview(ep_out, args.deck)
        drain_acks(ep_in, count=10, label="post-overview")

        # ===== Phase 4: waveform upload =====================================
        print(f"\nPhase 4: waveform (xx 2E PWV5) upload, {args.duration:.1f}s …")
        upload_waveform(ep_out, args.deck, args.duration)
        drain_acks(ep_in, count=30, timeout_ms=200, label="post-waveform")

        # ===== Phase 5: sustained metadata + heartbeats =====================
        print(f"\nPhase 5: sustained metadata + heartbeats for {args.hold:.1f}s …")
        print("        Watch the jog wheel now — waveform should appear if rendering works.")
        end_t = time.time() + args.hold
        while time.time() < end_t:
            for d in range(1, 5):
                send_metadata(ep_out, d,
                              track_loaded=(d == args.deck),
                              playing=(args.playing and d == args.deck))
            time.sleep(0.02)

        print("\n——— Done — heartbeats stopping ———")

    finally:
        if hb is not None:
            hb.stop()
            hb.join(timeout=1)
        if sysex is not None:
            sysex.stop()
            sysex.join(timeout=1)
            print(f"SysEx pings sent: {sysex.sent} (errors: {sysex.errors})")
        if audio_proc is not None:
            audio_proc.terminate()
            try:
                audio_proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                audio_proc.kill()
            print("Stopped background audio stream.")
        print("Releasing interface …")
        try:
            usb.util.release_interface(dev, SCREEN_INTERFACE)
        except Exception as e:
            print(f"  release_interface: {e}")
        if detached:
            try:
                dev.attach_kernel_driver(SCREEN_INTERFACE)
                print("Kernel HID driver re-attached.")
            except usb.core.USBError as e:
                print(f"Could not re-attach kernel driver: {e}")
        usb.util.dispose_resources(dev)


if __name__ == "__main__":
    main()
