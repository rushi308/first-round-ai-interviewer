import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoStore } from "./ddb-store.js";
import { createApp } from "./app.js";

const store = new DynamoStore(process.env.TABLE_NAME!);
let openaiKey = process.env.OPENAI_API_KEY;

async function resolveOpenAiKey() {
  if (openaiKey) return openaiKey;
  const arn = process.env.OPENAI_SECRET_ARN;
  if (!arn) return undefined;
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  openaiKey = res.SecretString;
  return openaiKey;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const key = await resolveOpenAiKey();
  console.log(key);
  const app = createApp({
    store,
    webOrigin: process.env.WEB_ORIGIN || "*",
    openaiKey: key,
    openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL,
    recordingsBucket: process.env.RECORDINGS_BUCKET,
    eventBusName: process.env.EVENT_BUS_NAME,
    enableCors: false,
  });
  const url = `https://${event.requestContext.domainName}${event.rawPath}${
    event.rawQueryString ? `?${event.rawQueryString}` : ""
  }`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v) headers.set(k, v);
  }
  const res = await app.fetch(
    new Request(url, {
      method: event.requestContext.http.method,
      headers,
      body: event.body
        ? event.isBase64Encoded
          ? Buffer.from(event.body, "base64")
          : event.body
        : undefined,
    }),
  );
  const body = await res.text();
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  return {
    statusCode: res.status,
    headers: outHeaders,
    body,
  };
}
