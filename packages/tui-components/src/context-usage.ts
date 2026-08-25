import type {
  ContextUsageCategory,
  ContextPressureViewState,
  ContextUsageSnapshot,
} from "@cbc/session-domain";

import { formatTokens } from "./chrome.ts";
import { fitLine, line, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import type { ThemeToken } from "./theme.ts";
import { stringWidth } from "./width.ts";

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

const GLYPHS: Readonly<Record<ContextUsageCategory | "free" | "reserved" | "cached", { readonly unicode: string; readonly ascii: string; readonly token: ThemeToken }>> = {
  system_prompt: { unicode: "●", ascii: "S", token: "accent.coral" },
  system_tools: { unicode: "◉", ascii: "T", token: "accent.cyan" },
  tool_io: { unicode: "◆", ascii: "O", token: "accent.amber" },
  messages: { unicode: "■", ascii: "M", token: "accent.purple" },
  free: { unicode: "□", ascii: ".", token: "fg.muted" },
  reserved: { unicode: "⊠", ascii: "R", token: "accent.blue" },
  cached: { unicode: "⚡", ascii: "C", token: "accent.cyan" },
};

export interface ContextInspectionLike {
  readonly softBudgetTokens?: number;
  readonly usedTokens?: number;
  readonly usedFraction?: number;
  readonly layers?: Array<{ layer: string; estimatedTokens: number; detail: string }>;
  readonly activeFiles?: Array<{ path: string; lines: string; checksum: string }>;
  readonly skills?: Array<{ name: string; version?: string; source: string }>;
  readonly toolSchemas?: string[];
  readonly reasoning?: { items: number; note: string };
  readonly cachePrefixFingerprint?: string;
  readonly compiledPackId?: string;
  readonly compiledInputTokens?: number;
  readonly compilerPack?: {
    readonly id: string;
    readonly manifestDigest: string;
    readonly included: number;
    readonly excluded: number;
    readonly fallback: boolean;
  };
  readonly excludedLargeOutputs?: Array<{ label: string; bytes: number; artifactId?: string }>;
  readonly instructionsSkipped?: Array<{ path: string; reason: string }>;
  readonly recentFailures?: Array<{ toolId: string; category: string; paths: string[] }>;
}

export interface ContextUsageRenderOptions {
  readonly details?: readonly StyledLine[];
  readonly inspection?: ContextInspectionLike;
  readonly pressure?: ContextPressureViewState;
}

export function renderContextUsage(
  snapshot: ContextUsageSnapshot | undefined,
  context: BlockContext,
  options: ContextUsageRenderOptions = {},
): StyledLine[] {
  if (snapshot === undefined) {
    const emptyLines: StyledLine[] = [
      fitLine("header", [
        segment("Context Usage  ", { fg: "fg.primary", bold: true }),
        segment("No compiled request yet", { fg: "fg.muted" }),
      ], context),
      fitLine("body", [
        segment("  └ ", { fg: "fg.muted" }),
        segment("Compile a provider request to measure context usage.", { fg: "fg.muted" }),
      ], context),
    ];
    if (options.inspection !== undefined) {
      emptyLines.push(...renderStyledInspection(options.inspection, context));
    } else if (options.details !== undefined) {
      emptyLines.push(...options.details);
    }
    return emptyLines;
  }

  const percent = snapshot.budgetTokens > 0
    ? Math.min(100, (snapshot.usedTokens / snapshot.budgetTokens) * 100)
    : 0;

  const usageTokenColor: ThemeToken = percent > 90 ? "accent.red" : percent > 75 ? "accent.amber" : "accent.cyan";
  const source = snapshot.source === "provider_reconciled" ? "provider-reconciled" : snapshot.source;

  const lines: StyledLine[] = [
    ...(options.pressure === undefined ? [] : [fitLine("notice", [
      segment("  Pressure: ", { fg: "fg.muted", bold: true }),
      segment(options.pressure.state, { fg: options.pressure.state === "emergency" ? "accent.red" : options.pressure.state === "compact" ? "accent.amber" : "accent.cyan", bold: true }),
      ...(options.pressure.reasonCodes.length > 0 ? [segment(` · ${options.pressure.reasonCodes.join(", ")}`, { fg: "fg.muted" })] : []),
    ], context)]),
    fitLine(
      "header",
      [
        segment("Context Usage  ", { fg: "fg.primary", bold: true }),
        segment(`${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.budgetTokens)} tokens`, { fg: usageTokenColor, bold: true }),
        segment(` (${percent.toFixed(1)}%)`, { fg: "fg.muted" }),
      ],
      context,
    ),
    fitLine(
      "body",
      [
        segment("  └ ", { fg: "fg.muted" }),
        segment(snapshot.modelId, { fg: "accent.cyan", bold: true }),
        segment(` · window ${formatTokens(snapshot.modelWindowTokens)} · reserve ${formatTokens(snapshot.outputReserveTokens)} · ${source}`, { fg: "fg.muted" }),
      ],
      context,
    ),
    fitLine("body", [segment("")], context),
  ];

  // Grid & Legend layout
  if (context.columns >= 56) {
    // Side-by-side 2-column layout (Claude Code style)
    lines.push(...renderSideBySide(snapshot, context));
  } else if (context.columns >= 40) {
    lines.push(...renderGrid(snapshot, context, 20));
    lines.push(...renderLegendRows(snapshot, context));
  } else {
    lines.push(...renderLegendRows(snapshot, context));
  }

  if (snapshot.overageTokens > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("notice", [
        segment("  ⚠ Over budget: ", { fg: "accent.red", bold: true }),
        segment(`+${formatTokens(snapshot.overageTokens)} tokens`, { fg: "accent.red" }),
      ], context),
    );
  }

  if (options.inspection !== undefined) {
    lines.push(...renderStyledInspection(options.inspection, context));
  } else if (options.details !== undefined) {
    lines.push(...options.details);
  }

  return lines;
}

