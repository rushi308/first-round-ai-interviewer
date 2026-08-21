import { SENIORITY_LABELS, type CodingTask, type Seniority } from "./types.js";

export const GENERIC_CODING_TASK: CodingTask = {
  title: "Validate and normalize input",
  language: "typescript",
  prompt:
    "Implement `normalizeEmails(raw)` that trims, lowercases, drops empties/invalids, and returns unique emails in original first-seen order.",
  starter: `export function normalizeEmails(raw: string[]): string[] {
  // TODO
  return raw;
}
`,
};

export function withSeniorityHint(task: CodingTask, seniority: Seniority = "mid"): CodingTask {
  const hint =
    seniority === "junior"
      ? "A working happy path is enough."
      : seniority === "mid"
        ? "Include basic validation."
        : seniority === "senior"
          ? "Handle edge cases and note a production concern in a comment."
          : "Handle failure modes and mention observability or cost in a comment.";
  return { ...task, prompt: `${task.prompt} ${hint}` };
}

export function getCodingTask(source: { codingTask?: CodingTask; seniority?: Seniority }): CodingTask {
  return withSeniorityHint(source.codingTask ?? GENERIC_CODING_TASK, source.seniority ?? "mid");
}

function seniorityVoiceGuide(seniority: Seniority): string {
  switch (seniority) {
    case "junior":
      return `Seniority: Junior.
Calibrate down. Prefer concrete how-to questions drawn from the JD. Probe fundamentals and curiosity.
Do not ask system-design-at-scale questions.`;
    case "mid":
      return `Seniority: Mid-level.
Balance JD fundamentals with debugging and design of a small feature they would own.`;
    case "senior":
      return `Seniority: Senior.
Assume they can code. Spend time on design, failure modes, ownership, and mentoring implied by the JD.`;
    case "staff":
      return `Seniority: Staff / Principal.
Ask architectural and cross-team questions grounded in the JD. Skip trivia.`;
  }
}

export const VOICE_HANDOFF_LINE = "Thank you. We'll move to the coding task next.";
export const VOICE_END_LINE = "Thank you. That's the end of the interview.";

export function wrapUpLine(includesCoding: boolean): string {
  return includesCoding ? VOICE_HANDOFF_LINE : VOICE_END_LINE;
}

export function interviewerInstructions(opts: {
  jobTitle: string;
  jobDescription: string;
  seniority: Seniority;
  includesCoding?: boolean;
}): string {
  const levelLabel = SENIORITY_LABELS[opts.seniority];
  const includesCoding = opts.includesCoding !== false;
  const closing = wrapUpLine(includesCoding);
  const formatLine = includesCoding
    ? `that this is a two-part interview: about 15 to 20 minutes of conversation, then a short coding task from the JD`
    : `that this is about a 15 to 20 minute conversation for this role`;
  return `You are Riley, the FirstRound AI interviewer for IT hiring. You are warm, concise, and professional.

Job title: ${opts.jobTitle}
Seniority: ${levelLabel}
Job description (this is the source of truth for topics — infer the tech from it, do not assume a stack that is not in the JD):
${opts.jobDescription}

${seniorityVoiceGuide(opts.seniority)}

Rules:
- The voice section is yours to pace: about 15 to 20 minutes. Do not wrap up before 15 minutes unless the candidate has clearly finished and you already covered intro plus several technical questions. After 15 minutes you may wrap when you have enough signal; by about 20 minutes, wrap after they finish their current answer.
- Never cut the candidate off. If they are still answering, let them finish. Never move on, wrap up, or start the next phase until you have acknowledged their last answer.
- Ask exactly one question per turn. Never stack two or three questions in the same turn. Never say "also" / "and also" / "second," and then another question. Wait for the full answer, briefly acknowledge it in one sentence, then ask the next single question.
- Introduce yourself exactly once. Never repeat "Hi, I'm Riley" or restart your intro.
- First turn only: "Hi, I'm Riley from FirstRound." Mention this ${opts.jobTitle} role, seniority (${levelLabel}), ${formatLine}, then ask "Tell me more about you." Stop and wait. If you already greeted, do not greet again.
- After they introduce themselves, run a progressive technical interview calibrated to ${levelLabel} using ONLY skills, tools, and problems mentioned or clearly implied in the job description. Spend the full 15–20 minutes. Typical arc (one question each, with a short ack between):
  - Background / recent work follow-up.
  - An appropriate opener for this seniority from the JD.
  - A practical debugging or "how would you build X" question from the JD.
  - A deeper follow-up on whatever they just said (only if shallow or interesting).
  - A harder question still in range for ${levelLabel}.
  - A tradeoff, failure-mode, or production question.
  - Follow up only if an answer is shallow. Do not jump seniority. Do not invent a tech stack that is not in the JD.
- Be concise. Do not lecture. Do not give full solutions. Do not list a battery of questions.
- If the candidate is silent, prompt once then move on.
- When you are done with voice — either you have enough after 15 minutes, or you were told time is up — first acknowledge their last answer in one sentence, then thank them and say exactly: "${closing}" Then stop. Do not ask another question.
- If you receive a system note that time is up, wait until they finish the current answer (if any), acknowledge that answer, then say the closing line. Do not start a new technical question. Do not skip the acknowledgment.
- Stay in English.`;
}

