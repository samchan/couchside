// Game-show music made on the fly with WebAudio: no audio files, nothing copyrighted.
// A new upbeat loop (random key, tempo and riff) for every question, ticks for the
// last seconds, a drumroll + fanfare on each reveal, and a bigger fanfare for the winner.
// Browsers only allow sound after a tap, so the TV shows a "Tap for sound" button.
const Sound = (() => {
  let ctx = null, master = null, on = false, loop = null, nextAt = 0, step = 0, pat = null;
  try { on = localStorage.getItem('ap_sound') === '1'; } catch {}
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
  const ratio = (semi) => Math.pow(2, semi / 12);

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  function tone(freq, t, dur, type, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  let noiseBuf = null;
  function noise(t, dur, vol, hp) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = 'highpass'; f.frequency.value = hp || 7000;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
  }
  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.25);
  }
  function newPattern() {
    const riff = () => Array.from({ length: 16 }, (_, i) => (i % 2 === 0 || Math.random() < 0.35 ? pick(PENTA.slice(0, 6)) : null));
    pat = {
      root: pick([196, 220, 233, 262, 294]),
      bpm: pick([116, 122, 128, 134]),
      bass: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 0 : i % 4 === 2 ? pick([0, 7, 12]) : null)),
      lead: riff(),
      clap: Math.random() < 0.6,
    };
  }
  function schedule() {
    const sixteenth = 60 / pat.bpm / 4;
    while (nextAt < ctx.currentTime + 0.2) {
      const t = nextAt, s = step % 16, bar = Math.floor(step / 16) % 4;
      if (s % 4 === 0) kick(t);
      if (s % 2 === 1) noise(t, 0.035, 0.12);
      if (pat.clap && (s === 4 || s === 12)) noise(t, 0.12, 0.25, 1500);
      if (pat.bass[s] != null) tone((pat.root / 2) * ratio(pat.bass[s] + (bar === 3 ? 5 : 0)), t, sixteenth * 1.8, 'triangle', 0.4);
      if (pat.lead[s] != null) tone(pat.root * 2 * ratio(pat.lead[s] + (bar === 3 ? 5 : 0)), t, sixteenth * 0.9, 'square', 0.05);
      nextAt += sixteenth; step++;
    }
  }
  function startLoop() {
    stopLoop();
    if (!on || !ensure()) return;
    newPattern(); step = 0; nextAt = ctx.currentTime + 0.05;
    loop = setInterval(schedule, 40);
  }
  function stopLoop() { if (loop) { clearInterval(loop); loop = null; } }
  function tick(urgent) {
    if (!on || !ensure()) return;
    tone(urgent ? 1568 : 1046, ctx.currentTime, 0.09, 'square', 0.12);
  }
  function reveal() {
    stopLoop();
    if (!on || !ensure()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 18; i++) noise(t + i * 0.045, 0.06, 0.08 + i * 0.012, 2500); // drumroll
    kick(t + 0.85);
    [523, 659, 784, 1047].forEach((f, i) => tone(f, t + 0.85 + i * 0.09, 0.4, 'square', 0.1));
    tone(1047, t + 1.25, 0.6, 'triangle', 0.2);
  }
  function pop() {
    if (!on || !ensure()) return;
    const t = ctx.currentTime;
    tone(660, t, 0.12, 'square', 0.12); tone(990, t + 0.07, 0.18, 'square', 0.1);
  }
  function drumroll(sec) {
    stopLoop();
    if (!on || !ensure()) return;
    const t = ctx.currentTime, n = Math.floor((sec || 2.4) / 0.045);
    for (let i = 0; i < n; i++) noise(t + i * 0.045, 0.06, 0.06 + (i / n) * 0.22, 2500);
  }
  function fanfare() {
    if (!on || !ensure()) return;
    const t = ctx.currentTime;
    kick(t);
    [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.4, 'square', 0.1));
    tone(1047, t + 0.4, 0.7, 'triangle', 0.2);
  }
  function winner() {
    stopLoop();
    if (!on || !ensure()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 30; i++) noise(t + i * 0.045, 0.06, 0.06 + i * 0.01, 2500);
    const notes = [523, 659, 784, 1047, 784, 1047, 1319, 1568];
    notes.forEach((f, i) => { tone(f, t + 1.4 + i * 0.13, 0.35, 'square', 0.1); if (i % 2 === 0) kick(t + 1.4 + i * 0.13); });
    [523, 659, 784].forEach((f) => tone(f, t + 2.5, 1.6, 'triangle', 0.18));
  }
  function toggle() {
    if (on && !isOn()) { ensure(); return; } // remembered "on", just needed a tap to unlock
    on = !on;
    try { localStorage.setItem('ap_sound', on ? '1' : '0'); } catch {}
    if (on) { ensure(); tone(880, ctx.currentTime, 0.12, 'square', 0.1); } else stopLoop();
  }
  // a sound preference from last time still needs a tap to unlock audio
  const isOn = () => on && !!ctx && ctx.state === 'running';
  return { startLoop, stopLoop, tick, reveal, pop, drumroll, fanfare, winner, toggle, isOn };
})();
