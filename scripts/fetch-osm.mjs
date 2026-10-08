// Downloads an OpenStreetMap extract of central Karlsruhe via the Overpass API.
// Usage: node scripts/fetch-osm.mjs   -> data/raw/osm.json (git-ignored)
import fs from 'node:fs';

// south, west, north, east  (Innenstadt: Hbf .. Durlacher Tor .. Mühlburger Tor, plus margin)
export const BBOX = [48.9930, 8.3670, 49.0180, 8.4300];
const [s, w, n, e] = BBOX;
const bb = `${s},${w},${n},${e}`;
const query = `
[out:json][timeout:180];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|cycleway|path|steps)$"](${bb});
  way["railway"="tram"](${bb});
  way["building"](${bb});
  node["highway"="traffic_signals"](${bb});
  node["highway"="crossing"](${bb});
  node["highway"="bus_stop"](${bb});
  node["railway"="tram_stop"](${bb});
  node["public_transport"="stop_position"](${bb});
  node["amenity"~"^(school|university|college|hospital|restaurant|cafe|cinema|theatre|marketplace)$"](${bb});
  node["shop"](${bb});
  relation["route"~"^(tram|bus)$"](${bb});
);
(._;>;);
out body;
`;
const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
for (const ep of endpoints) {
  try {
    console.log('POST', ep);
    const r = await fetch(ep, {
      method: 'POST',
      headers: { 'User-Agent': 'yniverz-trafficsim/0.1 (github.com/yniverz/trafficsim)', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!r.ok) { console.log('status', r.status); continue; }
    const txt = await r.text();
    fs.mkdirSync('data/raw', { recursive: true });
    fs.writeFileSync('data/raw/osm.json', txt);
    console.log('saved', (txt.length / 1e6).toFixed(1), 'MB');
    process.exit(0);
  } catch (err) { console.log('failed', err.message); }
}
process.exit(1);
