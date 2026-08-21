import { randomUUID } from "node:crypto";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  createInterviewInput,
  createJobInput,
  getCodingTask,
  integrityEventSchema,
  interviewerInstructions,
  jobIncludesCoding,
  OPENAI_REALTIME_FLAGSHIP_MODEL,
  OPENAI_REALTIME_MINI_MODEL,
  transcriptTurnSchema,
  type Interview,
  type Job,
} from "@ai-interviewer/shared";
import type { Store } from "./store.js";
import { scoreInterview } from "./score.js";
import { generateCodingTask } from "./generate-coding-task.js";

export interface AppEnv {
  store: Store;
  webOrigin: string;
  openaiKey?: string;
  openaiRealtimeModel?: string;
  recordingsBucket?: string;
  eventBusName?: string;
  enableCors?: boolean;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function token() {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
}

export function createApp(env: AppEnv) {
  const app = new Hono();
  if (env.enableCors !== false) {
    const allowed = new Set(
      [env.webOrigin, "http://localhost:3000", "http://127.0.0.1:3000"].filter(Boolean),
    );
    app.use(
      "*",
      cors({
        origin: (origin) => (origin && allowed.has(origin) ? origin : env.webOrigin),
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      }),
    );
  }

  app.get("/health", (c) => c.json({ ok: true }));

  async function emitInterviewCompleted(interviewId: string) {
    if (!env.eventBusName) return;
    await new EventBridgeClient({}).send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: env.eventBusName,
            Source: "ai-interviewer",
            DetailType: "interview.completed",
            Detail: JSON.stringify({ interviewId }),
          },
        ],
      }),
    );
  }

  app.post("/jobs", async (c) => {
    const body = createJobInput.parse(await c.req.json());
    const seniority = body.seniority ?? "mid";
    const codingRequired = body.codingRequired !== false;
    const codingTask = codingRequired
      ? await generateCodingTask({
          title: body.title,
          description: body.description,
          seniority,
          openaiKey: env.openaiKey,
        })
      : undefined;
    const job: Job = {
      title: body.title,
      description: body.description,
      seniority,
      codingRequired,
      ...(codingTask ? { codingTask } : {}),
      jobId: id("job"),
      createdAt: new Date().toISOString(),
    };
    await env.store.putJob(job);
    return c.json(job, 201);
  });

  app.get("/jobs", async (c) => c.json(await env.store.listJobs()));
  app.get("/jobs/:jobId", async (c) => {
    const job = await env.store.getJob(c.req.param("jobId"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json(job);
  });

  app.post("/interviews", async (c) => {
    const body = createInterviewInput.parse(await c.req.json());
    const job = await env.store.getJob(body.jobId);
    if (!job) return c.json({ error: "job_not_found" }, 404);
    const interviewToken = token();
    const interview: Interview = {
      interviewId: id("iv"),
      jobId: job.jobId,
      candidate: {
        candidateId: id("cand"),
        name: body.candidateName,
        ...(body.candidateEmail ? { email: body.candidateEmail } : {}),
      },
      token: interviewToken,
      status: "created",
      createdAt: new Date().toISOString(),
      ...(jobIncludesCoding(job)
        ? {
            codingTask: await generateCodingTask({
              title: job.title,
              description: job.description,
              seniority: job.seniority ?? "mid",
              openaiKey: env.openaiKey,
            }),
          }
        : {}),
    };
    await env.store.putInterview(interview);
    return c.json({
      ...interview,
      url: `${env.webOrigin}/i/${interviewToken}`,
    }, 201);
  });

  app.get("/interviews", async (c) => c.json(await env.store.listInterviews()));

  app.get("/interviews/:interviewId", async (c) => {
    const interview = await env.store.getInterview(c.req.param("interviewId"));
    if (!interview) return c.json({ error: "not_found" }, 404);
    const [job, turns, events] = await Promise.all([
      env.store.getJob(interview.jobId),
      env.store.listTurns(interview.interviewId),
      env.store.listEvents(interview.interviewId),
    ]);
    return c.json({ interview, job, turns, events });
  });

  app.get("/session/:token", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const job = await env.store.getJob(interview.jobId);
    if (!job) return c.json({ error: "job_missing" }, 404);
    const seniority = job.seniority ?? "mid";
    const includesCoding = jobIncludesCoding(job);
    if (includesCoding && !interview.codingTask) {
      interview.codingTask = await generateCodingTask({
        title: job.title,
        description: job.description,
        seniority,
        openaiKey: env.openaiKey,
      });
      await env.store.putInterview(interview);
    }
    const task = includesCoding
      ? getCodingTask({ codingTask: interview.codingTask, seniority })
      : null;
    return c.json({
      interview: { ...interview, token: undefined },
      job: {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        seniority,
        codingRequired: includesCoding,
      },
      task: task
        ? { title: task.title, prompt: task.prompt, starter: task.starter, language: task.language }
        : null,
    });
  });

  app.post("/session/:token/start", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    interview.status = "in_voice";
    interview.startedAt = interview.startedAt ?? new Date().toISOString();
    await env.store.putInterview(interview);
    return c.json({ ok: true, status: interview.status });
  });

  app.post("/session/:token/phase", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const { phase } = (await c.req.json()) as { phase: "in_coding" | "completed" };
    interview.status = phase;
    if (phase === "completed") interview.completedAt = new Date().toISOString();
    await env.store.putInterview(interview);
    if (phase === "completed") await emitInterviewCompleted(interview.interviewId);
    return c.json({ ok: true, status: interview.status });
  });

  app.post("/session/:token/turns", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const turn = transcriptTurnSchema.parse(await c.req.json());
    await env.store.appendTurn(interview.interviewId, turn);
    return c.json({ ok: true });
  });

  app.post("/session/:token/events", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const event = integrityEventSchema.parse(await c.req.json());
    await env.store.appendEvent(interview.interviewId, event);
    return c.json({ ok: true });
  });

  app.post("/session/:token/code", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const { code } = (await c.req.json()) as { code: string };
    interview.submittedCode = code;
    interview.status = "completed";
    interview.completedAt = new Date().toISOString();
    await env.store.putInterview(interview);
    await emitInterviewCompleted(interview.interviewId);
    return c.json({ ok: true });
  });

  app.post("/session/:token/realtime", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const job = await env.store.getJob(interview.jobId);
    if (!job) return c.json({ error: "job_missing" }, 404);

    const model =
      env.openaiRealtimeModel ||
      process.env.OPENAI_REALTIME_MODEL ||
      OPENAI_REALTIME_MINI_MODEL;
    const instructions = interviewerInstructions({
      jobTitle: job.title,
      jobDescription: job.description,
      seniority: job.seniority ?? "mid",
      includesCoding: jobIncludesCoding(job),
    });

    if (!env.openaiKey) {
      return c.json({
        provider: "mock",
        model,
        instructions,
        clientSecret: null,
      });
    }

    const resolvedModel =
      model === OPENAI_REALTIME_FLAGSHIP_MODEL
        ? OPENAI_REALTIME_FLAGSHIP_MODEL
        : OPENAI_REALTIME_MINI_MODEL;

    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: resolvedModel,
          instructions,
          audio: {
            output: { voice: "marin" },
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.65,
                silence_duration_ms: 2000,
                prefix_padding_ms: 300,
                create_response: true,
                interrupt_response: false,
              },
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return c.json({ error: "realtime_session_failed", detail: text }, 502);
    }
    const session = (await res.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value: string; expires_at?: number };
      session?: { model?: string };
      model?: string;
    };
    const clientSecret = session.value ?? session.client_secret?.value;
    const expiresAt = session.expires_at ?? session.client_secret?.expires_at;
    return c.json({
      provider: "openai-realtime",
      model: session.session?.model ?? session.model ?? resolvedModel,
      clientSecret,
      expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined,
      instructions,
    });
  });

  app.post("/session/:token/uploads", async (c) => {
    const interview = await env.store.getInterviewByToken(c.req.param("token"));
    if (!interview) return c.json({ error: "invalid_link" }, 404);
    const { kind, contentType } = (await c.req.json()) as {
      kind: "webcam" | "screen";
      partNumber?: number;
      contentType?: string;
    };
    const key = `interviews/${interview.interviewId}/${kind}.webm`;
    if (kind === "webcam") interview.webcamKey = key;
    else interview.screenKey = key;
    await env.store.putInterview(interview);

    if (!env.recordingsBucket) {
      return c.json({ uploadUrl: null, key, mode: "local" });
    }
    const s3 = new S3Client({});
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.recordingsBucket,
        Key: key,
        ContentType: contentType ?? "video/webm",
      }),
      { expiresIn: 60 * 15 },
    );
    return c.json({ uploadUrl, key, mode: "s3" });
  });

  app.post("/interviews/:interviewId/score", async (c) => {
    const interview = await env.store.getInterview(c.req.param("interviewId"));
    if (!interview) return c.json({ error: "not_found" }, 404);
    const job = await env.store.getJob(interview.jobId);
    if (!job) return c.json({ error: "job_missing" }, 404);
    const previousStatus = interview.status;
    interview.status = "scoring";
    await env.store.putInterview(interview);
    try {
      const [turns, events] = await Promise.all([
        env.store.listTurns(interview.interviewId),
        env.store.listEvents(interview.interviewId),
      ]);
      const scorecard = await scoreInterview({
        job,
        interview,
        turns,
        events,
        openaiKey: env.openaiKey,
      });
      interview.scorecard = scorecard;
      interview.status = "scored";
      await env.store.putInterview(interview);
      return c.json({ interview, scorecard, gradedBy: scorecard.gradedBy });
    } catch (err) {
      console.error("score_endpoint_failed", err);
      interview.status = previousStatus === "scoring" ? "completed" : previousStatus;
      await env.store.putInterview(interview).catch((putErr) => console.error("score_status_reset_failed", putErr));
      return c.json(
        { error: "scoring_failed", detail: err instanceof Error ? err.message : "unknown" },
        500,
      );
    }
  });

  return app;
}
