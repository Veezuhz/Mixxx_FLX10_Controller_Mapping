// PioneerDDJFLX10-screen.js  v1.0 (Serato protocol, byte-perfect)
// HID jog wheel screen module for the DDJ-FLX10.  Loaded by
// PioneerDDJFLX10-screen.hid.xml as a separate HID controller mapping.
//
// ====================================================================
// CHANGE LOG
// ====================================================================
// 2026-05-26 (late-night session):
//   * Byte 29 CAMELOT KEY encoding cracked. Full 24-key lookup table
//     wired to Mixxx's file_key CO. First DJ controller in Mixxx to
//     display real per-track Camelot keys on the FLX10 jog screen.
//     Pattern: even bytes 0x82..0x96 = A-side (minor), odd bytes
//     0x81..0x97 = B-side (major); each +2 step advances Camelot
//     number by +7 mod 12 (circle of fifths). 0x80 / 0x99 = "no key"
//     markers. See memory:flx10-protocol-full-decode for full table.
//   * Conditional MODE TOGGLE: byte 3/19/29/trailer adapt based on
//     `file_bpm > 0`. Tracks with beatgrid → theparade mode (b3=0x88,
//     b19=0x07, trailer ad/05/00). Tracks without → smoothplay mode
//     (b3=0x80, b19=0, trailer e0/01/00). Matches Serato's two modes
//     across 10+ captures.
//   * Byte 21 anchored to FILE-TIME × 2048/sec (was wall-time × 125).
//     Fixes wave-needle "swim" when tempo slider moves AND eliminates
//     the "smooth 2 bars then jump 2 bars" artifact (125/sec wrapped
//     every 2.048s ≈ 2 bars at 124 BPM; 2048/sec wraps every 125ms,
//     sub-perceptible). 2048/sec is Serato's measured active-play
//     rate from theparade capture (8 wraps over 0.987s).
//   * Bytes 8, 18, 22 held at 0 to eliminate the "wave content
//     flashes to track-start every 4 beats" artifact. Cycling these
//     (Serato's pattern) put firmware into beat-aligned-redraw mode
//     that we couldn't align cleanly.
//   * Byte 7 → 256/sec (was 1024/sec). Wraps once per second at the
//     byte-6 increment boundary instead of 4x per second mid-second,
//     killing the 4 Hz wave-needle shimmer.
//   * Forward-only interp logic: don't reset _lastPosTime if real pos
//     hasn't passed our extrapolation. Fixes the "-2 then +4" jitter.
//   * Removed diagnostic logs (FLASH, SWEEP, KEY) after cleanup.
//
// OPEN ITEMS (next session):
//   * Millisecond-scale wave-needle ticking. Probably the update-rate
//     bottleneck: JS xx 27 at 200 Hz but Mixxx playposition CO updates
//     at audio-buffer rate (~43 Hz). Visible quantization between Mixxx
//     ticks. Worth: faster CO polling, interp smoothing tweaks, daemon
//     refresh-rate bump from 127ms.
//   * Byte 18 measure-counter (0..5 cycling in theparade mode) is
//     held at 0 for now. Cycling caused wave-flash without proper beat
//     alignment from Mixxx; would need beat_distance CO integration.
//   * Bytes 23, 24, 26-28 confirmed always-zero in 9+ Serato captures.
//     Reserved/unused — do not touch.
// ====================================================================
//
// This v1.0 module is the result of multi-day reverse engineering that
// culminated 2026-05-23.  Every packet here is byte-for-byte verified against
// captures from Serato DJ Pro driving the same FLX10 hardware.  When the
// MIDI mapping (Pioneer-DDJ-FLX10-scripts.js) does the SysEx handshake and
// the user has run the vendor unlock (flx10_unlock_v2.py), this module
// renders a real waveform across the FLX10's jog wheel discs.
//
// CRITICAL PRECONDITIONS (without these the firmware silently drops everything):
//
//   1. Vendor unlock done.  Run:
//        sudo python3 ~/.mixxx/controllers/flx10_unlock_v2.py
//      once after plugging in the FLX10.  Mixxx cannot do this itself —
//      it requires snd-usb-audio unbind/rebind on Linux.
//
//   2. SysEx handshake running on MIDI OUT:
//        - F0 00 40 05 00 00 04 01 00 03 01 F7   sent once at startup
//        - F0 00 40 05 00 00 04 01 00 50 31 F7   keepalive every ~200 ms
//      These are sent from the MIDI mapping (PioneerDDJFLX10.init / .shutdown
//      in Pioneer-DDJ-FLX10-scripts.js) because Mixxx HID controller scripts
//      cannot send MIDI.
//
// SEND ORDER for waveform render (per deck, on track load):
//   xx 27 state → xx 30 init → xx 39 labels → xx 33 album art → xx 35 begin →
//   xx 36 waveform → xx 2f cue placeholder
// Plus xx 27 sustained at 50 Hz across all 4 decks while running.

var PioneerDDJFLX10Screen = {};

PioneerDDJFLX10Screen._DECK_BYTE     = [0x10, 0x20, 0x30, 0x40];
PioneerDDJFLX10Screen._STATE_BYTE_31 = {0x10: 0x02, 0x20: 0x01, 0x30: 0x04, 0x40: 0x03};
PioneerDDJFLX10Screen._STATE_MS      = 5;      // 200 Hz xx 27. Pairs with the
                                               // patched Mixxx visual_playposition CO
                                               // (sample-accurate, unthrottled, updates
                                               // every audio buffer). At 5ms we get many
                                               // samples per CO update for smooth wave.
// FLX10 vs Mixxx UI fixed offset compensation (seconds).
// playposition CO returns the engine's processing position; Mixxx UI shows
// the position adjusted for output-audio latency (audio buffer + DAC).
// Measured 2026-05-24: FLX10 was 0.96s "behind" Mixxx UI on a paused track
// (first tried 0.66 then bumped after residual gap). Likely audio buffer +
// display refresh + scripts.js timer-tick latency combined.
// Adjust if your audio buffer setting differs.
PioneerDDJFLX10Screen._TIME_OFFSET_SEC = 0.96;
PioneerDDJFLX10Screen._cachedTimeBytes = {1: null, 2: null, 3: null, 4: null};
PioneerDDJFLX10Screen._lastTimeRefresh = {1: 0, 2: 0, 3: 0, 4: 0};

