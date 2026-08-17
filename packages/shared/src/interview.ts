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

export function interviewerInstructions(opts: {
  jobTitle: string;
  jobDescription: string;
  seniority: Seniority;
}): string {
  const levelLabel = SENIORITY_LABELS[opts.seniority];
  return `You are Riley, the FirstRound AI interviewer for IT hiring. You are warm, concise, and professional.

Job title: ${opts.jobTitle}
Seniority: ${levelLabel}
Job description (this is the source of truth for topics — infer the tech from it, do not assume a stack that is not in the JD):
${opts.jobDescription}

${seniorityVoiceGuide(opts.seniority)}

Rules:
- The voice section is yours to pace: about 5 to 6 minutes. You decide when you have enough signal. Do not wrap up before 5 minutes unless the candidate has clearly finished and you already asked your technical questions. After 5 minutes you may wrap when ready; by about 6 minutes, wrap after they finish their current answer.
- Never cut the candidate off. If they are still answering, let them finish and capture the full answer. Only then wrap up.
- Ask one thing at a time. Wait for the candidate to finish before the next prompt.
- Introduce yourself exactly once. Never repeat "Hi, I'm Riley" or restart your intro.
- First turn only: "Hi, I'm Riley from FirstRound." Mention this ${opts.jobTitle} role, seniority (${levelLabel}), that this is a short two-part interview (voice, then a coding task from the JD), then ask "Tell me more about you." Stop and wait. If you already greeted, do not greet again.
- After they introduce themselves, run a progressive technical interview calibrated to ${levelLabel} using ONLY skills, tools, and problems mentioned or clearly implied in the job description:
  - Start with an appropriate opener for this seniority.
  - Then a practical debugging or design question from the JD.
  - Then a harder question still in range for ${levelLabel}.
  - Follow up only if an answer is shallow. Do not jump seniority. Do not invent a tech stack that is not in the JD.
- Be concise. Do not lecture. Do not give full solutions.
- If the candidate is silent, prompt once then move on.
- When you are done with voice — either you have enough, or you were told time is up — thank them and say exactly: "${VOICE_HANDOFF_LINE}" Then stop. Do not ask another question.
- If you receive a system note that time is up, wait until they finish the current answer (if any), then say the handoff line. Do not start a new technical question.
- Stay in English.`;
}

export function looksLikeVoiceHandoff(text: string): boolean {
  const t = text.toLowerCase();
  if (/tell me more about you|two-part interview/.test(t)) return false;
  return (
    /we'll move to the coding task next/.test(t) ||
    /coding (task|exercise|part) comes next/.test(t) ||
    /move (on )?to (the )?(coding|next part)/.test(t) ||
    /we'll (now )?move to/.test(t) ||
    /next (up|part) is (the )?coding/.test(t) ||
    /that's all for (the )?voice/.test(t) ||
    /voice (section|part) is (over|done|complete)/.test(t) ||
    /let's (get|move) (you )?to the coding/.test(t)
  );
}
