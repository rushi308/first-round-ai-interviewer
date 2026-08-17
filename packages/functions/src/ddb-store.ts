import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { IntegrityEvent, Interview, Job, TranscriptTurn } from "@ai-interviewer/shared";
import type { Store } from "./store.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class DynamoStore implements Store {
  constructor(private tableName: string) {}

  async putJob(job: Job) {
    await client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: `JOB#${job.jobId}`, sk: "META", type: "job", ...job },
      }),
    );
  }

  async getJob(jobId: string) {
    const res = await client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: `JOB#${jobId}`, sk: "META" } }),
    );
    return (res.Item as Job | undefined) ?? null;
  }

  async listJobs() {
    const res = await client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "#t = :job",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":job": "job" },
      }),
    );
    return ((res.Items ?? []) as Job[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async putInterview(interview: Interview) {
    await client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `INTERVIEW#${interview.interviewId}`,
          sk: "META",
          gsi1pk: `TOKEN#${interview.token}`,
          gsi1sk: "TOKEN",
          type: "interview",
          ...interview,
        },
      }),
    );
  }

  async getInterview(interviewId: string) {
    const res = await client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `INTERVIEW#${interviewId}`, sk: "META" },
      }),
    );
    return (res.Item as Interview | undefined) ?? null;
  }

  async getInterviewByToken(token: string) {
    const res = await client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `TOKEN#${token}` },
      }),
    );
    const item = res.Items?.[0];
    return (item as Interview | undefined) ?? null;
  }

  async listInterviews() {
    const res = await client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "#t = :interview",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":interview": "interview" },
      }),
    );
    return ((res.Items ?? []) as Interview[]).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async appendTurn(interviewId: string, turn: TranscriptTurn) {
    await client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `INTERVIEW#${interviewId}`,
          sk: `MSG#${turn.at}`,
          type: "turn",
          interviewId,
          ...turn,
        },
      }),
    );
  }

  async listTurns(interviewId: string) {
    const res = await client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": `INTERVIEW#${interviewId}`,
          ":sk": "MSG#",
        },
      }),
    );
    return (res.Items ?? []) as TranscriptTurn[];
  }

  async appendEvent(interviewId: string, event: IntegrityEvent) {
    await client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `INTERVIEW#${interviewId}`,
          sk: `EVT#${event.at}#${event.type}`,
          entity: "event",
          interviewId,
          eventType: event.type,
          at: event.at,
          detail: event.detail,
        },
      }),
    );
  }

  async listEvents(interviewId: string) {
    const res = await client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": `INTERVIEW#${interviewId}`,
          ":sk": "EVT#",
        },
      }),
    );
    return (res.Items ?? []).map((item) => ({
      type: (item.eventType ?? item.type) as IntegrityEvent["type"],
      at: item.at as string,
      detail: item.detail as string | undefined,
    }));
  }
}