PioneerDDJFLX10Screen._getCachedTimeBytes = function(deckNum, pos, duration) {
    var now = Date.now();
    if (this._cachedTimeBytes[deckNum] === null ||
        now - this._lastTimeRefresh[deckNum] >= this._TIME_REFRESH_MS) {
        this._lastTimeRefresh[deckNum] = now;
        if (duration > 0) {
            var pClamped = pos;
            if (pClamped < 0.0) pClamped = 0.0;
            if (pClamped > 1.0) pClamped = 1.0;
            var remainingSec = duration * (1.0 - pClamped);
            var totalMs = Math.round(remainingSec * 1000);
            if (totalMs < 0) totalMs = 0;
            var minutes = Math.floor(totalMs / 60000);
            var remMs   = totalMs % 60000;
            var seconds = Math.floor(remMs / 1000);
            var ms      = remMs % 1000;
            this._cachedTimeBytes[deckNum] = [
                minutes & 0xFF,
                seconds & 0xFF,
                ms & 0xFF,
                (ms >> 8) & 0xFF
            ];
        } else {
            this._cachedTimeBytes[deckNum] = [0x06, 0x1b, 0xfa, 0x01];
        }
    }
    return this._cachedTimeBytes[deckNum];
};
PioneerDDJFLX10Screen._WAVE_DURATION = 30;     // seconds of test-pattern waveform
PioneerDDJFLX10Screen._lastDuration  = {1: 0, 2: 0, 3: 0, 4: 0};
PioneerDDJFLX10Screen._lastPos       = {};
PioneerDDJFLX10Screen._lastPosTime   = {1: 0, 2: 0, 3: 0, 4: 0};
PioneerDDJFLX10Screen._lastSmoothMs  = {1: 0, 2: 0, 3: 0, 4: 0};
PioneerDDJFLX10Screen._stateTimer    = null;


// ===== Raw HID send via Mixxx ===============================================
PioneerDDJFLX10Screen._send = function(pkt) {
    controller.send(pkt, null, 0);
};

PioneerDDJFLX10Screen._zeros = function() {
    var p = [];
    for (var i = 0; i < 128; i++) { p[i] = 0; }
    return p;
};


// Per-deck cache of Mixxx-derived data we want to bake into the next xx 27 ping.
PioneerDDJFLX10Screen._deckBpm = {1: 0, 2: 0, 3: 0, 4: 0};

PioneerDDJFLX10Screen._deckFromDeckByte = function(deckByte) {
    if (deckByte === 0x10) { return 1; }
    if (deckByte === 0x20) { return 2; }
    if (deckByte === 0x30) { return 3; }
    if (deckByte === 0x40) { return 4; }
    return 0;
};

// ===== xx 27 — per-deck state ping (sent at 200 Hz to all 4 decks) ==========
// Reads pos / duration / BPM directly from Mixxx COs each tick — no log-tail
// lag.
//
// CURRENT byte map (verified 2026-05-26 — see file header CHANGE LOG):
//   [0]      Deck byte 0x10/0x20/0x30/0x40
//   [1]      0x27 (packet type)
//   [2]      0xb4 (const)
//   [3]      Mode flag: 0x88 (theparade mode) / 0x80 (smoothplay)
//   [4]      0x01 (const)
//   [5..7]   ELAPSED time as min / sec-in-min / sub-sec(256/sec, wraps at 1s)
//   [8]      Eighth-note counter (we HOLD AT 0 — cycling causes wave-flash)
//   [9..12]  REMAINING time: min(1B) / sec(1B) / ms LE16
//            ⚠ if [9..12] all zero, firmware drops the entire wave display
//   [13]     BPM integer
//   [14]     BPM frac × 16 (high nibble) — low nibble unused
//   [15..17] Tempo % offset: LE16 of (rate_ratio-1)*100*100; [15] = 0
//   [18]     Measure counter (we HOLD AT 0 — cycling causes wave-flash)
//   [19]     Beat-grid-active flag: 0x07 (theparade) / 0x00 (smoothplay)
//   [20]     0x0e (const)
//   [21]     Wave-entry counter: FILE-time × 2048/sec & 0xFF (Serato rate)
//   [22]     Sixteenth counter (we HOLD AT 0 — cycling causes wave-flash)
//   [23,24]  Reserved (always 0 in 9+ Serato captures — DO NOT TOUCH)
//   [25]     0x80 (const)
//   [26..28] Reserved (always 0 — DO NOT TOUCH)
//   [29]     CAMELOT KEY (see MIXXX_KEY_TO_B29 lookup in _buildState).
//            Also doubles as "loaded marker" — 0x80 = empty deck.
//   [30]     0x0d (const)
//   [31]     Deck state byte (see _STATE_BYTE_31 table)
//   [32..34] Trailer: ad/05/00 (theparade) / e0/01/00 (smoothplay)
// ==== _POS_RATE: DEAD CODE as of 2026-05-26 — DO NOT TUNE ====
// This constant is no longer referenced. Kept ONLY for the calibration
// values in comments (they may be useful if someone re-tries BE24-encoded
// bytes 5..7). The current production encoding writes bytes 5..7 as
// min/sec/sub-sec time-display fields, not as a BE24 wave-needle counter.
// The wave-needle position now comes from byte 21 (file-time × 2048/sec)
// and from xx 36 packets sent by the daemon.
//
// HISTORICAL calibration (when bytes 5..7 WERE BE24 = elapsed × _POS_RATE):
//   POS_RATE=250 → -1.5s drift / 60s
//   POS_RATE=256 → -0.5s drift / 60s
//   POS_RATE=258 → -0.2s drift / 60s
//   POS_RATE=260 → +0.2s drift / 60s   (IDENTICAL at tempo 0/+5/-5)
//   Linear fit: firmware rate ≈ 259.14 → 259 gives near-zero drift.
PioneerDDJFLX10Screen._POS_RATE = 259.0;   // unused — see above

// SCREEN MODE — pivot 2026-05-24. 'serato' uses xx 27 (legacy, drift issue).
// 'rekordbox' uses xx 21 + xx 3D heartbeat. 'vdj' uses xx 21 (different play
// values: 04 vs rekordbox 00) + no heartbeat. Keep this in sync with the
// matching flag in Pioneer-DDJ-FLX10-scripts.js (PioneerDDJFLX10._SCREEN_MODE).
PioneerDDJFLX10Screen._SCREEN_MODE = 'serato';

