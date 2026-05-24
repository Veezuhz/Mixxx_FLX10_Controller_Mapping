// PioneerDDJFLX10-screen.js  v1.0 (Serato protocol, byte-perfect)
// HID jog wheel screen module for the DDJ-FLX10.  Loaded by
// PioneerDDJFLX10-screen.hid.xml as a separate HID controller mapping.
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
PioneerDDJFLX10Screen._STATE_MS      = 100;    // 10 Hz xx 27 timer.
                                               // BPM/position update each tick (real-time).
                                               // Time bytes refresh from cache every
                                               // _TIME_REFRESH_MS via _getCachedTimeBytes.
PioneerDDJFLX10Screen._TIME_REFRESH_MS = 1000; // 1 Hz re-seed of firmware's time counter.
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

// ===== xx 27 — per-deck state ping (sent at 50 Hz to all 4 decks) ===========
// Reads pos / duration / BPM directly from Mixxx COs each tick — no log-tail
// lag (which was the source of the 5-20s timer drift in the daemon-only
// architecture). Verified protocol byte layout (cracked 2026-05-23):
//   [5..7]  BE24 = elapsed × 128 (playhead marker position)
//   [9..12] = remaining MM:SS:ms (firmware also uses these as the "loaded"
//             gate — if all zero, wave display drops)
//   [13]    = BPM integer
//   [14]    high nibble = BPM decimal tenths (low nibble unused)
PioneerDDJFLX10Screen._POS_RATE = 128.0;

PioneerDDJFLX10Screen._buildState = function(deckByte, trackLoaded) {
    var p = this._zeros();
    p[0]  = deckByte;
    p[1]  = 0x27;
    p[2]  = 0xb4;
    p[3]  = 0x80;
    p[4]  = 0x01;
    p[20] = 0x0e;
    p[25] = 0x80;
    p[30] = 0x0d;
    p[31] = this._STATE_BYTE_31[deckByte];
    // Trailer e0 01 00 verified from steady-playback Serato capture
    // (NOT ff ff ff which was from paused-state captures).
    p[32] = 0xe0;
    p[33] = 0x01;
    p[34] = 0x00;
    if (trackLoaded) {
        var deckNum = this._deckFromDeckByte(deckByte);
        var group   = "[Channel" + deckNum + "]";
        var pos      = engine.getValue(group, "playposition");
        var duration = engine.getValue(group, "duration");
        var fileBpm  = engine.getValue(group, "file_bpm");
        var rateRatio = engine.getValue(group, "rate_ratio");
        var liveBpm  = fileBpm * rateRatio;

        // Static loaded markers (verified from Serato capture)
        p[29] = 0x92;

        // Time bytes: [9]=min, [10]=sec, [11,12] LE16=ms (REAL REMAINING,
        // recomputed each tick). When position bytes [5..7] are ZERO,
        // firmware uses these directly — display matches Mixxx exactly.
        // (When position bytes are non-zero, firmware uses its own counter
        // derived from position, and time drifts. That's the trade-off:
        // accurate time OR scrolling wave, not both.)
        if (duration > 0) {
            var pClamped = pos;
            if (pClamped < 0.0) pClamped = 0.0;
            if (pClamped > 1.0) pClamped = 1.0;
            // Subtract fixed offset to match Mixxx UI's audio-latency-adjusted time
            var remainingSec = duration * (1.0 - pClamped) - this._TIME_OFFSET_SEC;
            if (remainingSec < 0) remainingSec = 0;
            var totalMs = Math.round(remainingSec * 1000);
            var minutes = Math.floor(totalMs / 60000);
            var remMs   = totalMs % 60000;
            var seconds = Math.floor(remMs / 1000);
            var ms      = remMs % 1000;
            p[9]  = minutes & 0xFF;
            p[10] = seconds & 0xFF;
            p[11] = ms & 0xFF;
            p[12] = (ms >> 8) & 0xFF;
        } else {
            p[9]  = 0x06;  p[10] = 0x1b;  p[11] = 0xfa;  p[12] = 0x01;
        }

        // BPM integer + decimal tenths nibble (same reason as time —
        // sending zero bytes makes the FLX10 BPM field blank).
        if (liveBpm > 0) {
            p[13] = Math.floor(liveBpm) & 0xFF;
            var frac = liveBpm - Math.floor(liveBpm);
            p[14] = (Math.round(frac * 10) & 0x0F) << 4;
        }

        // Position bytes ZERO — REQUIRED for accurate time display.
        // The firmware uses [5..7] for both wave-scroll AND time computation.
        // When non-zero, time drifts (firmware derives time from position
        // via a non-1x rate we haven't decoded). User priority is exact
        // time, so we leave these zero. Wave shape still renders (daemon's
        // xx 36 upload), just doesn't scroll.
        p[5] = 0; p[6] = 0; p[7] = 0;
    } else {
        p[29] = 0x80;
    }
    return p;
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
        // also wastes USB bandwidth/JS time. Daemon's old StatePingThread
        // had the same skip logic; we kept missing it in screen.js until
        // the perceived lag forced a closer look.
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

    // We no longer prime xx 30 / xx 39 here — the daemon does that.
    // Just start the 50 Hz xx 27 state ping (the only HID work this module
    // does in the new architecture).
    this._stateTimer = engine.beginTimer(
        this._STATE_MS,
        function() { PioneerDDJFLX10Screen._sendStateAllDecks(); },
        false
    );

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
PioneerDDJFLX10Screen.incomingData = function(data, length) {};
