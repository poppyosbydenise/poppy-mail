/* Denise Mail sounds: everything is synthesized in your browser with the Web Audio API.
   No audio files, no network. Sounds only play after you click something. */
window.DMSound = (function () {
  'use strict';
  var ctx = null, master = null, enabled = true, dialNodes = [];
  function ac() {
    if (!enabled) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      try { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.2; master.connect(ctx.destination); } catch (e) { ctx = null; return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }
  function tone(freq, start, dur, type, vol, to) {
    var a = ac(); if (!a) return null;
    var t = a.currentTime + start, o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.4, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function noise(start, dur, vol, lo, hi) {
    var a = ac(); if (!a) return;
    var t = a.currentTime + start, n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = (lo + hi) / 2; f.Q.value = 0.6;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master); src.start(t);
    dialNodes.push(src);
  }
  var ROW = [697, 770, 852, 941], COL = [1209, 1336, 1477];
  function dial(totalSeconds) {
    var a = ac(); if (!a) return;
    stopDial();
    var digits = [5, 5, 5, 0, 1, 9, 9], t = 0.15;
    digits.forEach(function (d) {
      var r = d === 0 ? 3 : Math.floor((d - 1) / 3), c = d === 0 ? 1 : (d - 1) % 3;
      dialNodes.push(tone(ROW[r], t, 0.09, 'sine', 0.22), tone(COL[c], t, 0.09, 'sine', 0.22)); t += 0.15;
    });
    t += 0.5;
    var steps = [2100, 1300, 2250, 980, 1650, 2400, 1100, 1800, 2100, 1500, 2300, 1200];
    var span = Math.max(1, (totalSeconds || 4) - t - 0.3), seg = span / steps.length;
    steps.forEach(function (f, i) { dialNodes.push(tone(f, t + i * seg, seg * 1.05, 'sawtooth', 0.09, f * (i % 2 ? 0.8 : 1.25))); });
    noise(t, span, 0.18, 800, 3500);
  }
  function stopDial() { dialNodes.forEach(function (n) { try { n && n.stop(); } catch (e) {} }); dialNodes = []; }
  var jTimer = null;
  function jingle(on) {
    if (jTimer) { clearInterval(jTimer); jTimer = null; }
    if (!on || !ac()) return false;
    var scale = [523, 587, 659, 784, 880, 1047, 880, 784, 659, 587, 523, 784], i = 0;
    jTimer = setInterval(function () { tone(scale[i % scale.length], 0, 0.2, 'triangle', 0.12); if (i % 4 === 0) tone(scale[(i + 3) % scale.length] / 2, 0, 0.4, 'sine', 0.08); i++; }, 240);
    return true;
  }
  return {
    jingle: jingle, isJingle: function () { return !!jTimer; },
    setEnabled: function (v) { enabled = !!v; if (!enabled) { stopDial(); jingle(false); } },
    isEnabled: function () { return enabled; },
    dial: dial, stopDial: stopDial,
    unlock: function () { ac(); },
    welcome: function () { tone(523, 0, 0.18, 'triangle', 0.3); tone(659, 0.16, 0.18, 'triangle', 0.3); tone(784, 0.32, 0.4, 'triangle', 0.3); },
    newMail: function () { tone(784, 0, 0.16, 'sine', 0.35); tone(1047, 0.14, 0.5, 'sine', 0.35); tone(1568, 0.14, 0.4, 'sine', 0.1); },
    sent: function () { tone(500, 0, 0.18, 'sine', 0.3, 1500); tone(1500, 0.14, 0.1, 'sine', 0.15); },
    error: function () { tone(220, 0, 0.25, 'sawtooth', 0.25, 120); tone(150, 0.2, 0.3, 'sawtooth', 0.2, 90); },
    click: function () { tone(900, 0, 0.04, 'square', 0.08); },
    trash: function () { tone(400, 0, 0.12, 'triangle', 0.25, 120); noise(0, 0.12, 0.12, 300, 1200); }
  };
})();
