(function () {
  const startBtn = document.getElementById('startArBtn');
  const stopBtn = document.getElementById('stopCameraBtn');
  const switchBtn = document.getElementById('switchCameraBtn');
  const video = document.getElementById('cameraFeed');
  const overlay = document.getElementById('arOverlay');
  const backdrop = document.getElementById('arBackdrop');
  const tempValue = document.getElementById('tempValue');
  const humidityValue = document.getElementById('humidityValue');
  const weatherMessage = document.getElementById('weatherMessage');
  const cachedBadge = document.getElementById('cachedBadge');
  const approxBadge = document.getElementById('approxBadge');
  const statusBanner = document.getElementById('statusBanner');
  const debugText = document.getElementById('debugText');
  const canvas = document.getElementById('arCanvas');

  let stream = null;
  let currentFacingMode = 'environment';
  let arOpen = false;
  let starting = false;
  let running = false;
  let rafId = null;

  let rotation = 0.4;
  let scale = 1.0;
  let isDragging = false;
  let lastX = 0;
  let activePointers = new Map();
  let initialPinchDistance = null;
  let initialScale = 1.0;

  const CACHE_KEY = 'weather-cache-v2';
  const ctx = canvas.getContext('2d');

  function debug(msg) {
    console.log('[DEBUG]', msg);
    if (debugText) debugText.textContent = msg;
  }

  function setStatus(text) {
    statusBanner.textContent = text;
    debug(`STATUS: ${text}`);
  }

  function resetWeatherUI() {
    tempValue.textContent = '--';
    humidityValue.textContent = 'Humidity --';
    weatherMessage.classList.add('hidden');
    cachedBadge.classList.add('hidden');
    approxBadge.classList.add('hidden');
  }

  function getUnit() {
    return localStorage.getItem('temperature-unit') || 'C';
  }

  function formatTemp(c) {
    const unit = getUnit();
    if (unit === 'F') return `${Math.round((c * 9 / 5) + 32)}°F`;
    return `${Math.round(c)}°C`;
  }

  function saveCache(payload) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...payload, ts: Date.now() }));
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts <= 30 * 60 * 1000) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  function renderWeather(result) {
    cachedBadge.classList.toggle('hidden', !result.cached);
    approxBadge.classList.toggle('hidden', !result.approximate);

    if (result.ok && result.data) {
      weatherMessage.classList.add('hidden');
      tempValue.textContent = result.data.temperatureDisplay;
      humidityValue.textContent = `Humidity ${result.data.humidity}%`;
      setStatus('AR active');
    } else {
      tempValue.textContent = '--';
      humidityValue.textContent = 'Humidity --';
      weatherMessage.textContent = 'Weather data temporarily unavailable';
      weatherMessage.classList.remove('hidden');
      setStatus('Camera active · Weather unavailable');
    }
  }

  function supportsMediaDevices() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function isSecureEnough() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  async function requestStream(facingMode) {
    if (!supportsMediaDevices()) {
      throw new Error('Camera API not supported in this browser');
    }

    if (!isSecureEnough()) {
      throw new Error('Camera requires HTTPS / secure context');
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (err) {
      debug(`Primary camera request failed, using fallback: ${err.message}`);
      return navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    }
  }

  async function startCamera() {
    if (stream) {
      video.srcObject = stream;
      await video.play();
      return stream;
    }

    stream = await requestStream(currentFacingMode);
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    await video.play();
    return stream;
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    video.pause();
    video.srcObject = null;
  }

  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    await startCamera();
  }

  function hasActiveStream() {
    return !!stream;
  }

  function getLocation(highAccuracy) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation unavailable'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos.coords),
        reject,
        {
          enableHighAccuracy: highAccuracy,
          timeout: 5000,
          maximumAge: 0
        }
      );
    });
  }

  async function getBestLocation() {
    const high = await getLocation(true).catch(() => null);

    if (high && typeof high.accuracy === 'number' && high.accuracy <= 50) {
      return {
        lat: high.latitude,
        lon: high.longitude,
        approximate: false,
        accuracy: high.accuracy
      };
    }

    const low = await getLocation(false).catch(() => null);

    if (low) {
      return {
        lat: low.latitude,
        lon: low.longitude,
        approximate: true,
        accuracy: low.accuracy ?? null
      };
    }

    throw new Error('Location unavailable');
  }

  async function requestWeather(lat, lon) {
    const res = await fetch(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  function normalizeWeather(data) {
    return {
      temperatureC: data.temperatureC,
      temperatureDisplay: formatTemp(data.temperatureC),
      humidity: data.humidity
    };
  }

  async function fetchWeatherWithFallbacks(loc) {
    try {
      const live = await requestWeather(loc.lat, loc.lon);
      const normalized = normalizeWeather(live);
      saveCache(normalized);

      return {
        ok: true,
        data: normalized,
        cached: false,
        approximate: !!loc.approximate
      };
    } catch (e) {
      if (e.status === 429) {
        await new Promise(r => setTimeout(r, 1000));

        try {
          const retry = await requestWeather(loc.lat, loc.lon);
          const normalized = normalizeWeather(retry);
          saveCache(normalized);

          return {
            ok: true,
            data: normalized,
            cached: false,
            approximate: !!loc.approximate
          };
        } catch {
          const cache = loadCache();
          if (cache) {
            return {
              ok: true,
              data: cache,
              cached: true,
              approximate: !!loc.approximate
            };
          }

          return { ok: false, cached: false, approximate: !!loc.approximate };
        }
      }

      const cache = loadCache();
      if (cache) {
        return {
          ok: true,
          data: cache,
          cached: true,
          approximate: !!loc.approximate
        };
      }

      return { ok: false, cached: false, approximate: !!loc.approximate };
    }
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawCube(cx, cy, size, rot) {
    const points = [
      [-1, -1, -1],[1, -1, -1],[1, 1, -1],[-1, 1, -1],
      [-1, -1, 1],[1, -1, 1],[1, 1, 1],[-1, 1, 1]
    ];

    const edges = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7]
    ];

    const projected = points.map(([x, y, z]) => {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const rx = x * cos - z * sin;
      const rz = x * sin + z * cos;
      const perspective = 220 / (rz + 4);
      return {
        x: cx + rx * size * perspective * 0.45,
        y: cy + y * size * perspective * 0.45
      };
    });

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();

    for (const [a, b] of edges) {
      ctx.moveTo(projected[a].x, projected[a].y);
      ctx.lineTo(projected[b].x, projected[b].y);
    }

    ctx.stroke();

    ctx.fillStyle = 'rgba(59,130,246,0.12)';
    ctx.beginPath();
    ctx.moveTo(projected[4].x, projected[4].y);
    ctx.lineTo(projected[5].x, projected[5].y);
    ctx.lineTo(projected[6].x, projected[6].y);
    ctx.lineTo(projected[7].x, projected[7].y);
    ctx.closePath();
    ctx.fill();
  }

  function renderAR() {
    if (!running) return;

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2 + 6;
    const size = Math.min(w, h) * 0.78 * scale;

    drawCube(cx, cy, size, rotation);

    rafId = requestAnimationFrame(renderAR);
  }

  function startAR() {
    resizeCanvas();
    running = true;
    renderAR();
  }

  function stopAR() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  function getDistance(p1, p2) {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  function openOverlay() {
    overlay.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    arOpen = true;
    startAR();
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
    backdrop.classList.add('hidden');
    arOpen = false;
    stopAR();
    debug('Overlay closed');
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      isDragging = true;
      lastX = e.clientX;
    }

    if (activePointers.size === 2) {
      const pts = [...activePointers.values()];
      initialPinchDistance = getDistance(pts[0], pts[1]);
      initialScale = scale;
      isDragging = false;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1 && isDragging) {
      const dx = e.clientX - lastX;
      rotation += dx * 0.01;
      lastX = e.clientX;
    }

    if (activePointers.size === 2 && initialPinchDistance) {
      const pts = [...activePointers.values()];
      const currentDistance = getDistance(pts[0], pts[1]);
      const ratio = currentDistance / initialPinchDistance;
      scale = Math.min(1.8, Math.max(0.55, initialScale * ratio));
    }
  });

  function endPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) initialPinchDistance = null;
    if (activePointers.size === 0) isDragging = false;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  window.addEventListener('resize', resizeCanvas);

  async function handleStartAR() {
    if (starting) {
      debug('Start blocked: already starting');
      return;
    }

    starting = true;

    try {
      debug('Start AR clicked');
      setStatus('Opening camera...');
      resetWeatherUI();

      debug(`Secure context: ${window.isSecureContext}`);
      debug(`mediaDevices exists: ${!!navigator.mediaDevices}`);
      debug(`getUserMedia exists: ${!!navigator.mediaDevices?.getUserMedia}`);
      debug(`geolocation exists: ${!!navigator.geolocation}`);

      await startCamera();
      debug('Camera started successfully');

      openOverlay();
      setStatus('Camera active · Getting location...');

      try {
        const loc = await getBestLocation();
        debug(`Location received: lat=${loc.lat}, lon=${loc.lon}, approximate=${loc.approximate}`);
        setStatus('Camera active · Loading weather...');
        const weather = await fetchWeatherWithFallbacks(loc);
        renderWeather(weather);
      } catch (locErr) {
        debug(`Location/weather failed: ${locErr?.message || locErr}`);
        renderWeather({ ok: false, cached: false, approximate: false });
        setStatus('Camera active · Location unavailable');
      }
    } catch (err) {
      debug(`Start AR failed: ${err?.name || 'Error'} - ${err?.message || err}`);
      const msg = String(err?.message || '').toLowerCase();
      const name = String(err?.name || '').toLowerCase();

      if (msg.includes('permission') || msg.includes('notallowed') || name.includes('notallowed')) {
        setStatus('Camera permission denied');
        alert('Camera access was blocked. Please allow camera permission for this site in your browser settings, then try again.');
      } else if (msg.includes('notfound') || name.includes('notfound') || msg.includes('overconstrained')) {
        setStatus('No compatible camera found');
        alert('No usable camera was found on this device/browser.');
      } else if (msg.includes('secure') || msg.includes('https')) {
        setStatus('Secure context required');
        alert('Camera requires a secure HTTPS page.');
      } else {
        setStatus('Unable to start camera');
        alert(`Unable to start AR.\n\nError: ${err?.message || err}`);
      }
    } finally {
      starting = false;
    }
  }

  function handleStopCamera() {
    debug('Stop Camera clicked');
    closeOverlay();
    stopCamera();
    setStatus('Camera stopped');
  }

  async function handleSwitchCamera() {
    try {
      if (!hasActiveStream()) {
        debug('Switch blocked: no active stream');
        setStatus('Start camera first');
        alert('Start AR first, then you can switch cameras.');
        return;
      }

      debug('Switch Camera clicked');
      setStatus('Switching camera...');
      await switchCamera();
      debug('Camera switched successfully');
      setStatus(arOpen ? 'AR active' : 'Camera active');
    } catch (err) {
      debug(`Switch failed: ${err?.message || err}`);
      setStatus('Unable to switch camera');
      alert('Unable to switch camera.');
    }
  }

  startBtn.addEventListener('click', handleStartAR);
  stopBtn.addEventListener('click', handleStopCamera);
  switchBtn.addEventListener('click', handleSwitchCamera);
  backdrop.addEventListener('click', closeOverlay);

  window.addEventListener('error', (e) => {
    debug(`Window error: ${e.message}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    debug(`Unhandled promise rejection: ${e.reason?.message || e.reason}`);
  });

  setStatus('Tap Start AR to begin');
  debug('App initialized successfully');
})();