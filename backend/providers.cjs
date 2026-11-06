// ---------- Multi-provider data sources ----------
// Each adapter: search({ keyword, area, city, state, apiKey }) -> [{name, phone, address, city, state}]
// Returns only the 5 standard fields (raw; cleaning happens in server.js).

function normPhone(raw) { return String(raw || '').trim(); }

const PROVIDER_META = {
  gosom: { name: 'Google Maps Scraper (gosom)', signup: 'https://github.com/gosom/google-maps-scraper', limit: 0, period: 'none', needsKey: false },
  serper: { name: 'Serper.dev (Google Maps)', signup: 'https://serper.dev', limit: 2500, period: 'total', needsKey: true },
  serpapi: { name: 'SerpApi (Google Maps)', signup: 'https://serpapi.com', limit: 250, period: 'monthly', needsKey: true },
  hasdata: { name: 'HasData (Google Maps)', signup: 'https://hasdata.com', limit: 100, period: 'monthly', needsKey: true },
  apify: { name: 'Apify (Google Maps actor)', signup: 'https://apify.com', limit: 100, period: 'monthly', needsKey: true },
  geoapify: { name: 'Geoapify Places', signup: 'https://www.geoapify.com', limit: 3000, period: 'daily', needsKey: true },
  overpass: { name: 'OpenStreetMap Overpass', signup: 'https://overpass-turbo.eu', limit: 1000, period: 'daily', needsKey: false },
  sherlock: { name: 'SherlockMaps (local Docker)', signup: 'https://github.com/Ayyouboss0011/SherlockMaps', limit: 10000, period: 'daily', needsKey: false },
  google_places: { name: 'Google Places API (New)', signup: 'https://console.cloud.google.com', limit: 10000, period: 'monthly', needsKey: true },
  hunterio: { name: 'Hunter.io (Email Finder)', signup: 'https://hunter.io', limit: 50, period: 'monthly', needsKey: true },
};

const TOPUP_ORDER = ['geoapify', 'overpass', 'sherlock', 'serper', 'serpapi', 'hasdata', 'apify'];

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || text.slice(0, 200);
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

function row(name, phone, address, city, state) {
  return { name: String(name || '').trim(), phone: normPhone(phone), address: String(address || '').trim(), city: String(city || '').trim(), state: String(state || '').trim() };
}

// ---------- Serper.dev ----------
async function serperSearch({ keyword, area, city, state, apiKey }) {
  const q = `${keyword} in ${area || city}, ${state}`;
  const data = await fetchJson('https://google.serper.dev/maps', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 40 }),
  });
  const places = data.places || data.organic || [];
  return places.map((p) => row(p.title || p.name, p.phone || p.phoneNumber, p.address, city, state));
}

// ---------- SerpApi ----------
async function serpapiSearch({ keyword, area, city, state, apiKey }) {
  const q = `${keyword} in ${area || city}, ${state}`;
  const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const places = data.local_results || data.place_results ? [data.place_results] : [];
  const arr = Array.isArray(places) ? places : [];
  return arr.map((p) => row(p.title || p.name, p.phone, p.address, city, state));
}

// ---------- HasData ----------
async function hasdataSearch({ keyword, area, city, state, apiKey }) {
  const q = `${keyword} in ${area || city}, ${state}`;
  const url = `https://api.hasdata.com/scrape/google-maps/search?keyword=${encodeURIComponent(q)}&location=${encodeURIComponent(city + ', ' + state)}&api_key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const places = data.organic_results || data.results || data.places || [];
  return (Array.isArray(places) ? places : []).map((p) => row(p.title || p.name, p.phone, p.address, city, state));
}

// ---------- Apify ----------
async function apifySearch({ keyword, area, city, state, apiKey }) {
  const q = `${keyword} in ${area || city}, ${state}`;
  const url = `https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${encodeURIComponent(apiKey)}&timeout=120`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchStringsArray: [q], locationQuery: `${city}, ${state}`, maxCrawledPlacesPerSearch: 60, language: 'en' }),
  });
  const arr = Array.isArray(data) ? data : (data.items || []);
  return arr.map((p) => row(p.title || p.name, p.phone || p.phoneNumber, p.address, p.city || city, p.state || state));
}

// ---------- Geoapify ----------
const geoCache = {};
async function geoapifyGeocode(city, state, apiKey) {
  const key = `${city}|${state}`;
  if (geoCache[key]) return geoCache[key];
  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(city + ', ' + state)}&limit=1&apiKey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const f = (data && data.features && data.features[0]) || null;
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  const res = { lat, lon };
  geoCache[key] = res;
  return res;
}

async function geoapifySearch({ keyword, area, city, state, apiKey }) {
  const coords = await geoapifyGeocode(area || city, state, apiKey);
  if (!coords) return [];
  const categories = 'commercial,healthcare,education,service,accommodation,catering,entertainment,office';
  const url = `https://api.geoapify.com/v2/places?categories=${categories}&bias=proximity:${coords.lon},${coords.lat}&limit=50&apiKey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const features = (data && data.features) || [];
  return features.map((f) => {
    const p = f.properties || {};
    return row(p.name, p.phone || p.contact_phone, p.formatted || p.address_line1, p.city || city, p.state || state);
  });
}

