/**
 * Pages Functions adapter for cf2gdrive.
 * Bridges the Pages onRequest context to the Worker's default export.
 * functions/ sits at the project root (wrangler Pages convention); the shared
 * app lives in ../src and is bundled into dist/functions by scripts/build-pages.sh.
 */
import worker from "../src/index.js";

export async function onRequest(context) {
  const ctx =
    typeof context.waitUntil === "function"
      ? { waitUntil: context.waitUntil.bind(context) }
      : { waitUntil: () => {} };
  return worker.fetch(context.request, context.env, ctx);
}
