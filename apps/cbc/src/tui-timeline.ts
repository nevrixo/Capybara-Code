/**
 * Timeline presentation — P1-02 split of the former `InteractiveUi` god class.
 *
 * The TimelinePresenter half: turns reducer timeline items (and provider
 * streaming text that has not durable-landed yet) into the items a frame
 * renders, in the order and shape both the append-only and full-screen paths
 * need. Pure functions only — no terminal, no state.
 */

import type { TimelineItem, TimelineSubagentEvent, TimelineTask } from "@cbc/session-domain";

export function subagentEventAsTool(taskId: string, event: TimelineSubagentEvent): TimelineItem {
  return {
    type: "tool",
    id: event.id,
    sequence: event.sequence,
    callId: event.callId,
    toolId: event.toolId,
    argumentsSummary: event.argumentsSummary,
    agentId: taskId,
    status: event.status,
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    ...(event.progress !== undefined ? { progress: event.progress } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.additions !== undefined ? { additions: event.additions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.artifacts !== undefined ? { artifacts: [...event.artifacts] } : {}),
    ...(event.diffPreview !== undefined ? { diffPreview: [...event.diffPreview] } : {}),
  };
}

export interface PlainTimelineRecord {
  readonly item: TimelineItem;
  readonly sequence: number;
  readonly order: number;
  readonly parentTask?: TimelineTask;
  readonly childEvent?: TimelineSubagentEvent;
}

export const SUBAGENT_PLAIN_VISIBLE = 3;
export const SUBAGENT_HEADER_ONLY = true;

export function chronologicalPlainRecords(items: readonly TimelineItem[]): PlainTimelineRecord[] {
  const records: PlainTimelineRecord[] = [];
  let order = 0;
  for (const item of items) {
    records.push({ item, sequence: item.sequence, order: order++ });
    if (item.type !== "task") continue;
    const events = item.subagentEvents;
    if (events.length === 0) continue;
    const hidden = Math.max(0, events.length - SUBAGENT_PLAIN_VISIBLE);
    if (hidden > 0) {
      records.push({
        item: {
          type: "notice",
          id: `${item.id}::subagent-hidden`,
          sequence: events[hidden]!.sequence - 1,
          level: "info",
          text: `↳ subagent ${item.title} — … ${hidden} earlier call(s) hidden · showing last ${SUBAGENT_PLAIN_VISIBLE}`,
          icon: "…",
        } as TimelineItem,
        sequence: events[hidden]!.sequence - 1,
        order: order++,
      });
    }
    const visible = hidden > 0 ? events.slice(-SUBAGENT_PLAIN_VISIBLE) : events;
    for (const event of visible) {
      records.push({
        item: subagentEventAsTool(item.taskId, event),
        sequence: event.sequence,
        order: order++,
        parentTask: item,
        childEvent: event,
      });
    }
  }
  records.sort((left, right) => {
    const sequence = left.sequence - right.sequence;
    if (sequence !== 0) return sequence;
    // Keep an anchor before a child when a replayed or synthetic event shares its
    // sequence. Stable insertion order handles unrelated ties.
    const leftChild = left.childEvent === undefined ? 0 : 1;
    const rightChild = right.childEvent === undefined ? 0 : 1;
    return leftChild - rightChild || left.order - right.order;
  });
  return records;
}

export function timelineSubagentEventEqual(
  left: TimelineSubagentEvent | undefined,
  right: TimelineSubagentEvent | undefined,
): boolean {
  return timelineValueEqual(left, right);
}

export function timelineItemEqual(left: TimelineItem, right: TimelineItem): boolean {
  return timelineValueEqual(left, right);
}

function timelineValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => timelineValueEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && timelineValueEqual(leftRecord[key], rightRecord[key]),
  );
}

export function taskHasChildDelta(item: TimelineTask, previous: TimelineItem): boolean {
  if (previous.type !== "task") return true;
  if (item.subagentEvents.length !== previous.subagentEvents.length) return true;
  const prior = new Map(previous.subagentEvents.map((event) => [event.id, event]));
  return item.subagentEvents.some((event) => !timelineSubagentEventEqual(prior.get(event.id), event));
}
export function cloneTimelineItemForUi(item: TimelineItem): TimelineItem {
  if (item.type === "task") {
    return {
      ...item,
      subagentEvents: item.subagentEvents.map((event) => ({
        ...event,
        ...(event.artifacts !== undefined ? { artifacts: [...event.artifacts] } : {}),
        ...(event.diffPreview !== undefined ? { diffPreview: [...event.diffPreview] } : {}),
      })),
    };
  }
  if (item.type === "plan") {
    return { ...item, items: item.items.map((entry) => ({ ...entry })) };
  }
  if (item.type === "tool" && item.diffPreview !== undefined) {
    return { ...item, diffPreview: [...item.diffPreview] };
  }
  return { ...item } as TimelineItem;
}
export function streamingTimelineItems(
  baseSequence: number,
  commentary: string,
  reasoning: string,
  finalText: string,
  provisionalText: string,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let sequence = baseSequence;
  if (commentary.length > 0) {
    items.push({
      type: "commentary",
      id: "streaming-commentary",
      sequence: ++sequence,
      variant: "commentary",
      text: commentary,
    });
  }
  if (reasoning.length > 0) {
    const preview = reasoning
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 160);
    items.push({
      type: "thinking",
      id: "thinking:streaming:root:streaming:0",
      sequence: ++sequence,
      turnId: "turn:streaming",
      agentId: "root",
      requestId: "streaming",
      segmentIndex: 0,
      providerItemIds: [],
      state: "streaming",
      sources: ["provider_reasoning"],
      ...(preview !== undefined ? { summaryText: preview, summaryOrigin: "derived_from_visible_detail" as const } : {}),
      detailText: reasoning,
    });
  }
  if (provisionalText.length > 0) {
    items.push({
      type: "commentary",
      id: "streaming-provisional",
      sequence: ++sequence,
      variant: "commentary",
      text: provisionalText,
    });
  }
  if (finalText.length > 0) {
    items.push({
      type: "final",
      id: "streaming-answer",
      sequence: ++sequence,
      text: finalText,
    });
  }
  return items;
}
