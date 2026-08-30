import { sanitizeInline } from "./sanitize.ts";
import {
  bodyLines,
  fitLine,
  segment,
  wrapPrefixedLines,
  type BlockContext,
  type StyledLine,
} from "./segments.ts";
import { treeGlyphs } from "./theme.ts";

export interface QuestionnaireOptionView {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface QuestionnaireQuestionView {
  readonly id: string;
  readonly decisionKey: string;
  readonly tab: string;
  readonly question: string;
  readonly kind: "single_select" | "multi_select" | "text";
  readonly required: boolean;
  readonly options?: readonly QuestionnaireOptionView[];
  readonly allowCustom?: boolean;
}

export interface QuestionnaireAnswerView {
  readonly questionId: string;
  readonly decisionKey: string;
  readonly selectedOptionIds?: readonly string[];
  readonly customText?: string;
}

export interface QuestionnaireRenderState {
  readonly questionnaireId: string;
  readonly reason: string;
  readonly questions: readonly QuestionnaireQuestionView[];
  readonly allowDraftNow: boolean;
  readonly activeQuestionIndex: number;
  readonly answers: readonly QuestionnaireAnswerView[];
  readonly optionCursor: number;
  readonly textCursor: number;
  readonly editingCustom?: boolean;
  readonly pauseMenuSelected?: number;
  readonly validationMessage?: string;
}

export interface QuestionnairePauseAction {
  readonly status: "return" | "draft_now" | "paused" | "cancelled";
  readonly label: string;
}

export function questionnairePauseActions(
  allowDraftNow: boolean,
): readonly QuestionnairePauseAction[] {
  return [
    { status: "return", label: "Return to questions" },
    ...(allowDraftNow
      ? [{ status: "draft_now" as const, label: "Write the plan now with current answers" }]
      : []),
    { status: "paused", label: "Pause Deep Plan" },
    { status: "cancelled", label: "Cancel this Deep Plan" },
  ];
}

function answerFor(
  state: QuestionnaireRenderState,
  questionId: string,
): QuestionnaireAnswerView | undefined {
  return state.answers.find((answer) => answer.questionId === questionId);
}

function answered(answer: QuestionnaireAnswerView | undefined): boolean {
  return answer !== undefined && (
    (answer.selectedOptionIds?.length ?? 0) > 0 ||
    (answer.customText?.trim().length ?? 0) > 0
  );
}

function progressLine(
  state: QuestionnaireRenderState,
  context: BlockContext,
): StyledLine {
  const active = Math.max(0, Math.min(state.questions.length - 1, state.activeQuestionIndex));
  if (context.columns < 72) {
    const question = state.questions[active];
    return fitLine("approval", [
      segment(
        `  ${active + 1}/${state.questions.length} `,
        { fg: "accent.cyan", bold: true },
      ),
      segment(sanitizeInline(question?.tab ?? "Question", 24), {
        fg: "fg.primary",
        bold: true,
      }),
    ], context);
  }
  const parts = state.questions.flatMap((question, index) => {
    const isActive = index === active;
    const isDone = answered(answerFor(state, question.id));
    const marker = isActive ? "●" : isDone ? "✓" : "○";
    const token = isActive ? "accent.cyan" : isDone ? "accent.green" : "fg.muted";
    return [
      segment(`  ${marker} `, { fg: token, bold: isActive }),
      segment(sanitizeInline(question.tab, 24), {
        fg: isActive ? "fg.primary" : "fg.muted",
        bold: isActive,
      }),
    ];
  });
  parts.push(segment(`    ${active + 1}/${state.questions.length}`, {
    fg: "fg.muted",
    dim: true,
  }));
  return fitLine("approval", parts, context);
}

function renderTextEditor(
  state: QuestionnaireRenderState,
  question: QuestionnaireQuestionView,
  context: BlockContext,
): StyledLine[] {
  const text = answerFor(state, question.id)?.customText ?? "";
  const clean = sanitizeInline(text, 2_000);
  const cursor = Math.max(0, Math.min(clean.length, state.textCursor));
  const before = clean.slice(0, cursor);
  const at = clean.slice(cursor, cursor + 1) || " ";
  const after = clean.slice(cursor + 1);
  return [
    fitLine("approval", [
      segment("  > ", { fg: "accent.cyan", bold: true }),
      segment(before, { fg: "fg.primary" }),
      segment(at, { fg: "bg.base", bg: "accent.cyan" }),
      segment(after, { fg: "fg.primary" }),
    ], context),
  ];
}

function renderOptions(
  state: QuestionnaireRenderState,
  question: QuestionnaireQuestionView,
  context: BlockContext,
): StyledLine[] {
  const lines: StyledLine[] = [];
  const answer = answerFor(state, question.id);
  const selected = new Set(answer?.selectedOptionIds ?? []);
  const options = question.options ?? [];
  for (const [index, option] of options.entries()) {
    const active = index === state.optionCursor;
    const checked = selected.has(option.id);
    const stateMark = question.kind === "multi_select"
      ? checked ? "[x]" : "[ ]"
      : checked ? "(*)" : "( )";
    const prefix = [
      segment(active ? "  > " : "    ", {
        fg: active ? "accent.cyan" : "fg.muted",
        bold: active,
      }),
      segment(`${index + 1}. ${stateMark} `, {
        fg: checked ? "accent.green" : "fg.muted",
        bold: active || checked,
      }),
    ];
    const label = option.recommended === true
      ? `${option.label}  [Recommended]`
      : option.label;
    lines.push(...wrapPrefixedLines(
      prefix,
      sanitizeInline(label, 120),
      context,
      { fg: active ? "fg.primary" : "fg.muted", bold: active },
      "approval",
    ));
    if (option.description !== undefined) {
      lines.push(...bodyLines(sanitizeInline(option.description, 300), context, {
        indent: "       ",
        kind: "approval",
        style: { fg: "fg.muted", dim: !active },
      }));
    }
  }

  if (question.allowCustom === true) {
    const index = options.length;
    const active = state.optionCursor === index;
    const hasCustom = (answer?.customText?.trim().length ?? 0) > 0;
    lines.push(...wrapPrefixedLines(
      [
        segment(active ? "  > " : "    ", {
          fg: active ? "accent.cyan" : "fg.muted",
          bold: active,
        }),
        segment(`${index + 1}. ${hasCustom ? "(*)" : "( )"} `, {
          fg: hasCustom ? "accent.green" : "fg.muted",
        }),
      ],
      state.editingCustom === true && active
        ? answer?.customText ?? ""
        : hasCustom
          ? `Other: ${answer?.customText ?? ""}`
          : "Other — type a custom answer",
      context,
      { fg: active ? "fg.primary" : "fg.muted", bold: active },
      "approval",
    ));
    if (state.editingCustom === true && active) {
      lines.push(...renderTextEditor(state, question, context));
    }
  }
  return lines;
}

/** Width-aware tabbed questionnaire card for full-screen interactive input. */
export function renderQuestionnaire(
  state: QuestionnaireRenderState,
  context: BlockContext,
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const dividerWidth = Math.max(12, context.columns);
  const lines: StyledLine[] = [
    fitLine("approval", [
      segment(glyphs.horizontal.repeat(dividerWidth), { fg: "border.warm", dim: true }),
    ], context),
    fitLine("approval", [
      segment("  ?  ", { fg: "accent.cyan" }),
      segment("Deep Plan", { fg: "accent.cyan", bold: true }),
      segment(`  ${sanitizeInline(state.reason, 1_200)}`, { fg: "fg.muted" }),
    ], context),
    progressLine(state, context),
    fitLine("approval", [], context),
  ];

  if (state.pauseMenuSelected !== undefined) {
    lines.push(
      fitLine("approval", [
        segment("  Pause Deep Plan", { fg: "accent.amber", bold: true }),
      ], context),
    );
    for (const [index, action] of questionnairePauseActions(state.allowDraftNow).entries()) {
      const active = index === state.pauseMenuSelected;
      lines.push(...wrapPrefixedLines(
        [segment(active ? "  > " : "    ", {
          fg: active ? "accent.cyan" : "fg.muted",
          bold: active,
        })],
        `${index + 1}. ${action.label}`,
        context,
        { fg: active ? "fg.primary" : "fg.muted", bold: active },
        "approval",
      ));
    }
  } else {
    const question = state.questions[state.activeQuestionIndex];
    if (question !== undefined) {
      lines.push(...bodyLines(sanitizeInline(question.question, 1_200), context, {
        indent: "  ",
        kind: "approval",
        style: { fg: "fg.primary", bold: true },
      }));
      if (question.required) {
        lines.push(fitLine("approval", [
          segment("  Required", { fg: "accent.amber", dim: true }),
        ], context));
      }
      lines.push(fitLine("approval", [], context));
      if (question.kind === "text") {
        lines.push(...renderTextEditor(state, question, context));
      } else {
        lines.push(...renderOptions(state, question, context));
      }
    }
  }

  if (state.validationMessage !== undefined) {
    lines.push(...bodyLines(sanitizeInline(state.validationMessage, 300), context, {
      indent: "  ! ",
      kind: "approval",
      style: { fg: "accent.red", bold: true },
    }));
  }
  lines.push(fitLine("approval", [], context));
  lines.push(
    fitLine("approval", [
      segment(
        state.pauseMenuSelected === undefined
          ? "  Tab/→ next · Shift+Tab/← previous · ↑↓ move · Enter select · Esc pause"
          : "  ↑↓ move · Enter choose · Esc return",
        { fg: "fg.muted", italic: true },
      ),
    ], context),
  );
  lines.push(
    fitLine("approval", [
      segment(glyphs.horizontal.repeat(dividerWidth), { fg: "border.warm", dim: true }),
    ], context),
  );
  return lines;
}