function renderSideBySide(snapshot: ContextUsageSnapshot, context: BlockContext): StyledLine[] {
  const gridRows = getGridRows(snapshot, context, 100, 10);
  const legendRows = getLegendRows(snapshot, context);

  const totalRows = Math.max(gridRows.length, legendRows.length);
  const rows: StyledLine[] = [];

  for (let i = 0; i < totalRows; i += 1) {
    const gridSegs = gridRows[i] ?? [segment("".padEnd(20))];
    const legendSegs = legendRows[i] ?? [];
    rows.push(
      fitLine("body", [
        segment("  "),
        ...gridSegs,
        segment("    "),
        ...legendSegs,
      ], context),
    );
  }

  return rows;
}

function getGridRows(snapshot: ContextUsageSnapshot, context: BlockContext, cellCount: number, width: number): Segment[][] {
  const entries = allocateCells(snapshot, cellCount);
  const cells: Segment[] = [];
  const unicode = context.capabilities.unicode;

  for (const entry of entries) {
    const glyph = GLYPHS[entry.id];
    const text = unicode ? glyph.unicode : glyph.ascii;
    for (let index = 0; index < entry.cells; index += 1) {
      cells.push(segment(text + (unicode ? " " : " "), { fg: glyph.token }));
    }
  }

  const rows: Segment[][] = [];
  for (let index = 0; index < cells.length; index += width) {
    rows.push(cells.slice(index, index + width));
  }
  return rows;
}