// (Serato-mode only) A/B flag: when false, position bytes [5..7] are zero
// (firmware uses our [9..12] time bytes directly → accurate time, static wave);
// when true, position bytes encode elapsed×POS_RATE BE24 (wave scrolls but
// firmware re-derives time from position at 0.5x rate → drift).
// Default false: user explicitly prefers time accuracy over wave scroll
// ("I cant be having ANY drifting"). The firmware coupling between needle
// position and time display can't be broken in Serato mode (see history).
PioneerDDJFLX10Screen._SEND_POSITION = true;

// 2026-05-25: BPM-zero test confirmed firmware does NOT use our BPM bytes
// for drift formula (uses internal BPM somehow). Reverting to sending real BPM.
PioneerDDJFLX10Screen._ZERO_BPM_FOR_DRIFT_TEST = false;

PioneerDDJFLX10Screen._buildState = function(deckByte, trackLoaded) {
    var p = this._zeros();
    p[0]  = deckByte;
    p[1]  = 0x27;
    p[2]  = 0xb4;
    p[4]  = 0x01;
    p[20] = 0x0e;
    p[25] = 0x80;
    p[30] = 0x0d;
    p[31] = this._STATE_BYTE_31[deckByte];
    // Mode-flag bytes (3, 19, 29, 32-34) are set CONDITIONALLY inside the
    // trackLoaded block based on whether Mixxx has a beat grid for the track
    // (proxy: file_bpm > 0).
    //   - Beat-grid present  → theparade mode (b3=88 b19=07 b29=8c trailer=ad/05/00)
    //   - Beat-grid absent   → older Serato mode (b3=80 b19=00 b29=92 trailer=e0/01/00)
    // For empty/unloaded decks, use the simpler default below.
    p[3]  = 0x80;
    p[19] = 0x00;
    p[32] = 0xe0;
    p[33] = 0x01;
    p[34] = 0x00;
    if (trackLoaded) {
        var deckNum = this._deckFromDeckByte(deckByte);
        var group   = "[Channel" + deckNum + "]";
        // 2026-05-25 DIAGNOSTIC: log + use BOTH playposition COs to test which.
        var vp = engine.getValue(group, "visual_playposition");
        var pp = engine.getValue(group, "playposition");
        // Use playposition (the throttled but stable one) instead of
        // visual_playposition for this test. If flash stops, the glitch
        // was in visual_playposition CO; if flashes persist, cause is
        // elsewhere (e.g. daemon, firmware, or other byte).
        var pos = pp;
        // Log when there's a >0.5 disagreement between the two (indicates a
        // glitch where one is at 0 and the other has the real value).
        if (Math.abs(vp - pp) > 0.5) {
            console.log("FLX10 POS_GLITCH deck=" + deckNum + " vp=" + vp + " pp=" + pp);
        }
        var duration = engine.getValue(group, "duration");
        var fileBpm  = engine.getValue(group, "file_bpm");
        var rateRatio = engine.getValue(group, "rate_ratio");
        var liveBpm  = fileBpm * rateRatio;

        // 2026-05-26 CAMELOT KEY ENCODING — byte 29.
        // CORRECTED mapping after empirical test with real Mixxx tracks:
        //   Odd  values 0x81,0x83,...,0x97 → B-side (major) Camelot
        //   Even values 0x80,0x82,...,0x96 → A-side (minor) Camelot
        // (The b29 sweep test had A/B transposed in user's notes — verified
        //  against minor tracks displaying B-side when we sent odd bytes.)
        // Camelot number cycle: 8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1 (circle of fifths).
        // Maps to Mixxx's file_key CO enum (1-24: 1-12=major, 13-24=minor chromatic).
        //
        // Mode bytes use theparade set (b3=88, b19=07, trailer=ad/05/00) since
        // the sweep was performed in that context. Could differ in other modes.
        p[3]  = 0x88;
        p[19] = 0x07;
        p[32] = 0xad;  p[33] = 0x05;  p[34] = 0x00;
        // 2026-05-26 v2 — corrected after live track test. The original sweep
        // was off by one Camelot position; rebuilt from direct (file_key,
        // FLX10 display) measurements. Pattern: each +2 byte step advances
        // the Camelot number by +7 (mod 12), starting from 0x82=8A.
        // 0x80 displays nothing (firmware treats as "no key" marker).
        // 1A maps to 0x98 (extrapolated — completes the 12-position cycle).
        // ODD bytes are inferred as B-side counterparts (not yet directly tested).
        // 2026-05-26 v3 — finalized after testing both A- and B-side tracks.
        // Pattern: each +2 byte step advances Camelot number by +7 (mod 12).
        // A-side (even bytes) cycle starts at 0x82=8A and 0x80 is the "no key"
        // marker. B-side (odd bytes) cycle starts at 0x81=8B with no skip;
        // its "no key" marker is at the END (0x99). Two terminal markers,
        // not one. (Confirmed: 0x8f→9B in Round 4 test; 0x99→nothing.)
        var MIXXX_KEY_TO_B29 = [
            0x80,   //  0 invalid / unanalyzed → "no key" display
            0x81,   //  1 C major     = 8B
            0x83,   //  2 D♭ major    = 3B
            0x85,   //  3 D major     = 10B
            0x87,   //  4 E♭ major    = 5B
            0x89,   //  5 E major     = 12B
            0x8b,   //  6 F major     = 7B
            0x8d,   //  7 F# major    = 2B
            0x8f,   //  8 G major     = 9B
            0x91,   //  9 A♭ major    = 4B
            0x93,   // 10 A major     = 11B
            0x95,   // 11 B♭ major    = 6B
            0x97,   // 12 B major     = 1B
            0x88,   // 13 C minor     = 5A
            0x8a,   // 14 C# minor    = 12A
            0x8c,   // 15 D minor     = 7A
            0x8e,   // 16 E♭ minor    = 2A
            0x90,   // 17 E minor     = 9A
            0x92,   // 18 F minor     = 4A
            0x94,   // 19 F# minor    = 11A
            0x96,   // 20 G minor     = 6A
            0x98,   // 21 G# minor    = 1A
            0x82,   // 22 A minor     = 8A
            0x84,   // 23 B♭ minor    = 3A
            0x86    // 24 B minor     = 10A
        ];
        var fileKey = engine.getValue(group, "file_key");
        var keyIdx  = (fileKey | 0);
        if (keyIdx < 0 || keyIdx > 24) keyIdx = 0;
        p[29] = MIXXX_KEY_TO_B29[keyIdx];

        // TEMPO % DISPLAY (decoded 2026-05-24 from tempo-slider capture).
        // Bytes layout in xx 27:
        //   [15] = jitter/counter (4-bit value 0..9, seems noise — try 0)
        //   [16] = LE-low byte of tempo-related 16-bit value
        //   [17] = LE-high byte
        // Empirical: at file_bpm=120, [17][16] LE16 ≈ (live_bpm - 120) × 83.
        // Generalize: encode percentage offset × scale.
        // tempo_pct = (live_bpm / file_bpm - 1) × 100  (e.g. +2.5 for +2.5%)
        // scale empirically ≈ 100 (16-bit value = pct × 100, two-decimal precision)
        // Use rate_ratio directly so tempo % displays even on tracks without
        // a detected BPM (where fileBpm = 0 would otherwise blank the field).
        if (rateRatio > 0) {
            var pctOffset = (rateRatio - 1.0) * 100.0;
            // Signed 16-bit, scale by 100 to preserve 2 decimal places
            var tempoEnc = Math.round(pctOffset * 100.0);
            if (tempoEnc < 0) tempoEnc = 0x10000 + tempoEnc;   // two's complement LE16
            if (tempoEnc > 0xFFFF) tempoEnc = 0xFFFF;
            p[15] = 0;                      // jitter byte — fine at 0
            p[16] =  tempoEnc        & 0xFF;
            p[17] = (tempoEnc >>  8) & 0xFF;
        }

        // [9..12] = WALL duration = file_duration / rate_ratio.
        // FLOOR (truncate) sub-sec to tenths. Math.round in JS rounds X.5 UP
        // (Math.round(0.5)==1) which would add a 50-100ms bias for any track
        // whose sub-sec is in the .X50..X99 range. Floor truncates cleanly.
        if (duration > 0) {
            var rrForDur = rateRatio > 0 ? rateRatio : 1.0;
            var wallDurSec = duration / rrForDur;
            var totalMsDur = Math.floor(wallDurSec * 1000);
            var minutesD = Math.floor(totalMsDur / 60000);
            var remMsD   = totalMsDur % 60000;
            var secondsD = Math.floor(remMsD / 1000);
            var msD      = Math.floor((remMsD % 1000) / 100) * 100;
            p[9]  = minutesD & 0xFF;
            p[10] = secondsD & 0xFF;
            p[11] = msD & 0xFF;
            p[12] = (msD >> 8) & 0xFF;
        } else {
            p[9]  = 0x06;  p[10] = 0x1b;  p[11] = 0xfa;  p[12] = 0x01;
        }

        // BPM integer + decimal tenths nibble (same reason as time —
        // sending zero bytes makes the FLX10 BPM field blank).
        // 2026-05-25 TEST: try zeroing BPM bytes to see if firmware drift
        // formula uses the BPM bytes we send vs internal BPM.
        // BPM restored — testing BPM=0 confirmed BPM bytes aren't the
        // cause of 2 Hz jitter. The user's perceived "downbeat" jumps may
        // be coincidental with the firmware's fixed refresh rate.
        if (liveBpm > 0) {
            p[13] = Math.floor(liveBpm) & 0xFF;
            var frac = liveBpm - Math.floor(liveBpm);
            p[14] = (Math.round(frac * 16) & 0x0F) << 4;
        }

        // 2026-05-25 ROOT-CAUSE FIX for "constant fine-grained shimmer":
        // Bytes [5..7] are read by firmware as a continuous BE24 wave-needle
        // counter (per protocol decode memory: "Drives wave needle"). The
        // previous encoding (byte 5 = minutes, byte 6 = sec-in-min, byte 7 =
        // sub-sec at 1024/sec % 256) caused byte 7 to wrap every 250ms,
        // making the BE24 drop by ~254 four times per second — visible as a
        // 4Hz back-2-forward-4 wave-needle vibration. New encoding: BE24 =
        // floor(elapsed × POS_RATE), POS_RATE=128 (daemon's empirically
        // determined in-sync rate). Remaining-time display is unaffected
        // because it's driven by bytes [9..12].
        if (this._SEND_POSITION && duration > 0) {
            var pClampedP = pos;
            if (pClampedP < 0.0) pClampedP = 0.0;
            if (pClampedP > 1.0) pClampedP = 1.0;
            var rrForPos = rateRatio > 0 ? rateRatio : 1.0;
            var fileElapsedSec = duration * pClampedP;
            var wallElapsedSec = fileElapsedSec / rrForPos;

            // Mixxx's visual_playposition CO updates ~43 Hz (audio buffer rate)
            // but our timer runs at 200 Hz. Without interpolation, byte 7
            // stair-steps every 23ms with ~24-unit jumps = visible jitter.
            // With interpolation: linear forward extrapolation between Mixxx
            // updates. NO snap-back: clamp interpolation to NEVER decrease
            // and only reset base on big pos jumps (seek > 100ms).
            var nowMs = Date.now();
            if (this._lastPos[deckNum] === undefined ||
                Math.abs(pos - this._lastPos[deckNum]) > 0.005) {
                // Track loaded / seek: reset interpolation base
                this._lastPos[deckNum]     = pos;
                this._lastPosTime[deckNum] = nowMs;
                this._lastSmoothMs[deckNum] = wallElapsedSec * 1000;
            } else if (pos !== this._lastPos[deckNum]) {
                // Normal forward update from Mixxx. Two cases:
                // (a) Real pos catches up to or passes our extrapolation → sync.
                // (b) Real pos is still BEHIND our extrapolation (we've been
                //     running ahead) → DON'T reset base/time; just track pos.
                //     If we reset lastPosTime here, next tick computes
                //     smoothMs = oldBase + ~0, which is LESS than what we
                //     just sent on the previous tick — visible as a -N+M
                //     jitter (the user-reported "-2 ticks then +4").
                this._lastPos[deckNum] = pos;
                var newBase = wallElapsedSec * 1000;
                var currentSmooth = this._lastSmoothMs[deckNum] +
                                    (nowMs - this._lastPosTime[deckNum]);
                if (newBase >= currentSmooth) {
                    this._lastSmoothMs[deckNum] = newBase;
                    this._lastPosTime[deckNum]  = nowMs;
                }
                // else: keep extrapolating from the existing base; the maxMs
                // clamp below will keep us within 30ms of reality.
            }
            var msSince = nowMs - this._lastPosTime[deckNum];
            var smoothMs = Math.floor(this._lastSmoothMs[deckNum] + msSince);
            // Clamp to never exceed wallElapsedSec by more than 30ms
            // (= one audio buffer worth of extrapolation)
            var maxMs = Math.floor(wallElapsedSec * 1000) + 30;
            if (smoothMs > maxMs) smoothMs = maxMs;
            var smoothElapsed = smoothMs / 1000;
            var smoothSecI    = Math.floor(smoothElapsed);
            p[5] = Math.floor(smoothSecI / 60) & 0xFF;
            p[6] = (smoothSecI % 60) & 0xFF;
            // Byte 7: sub-second counter. Firmware EXPECTS ~1024/sec
            // (4 wraps per second — Serato-captured) for the time display
            // to render correctly. 2026-05-25 ATTEMPT: 256/sec (one wrap
            // per second) eliminates BE24 mid-second dips but past testing
            // showed it produced a .4,.3,.2,.4 time-display cycle. If THIS
            // attempt also breaks time, revert to 1024/sec and accept the
            // shimmer until we find another wave-needle source byte.
            p[7] = Math.floor((smoothMs % 1000) * 256 / 1000) & 0xFF;
            // Byte 21 — wave-entry / play-progress counter. Two key choices:
            //   (a) FILE-time anchor (not wall-time / smoothElapsed). Tempo
            //       slider can't shift byte 21 because file-position doesn't
            //       move when only tempo changes → no "wave swims with tempo".
            //   (b) Rate 2048/sec: measured Serato active-play rate from
            //       flx10-serato-theparade-steady-play.pcapng (8 wraps over
            //       0.987s = 2076/sec). Wraps every 125ms — sub-perceptible.
            //       Previous 125/sec wrapped every 2.048s → user-visible as
            //       "smooth for 2 bars then jump 2 bars".
            var waveIdx = Math.floor(fileElapsedSec * 2048);
            p[21] = waveIdx & 0xFF;
            // Beat counters per Serato pattern:
            //   byte 8  = eighth-note counter (0..3, cycles every 2 beats)
            //   byte 22 = sixteenth-note counter (0..14)
            //   byte 18 = TEST: held at constant 1. User reports wave flickering
            //             between current position and position 0 — possibly
            //             firmware redraws the OVERVIEW wave from start on each
            //             byte 18 transition. Held constant to test.
            if (fileBpm > 0) {
                // 2026-05-25: bytes 8, 18, 22 held at 0 (fixed the 4-beat
                // wave-content flash — cycling these triggered firmware redraw).
                p[22] = 0;
                p[8]  = 0;
                p[18] = 0;
            } else {
                p[22] = 0;
                p[8]  = 0;
                p[18] = 0;
            }
            // 2026-05-26 BYTE 23 STATIC TEST: hold at 0xFF and compare to the
            // prior state where byte 23 was 0. Watch for any difference.
            p[23] = 0xff;
        } else {
            p[5] = 0; p[6] = 0; p[7] = 0;
            p[21] = 0x02;
            p[22] = 0;
            p[8]  = 0;
        }
    } else {
        p[29] = 0x80;
    }
    return p;
};


