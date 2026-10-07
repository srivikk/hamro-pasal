import { isWithinNepalBoundingBox, NEPAL_BOUNDING_BOX } from '@hamro-pasal/shared-types';
import { z } from 'zod';

import type { Coordinates } from '../territory/territory';

/** Kathmandu (Thamel): where the map opens when there is no pin yet. */
export const DEFAULT_MAP_CENTER: Coordinates = { latitude: 27.7154, longitude: 85.3123 };
export const MAP_PIN_ZOOM = 16;

const LEAFLET_VERSION = '1.9.4';

/**
 * The page shown in the pin-drop WebView: a Leaflet map on OpenStreetMap tiles with a pin fixed at
 * the centre of the view. The customer moves the map under the pin; after every move the page
 * posts the centre to React Native. Panning is limited to Nepal's bounding box (SPEC §1).
 *
 * Only numbers are interpolated into the page (never text from the customer or the server).
 */
export function mapPinHtml(center: Coordinates): string {
  const lat = center.latitude.toFixed(6);
  const lng = center.longitude.toFixed(6);
  const bounds = `[[${String(NEPAL_BOUNDING_BOX.minLat)}, ${String(NEPAL_BOUNDING_BOX.minLng)}], [${String(NEPAL_BOUNDING_BOX.maxLat)}, ${String(NEPAL_BOUNDING_BOX.maxLng)}]]`;
  const zoom = String(MAP_PIN_ZOOM);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #pin { position: absolute; left: 50%; top: 50%; width: 28px; height: 28px; margin: -28px 0 0 -14px;
    z-index: 1000; pointer-events: none; }
  #pin svg { width: 28px; height: 28px; }
</style>
</head>
<body>
<div id="map"></div>
<div id="pin"><svg viewBox="0 0 24 24"><path fill="#B91C1C" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg></div>
<script src="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js"></script>
<script>
  function post(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  try {
    var map = L.map('map', {
      zoomControl: true,
      maxBounds: ${bounds},
      maxBoundsViscosity: 1,
      minZoom: 6
    }).setView([${lat}, ${lng}], ${zoom});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    function report() {
      var c = map.getCenter();
      post({ type: 'center', lat: c.lat, lng: c.lng });
    }
    map.on('moveend', report);
    report();
  } catch (error) {
    post({ type: 'error' });
  }
</script>
</body>
</html>`;
}

const mapMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('center'), lat: z.number(), lng: z.number() }),
  z.strictObject({ type: z.literal('error') }),
]);

export type MapPinMessage =
  { kind: 'center'; position: Coordinates; insideNepal: boolean } | { kind: 'error' } | null;

/** Reads what the page posted. Anything that is not one of its two messages is ignored (null). */
export function parseMapPinMessage(data: string): MapPinMessage {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const message = mapMessageSchema.safeParse(json);
  if (!message.success) return null;
  if (message.data.type === 'error') return { kind: 'error' };
  const { lat, lng } = message.data;
  return {
    kind: 'center',
    position: { latitude: lat, longitude: lng },
    insideNepal: isWithinNepalBoundingBox({ lat, lng }),
  };
}