function getLegendRows(snapshot: ContextUsageSnapshot, context: BlockContext): Segment[][] {
  const unicode = context.capabilities.unicode;
  const rows: Segment[][] = [];

  for (const category of CATEGORY_ORDER) {
    const tokens = snapshot.categories[category];
    const fraction = snapshot.usedTokens > 0 ? (tokens / snapshot.usedTokens) * 100 : 0;
    const glyph = GLYPHS[category];
    rows.push([
      segment(`${unicode ? glyph.unicode : glyph.ascii} `, { fg: glyph.token }),
      segment(`${LABELS[category]}: `, { fg: "fg.primary" }),
      segment(`${formatTokens(tokens)} tokens`, { fg: "fg.primary", bold: true }),
      segment(` (${fraction.toFixed(1)}%)`, { fg: "fg.muted" }),
    ]);
  }

  // Free space
  const freeFraction = snapshot.budgetTokens > 0 ? (snapshot.freeTokens / snapshot.budgetTokens) * 100 : 0;
  const free = GLYPHS.free;
  rows.push([
    segment(`${unicode ? free.unicode : free.ascii} `, { fg: free.token }),
    segment("Free space: ", { fg: "fg.primary" }),
    segment(`${formatTokens(snapshot.freeTokens)} tokens`, { fg: "fg.primary", bold: true }),
    segment(` (${freeFraction.toFixed(1)}%)`, { fg: "fg.muted" }),
  ]);

  // Output Reserve
  if (snapshot.outputReserveTokens > 0) {
    const res = GLYPHS.reserved;
    rows.push([
      segment(`${unicode ? res.unicode : res.ascii} `, { fg: res.token }),
      segment("Reserved: ", { fg: "fg.muted" }),
      segment(`${formatTokens(snapshot.outputReserveTokens)} tokens`, { fg: "fg.muted" }),
      segment(" [output reserve]", { fg: "fg.muted" }),
    ]);
  }

  // Cached input
  if (snapshot.cachedInputTokens > 0) {
    const cache = GLYPHS.cached;
    rows.push([
      segment(`${unicode ? cache.unicode : cache.ascii} `, { fg: cache.token }),
      segment("Cached input: ", { fg: "fg.muted" }),
      segment(`${formatTokens(snapshot.cachedInputTokens)} tokens`, { fg: "accent.cyan" }),
    ]);
  }

  return rows;
}

function renderGrid(snapshot: ContextUsageSnapshot, context: BlockContext, cellCount: number): StyledLine[] {
  const rows = getGridRows(snapshot, context, cellCount, cellCount === 100 ? 10 : 20);
  return rows.map((r) => fitLine("body", [segment("  "), ...r], context));
}

function renderLegendRows(snapshot: ContextUsageSnapshot, context: BlockContext): StyledLine[] {
  const rows = getLegendRows(snapshot, context);
  return rows.map((r) => fitLine("body", [segment("  "), ...r], context));
}