// ===== REKORDBOX-MODE PACKETS (xx 3D heartbeat + xx 21 deck state) =========
// Captured from flx10-rekordbox-pause-play-scrub.pcapng (deck 1) + opening
// capture. Static bytes copied verbatim from the captured "loaded paused"
// packet; we only update [2] (play/pause), [5] (active flag), [11][12]
// (position) per Mixxx state.

// Captured byte layout for xx 21 — TWO distinct templates per deck state.
// Empty-deck (no track loaded): minimal packet, mostly zeros. Decoded from
// flx10-rekordbox-opening (deck 1, no track), bytes [0..15]:
//   10 21 00 00 20 01 00 00 80 10 00 00 00 00 00 00
// Loaded-paused: many more bytes set. Decoded from flx10-rekordbox-pause-play-scrub
// (deck 1, t=0, loaded paused), bytes [0..63]:
//   10 21 00 0a 2c 01 00 02 80 b4 00 00 00 02 00 02
//   26 32 03 00 00 7c 00 03 00 00 00 80 00 00 00 02
//   00 00 00 00 00 00 00 00 00 00 00 ff ff 00 00 00
//   00 30 00 00 00 00 00 02 00 00 01 00 85 0d 00 00
// We MUST send the empty template for non-loaded decks. Sending the loaded
// template for empty decks tells the firmware "deck loaded but garbage data"
// and the firmware falls back to a degraded display mode.

