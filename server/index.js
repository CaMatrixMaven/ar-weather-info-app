import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

app.use(express.static(rootDir));

function normalizeWeatherPayload(raw) {
  const current = raw?.current || {};
  return {
    temperatureC: current.temperature_2m ?? null,
    humidity: current.relative_humidity_2m ?? null
  };
}

async function fetchOpenMeteoWeather(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m');

  const res = await fetch(url.toString());

  if (!res.ok) {
    const err = new Error(`Open-Meteo error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const raw = await res.json();
  return normalizeWeatherPayload(raw);
}

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'missing_coordinates' });
  }

  try {
    const data = await fetchOpenMeteoWeather(lat, lon);

    if (data.temperatureC == null || data.humidity == null) {
      return res.status(502).json({ error: 'weather_unavailable' });
    }

    return res.json(data);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'weather_unavailable' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }

  res.sendFile(path.join(rootDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});