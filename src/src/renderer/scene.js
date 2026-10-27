'use strict';

// The living valley behind the launcher: its sky follows the time of day in
// Toon Valley right now (the game's clock is Pacific time), the sun and
// moon cross it as they do in the game, and the season adds its touches.
// Everything that moves is a CSS animation of transforms and opacity (the
// compositor's work, not the page's), and it all stops while the game is
// running or the launcher is out of sight.
(function scene() {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const windowEl = $('window');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The game's times of day (toontown/graphics/LightingPresets.py): at
  // each hour the sky is these colours; between two, it blends.
  const SKY = [
    [0.0, '#0a1130', '#1c2754', 0.42],
    [5.0, '#0a1130', '#1c2754', 0.42],
    [6.2, '#3c4d8e', '#f3a27c', 0.7],
    [8.0, '#4b8de0', '#bfe3ff', 0.95],
    [12.5, '#3d84f0', '#a8dbff', 1.0],
    [16.5, '#4a86dc', '#cde5ff', 1.0],
    [18.6, '#5a6dbf', '#ffc075', 0.86],
    [19.6, '#2b2e6d', '#e26d6f', 0.62],
    [20.6, '#0a1130', '#1c2754', 0.42],
    [24.0, '#0a1130', '#1c2754', 0.42],
  ];
  const SUN_RISE = 6.0;
  const SUN_SET = 20.0;
  const MOON_RISE = 19.0;
  const MOON_SET = 6.5;

  function hex(color) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    const x = hex(a);
    const y = hex(b);
    return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(', ')})`;
  }

  // The time in Toon Valley: the game's server clock is Pacific time.
  function valleyTime(now = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', month: 'numeric', day: 'numeric', hourCycle: 'h23',
      }).formatToParts(now);
      const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
      return { hour: get('hour') + get('minute') / 60, month: get('month'), day: get('day') };
    } catch {
      return { hour: now.getHours() + now.getMinutes() / 60, month: now.getMonth() + 1, day: now.getDate() };
    }
  }

  function nightness(hour) {
    if (hour >= 7 && hour <= 19) return 0;
    if (hour >= 20.6 || hour <= 5) return 1;
    const t = hour > 12 ? (hour - 19) / 1.6 : (7 - hour) / 2;
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
  }

  // Along an arc across the sky, t from 0 (rising, left) to 1 (setting).
  function placeOnArc(el, t, height) {
    if (t < 0 || t > 1) {
      el.style.opacity = '0';
      return;
    }
    const x = 6 + t * 82;
    const y = 58 - Math.sin(Math.PI * t) * height;
    el.style.opacity = '1';
    el.style.transform = `translate(${x}vw, ${y}vh)`;
  }

  function paintSky() {
    const { hour } = valleyTime();
    let top = SKY[0][1];
    let bottom = SKY[0][2];
    let light = SKY[0][3];
    for (let i = 0; i < SKY.length - 1; i += 1) {
      const [h0, t0, b0, l0] = SKY[i];
      const [h1, t1, b1, l1] = SKY[i + 1];
      if (hour >= h0 && hour <= h1) {
        const raw = h1 === h0 ? 0 : (hour - h0) / (h1 - h0);
        const t = raw * raw * (3 - 2 * raw);
        top = mix(t0, t1, t);
        bottom = mix(b0, b1, t);
        light = l0 + (l1 - l0) * t;
        break;
      }
    }
    const night = nightness(hour);
    root.style.setProperty('--sky-top', top);
    root.style.setProperty('--sky-bottom', bottom);
    root.style.setProperty('--land-light', light.toFixed(3));
    root.style.setProperty('--night', night.toFixed(3));
    placeOnArc($('sun'), (hour - SUN_RISE) / (SUN_SET - SUN_RISE), 46);
    const moonHours = ((hour - MOON_RISE) % 24 + 24) % 24;
    placeOnArc($('moon'), moonHours / ((MOON_SET - MOON_RISE + 24) % 24), 40);
    windowEl.classList.toggle('is-night', night > 0.5);
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    const ampm = h < 12 ? 'AM' : 'PM';
    $('valley-clock').textContent = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm} in Toon Valley`;
  }

  // The season's touches: pumpkins in October, snow in December, and
  // the odd gag drifting by the rest of the year.
  function season() {
    const { month } = valleyTime();
    if (month === 10) return { name: 'halloween', images: ['pumpkin'], count: 9 };
    if (month === 12 || month === 1) return { name: 'winter', images: ['snowflake'], count: 22 };
    return { name: 'gags', images: ['gag-pie', 'gag-horn', 'gag-flower', 'gag-cake', 'gag-feather', 'gag-banana', 'gag-magnet', 'gag-anvil'], count: 7 };
  }

  function fillSeason() {
    const current = season();
    const holder = $('season');
    holder.replaceChildren();
    windowEl.dataset.season = current.name;
    for (let i = 0; i < current.count; i += 1) {
      const img = document.createElement('img');
      img.src = `images/tv/${current.images[i % current.images.length]}.png`;
      img.alt = '';
      img.draggable = false;
      img.className = 'drifter';
      // Spread out evenly, each at its own pace.
      img.style.left = `${(i + 0.5) * (100 / current.count) + (Math.random() * 6 - 3)}%`;
      img.style.setProperty('--size', `${current.name === 'winter' ? 14 + Math.random() * 16 : 30 + Math.random() * 22}px`);
      img.style.setProperty('--duration', `${(current.name === 'winter' ? 14 : 34) + Math.random() * 18}s`);
      img.style.setProperty('--delay', `${-Math.random() * 40}s`);
      img.style.setProperty('--sway', `${Math.random() * 40 - 20}px`);
      holder.append(img);
    }
  }

  // The mouse moves the layers a little, nearer ones more.
  let pointer = null;
  let parallaxQueued = false;
  function parallax() {
    parallaxQueued = false;
    if (!pointer || windowEl.classList.contains('paused')) return;
    const { x, y } = pointer;
    document.querySelectorAll('[data-depth]').forEach((layer) => {
      const depth = Number(layer.dataset.depth);
      layer.style.translate = `${(-x * 14 * depth).toFixed(1)}px ${(-y * 8 * depth).toFixed(1)}px`;
    });
  }
  if (!reduceMotion) {
    window.addEventListener('mousemove', (event) => {
      pointer = { x: event.clientX / window.innerWidth - 0.5, y: event.clientY / window.innerHeight - 0.5 };
      if (!parallaxQueued) {
        parallaxQueued = true;
        requestAnimationFrame(parallax);
      }
    }, { passive: true });
  }

  // Confetti, for the big moments: logged in, updated, off to play.
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  const COLORS = ['#ffd23a', '#e43c32', '#2f6fe6', '#3fbf3a', '#ff7ac8', '#ff9a2e', '#9a5cff'];
  let pieces = [];
  let confettiFrame = null;
  function confetti(originX = 0.5, originY = 0.62, count = 90) {
    if (reduceMotion || windowEl.classList.contains('paused')) return;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const speed = 6 + Math.random() * 9;
      pieces.push({
        x: canvas.width * originX, y: canvas.height * originY,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
        spin: Math.random() * Math.PI, vspin: (Math.random() - 0.5) * 0.4,
        color: COLORS[i % COLORS.length], life: 1,
      });
    }
    if (!confettiFrame) confettiFrame = requestAnimationFrame(drawConfetti);
  }
  function drawConfetti() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces = pieces.filter((p) => p.life > 0 && p.y < canvas.height + 20);
    for (const p of pieces) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += p.vspin;
      p.life -= 0.006;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.spin * 2)));
      ctx.restore();
    }
    confettiFrame = pieces.length ? requestAnimationFrame(drawConfetti) : null;
    if (!confettiFrame) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // The game's own interface sounds, quietly.
  const SOUNDS = {
    hover: 'sounds/GUI_rollover.ogg',
    click: 'sounds/GUI_create_toon_fwd.ogg',
    back: 'sounds/GUI_create_toon_back.ogg',
    pop: 'sounds/GUI_balloon_popup.ogg',
    bell: 'sounds/SZ_trolley_bell.ogg',
  };
  const audio = {};
  let soundOn = true;
  try {
    soundOn = localStorage.getItem('tv-sound') !== 'off';
  } catch {
    // Storage can be unavailable; sounds stay on.
  }
  function sound(name, volume = 0.3) {
    if (!soundOn || !SOUNDS[name]) return;
    if (!audio[name]) audio[name] = new Audio(SOUNDS[name]);
    const clip = audio[name];
    clip.volume = volume;
    clip.currentTime = 0;
    clip.play().catch(() => {});
  }
  function showSoundButton() {
    const button = $('toggle-sound');
    button.setAttribute('aria-pressed', String(soundOn));
    button.title = soundOn ? 'Sound effects on' : 'Sound effects off';
    button.classList.toggle('muted', !soundOn);
  }
  $('toggle-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    try {
      localStorage.setItem('tv-sound', soundOn ? 'on' : 'off');
    } catch {
      // Not remembered, but still switched.
    }
    showSoundButton();
    sound('click');
  });
  showSoundButton();
  // Buttons say so when the mouse comes over them (not too often).
  let lastHover = 0;
  document.addEventListener('mouseover', (event) => {
    const button = event.target.closest('button:not(:disabled)');
    if (!button || button.contains(event.relatedTarget)) return;
    const now = performance.now();
    if (now - lastHover > 90) {
      lastHover = now;
      sound('hover', 0.18);
    }
  });

  // The trolley rides its track: state 'idle', 'busy', 'ready', 'error' or
  // 'progress' with a percentage.
  function trolley(state, percent) {
    const track = $('progress');
    track.dataset.state = state;
    const p = state === 'progress' ? Math.max(0, Math.min(100, percent || 0)) : (state === 'ready' ? 100 : 0);
    track.style.setProperty('--progress', `${p}%`);
    track.setAttribute('aria-valuenow', String(Math.round(p)));
  }

  // Nothing moves while the game is running, or the launcher can't be
  // seen: the game gets the computer to itself.
  let gameRunning = false;
  function updatePaused() {
    windowEl.classList.toggle('paused', gameRunning || document.hidden || reduceMotion);
  }
  document.addEventListener('visibilitychange', updatePaused);

  paintSky();
  fillSeason();
  updatePaused();
  // Every minute, the sky moves on with the clock.
  setInterval(() => {
    if (!document.hidden) paintSky();
  }, 60 * 1000);

  window.scene = {
    confetti,
    sound,
    trolley,
    setGameRunning(running) {
      gameRunning = running;
      updatePaused();
    },
    valleyTime,
  };
}());