PioneerDDJFLX10Screen._XX21_LOADED_HEX = (
    "10210000" + "2c01" + "0002" + "80b40000" + "0002" + "0002" +
    "26320300" + "007c0003" + "00000080" + "00000002" +
    "00000000" + "00000000" + "0000ffff" + "00000000" +
    "30000000" + "00000200" + "00010085" + "0d000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000"
);

PioneerDDJFLX10Screen._DECK_BYTE_XX21 = [0x10, 0x20, 0x30, 0x40];

PioneerDDJFLX10Screen._buildXX21 = function(deckNum, trackLoaded) {
    var p = this._zeros();
    var deckByte = this._DECK_BYTE_XX21[deckNum - 1];

    if (!trackLoaded) {
        // EMPTY DECK template — verbatim from rekordbox-opening capture.
        // 10 21 00 00 20 01 00 00 80 10 00 00 ...zeros
        p[0] = deckByte;
        p[1] = 0x21;
        p[4] = 0x20;
        p[5] = 0x01;
        p[8] = 0x80;
        p[9] = 0x10;
        return p;
    }

    // LOADED template — fill from hex, then override dynamic fields.
    var hex = this._XX21_LOADED_HEX;
    for (var i = 0; i < 128 && (i*2 + 2) <= hex.length; i++) {
        p[i] = parseInt(hex.substr(i*2, 2), 16);
    }
    p[0] = deckByte;

    var group = "[Channel" + deckNum + "]";
    var pos      = engine.getValue(group, "playposition");
    var duration = engine.getValue(group, "duration");
    var play     = engine.getValue(group, "play");
    var rateRatio = engine.getValue(group, "rate_ratio");
    if (!(rateRatio > 0)) rateRatio = 1.0;

    // [2] play/pause toggle: 00 playing, 02 paused
    p[2] = play > 0 ? 0x00 : 0x02;
    // [5] active flag: 0x81 when track is loaded
    p[5] = 0x81;

    // [11..12] BE16 position (rate-adjusted real elapsed seconds)
    if (duration > 0) {
        var pClamped = pos;
        if (pClamped < 0.0) pClamped = 0.0;
        if (pClamped > 1.0) pClamped = 1.0;
        var elapsedReal = duration * pClamped / rateRatio;
        var posBE16 = Math.floor(elapsedReal);
        if (posBE16 < 0) posBE16 = 0;
        if (posBE16 > 0xFFFF) posBE16 = 0xFFFF;
        p[11] = (posBE16 >> 8) & 0xFF;
        p[12] =  posBE16       & 0xFF;
    }
    return p;
};

