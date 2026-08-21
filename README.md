# FirstRound

Standalone TypeScript monorepo: Next.js recruiter + candidate app, AWS CDK serverless backend. **Riley** runs a 15–20 minute voice interview, with an optional 5-minute coding task. Invites are **copyable links** (no SES).

## Layout

```
apps/web                 Next.js App Router (FirstRound)
packages/infra           AWS CDK (Cognito, DynamoDB, S3, HTTP API, Step Functions, Amplify app)
packages/functions       Hono API (Lambda + local server)
packages/shared          Zod types, coding tasks, voice provider contract
```

## Local demo

```bash
pnpm install
pnpm --filter @ai-interviewer/shared build
pnpm --filter @ai-interviewer/functions dev   # API on :3001 (in-memory)
pnpm --filter @ai-interviewer/web dev         # UI on :3000
```

1. Open http://localhost:3000 (landing) or `/login` (any email/password in local auth mode).
2. Create a role, invite a candidate, **copy the interview URL**.
3. Open the URL, grant camera/mic/fullscreen (and screen share if the role includes coding), complete the interview with Riley.

Without `OPENAI_API_KEY`, voice uses a browser speech-synthesis mock interviewer. With a key:

```bash
OPENAI_API_KEY=sk-... pnpm --filter @ai-interviewer/functions dev
```

## AWS deploy

```bash
cd packages/infra
npx cdk deploy --all --context webOrigin=https://YOUR_AMPLIFY_DOMAIN
aws secretsmanager put-secret-value --secret-id ai-interviewer/openai --secret-string 'YOUR_OPENAI_KEY'
```

Set Amplify env `NEXT_PUBLIC_API_URL` from the `ApiUrl` stack output. Recruiter auth uses Cognito when `NEXT_PUBLIC_AUTH_MODE=cognito`.

Recordings live in S3 for 30 days. Scoring prefers Bedrock Claude, then OpenAI, then a last-resort heuristic.

## Cost (approx, per 10-min interview)

~$0.25–$0.35 with OpenAI Realtime mini, ~$0.45–$0.70 with flagship.
