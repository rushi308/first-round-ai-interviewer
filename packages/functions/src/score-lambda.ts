import type { Handler } from "aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoStore } from "./ddb-store.js";
import { scoreInterview } from "./score.js";

async function resolveOpenAiKey(): Promise<string | undefined> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const arn = process.env.OPENAI_SECRET_ARN;
  if (!arn) return undefined;
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return res.SecretString;
}

export const handler: Handler<{ interviewId: string }> = async (event) => {
  const store = new DynamoStore(process.env.TABLE_NAME!);
  const interview = await store.getInterview(event.interviewId);
  if (!interview) throw new Error("interview not found");
  const job = await store.getJob(interview.jobId);
  if (!job) throw new Error("job not found");
  const [turns, events] = await Promise.all([
    store.listTurns(interview.interviewId),
    store.listEvents(interview.interviewId),
  ]);
  interview.status = "scoring";
  await store.putInterview(interview);
  const openaiKey = await resolveOpenAiKey();
  const scorecard = await scoreInterview({ job, interview, turns, events, openaiKey });
  interview.scorecard = scorecard;
  interview.status = "scored";
  await store.putInterview(interview);
  return {
    interviewId: interview.interviewId,
    status: interview.status,
    gradedBy: scorecard.gradedBy,
  };
};
