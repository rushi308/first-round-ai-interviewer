import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { memoryStore } from "./memory-store.js";
import { DynamoStore } from "./ddb-store.js";

const useDdb = Boolean(process.env.TABLE_NAME);
const store = useDdb ? new DynamoStore(process.env.TABLE_NAME!) : memoryStore;

const app = createApp({
  store,
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:3000",
  openaiKey: process.env.OPENAI_API_KEY,
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL,
  recordingsBucket: process.env.RECORDINGS_BUCKET,
  eventBusName: process.env.EVENT_BUS_NAME,
});

const port = Number(process.env.PORT || 3001);
serve({ fetch: app.fetch, port }, () => {
  console.log(`API listening on http://localhost:${port} (${useDdb ? "dynamodb" : "memory"})`);
});