// xx 3D heartbeat — rekordbox sends 5-frame rotation (byte[2] cycles 01..05)
// continuously. Stateless cycle counter increments each tick.
PioneerDDJFLX10Screen._heartbeatTick = 0;
PioneerDDJFLX10Screen._sendXX3DHeartbeat = function() {
    this._heartbeatTick = (this._heartbeatTick % 5) + 1;
    var p = this._zeros();
    p[0] = 0x00;
    p[1] = 0x3d;
    p[2] = this._heartbeatTick;
    p[3] = 0x00;
    p[4] = 0x05;
    this._send(p);
};

PioneerDDJFLX10Screen._sendRekordboxState = function() {
    // 1 heartbeat per tick + 1 xx 21 per loaded deck
    this._sendXX3DHeartbeat();
    for (var d = 1; d <= 4; d++) {
        var duration = engine.getValue("[Channel" + d + "]", "duration");
        this._lastDuration[d] = duration;
        var loaded = (duration > 0);
        this._send(this._buildXX21(d, loaded));
    }
};

// ===== VDJ-MODE xx 21 (captured 2026-05-24 from flx10-vdj-* captures) ======
// Same xx 21 layout as rekordbox but DIFFERENT byte values:
//   byte [2] = 0x04 playing, 0x02 paused (rekordbox: 00/02)
// Empty-deck template differs slightly from rekordbox empty.
// VDJ does NOT send xx 3D heartbeat (verified in init capture).

PioneerDDJFLX10Screen._VDJ_XX21_EMPTY_HEX = (
    // From flx10-vdj-init capture, deck 1, no track loaded (t=6.406):
    // 10 21 00 0a 04 01 00 02 00 00 0e 00 00 00 00 00
    // 00 00 00 00 00 69 60 50 fb 00 00 80 00 00 00 00 ...
    "10210000" + "0a04" + "0100" + "02000000" + "0e000000" +
    "00000000" + "00000000" + "00696050" + "fb000080" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000"
);

PioneerDDJFLX10Screen._VDJ_XX21_LOADED_HEX = (
    // From flx10-vdj-track-load capture, deck 1, loaded (t=14.006):
    // 10 21 04 0a 0c 81 00 02 80 b4 0e 00 00 c0 01 05
    // 24 1a 00 00 00 7c 30 00 00 00 00 80 00 00 00 c0
    // 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    // 00 70 00 00 00 00 00 c0 01 00 03 1e 0b 0d 00 00
    "1021040a" + "0c810002" + "80b40e00" + "00c00105" +
    "241a0000" + "007c3000" + "00000080" + "000000c0" +
    "01000000" + "00000000" + "00000000" + "00000000" +
    "00700000" + "000000c0" + "0100031e" + "0b0d0000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000" +
    "00000000" + "00000000" + "00000000" + "00000000"
);

PioneerDDJFLX10Screen._buildVDJ_XX21 = function(deckNum, trackLoaded) {
    var p = this._zeros();
    var deckByte = this._DECK_BYTE_XX21[deckNum - 1];
    var hex = trackLoaded ? this._VDJ_XX21_LOADED_HEX : this._VDJ_XX21_EMPTY_HEX;
    for (var i = 0; i < 128 && (i*2 + 2) <= hex.length; i++) {
        p[i] = parseInt(hex.substr(i*2, 2), 16);
    }
    p[0] = deckByte;

    if (trackLoaded) {
        var group = "[Channel" + deckNum + "]";
        var pos      = engine.getValue(group, "playposition");
        var duration = engine.getValue(group, "duration");
        var play     = engine.getValue(group, "play");
        var rateRatio = engine.getValue(group, "rate_ratio");
        if (!(rateRatio > 0)) rateRatio = 1.0;

        // VDJ play/pause toggle: 04 playing, 02 paused
        p[2] = play > 0 ? 0x04 : 0x02;
        // [5] = 0x81 active flag (already in template)
        // [11..12] BE16 elapsed seconds, rate-adjusted to match Mixxx UI clock
        if (duration > 0) {
            var pC = pos; if (pC < 0) pC = 0; if (pC > 1) pC = 1;
            var elapsedReal = duration * pC / rateRatio;
            var pos16 = Math.floor(elapsedReal);
            if (pos16 < 0) pos16 = 0;
            if (pos16 > 0xFFFF) pos16 = 0xFFFF;
            p[11] = (pos16 >> 8) & 0xFF;
            p[12] =  pos16       & 0xFF;
        }
    }
    return p;
};

PioneerDDJFLX10Screen._sendVDJState = function() {
    // VDJ has NO xx 3D heartbeat. Just xx 21 per deck.
    for (var d = 1; d <= 4; d++) {
        var duration = engine.getValue("[Channel" + d + "]", "duration");
        this._lastDuration[d] = duration;
        var loaded = (duration > 0);
        this._send(this._buildVDJ_XX21(d, loaded));
    }
};

// EXPERIMENT FLAG: when true, ALWAYS send xx 27 as track_loaded=false even
// when Mixxx has a track loaded. Tests whether the firmware will keep
// rendering an already-uploaded xx 36 waveform even with xx 27 in empty
// state. If yes, this unlocks MIDI channel-16 to drive the deck-info text
// (BPM, time) like it does without our HID module.
// Set to false to use the proven "loaded markers => waveform renders" path
// (which also overrides MIDI ch16 text with hardcoded placeholders).
// Decision (2026-05-23): the firmware requires xx 27 to carry track-loaded
// markers in order to keep the xx 36 waveform visible. As soon as we send
// track_loaded=false, the firmware drops the waveform too (verified by
// flipping this flag to true and observing no render). So we keep it false
// here. The cost is that the firmware uses its own text fields (driven by
// our hardcoded state-5 bytes in _buildState) instead of MIDI ch16 — the
// time and BPM displays show placeholder values until we figure out the
// real encoding for the duration/BPM bytes. See FLX10-SCREEN-PROTOCOL-FINDINGS.md.
PioneerDDJFLX10Screen._FORCE_STATE_EMPTY_FOR_MIDI_TEXT = false;