function allocateCells(snapshot: ContextUsageSnapshot, cellCount: number): Array<{ readonly id: ContextUsageCategory | "free"; readonly cells: number }> {
  const entries = [
    ...CATEGORY_ORDER.map((id) => ({ id, tokens: Math.max(0, snapshot.categories[id]) })),
    { id: "free" as const, tokens: Math.max(0, snapshot.freeTokens) },
  ];
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total === 0) return entries.map((entry) => ({ id: entry.id, cells: entry.id === "free" ? cellCount : 0 }));
  const raw = entries.map((entry, order) => {
    const exact = (entry.tokens / total) * cellCount;
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

export function renderStyledInspection(view: ContextInspectionLike, context: BlockContext): StyledLine[] {
  const lines: StyledLine[] = [];

  // Divider
  lines.push(fitLine("body", [segment("")], context));

  // Layers section
  if (view.layers && view.layers.length > 0) {
    const totalEstimated = view.layers.reduce((sum, row) => sum + row.estimatedTokens, 0);
    lines.push(
      fitLine("header", [
        segment("Layers", { fg: "fg.primary", bold: true }),
        segment(` · ${formatTokens(totalEstimated)} tokens estimated`, { fg: "fg.muted" }),
      ], context),
    );

    for (const row of view.layers) {
      const hasTokens = row.estimatedTokens > 0;
      const cleanLayer = row.layer.replace(/^L\d+_/, (m) => `${m.slice(0, 2)} `).replace(/_/g, " ");
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(`${cleanLayer.padEnd(20)} `, { fg: hasTokens ? "accent.cyan" : "fg.muted" }),
          segment(`${formatTokens(row.estimatedTokens).padStart(6)} tokens`, {
            fg: hasTokens ? "fg.primary" : "fg.muted",
            bold: hasTokens,
          }),
          segment(` · ${row.detail}`, { fg: "fg.muted" }),
        ], context),
      );
    }
  }

  // Active files section
  if (view.activeFiles && view.activeFiles.length > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Active Files", { fg: "fg.primary", bold: true }),
        segment(` · ${view.activeFiles.length} file(s)`, { fg: "fg.muted" }),
      ], context),
    );
    for (const file of view.activeFiles) {
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(file.path, { fg: "accent.cyan" }),
          segment(` (${file.lines})`, { fg: "fg.muted" }),
          segment(` sha256:${file.checksum.slice(0, 10)}…`, { fg: "fg.muted" }),
        ], context),
      );
    }
  }

  // Skills section
  if (view.skills && view.skills.length > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Skills", { fg: "fg.primary", bold: true }),
        segment(` · ${view.skills.length} available`, { fg: "fg.muted" }),
      ], context),
    );
    for (const skill of view.skills) {
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(skill.name, { fg: "accent.green", bold: true }),
          segment(skill.version ? ` v${skill.version}` : "", { fg: "fg.muted" }),
          segment(` [${skill.source}]`, { fg: "fg.muted" }),
        ], context),
      );
    }
  }

  // Reasoning & Cache
  if (view.reasoning !== undefined || view.cachePrefixFingerprint !== undefined) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [segment("Reasoning & Cache", { fg: "fg.primary", bold: true })], context),
    );
    if (view.reasoning !== undefined) {
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment("Reasoning items: ", { fg: "fg.muted" }),
          segment(String(view.reasoning.items), { fg: "accent.purple", bold: true }),
          segment(` (${view.reasoning.note})`, { fg: "fg.muted" }),
        ], context),
      );
    }
    if (view.cachePrefixFingerprint !== undefined) {
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment("Cache prefix: ", { fg: "fg.muted" }),
          segment(view.cachePrefixFingerprint, { fg: "fg.primary" }),
        ], context),
      );
    }
  }

  // Compiler Manifest
  if (view.compilerPack !== undefined) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Compiler Manifest", { fg: "fg.primary", bold: true }),
        segment(` · ${view.compilerPack.included} included, ${view.compilerPack.excluded} excluded${view.compilerPack.fallback ? ", fallback" : ""}`, { fg: "fg.muted" }),
      ], context),
      fitLine("body", [
        segment("  └ ", { fg: "fg.muted" }),
        segment(`Pack ID: ${view.compilerPack.id}`, { fg: "fg.muted" }),
      ], context),
      fitLine("body", [
        segment("  └ ", { fg: "fg.muted" }),
        segment(`Digest: ${view.compilerPack.manifestDigest}`, { fg: "fg.muted" }),
      ], context),
    );
  }

  // Excluded large outputs
  if (view.excludedLargeOutputs && view.excludedLargeOutputs.length > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Excluded Large Outputs", { fg: "accent.amber", bold: true }),
        segment(` · ${view.excludedLargeOutputs.length} item(s)`, { fg: "fg.muted" }),
      ], context),
    );
    for (const output of view.excludedLargeOutputs) {
      const artifact = output.artifactId !== undefined ? ` → ${output.artifactId}` : "";
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(output.label, { fg: "fg.primary" }),
          segment(` (${formatBytes(output.bytes)})`, { fg: "fg.muted" }),
          segment(artifact, { fg: "accent.cyan" }),
        ], context),
      );
    }
  }

  // Skipped instructions
  if (view.instructionsSkipped && view.instructionsSkipped.length > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Instruction Files Not Applied", { fg: "accent.amber", bold: true }),
      ], context),
    );
    for (const skipped of view.instructionsSkipped) {
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(skipped.path, { fg: "fg.primary" }),
          segment(`: ${skipped.reason}`, { fg: "fg.muted" }),
        ], context),
      );
    }
  }

  // Recent failures
  if (view.recentFailures && view.recentFailures.length > 0) {
    lines.push(
      fitLine("body", [segment("")], context),
      fitLine("header", [
        segment("Recent Failures Weighting Selection", { fg: "accent.red", bold: true }),
      ], context),
    );
    for (const failure of view.recentFailures) {
      const where = failure.paths.length > 0 ? `: ${failure.paths.join(", ")}` : "";
      lines.push(
        fitLine("body", [
          segment("  └ ", { fg: "fg.muted" }),
          segment(failure.toolId, { fg: "accent.red", bold: true }),
          segment(` (${failure.category})${where}`, { fg: "fg.muted" }),
        ], context),
      );
    }
  }

  return lines;
}

export function formatBytes(bytes: number): string {
  const normalized = Math.max(0, Math.floor(bytes));
  if (normalized >= 1024 * 1024) return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
  if (normalized >= 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${normalized} bytes`;
}