// ---------- Overpass (OSM) ----------
async function overpassSearch({ keyword, area, city, state, apiKey }) {
  // Find OSM nodes in the city area whose name matches the keyword and have a phone.
  const query = `
[out:json][timeout:25];
area["name"="${city}"]->.a;
node(area.a)["name"~"${keyword.replace(/"/g, '')}",i]["phone"];
out body;
`.trim();
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  const els = (data && data.elements) || [];
  return els.map((e) => {
    const t = e.tags || {};
    const addr = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'], t['addr:city'] || city, t['addr:state'] || state, t['addr:postcode']].filter(Boolean).join(', ');
    return row(t.name, t.phone || t['contact:phone'], addr, t['addr:city'] || city, t['addr:state'] || state);
  });
}

// ---------- Google Places API (New) ----------
async function googlePlacesSearch({ keyword, area, city, state, apiKey }) {
  const data = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber',
    },
    body: JSON.stringify({ textQuery: `${keyword} in ${area || city}, ${state}`, maxResultCount: 20 }),
  });
  const places = (data && data.places) || [];
  return places.map((p) => row(p.displayName && p.displayName.text, p.nationalPhoneNumber || p.internationalPhoneNumber, p.formattedAddress, city, state));
}

// ---------- SherlockMaps (local Docker API) ----------
async function sherlockSearch({ keyword, area, city, state, apiKey }) {
  const base = (process.env.SHERLOCK_URL || 'http://localhost:8000').replace(/\/$/, '');
  const prompt = `${keyword} in ${area || city}, ${state}`;
  // Start crawl (async job)
  const start = await fetchJson(`${base}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const jobId = start.job_id || start.id || start.jobId;
  if (!jobId) throw new Error('sherlock: no job_id returned');

  // Poll until done (max ~10 min)
  const deadline = Date.now() + 10 * 60 * 1000;
  let status = 'pending';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await fetchJson(`${base}/crawl/${jobId}`);
    status = (st.status || st.state || '').toLowerCase();
    if (status === 'completed' || status === 'done' || status === 'finished' || status === 'success') break;
    if (status === 'failed' || status === 'error' || status === 'cancelled') throw new Error(`sherlock job ${status}`);
  }
  if (!['completed', 'done', 'finished', 'success'].includes(status)) {
    throw new Error(`sherlock job timed out (status=${status})`);
  }

  // Fetch results
  const res = await fetchJson(`${base}/crawl/${jobId}/results`);
  let arr = [];
  if (Array.isArray(res)) arr = res;
  else if (Array.isArray(res.results)) arr = res.results;
  else if (Array.isArray(res.data)) arr = res.data;
  else if (Array.isArray(res.companies)) arr = res.companies;
  else if (Array.isArray(res.items)) arr = res.items;

  return arr.map((p) => {
    const addr = p.address || p.formatted_address || p.location || '';
    const parts = String(addr).split(',').map((x) => x.trim()).filter(Boolean);
    let detectedCity = city;
    if (parts.length >= 2) detectedCity = parts[parts.length - 2] || city;
    return row(p.name || p.title || p.company_name, p.phone || p.phone_number || p.phoneNumber, addr, detectedCity, p.state || state);
  });
}
const ADAPTERS = {
  sherlock: sherlockSearch,
  serper: serperSearch,
  serpapi: serpapiSearch,
  hasdata: hasdataSearch,
  apify: apifySearch,
  geoapify: geoapifySearch,
  overpass: overpassSearch,
  google_places: googlePlacesSearch,
};

async function testKey(provider, apiKey) {
  // Minimal call to validate the key.
  const fn = ADAPTERS[provider];
  if (!fn && provider !== 'gosom') throw new Error('unknown provider');
  if (provider === 'gosom') return { ok: true, message: 'gosom needs no key' };
  if (provider === 'overpass') {
    const r = await overpassSearch({ keyword: 'hospital', area: null, city: 'Mumbai', state: 'Maharashtra', apiKey: '' });
    return { ok: true, message: `Overpass OK (${r.length} rows)` };
  }
  const r = await ADAPTERS[provider]({ keyword: 'hospital', area: null, city: 'Mumbai', state: 'Maharashtra', apiKey });
  return { ok: true, message: `${provider} OK (${r.length} rows)` };
}

module.exports = { PROVIDER_META, TOPUP_ORDER, ADAPTERS, testKey };
