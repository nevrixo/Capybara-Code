import {
  truncateToWidth,
  type CompletionCandidate,
} from "@cbc/tui-components";

import type { RuntimeSessionSummary } from "./runtime.ts";

const RESUME_CANDIDATE_LIMIT = 30;
const RESUME_TITLE_COLUMNS = 52;
const SESSION_ID_TIMESTAMP =
  /^ses_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[^_]+$/u;

type ResumeSessionSummary = Pick<
  RuntimeSessionSummary,
  "id" | "createdAt" | "updatedAt" | "title" | "state" | "turnCount"
>;

/**
 * Build the `/resume` picker rows in most-recently-active order.
 *
 * The opaque session id remains the completion's inserted value, while the row
 * itself leads with a local timestamp and a human title. This keeps selection
 * exact without making users decode `ses_2026...` identifiers.
 */
export function buildResumeCandidates(
  sessions: readonly ResumeSessionSummary[],
): CompletionCandidate[] {
  return [...sessions]
    .sort(compareSessionRecency)
    .slice(0, RESUME_CANDIDATE_LIMIT)
    .map((session) => {
      const title = readableSessionTitle(session);
      const timestamp = formatLocalMinute(sessionTimestampMs(session));
      const turns = `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"}`;

      return {
        value: `${timestamp} · ${truncateToWidth(title, RESUME_TITLE_COLUMNS)}`,
        detail: `${session.state} · ${turns} · id ${shortSessionId(session.id)}`,
        insert: session.id,
      };
    });
}

function compareSessionRecency(
  left: ResumeSessionSummary,
  right: ResumeSessionSummary,
): number {
  const leftTime = sessionTimestampMs(left) ?? Number.NEGATIVE_INFINITY;
  const rightTime = sessionTimestampMs(right) ?? Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime > leftTime ? 1 : -1;

  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

function sessionTimestampMs(session: ResumeSessionSummary): number | undefined {
  for (const value of [session.updatedAt, session.createdAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  const match = SESSION_ID_TIMESTAMP.exec(session.id);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatLocalMinute(timestampMs: number | undefined): string {
  if (timestampMs === undefined) return "Unknown time";
  const date = new Date(timestampMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function readableSessionTitle(session: ResumeSessionSummary): string {
  const title = session.title.replace(/\s+/gu, " ").trim();
  if (title.length > 0 && !/^untitled(?: session)?$/iu.test(title)) return title;
  return session.turnCount === 0 ? "Empty session" : "Untitled session";
}

function shortSessionId(id: string): string {
  const suffix = /_([^_]+)$/u.exec(id)?.[1] ?? id;
  return truncateToWidth(suffix, 12);
}
