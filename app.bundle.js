/*
Key concepts in this file:

1. Weather fetching pipeline:
   - requestWeather → normalize → cache → fallback logic
   - Handles API rate limits (429) with retry + cache fallback

2. AR rendering:
   - Manual AR Panel projection 
   

3. Pointer system:
   - Tracks multiple active pointers for gesture detection
*/

(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function init() {
    var startBtn = byId('startArBtn');
    var stopBtn = byId('stopCameraBtn');
    var switchBtn = byId('switchCameraBtn');
    var video = byId('cameraFeed');
    var overlay = byId('arOverlay');
    var backdrop = byId('arBackdrop');
    var tempValue = byId('tempValue');
    var humidityValue = byId('humidityValue');
    var weatherMessage = byId('weatherMessage');
    var cachedBadge = byId('cachedBadge');
    var approxBadge = byId('approxBadge');
    var statusBanner = byId('statusBanner');
    var debugText = byId('debugText');
    var canvas = byId('arCanvas');

    if (
      !startBtn || !stopBtn || !switchBtn || !video || !overlay || !backdrop ||
      !tempValue || !humidityValue || !weatherMessage || !cachedBadge ||
      !approxBadge || !statusBanner || !debugText || !canvas
    ) {
      alert('App error will not initialize.');
      return;
    }

    var stream = null;
    var currentFacingMode = 'environment';
    var arOpen = false;
    var starting = false;
    var running = false;
    var rafId = null;

    var rotation = 0.4;
    var scale = 1.0;
    var isDragging = false;
    var lastX = 0;
    var activePointers = {};
    var activePointerCount = 0;
    var initialPinchDistance = null;
    var initialScale = 1.0;

    var CACHE_KEY = 'weather-cache-v5';
    var ctx = canvas.getContext('2d');

    function debug(msg) {
      console.log('[DEBUG]', msg);
      if (debugText) debugText.textContent = String(msg);
    }

    function setStatus(text) {
      if (statusBanner) statusBanner.textContent = text;
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
      try {
        return localStorage.getItem('temperature-unit') || 'C';
      } catch (e) {
        return 'C';
      }
    }

    function formatTemp(c) {
      var unit = getUnit();
      if (unit === 'F') {
        return Math.round((c * 9 / 5) + 32) + '°F';
      }
      return Math.round(c) + '°C';
    }

    function saveCache(payload) {
      try {
        var withTs = {};
        for (var k in payload) withTs[k] = payload[k];
        withTs.ts = Date.now();
        localStorage.setItem(CACHE_KEY, JSON.stringify(withTs));
      } catch (e) {}
    }

    function loadCache() {
      try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts <= 30 * 60 * 1000) {
          return parsed;
        }
      } catch (e) {}
      return null;
    }

    function renderWeather(result) {
      cachedBadge.classList.toggle('hidden', !result.cached);
      approxBadge.classList.toggle('hidden', !result.approximate);

      if (result.ok && result.data) {
        weatherMessage.classList.add('hidden');
        tempValue.textContent = result.data.temperatureDisplay;
        humidityValue.textContent = 'Humidity ' + result.data.humidity + '%';
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

    function waitForVideoReady(videoEl, timeout) {
      timeout = timeout || 5000;
      return new Promise(function (resolve, reject) {
        if (videoEl.readyState >= 1) {
          resolve();
          return;
        }

        var timer = setTimeout(function () {
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

    function requestStream(facingMode) {
      if (!supportsMediaDevices()) {
        return Promise.reject(new Error('Camera API not supported'));
      }

      return navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      }).catch(function (err) {
        debug('Primary camera request failed: ' + err.message);
        return navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      });
    }

    function startCamera() {
      if (stream) {
        video.srcObject = stream;
        return waitForVideoReady(video).catch(function () {}).then(function () {
          return video.play().catch(function () {});
        }).then(function () {
          return stream;
        });
      }

      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;

      return requestStream(currentFacingMode).then(function (s) {
        stream = s;
        debug('Camera stream acquired');
        video.srcObject = stream;
        return waitForVideoReady(video);
      }).then(function () {
        return video.play();
      }).then(function () {
        debug('Video active ' + video.videoWidth + 'x' + video.videoHeight);
        return stream;
      });
    }

    function stopCamera() {
      if (stream) {
        var tracks = stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
        stream = null;
      }
      video.pause();
      video.srcObject = null;
    }

    function switchCamera() {
      currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
      if (stream) {
        var tracks = stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
        stream = null;
      }
      return startCamera();
    }

    function getLocation(highAccuracy) {
      return new Promise(function (resolve, reject) {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation unavailable'));
          return;
        }

        navigator.geolocation.getCurrentPosition(
          function (pos) { resolve(pos.coords); },
          function (err) { reject(err); },
          { enableHighAccuracy: highAccuracy, timeout: 5000, maximumAge: 0 }
        );
      });
    }

    function getBestLocation() {
      return getLocation(true).catch(function () { return null; }).then(function (high) {
        if (high && typeof high.accuracy === 'number' && high.accuracy <= 50) {
          return {
            lat: high.latitude,
            lon: high.longitude,
            approximate: false
          };
        }

        return getLocation(false).catch(function () { return null; }).then(function (low) {
          if (low) {
            return {
              lat: low.latitude,
              lon: low.longitude,
              approximate: true
            };
          }
          throw new Error('Location unavailable');
        });
      });
    }

    function requestWeather(lat, lon) {
      return fetch('/api/weather?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon))
        .then(function (res) {
          if (!res.ok) {
            var err = new Error('HTTP ' + res.status);
            err.status = res.status;
            throw err;
          }
          return res.json();
        });
    }

    function normalizeWeather(data) {
      return {
        temperatureC: data.temperatureC,
        temperatureDisplay: formatTemp(data.temperatureC),
        humidity: data.humidity
      };
    }

    // Robust fetch pipeline:
    // 1. Try live API
    // 2. Retry on rate limit (429)
    // 3. Fallback to cached data
    function fetchWeatherWithFallbacks(loc) {
      return requestWeather(loc.lat, loc.lon).then(function (live) {
        var normalized = normalizeWeather(live);
        saveCache(normalized);
        return {
          ok: true,
          data: normalized,
          cached: false,
          approximate: !!loc.approximate
        };
      }).catch(function (e) {
        if (e.status === 429) {
          return new Promise(function (resolve) {
            setTimeout(resolve, 1000);
          }).then(function () {
            return requestWeather(loc.lat, loc.lon).then(function (retry) {
              var normalized = normalizeWeather(retry);
              saveCache(normalized);
              return {
                ok: true,
                data: normalized,
                cached: false,
                approximate: !!loc.approximate
              };
            }).catch(function () {
              var cache = loadCache();
              if (cache) {
                return {
                  ok: true,
                  data: cache,
                  cached: true,
                  approximate: !!loc.approximate
                };
              }
              return {
                ok: false,
                cached: false,
                approximate: !!loc.approximate
              };
            });
          });
        }

        var cache = loadCache();
        if (cache) {
          return {
            ok: true,
            data: cache,
            cached: true,
            approximate: !!loc.approximate
          };
        }

        return {
          ok: false,
          cached: false,
          approximate: !!loc.approximate
        };
      });
    }

    // Adjusts canvas resolution for device pixel ratio to keep rendering sharp
    function resizeCanvas() {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Projects a Panel onto 2D canvas using a simple perspective projection.
    function drawCube(cx, cy, size, rot) {
      var points = [
        [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
        [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]
      ];
      var edges = [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7]
      ];

      var projected = [];
      for (var i = 0; i < points.length; i++) {
        var x = points[i][0];
        var y = points[i][1];
        var z = points[i][2];
        var cos = Math.cos(rot);
        var sin = Math.sin(rot);
        var rx = x * cos - z * sin;
        var rz = x * sin + z * cos;
        var perspective = 220 / (rz + 4);
        projected.push({
          x: cx + rx * size * perspective * 0.45,
          y: cy + y * size * perspective * 0.45
        });
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();

      for (var j = 0; j < edges.length; j++) {
        var a = edges[j][0];
        var b = edges[j][1];
        ctx.moveTo(projected[a].x, projected[a].y);
        ctx.lineTo(projected[b].x, projected[b].y);
      }

      ctx.stroke();
    }

    // Main animation loop using requestAnimationFrame
    function renderAR() {
      if (!running) return;
      var rect = canvas.getBoundingClientRect();
      drawCube(rect.width / 2, rect.height / 2 + 6, Math.min(rect.width, rect.height) * 0.78 * scale, rotation);
      rafId = requestAnimationFrame(renderAR);
    }

    function startARVisual() {
      resizeCanvas();
      running = true;
      renderAR();
    }

    function stopARVisual() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    }

    // Euclidean distance between two touch points (used for mobile device pinch scaling)
    function getDistance(p1, p2) {
      var dx = p2.x - p1.x;
      var dy = p2.y - p1.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getActivePointerArray() {
      var arr = [];
      for (var key in activePointers) {
        if (activePointers.hasOwnProperty(key)) {
          arr.push(activePointers[key]);
        }
      }
      return arr;
    }

    function openOverlay() {
      overlay.classList.remove('hidden');
      backdrop.classList.remove('hidden');
      arOpen = true;
      startARVisual();
    }

    function closeOverlay() {
      overlay.classList.add('hidden');
      backdrop.classList.add('hidden');
      arOpen = false;
      stopARVisual();
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (canvas.setPointerCapture) {
        canvas.setPointerCapture(e.pointerId);
      }

      activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      activePointerCount++;

      if (activePointerCount === 1) {
        isDragging = true;
        lastX = e.clientX;
      }

      if (activePointerCount === 2) {
        var pts = getActivePointerArray();
        initialPinchDistance = getDistance(pts[0], pts[1]);
        initialScale = scale;
        isDragging = false;
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!activePointers[e.pointerId]) return;

      activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };

      if (activePointerCount === 1 && isDragging) {
        var dx = e.clientX - lastX;
        rotation += dx * 0.01;
        lastX = e.clientX;
      }

      if (activePointerCount === 2 && initialPinchDistance) {
        var pts = getActivePointerArray();
        var currentDistance = getDistance(pts[0], pts[1]);
        var ratio = currentDistance / initialPinchDistance;
        scale = Math.min(1.8, Math.max(0.55, initialScale * ratio));
      }
    });

    function endPointer(e) {
      if (activePointers[e.pointerId]) {
        delete activePointers[e.pointerId];
        activePointerCount--;
      }

      if (activePointerCount < 2) initialPinchDistance = null;
      if (activePointerCount <= 0) {
        activePointerCount = 0;
        isDragging = false;
      }
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    window.addEventListener('resize', resizeCanvas);

    function handleStartAR() {
      if (starting) return;
      starting = true;

      debug('Start AR clicked');
      setStatus('Opening camera...');
      resetWeatherUI();

      startCamera().then(function () {
        openOverlay();
        setStatus('Camera active · Getting location...');
        return getBestLocation().then(function (loc) {
          setStatus('Camera active · Loading weather...');
          return fetchWeatherWithFallbacks(loc).then(function (weather) {
            renderWeather(weather);
          });
        }).catch(function () {
          renderWeather({ ok: false, cached: false, approximate: false });
          setStatus('Camera active · Location unavailable');
        });
      }).catch(function (err) {
        debug('Start error: ' + (err && err.message ? err.message : err));
        setStatus('Unable to start camera');
        alert('Unable to start AR. Please allow camera and location permissions.');
      }).finally(function () {
        starting = false;
      });
    }

    function handleStopCamera() {
      debug('Stop clicked');
      closeOverlay();
      stopCamera();
      setStatus('Camera stopped');
    }

    function handleSwitchCamera() {
      if (!stream) {
        alert('Start AR first, then switch camera.');
        return;
      }

      setStatus('Switching camera...');
      switchCamera().then(function () {
        setStatus(arOpen ? 'AR active' : 'Camera active');
      }).catch(function (err) {
        debug('Switch error: ' + (err && err.message ? err.message : err));
        alert('Unable to switch camera.');
      });
    }

    startBtn.addEventListener('click', handleStartAR);
    stopBtn.addEventListener('click', handleStopCamera);
    switchBtn.addEventListener('click', handleSwitchCamera);
    backdrop.addEventListener('click', closeOverlay);

    setStatus('Tap Start AR to begin');
    debug('App initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