PioneerDDJFLX10Screen._sendStateAllDecks = function() {
    for (var d = 1; d <= 4; d++) {
        var duration = engine.getValue("[Channel" + d + "]", "duration");
        // CRITICAL: skip xx 27 for unloaded decks. Sending "empty deck"
        // xx 27 packets RESETS the firmware's global display state and
        // also wastes USB bandwidth/JS time.
        this._lastDuration[d] = duration;
        if (!(duration > 0)) { continue; }
        if (this._FORCE_STATE_EMPTY_FOR_MIDI_TEXT) { continue; }
        this._send(this._buildState(this._DECK_BYTE[d - 1], true));
    }
};

// Event-driven scheduler: called whenever playposition / rate_ratio changes.
// Throttles to _SEND_MIN_GAP_MS to avoid flooding Mixxx's HID write queue.
PioneerDDJFLX10Screen._lastSendTime = 0;
PioneerDDJFLX10Screen._scheduleStateUpdate = function() {
    var now = Date.now();
    if (now - this._lastSendTime >= this._SEND_MIN_GAP_MS) {
        this._lastSendTime = now;
        this._sendStateAllDecks();
    }
};


// ===== xx 30 — per-deck init (8 enable-flags at [10,16,22,28,34,40,46,52]) =
PioneerDDJFLX10Screen._sendInit30 = function(deck) {
    var p = this._zeros();
    p[0] = this._DECK_BYTE[deck - 1];
    p[1] = 0x30;
    p[2] = 0x01;
    p[4] = 0x01;
    var flags = [10, 16, 22, 28, 34, 40, 46, 52];
    for (var i = 0; i < flags.length; i++) { p[flags[i]] = 0xff; }
    this._send(p);
};


// ===== xx 35 — "begin waveform" (3 packets per deck) =======================
PioneerDDJFLX10Screen._sendInit35 = function(deck) {
    var db = this._DECK_BYTE[deck - 1];
    var p1 = this._zeros();
    p1[0] = db;  p1[1] = 0x35;
    this._send(p1);
    for (var i = 0; i < 2; i++) {
        var p = this._zeros();
        p[0] = db;  p[1] = 0x35;  p[2] = 0x0e;  p[3] = 0xe3;
        this._send(p);
    }
};


// ===== xx 39 — pad-mode labels ("HOT CUE"), 3 packets per deck =============
// Hardcoded byte-for-byte from Serato capture; only byte[0] (deck) varies.
PioneerDDJFLX10Screen._XX39_HEX = [
    "10390100030000484f54204355450000000000000000000000000000000000000000000000003f000000000000000000000000000000000000000000000000000000000000023f000000000000000000000000000000000000000000000000000000000000023f00000000000000000000000000000000000000000000000000",
    "1039020003000000000000023f000000000000000000000000000000000000000000000000000000000000023f000000000000000000000000000000000000000000000000000000000000023f000000000000000000000000000000000000000000000000000000000000023f00000000000000000000000000000000000000",
    "1039030003000000000000000000000000023f00000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
];

