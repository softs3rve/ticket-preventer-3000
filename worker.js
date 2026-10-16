import { handleParkingRoute, checkParkingAlert } from './parking.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await handleParkingRoute(request, env, url);
    return response || new Response('Not found', { status: 404 });
  },

  // Cron Trigger (see wrangler.toml): /parking/report only re-checks the
  // schedule when the car's location changes, so this is what notices the
  // 30-minute mark arriving while the car sits still.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkParkingAlert(env));
  },
};
