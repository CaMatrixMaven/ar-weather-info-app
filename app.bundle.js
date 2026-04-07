(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function init() {
    const startBtn = byId('startArBtn');
    const stopBtn = byId('stopCameraBtn');
    const switchBtn = byId('switchCameraBtn');
    const video = byId('cameraFeed');
    const overlay = byId('arOverlay');
    const backdrop = byId('arBackdrop');
    const tempValue = byId('tempValue');
    const humidityValue = byId('humidityValue');
    const weatherMessage = byId('weatherMessage');
    const cachedBadge = byId('cachedBadge');
    const approxBadge = byId('approxBadge');
    const statusBanner = byId('statusBanner');
    const debugText = byId('debugText');
    const canvas = byId('arCanvas');

    if (!startBtn || !stopBtn || !switchBtn || !video || !overlay || !backdrop || !tempValue || !humidityValue || !weatherMessage || !cachedBadge || !approxBadge || !statusBanner || !debugText || !canvas) {
      alert('App failed to initialize.');
      return;
    }

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

    const CACHE_KEY = 'weather-cache-v4';
    const ctx = canvas.getContext('2d');

    function debug(msg) {
      console.log('[DEBUG]', msg);
      debugText.textContent = msg;
    }

    function setStatus(text) {
      statusBanner.textContent = text;
      debug(text);
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
      return unit === 'F' ? `${Math.round((c * 9 / 5) + 32)}°F` : `${Math.round(c)}°C`;
    }

    function saveCache(payload) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...payload, ts: Date.now() }));
    }

    function loadCache() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return (Date.now() - parsed.ts <= 30 * 60 * 1000) ? parsed : null;
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

    function waitForVideoReady(videoEl, timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (videoEl.readyState >= 1) return resolve();

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Video metadata load timeout'));
        }, timeout);

        function onLoaded() {
          cleanup();
          resolve();
        }

        function onError() {
          cleanup();
          reject(new Error('Video metadata failed to load'));
        }

        function cleanup() {
          clearTimeout(timer);
          videoEl.removeEventListener('loadedmetadata', onLoaded);
          videoEl.removeEventListener('error', onError);
        }

        videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });
        videoEl.addEventListener('error', onError, { once: true });
      });
    }

    async function requestStream(facingMode) {
      if (!supportsMediaDevices()) {
        throw new Error('Camera API not supported');
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
        debug(`Primary camera request failed: ${err.message}`);
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }

    async function startCamera() {
      if (stream) {
        video.srcObject = stream;
        await waitForVideoReady(video).catch(() => {});
        await video.play().catch(() => {});
        return stream;
      }

      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;

      stream = await requestStream(currentFacingMode);
      debug(`Camera stream acquired`);

      video.srcObject = stream;
      await waitForVideoReady(video);
      await video.play();

      debug(`Video active ${video.videoWidth}x${video.videoHeight}`);
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

    function getLocation(highAccuracy) {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation unavailable'));
          return;
        }

        navigator.geolocation.getCurrentPosition(
          pos => resolve(pos.coords),
          reject,
          { enableHighAccuracy: highAccuracy, timeout: 5000, maximumAge: 0 }
        );
      });
    }

    async function getBestLocation() {
      const high = await getLocation(true).catch(() => null);
      if (high && typeof high.accuracy === 'number' && high.accuracy <= 50) {
        return { lat: high.latitude, lon: high.longitude, approximate: false };
      }

      const low = await getLocation(false).catch(() => null);
      if (low) {
        return { lat: low.latitude, lon: low.longitude, approximate: true };
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
        return { ok: true, data: normalized, cached: false, approximate: !!loc.approximate };
      } catch (e) {
        if (e.status === 429) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const retry = await requestWeather(loc.lat, loc.lon);
            const normalized = normalizeWeather(retry);
            saveCache(normalized);
            return { ok: true, data: normalized, cached: false, approximate: !!loc.approximate };
          } catch {
            const cache = loadCache();
            if (cache) return { ok: true, data: cache, cached: true, approximate: !!loc.approximate };
            return { ok: false, cached: false, approximate: !!loc.approximate };
          }
        }

        const cache = loadCache();
        if (cache) return { ok: true, data: cache, cached: true, approximate: !!loc.approximate };
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
        [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
        [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]
      ];
      const edges = [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7]
      ];

      const projected = points.map(([x,y,z]) => {
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

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();

      for (const [a,b] of edges) {
        ctx.moveTo(projected[a].x, projected[a].y);
        ctx.lineTo(projected[b].x, projected[b].y);
      }

      ctx.stroke();
    }

    function renderAR() {
      if (!running) return;
      const rect = canvas.getBoundingClientRect();
      drawCube(rect.width / 2, rect.height / 2 + 6, Math.min(rect.width, rect.height) * 0.78 * scale, rotation);
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
      if (starting) return;
      starting = true;

      try {
        debug('Start AR clicked');
        setStatus('Opening camera...');
        resetWeatherUI();

        await startCamera();
        openOverlay();
        setStatus('Camera active · Getting location...');

        try {
          const loc = await getBestLocation();
          setStatus('Camera active · Loading weather...');
          const weather = await fetchWeatherWithFallbacks(loc);
          renderWeather(weather);
        } catch {
          renderWeather({ ok: false, cached: false, approximate: false });
          setStatus('Camera active · Location unavailable');
        }
      } catch (err) {
        debug(`Start failed: ${err.message || err}`);
        setStatus('Unable to start camera');
        alert('Unable to start AR. Please allow camera and location permissions.');
      } finally {
        starting = false;
      }
    }

    function handleStopCamera() {
      debug('Stop clicked');
      closeOverlay();
      stopCamera();
      setStatus('Camera stopped');
    }

    async function handleSwitchCamera() {
      try {
        if (!stream) {
          alert('Start AR first, then switch camera.');
          return;
        }
        setStatus('Switching camera...');
        await switchCamera();
        setStatus(arOpen ? 'AR active' : 'Camera active');
      } catch (err) {
        debug(`Switch failed: ${err.message || err}`);
        alert('Unable to switch camera.');
      }
    }

    startBtn.addEventListener('click', handleStartAR);
    stopBtn.addEventListener('click', handleStopCamera);
    switchBtn.addEventListener('click', handleSwitchCamera);

    startBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleStartAR();
    }, { passive: false });

    stopBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleStopCamera();
    }, { passive: false });

    switchBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleSwitchCamera();
    }, { passive: false });

    backdrop.addEventListener('click', closeOverlay);
    backdrop.addEventListener('touchend', (e) => {
      e.preventDefault();
      closeOverlay();
    }, { passive: false });

    setStatus('Tap Start AR to begin');
    debug('App initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