PioneerDDJFLX10Screen._sendInit39 = function(deck) {
    var db = this._DECK_BYTE[deck - 1];
    for (var s = 0; s < 3; s++) {
        var hex = this._XX39_HEX[s];
        var p = [];
        for (var i = 0; i < 128; i++) {
            p[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        p[0] = db;
        this._send(p);
    }
};


// ===== xx 2f — cue-data placeholder (one empty packet per deck) ============
PioneerDDJFLX10Screen._sendInit2f = function(deck) {
    var p = this._zeros();
    p[0] = this._DECK_BYTE[deck - 1];
    p[1] = 0x2f;
    p[2] = 0x01;
    p[4] = 0x01;
    this._send(p);
};


// ===== xx 33 — album-art JPEG upload =======================================
// Hardcoded 240×240 red JPEG (1529 bytes).  In a future iteration this would
// be replaced with real cover-art bytes per track.
PioneerDDJFLX10Screen._TEST_JPEG_HEX = (
    "ffd8ffe000104a46494600010100000100010000ffdb0043000a07070807060a" +
    "0808080b0a0a0b0e18100e0d0d0e1d15161118231f2524221f2221262b372f26" +
    "293429212230413134393b3e3e3e252e4449433c48373d3e3bffdb0043010a0b" +
    "0b0e0d0e1c10101c3b2822283b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b" +
    "3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3bffc0" +
    "00110800f000f003012200021101031101ffc4001f0000010501010101010100" +
    "000000000000000102030405060708090a0bffc400b510000201030302040305" +
    "0504040000017d01020300041105122131410613516107227114328191a10823" +
    "42b1c11552d1f02433627282090a161718191a25262728292a3435363738393a" +
    "434445464748494a535455565758595a636465666768696a737475767778797a" +
    "838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7" +
    "b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1" +
    "f2f3f4f5f6f7f8f9faffc4001f01000301010101010101010100000000000001" +
    "02030405060708090a0bffc400b5110002010204040304070504040001027700" +
    "0102031104052131061241510761711322328108144291a1b1c109233352f015" +
    "6272d10a162434e125f11718191a262728292a35363738393a43444546474849" +
    "4a535455565758595a636465666768696a737475767778797a82838485868788" +
    "898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4" +
    "c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9" +
    "faffda000c03010002110311003f00e568a28af9d3f660a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a2" +
    "8a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2800a28a2803ffd9");

PioneerDDJFLX10Screen._uploadAlbumArt = function(deck) {
    var hex = this._TEST_JPEG_HEX;
    var db = this._DECK_BYTE[deck - 1];
    var jpegSize = hex.length / 2;
    var SEG1_CAP = 119;
    var SEG_CAP  = 122;
    var totalSegs = (jpegSize <= SEG1_CAP) ? 1
                    : 1 + Math.ceil((jpegSize - SEG1_CAP) / SEG_CAP);

    var hexAt = function(i) { return parseInt(hex.substr(i * 2, 2), 16); };
    var pos = 0;
    for (var seg = 1; seg <= totalSegs; seg++) {
        var p = this._zeros();
        p[0] = db;
        p[1] = 0x33;
        p[2] = seg;
        p[4] = totalSegs;
        if (seg === 1) {
            p[6] = jpegSize & 0xff;
            p[7] = (jpegSize >> 8) & 0xff;
            var take = Math.min(SEG1_CAP, jpegSize - pos);
            for (var j = 0; j < take; j++) { p[9 + j] = hexAt(pos + j); }
            pos += take;
        } else {
            var take2 = Math.min(SEG_CAP, jpegSize - pos);
            for (var k = 0; k < take2; k++) { p[6 + k] = hexAt(pos + k); }
            pos += take2;
        }
        this._send(p);
    }
};


// ===== xx 36 — PWV5 waveform upload ========================================
// Test pattern: bright solid red, max height across the whole track length.
// To swap in real Mixxx waveform data: replace _generateEntries with a function
// that returns LE16 PWV5 bytes derived from the loaded track.
PioneerDDJFLX10Screen._generateEntries = function(durationSec) {
    var n = Math.floor(durationSec * 150);
    var out = [];
    var r = 7, g = 0, b = 0, h = 31;
    var v = (r << 13) | (g << 10) | (b << 7) | (h << 2);
    var lo = v & 0xff;
    var hi = (v >> 8) & 0xff;
    for (var i = 0; i < n; i++) { out.push(lo); out.push(hi); }
    return out;
};

PioneerDDJFLX10Screen._uploadWaveform = function(deck, durationSec) {
    var db = this._DECK_BYTE[deck - 1];
    var entryBytes = this._generateEntries(durationSec);
    var nEntries = entryBytes.length / 2;
    var ENTRIES_PER_PKT = 19;

    var pos = 0;
    while (pos < nEntries) {
        var take = Math.min(ENTRIES_PER_PKT, nEntries - pos);
        var p = this._zeros();
        p[0]  = db;
        p[1]  = 0x36;
        p[2]  = 0x01;     // CONSTANT — not a segment counter
        p[4]  = 0x01;
        p[6]  = 0x13;
        p[10] =  pos        & 0xff;
        p[11] = (pos >> 8)  & 0xff;
        p[12] = (pos >> 16) & 0xff;
        p[13] = (pos >> 24) & 0xff;
        for (var j = 0; j < take * 2; j++) {
            p[14 + j] = entryBytes[pos * 2 + j];
        }
        this._send(p);
        pos += take;
    }
};


// ===== Track-load handler ===================================================
PioneerDDJFLX10Screen._onTrackLoad = function(deck) {
    var group = "[Channel" + deck + "]";
    // DIAGNOSTIC: log all candidate COs so we can figure out which one
    // matches what Mixxx's UI timer displays. The user reports a constant
    // 14-20s offset between our (playposition × duration) calc and what
    // Mixxx UI shows — possibly intro/outro marker driven.
    var duration = engine.getValue(group, "duration");
    var pos      = engine.getValue(group, "playposition");
    var cue      = engine.getValue(group, "cue_point");
    var samples  = engine.getValue(group, "track_samples");
    var sr       = engine.getValue(group, "track_samplerate");
    var intro_s  = engine.getValue(group, "intro_start_position");
    var intro_e  = engine.getValue(group, "intro_end_position");
    var outro_s  = engine.getValue(group, "outro_start_position");
    var outro_e  = engine.getValue(group, "outro_end_position");
    console.log("FLX10 screen: track loaded on deck " + deck +
                " | duration=" + duration + " pos=" + pos +
                " cue_point=" + cue + " samples=" + samples + " sr=" + sr +
                " intro_s=" + intro_s + " intro_e=" + intro_e +
                " outro_s=" + outro_s + " outro_e=" + outro_e);
    // Daemon handles xx 30/35/39/33/2f init + xx 36 wave upload.
    // screen.js's only HID job is the xx 27 state ping.
};


// ===== Lifecycle ============================================================
PioneerDDJFLX10Screen.init = function(id) {
    console.log("FLX10 screen v2.0 (xx 27 only, daemon handles wave): init");

    // Mixxx 2.7-alpha gives us engine.getPlayer() returning a JavascriptPlayerProxy
    // with: artist, title, album, key (Camelot text like "3B (D♭)"), genre, year, etc.
    // plus per-property change signals (keyChanged, titleChanged, etc).
    // NOT exposed: file path / samples / fileBpm / duration / trackLoaded signal.
    // So daemon's log-tail + SQL-by-samples-and-bpm still needed for waveform.
    // We can use player.key for Camelot display once we crack the FLX10 key bytes.
    PioneerDDJFLX10Screen._hasPlayerProxy = (typeof engine.getPlayer === "function");
    if (this._hasPlayerProxy) {
        console.log("FLX10 screen: engine.getPlayer available (Mixxx 2.7-alpha+)");
    }

    // State timer — dispatch based on _SCREEN_MODE.
    var modeFn;
    if (this._SCREEN_MODE === 'vdj') {
        modeFn = function() { PioneerDDJFLX10Screen._sendVDJState(); };
        console.log("FLX10 screen: VDJ mode (xx 21, no heartbeat)");
    } else if (this._SCREEN_MODE === 'rekordbox') {
        modeFn = function() { PioneerDDJFLX10Screen._sendRekordboxState(); };
        console.log("FLX10 screen: REKORDBOX mode (xx 21 + xx 3D heartbeat)");
    } else {
        modeFn = function() { PioneerDDJFLX10Screen._sendStateAllDecks(); };
        console.log("FLX10 screen: SERATO mode (xx 27)");
    }
    this._stateTimer = engine.beginTimer(this._STATE_MS, modeFn, false);

    // Track-load detection only — xx 27 updates come from the timer above
    // (NOT event-driven, because Mixxx throttles makeConnection callbacks
    // on playposition).
    for (var dd = 1; dd <= 4; dd++) {
        (function(deck) {
            engine.makeConnection(
                "[Channel" + deck + "]",
                "duration",
                function(value) {
                    if (value > 0 && value !== PioneerDDJFLX10Screen._lastDuration[deck]) {
                        PioneerDDJFLX10Screen._lastDuration[deck] = value;
                        var bpm = engine.getValue("[Channel" + deck + "]", "bpm");
                        if (bpm > 0) { PioneerDDJFLX10Screen._deckBpm[deck] = bpm; }
                        PioneerDDJFLX10Screen._onTrackLoad(deck);
                    }
                }
            );
        })(dd);
    }
};

PioneerDDJFLX10Screen.shutdown = function() {
    console.log("FLX10 screen: shutdown");
    if (this._stateTimer !== null) {
        engine.stopTimer(this._stateTimer);
        this._stateTimer = null;
    }
};

// ACK packets (xx D8 ...) arrive on EP4 IN; we don't need to act on them.
PioneerDDJFLX10Screen.incomingData = function(data, length) {
    // Log first 16 bytes — looking for jog-mode button events from FLX10.
    try {
        var hex = '';
        var n = Math.min(length, 16);
        for (var i = 0; i < n; i++) {
            var b = data[i] || 0;
            hex += (b < 16 ? '0' : '') + b.toString(16) + ' ';
        }
        console.log("FLX10_HID_IN len=" + length + " bytes=" + hex);
    } catch (e) {}
};