export function looksLikeVoiceHandoff(text: string): boolean {
  const t = text.toLowerCase();
  if (/tell me more about you|two-part interview/.test(t)) return false;
  return (
    /we'll move to the coding task next/.test(t) ||
    /that's the end of the interview/.test(t) ||
    /that is the end of the interview/.test(t) ||
    /coding (task|exercise|part) comes next/.test(t) ||
    /move (on )?to (the )?(coding|next part)/.test(t) ||
    /we'll (now )?move to/.test(t) ||
    /next (up|part) is (the )?coding/.test(t) ||
    /that's all for (the )?(voice|interview)/.test(t) ||
    /voice (section|part) is (over|done|complete)/.test(t) ||
    /we've (reached|come to) the end/.test(t) ||
    /let's (get|move) (you )?to the coding/.test(t)
  );
}

export function orderTranscriptTurns<T extends { role: "assistant" | "user" }>(turns: T[]): T[] {
  const firstAssistant = turns.findIndex((t) => t.role === "assistant");
  if (firstAssistant < 0) return [...turns];

  const leadingUsers: T[] = [];
  const rest: T[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i < firstAssistant && turns[i].role === "user") leadingUsers.push(turns[i]);
    else rest.push(turns[i]);
  }

  const seeded: T[] = [];
  for (let i = 0; i < rest.length; i++) {
    seeded.push(rest[i]);
    if (i === 0 && rest[i].role === "assistant" && leadingUsers.length) {
      seeded.push(...leadingUsers);
    }
  }

  const result: T[] = [];
  for (const turn of seeded) {
    if (turn.role !== "user") {
      result.push(turn);
      continue;
    }
    let insertAt = result.length;
    while (
      insertAt >= 2 &&
      result[insertAt - 1]?.role === "assistant" &&
      result[insertAt - 2]?.role === "assistant"
    ) {
      insertAt -= 1;
    }
    if (insertAt === 0 && result[0]?.role === "assistant") insertAt = 1;
    result.splice(insertAt, 0, turn);
  }
  return result;
}

export function extractQaPairs(
  turns: { role: "assistant" | "user"; text: string }[],
): { question: string; answer: string }[] {
  const ordered = orderTranscriptTurns(turns);
  const pairs: { question: string; answer: string }[] = [];
  let question = "";
  let answer = "";

  const flush = () => {
    if (question.trim() && answer.trim()) {
      pairs.push({ question: question.trim(), answer: answer.trim() });
    }
    question = "";
    answer = "";
  };

  for (const turn of ordered) {
    const text = turn.text.trim();
    if (!text) continue;
    if (turn.role === "assistant") {
      if (looksLikeVoiceHandoff(text)) {
        flush();
        continue;
      }
      if (answer) flush();
      question = question ? `${question} ${text}` : text;
    } else {
      answer = answer ? `${answer} ${text}` : text;
    }
  }
  flush();
  return pairs;
}

