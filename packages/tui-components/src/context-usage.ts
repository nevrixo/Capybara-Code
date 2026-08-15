import type {
  ContextUsageCategory,
  ContextUsageSnapshot,
} from "@cbc/session-domain";

import { fitLine, line, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import type { ThemeToken } from "./theme.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

const CATEGORY_ORDER: readonly ContextUsageCategory[] = [
  "system_prompt",
  "system_tools",
  "tool_io",
  "messages",
];

const LABELS: Readonly<Record<ContextUsageCategory, string>> = {
  system_prompt: "System prompt",
  system_tools: "System tools",
  tool_io: "Tool use & results",
  messages: "Messages",
};

const GLYPHS: Readonly<Record<ContextUsageCategory | "free", { readonly unicode: string; readonly ascii: string; readonly token: ThemeToken }>> = {
  system_prompt: { unicode: "●", ascii: "S", token: "accent.coral" },
  system_tools: { unicode: "◉", ascii: "T", token: "accent.cyan" },
  tool_io: { unicode: "◆", ascii: "O", token: "accent.amber" },
  messages: { unicode: "■", ascii: "M", token: "accent.green" },
  free: { unicode: "□", ascii: ".", token: "fg.muted" },
};

export interface ContextUsageRenderOptions {
  readonly details?: readonly StyledLine[];
}

export function renderContextUsage(
  snapshot: ContextUsageSnapshot | undefined,
  context: BlockContext,
  options: ContextUsageRenderOptions = {},
): StyledLine[] {
  if (snapshot === undefined) {
    return [
      fitLine("overlay", [segment("Context Usage  No compiled request yet", { fg: "fg.muted" })], context),
      fitLine("body", [segment("Compile a provider request to measure context usage.", { fg: "fg.primary" })], context),
    ];
  }

  const percent = snapshot.budgetTokens > 0
    ? Math.min(100, (snapshot.usedTokens / snapshot.budgetTokens) * 100)
    : 0;
  const header = `Context Usage  ${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.budgetTokens)} ${percent.toFixed(1)}%`;
  const source = snapshot.source === "provider_reconciled" ? "provider-reconciled" : snapshot.source;
  const lines: StyledLine[] = [
    fitLine("header", [segment(header, { fg: "fg.primary", bold: true })], context),
    fitLine(
      "body",
      [
        segment(`${snapshot.modelId}  `, { fg: "accent.cyan" }),
        segment(`window ${formatTokens(snapshot.modelWindowTokens)} · reserve ${formatTokens(snapshot.outputReserveTokens)} · ${source}`, { fg: "fg.muted" }),
      ],
      context,
    ),
  ];

  if (context.columns >= 40) {
    const cells = context.columns >= 56 ? 100 : 20;
    lines.push(...renderGrid(snapshot, context, cells));
  }
  lines.push(...renderLegend(snapshot, context));
  if (snapshot.overageTokens > 0) {
    lines.push(fitLine("notice", [segment(`Over budget +${formatTokens(snapshot.overageTokens)}`, { fg: "accent.red", bold: true })], context));
  }
  lines.push(
    fitLine("body", [segment(`Cached input ${formatTokens(snapshot.cachedInputTokens)} · d details · esc close`, { fg: "fg.muted" })], context),
  );
  if (options.details !== undefined) lines.push(...options.details);
  return lines;
}

function renderGrid(snapshot: ContextUsageSnapshot, context: BlockContext, cellCount: number): StyledLine[] {
  const entries = allocateCells(snapshot, cellCount);
  const width = cellCount === 100 ? 10 : 20;
  const cells: Segment[] = [];
  for (const entry of entries) {
    const glyph = GLYPHS[entry.id];
    const text = context.capabilities.unicode ? glyph.unicode : glyph.ascii;
    for (let index = 0; index < entry.cells; index += 1) cells.push(segment(text, { fg: glyph.token }));
  }
  const rows: StyledLine[] = [];
  for (let index = 0; index < cells.length; index += width) {
    rows.push(fitLine("body", cells.slice(index, index + width), context));
  }
  return rows;
}

function renderLegend(snapshot: ContextUsageSnapshot, context: BlockContext): StyledLine[] {
  const rows: StyledLine[] = [];
  for (const category of CATEGORY_ORDER) {
    const tokens = snapshot.categories[category];
    const fraction = snapshot.usedTokens > 0 ? (tokens / snapshot.usedTokens) * 100 : 0;
    const glyph = GLYPHS[category];
    rows.push(fitLine("body", [
      segment(`${context.capabilities.unicode ? glyph.unicode : glyph.ascii} `, { fg: glyph.token }),
      segment(`${LABELS[category].padEnd(20)} `, { fg: "fg.primary" }),
      segment(`${formatTokens(tokens).padStart(7)} ${fraction.toFixed(1).padStart(5)}%`, { fg: "fg.muted" }),
    ], context));
  }
  const freeFraction = snapshot.budgetTokens > 0 ? (snapshot.freeTokens / snapshot.budgetTokens) * 100 : 0;
  const free = GLYPHS.free;
  rows.push(fitLine("body", [
    segment(`${context.capabilities.unicode ? free.unicode : free.ascii} `, { fg: free.token }),
    segment(`${"Free space".padEnd(20)} `, { fg: "fg.primary" }),
    segment(`${formatTokens(snapshot.freeTokens).padStart(7)} ${freeFraction.toFixed(1).padStart(5)}%`, { fg: "fg.muted" }),
  ], context));
  return rows;
}

function allocateCells(snapshot: ContextUsageSnapshot, cellCount: number): Array<{ readonly id: ContextUsageCategory | "free"; readonly cells: number }> {
  const entries = [...CATEGORY_ORDER.map((id) => ({ id, tokens: Math.max(0, snapshot.categories[id]) })), { id: "free" as const, tokens: Math.max(0, snapshot.freeTokens) }];
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total === 0) return entries.map((entry) => ({ id: entry.id, cells: entry.id === "free" ? cellCount : 0 }));
  const raw = entries.map((entry, order) => {
    const exact = entry.tokens / total * cellCount;
    const floor = Math.floor(exact);
    return { ...entry, order, floor, remainder: exact - floor };
  });
  let remaining = cellCount - raw.reduce((sum, entry) => sum + entry.floor, 0);
  for (const entry of [...raw].sort((a, b) => b.remainder - a.remainder || a.order - b.order)) {
    if (remaining <= 0) break;
    entry.floor += 1;
    remaining -= 1;
  }
  return raw.map((entry) => ({ id: entry.id, cells: entry.floor }));
}

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.floor(value));
  if (normalized >= 1000) return `${(normalized / 1000).toFixed(normalized >= 10_000 ? 1 : 2).replace(/\.00$/u, "")}k`;
  return normalized.toLocaleString("en-US");
}
