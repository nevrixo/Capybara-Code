/**
 * Deep Plan domain state.
 *
 * Deep Plan is a conversational policy layered over Plan mode. This module is
 * deliberately UI- and provider-neutral: the TUI edits questionnaire drafts,
 * the tool bridge submits a result, and the kernel consumes only readiness and
 * the compact decision projection.
 */

export type DeepPlanMode = "off" | "on";
export type DeepPlanPhase =
  | "idle"
  | "investigating"
  | "questioning"
  | "drafting"
  | "validating"
  | "review_ready"
  | "revising"
  | "paused"
  | "completed"
  | "cancelled";
export type DeepPlanQuestionKind = "single_select" | "multi_select" | "text";
export type DeepPlanQuestionnaireStatus =
  | "submitted"
  | "draft_now"
  | "paused"
  | "cancelled"
  | "unavailable";

export interface DeepPlanQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface DeepPlanQuestion {
  readonly id: string;
  readonly decisionKey: string;
  readonly tab: string;
  readonly question: string;
  readonly kind: DeepPlanQuestionKind;
  readonly required: boolean;
  readonly options?: readonly DeepPlanQuestionOption[];
  readonly allowCustom?: boolean;
  readonly revisitReason?: string;
}

export interface UserAskBatchInput {
  readonly questionnaireId: string;
  readonly reason: string;
  readonly questions: readonly DeepPlanQuestion[];
  readonly allowDraftNow?: boolean;
}

export interface DeepPlanAnswer {
  readonly questionId: string;
  readonly decisionKey: string;
  readonly selectedOptionIds?: readonly string[];
  readonly customText?: string;
}

export interface UserAskBatchResult {
  readonly questionnaireId: string;
  readonly status: DeepPlanQuestionnaireStatus;
  readonly answers: readonly DeepPlanAnswer[];
}

export interface DeepPlanQuestionnaire extends UserAskBatchInput {
  readonly allowDraftNow: boolean;
  readonly activeQuestionIndex: number;
  readonly draftAnswers: readonly DeepPlanAnswer[];
  readonly openedAt: string;
}

export interface DeepPlanAnswerRecord extends DeepPlanAnswer {
  readonly questionnaireId: string;
  readonly answerRevision: number;
  readonly answeredAt: string;
}

export interface DeepPlanDecision {
  readonly key: string;
  readonly status: "unresolved" | "resolved" | "assumed" | "conflicted";
  readonly value?: unknown;
  readonly source: "user" | "repository" | "conversation" | "assumption";
  readonly evidenceRefs?: readonly string[];
  readonly blocking: boolean;
}

export interface DeepPlanContradiction {
  readonly decisionKey: string;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
  readonly recordedAt: string;
}

export interface DeepPlanQuestionnaireRecord {
  readonly questionnaireId: string;
  readonly result: UserAskBatchResult;
  readonly completedAt: string;
}

export interface DeepPlanState {
  readonly mode: DeepPlanMode;
  readonly phase: DeepPlanPhase;
  readonly revision: number;
  readonly turnRevision: number;
  readonly activeTurnKey?: string | undefined;
  readonly taskEpochId?: string | undefined;
  readonly goalDigest?: string | undefined;
  readonly workspaceIdentityDigest?: string | undefined;
  readonly round: number;
  readonly pendingQuestionnaire?: DeepPlanQuestionnaire | undefined;
  readonly answers: readonly DeepPlanAnswerRecord[];
  readonly decisions: readonly DeepPlanDecision[];
  readonly contradictions: readonly DeepPlanContradiction[];
  readonly questionnaireResults: readonly DeepPlanQuestionnaireRecord[];
  readonly answerRevision: number;
  readonly planAnswerRevision: number;
  readonly planTurnRevision?: number | undefined;
  readonly planRevision?: number | undefined;
  readonly draftNow: boolean;
  readonly pausedReason?: string | undefined;
  readonly updatedAt: string;
}

export interface DeepPlanPlanSnapshot {
  readonly revision?: number;
  readonly document?: {
    readonly context?: readonly string[];
    readonly assumptions?: readonly string[];
  };
}

export interface DeepPlanReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
  /** Paused/cancelled input intentionally bypasses continuation to avoid loops. */
  readonly bypassed?: "paused" | "cancelled";
}

export type DeepPlanQuestionnaireOpenResult =
  | { readonly kind: "opened" | "pending"; readonly questionnaire: DeepPlanQuestionnaire }
  | { readonly kind: "replay"; readonly result: UserAskBatchResult };

export type DeepPlanErrorCode =
  | "QUESTIONNAIRE_INVALID"
  | "QUESTIONNAIRE_PENDING"
  | "QUESTIONNAIRE_NOT_PENDING"
  | "QUESTION_ALREADY_RESOLVED"
  | "ANSWER_INVALID";

export class DeepPlanError extends Error {
  readonly code: DeepPlanErrorCode;

  constructor(code: DeepPlanErrorCode, message: string) {
    super(message);
    this.name = "DeepPlanError";
    this.code = code;
  }
}

const MAX_RESULTS = 64;
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/gu;
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function sanitizeDeepPlanText(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(DISALLOWED_CONTROL, "").trim();
}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new DeepPlanError("QUESTIONNAIRE_INVALID", `${label} must be a string`);
  }
  const clean = sanitizeDeepPlanText(value);
  if (clean.length === 0 || clean.length > max) {
    throw new DeepPlanError(
      "QUESTIONNAIRE_INVALID",
      `${label} must contain 1–${max} characters`,
    );
  }
  return clean;
}

function cloneAnswer(answer: DeepPlanAnswer): DeepPlanAnswer {
  return {
    questionId: answer.questionId,
    decisionKey: answer.decisionKey,
    ...(answer.selectedOptionIds === undefined
      ? {}
      : { selectedOptionIds: [...answer.selectedOptionIds] }),
    ...(answer.customText === undefined ? {} : { customText: answer.customText }),
  };
}

function cloneResult(result: UserAskBatchResult): UserAskBatchResult {
  return {
    questionnaireId: result.questionnaireId,
    status: result.status,
    answers: result.answers.map(cloneAnswer),
  };
}

function cloneQuestion(question: DeepPlanQuestion): DeepPlanQuestion {
  return {
    ...question,
    ...(question.options === undefined
      ? {}
      : { options: question.options.map((option) => ({ ...option })) }),
  };
}

function cloneQuestionnaire(questionnaire: DeepPlanQuestionnaire): DeepPlanQuestionnaire {
  return {
    ...questionnaire,
    questions: questionnaire.questions.map(cloneQuestion),
    draftAnswers: questionnaire.draftAnswers.map(cloneAnswer),
  };
}

function cloneState(state: DeepPlanState): DeepPlanState {
  return {
    ...state,
    ...(state.pendingQuestionnaire === undefined
      ? {}
      : { pendingQuestionnaire: cloneQuestionnaire(state.pendingQuestionnaire) }),
    answers: state.answers.map((answer) => ({
      ...cloneAnswer(answer),
      questionnaireId: answer.questionnaireId,
      answerRevision: answer.answerRevision,
      answeredAt: answer.answeredAt,
    })),
    decisions: state.decisions.map((decision) => ({
      ...decision,
      ...(decision.evidenceRefs === undefined
        ? {}
        : { evidenceRefs: [...decision.evidenceRefs] }),
    })),
    contradictions: state.contradictions.map((entry) => ({
      ...entry,
      evidenceRefs: [...entry.evidenceRefs],
    })),
    questionnaireResults: state.questionnaireResults.map((entry) => ({
      ...entry,
      result: cloneResult(entry.result),
    })),
  };
}

export function createDeepPlanState(
  mode: DeepPlanMode = "off",
  now = new Date().toISOString(),
): DeepPlanState {
  return {
    mode,
    phase: "idle",
    revision: 0,
    turnRevision: 0,
    round: 0,
    answers: [],
    decisions: [],
    contradictions: [],
    questionnaireResults: [],
    answerRevision: 0,
    planAnswerRevision: 0,
    draftNow: false,
    updatedAt: now,
  };
}

function normalizeQuestionnaire(input: UserAskBatchInput, now: string): DeepPlanQuestionnaire {
  const questionnaireId = bounded(input.questionnaireId, "questionnaireId", 200);
  const reason = bounded(input.reason, "reason", 1_200);
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    throw new DeepPlanError("QUESTIONNAIRE_INVALID", "a batch must contain 1–4 questions");
  }
  const ids = new Set<string>();
  const decisionKeys = new Set<string>();
  const questions = input.questions.map((raw, index): DeepPlanQuestion => {
    const id = bounded(raw.id, `questions[${index}].id`, 120);
    const decisionKey = bounded(raw.decisionKey, `questions[${index}].decisionKey`, 160);
    if (ids.has(id)) {
      throw new DeepPlanError("QUESTIONNAIRE_INVALID", `duplicate question id '${id}'`);
    }
    if (decisionKeys.has(decisionKey)) {
      throw new DeepPlanError("QUESTIONNAIRE_INVALID", `duplicate decisionKey '${decisionKey}'`);
    }
    ids.add(id);
    decisionKeys.add(decisionKey);
    if (!["single_select", "multi_select", "text"].includes(raw.kind)) {
      throw new DeepPlanError("QUESTIONNAIRE_INVALID", `question '${id}' has an invalid kind`);
    }
    const tab = bounded(raw.tab, `question '${id}' tab`, 24);
    const question = bounded(raw.question, `question '${id}' text`, 1_200);
    const revisitReason =
      raw.revisitReason === undefined
        ? undefined
        : bounded(raw.revisitReason, `question '${id}' revisitReason`, 1_200);
    if (raw.kind === "text") {
      if (raw.options !== undefined && raw.options.length > 0) {
        throw new DeepPlanError("QUESTIONNAIRE_INVALID", `text question '${id}' cannot have options`);
      }
      return {
        id,
        decisionKey,
        tab,
        question,
        kind: raw.kind,
        required: raw.required === true,
        ...(revisitReason === undefined ? {} : { revisitReason }),
      };
    }
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 6) {
      throw new DeepPlanError(
        "QUESTIONNAIRE_INVALID",
        `select question '${id}' must contain 2–6 options`,
      );
    }
    const optionIds = new Set<string>();
    let recommendations = 0;
    const rawOptions = raw.options as readonly DeepPlanQuestionOption[];
    const options = rawOptions.map((option, optionIndex): DeepPlanQuestionOption => {
      const optionId = bounded(option.id, `question '${id}' option[${optionIndex}].id`, 120);
      if (optionIds.has(optionId)) {
        throw new DeepPlanError(
          "QUESTIONNAIRE_INVALID",
          `question '${id}' has duplicate option id '${optionId}'`,
        );
      }
      optionIds.add(optionId);
      if (option.recommended === true) recommendations += 1;
      return {
        id: optionId,
        label: bounded(option.label, `question '${id}' option '${optionId}' label`, 120),
        ...(option.description === undefined
          ? {}
          : {
              description: bounded(
                option.description,
                `question '${id}' option '${optionId}' description`,
                300,
              ),
            }),
        ...(option.recommended === true ? { recommended: true } : {}),
      };
    });
    if (recommendations > 1) {
      throw new DeepPlanError(
        "QUESTIONNAIRE_INVALID",
        `question '${id}' may recommend at most one option`,
      );
    }
    return {
      id,
      decisionKey,
      tab,
      question,
      kind: raw.kind,
      required: raw.required === true,
      options,
      ...(raw.allowCustom === true ? { allowCustom: true } : {}),
      ...(revisitReason === undefined ? {} : { revisitReason }),
    };
  });
  return {
    questionnaireId,
    reason,
    questions,
    allowDraftNow: input.allowDraftNow !== false,
    activeQuestionIndex: 0,
    draftAnswers: [],
    openedAt: now,
  };
}

function normalizedAnswers(
  questionnaire: DeepPlanQuestionnaire,
  rawAnswers: readonly DeepPlanAnswer[],
  requireComplete: boolean,
): DeepPlanAnswer[] {
  if (!Array.isArray(rawAnswers)) {
    throw new DeepPlanError("ANSWER_INVALID", "answers must be an array");
  }
  const byQuestion = new Map(questionnaire.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const inputAnswers: readonly DeepPlanAnswer[] = rawAnswers;
  const answers = inputAnswers.map((raw): DeepPlanAnswer => {
    const questionId = sanitizeDeepPlanText(raw.questionId);
    const question = byQuestion.get(questionId);
    if (question === undefined) {
      throw new DeepPlanError("ANSWER_INVALID", `unknown question '${questionId}'`);
    }
    if (seen.has(questionId)) {
      throw new DeepPlanError("ANSWER_INVALID", `question '${questionId}' was answered twice`);
    }
    seen.add(questionId);
    if (sanitizeDeepPlanText(raw.decisionKey) !== question.decisionKey) {
      throw new DeepPlanError(
        "ANSWER_INVALID",
        `answer for '${questionId}' has the wrong decisionKey`,
      );
    }
    const selected: string[] = raw.selectedOptionIds === undefined
      ? []
      : [...new Set(raw.selectedOptionIds.map((id) => sanitizeDeepPlanText(id)))];
    const customText = raw.customText === undefined
      ? undefined
      : sanitizeDeepPlanText(raw.customText);
    if (customText !== undefined && customText.length > 2_000) {
      throw new DeepPlanError("ANSWER_INVALID", `answer for '${questionId}' is too long`);
    }
    if (question.kind === "text") {
      if (selected.length > 0) {
        throw new DeepPlanError("ANSWER_INVALID", `text question '${questionId}' cannot select options`);
      }
    } else {
      const optionIds = new Set((question.options ?? []).map((option) => option.id));
      if (selected.some((id) => !optionIds.has(id))) {
        throw new DeepPlanError("ANSWER_INVALID", `answer for '${questionId}' selects an unknown option`);
      }
      if (question.kind === "single_select" && selected.length > 1) {
        throw new DeepPlanError("ANSWER_INVALID", `single-select question '${questionId}' has multiple choices`);
      }
      if (customText !== undefined && customText.length > 0 && question.allowCustom !== true) {
        throw new DeepPlanError("ANSWER_INVALID", `question '${questionId}' does not allow custom input`);
      }
      if (question.kind === "single_select" && selected.length > 0 && (customText?.length ?? 0) > 0) {
        throw new DeepPlanError("ANSWER_INVALID", `single-select question '${questionId}' cannot mix a choice and custom input`);
      }
    }
    const answered =
      selected.length > 0 || (customText !== undefined && customText.length > 0);
    if (requireComplete && question.required && !answered) {
      throw new DeepPlanError("ANSWER_INVALID", `required question '${questionId}' is unanswered`);
    }
    return {
      questionId,
      decisionKey: question.decisionKey,
      ...(selected.length === 0 ? {} : { selectedOptionIds: selected }),
      ...(customText === undefined || customText.length === 0 ? {} : { customText }),
    };
  });
  if (requireComplete) {
    for (const question of questionnaire.questions) {
      if (question.required && !seen.has(question.id)) {
        throw new DeepPlanError("ANSWER_INVALID", `required question '${question.id}' is unanswered`);
      }
    }
  }
  return answers;
}

function answerValue(question: DeepPlanQuestion, answer: DeepPlanAnswer): unknown {
  if (question.kind === "text") return answer.customText ?? "";
  const selected = new Set(answer.selectedOptionIds ?? []);
  const selectedOptions = (question.options ?? [])
    .filter((option) => selected.has(option.id))
    .map((option) => ({ id: option.id, label: option.label }));
  return {
    selectedOptionIds: selectedOptions.map((option) => option.id),
    selectedLabels: selectedOptions.map((option) => option.label),
    ...(answer.customText === undefined ? {} : { customText: answer.customText }),
  };
}

function replaceDecision(
  decisions: readonly DeepPlanDecision[],
  decision: DeepPlanDecision,
): DeepPlanDecision[] {
  const index = decisions.findIndex((candidate) => candidate.key === decision.key);
  if (index < 0) return [...decisions, decision];
  const next = [...decisions];
  next[index] = decision;
  return next;
}

function resultFor(
  state: DeepPlanState,
  questionnaireId: string,
): UserAskBatchResult | undefined {
  const record = [...state.questionnaireResults]
    .reverse()
    .find((entry) => entry.questionnaireId === questionnaireId);
  return record === undefined ? undefined : cloneResult(record.result);
}

function valueCandidates(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length === 0 ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(valueCandidates);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap(valueCandidates);
}

function planReflectsDecision(
  decision: DeepPlanDecision,
  plan: DeepPlanPlanSnapshot | undefined,
): boolean {
  const document = plan?.document;
  if (document === undefined) return false;
  const haystack = [...(document.context ?? []), ...(document.assumptions ?? [])]
    .join("\n")
    .toLocaleLowerCase();
  if (haystack.includes(decision.key.toLocaleLowerCase())) return true;
  return valueCandidates(decision.value).some((candidate) => {
    const normalized = candidate.trim().toLocaleLowerCase();
    return normalized.length > 0 && haystack.includes(normalized);
  });
}

export function compactDeepPlanProjection(state: DeepPlanState): string {
  const lines = ["Deep Plan decisions:"];
  if (state.decisions.length === 0) lines.push("- none recorded");
  for (const decision of state.decisions) {
    const rendered = decision.value === undefined
      ? decision.status
      : typeof decision.value === "string"
        ? decision.value
        : JSON.stringify(decision.value);
    lines.push(
      `- ${decision.key} = ${rendered} [${decision.source}; ${decision.status}${decision.blocking ? "; blocking" : ""}]`,
    );
  }
  lines.push(
    `State: phase=${state.phase}; round=${state.round}; answerRevision=${state.answerRevision}; draftNow=${state.draftNow}`,
  );
  return lines.join("\n");
}

export function assessDeepPlanReadiness(
  state: DeepPlanState,
  plan?: DeepPlanPlanSnapshot,
): DeepPlanReadiness {
  if (state.mode === "off") return { ready: true, blockers: [] };
  if (state.phase === "cancelled") {
    return { ready: true, blockers: [], bypassed: "cancelled" };
  }
  if (state.phase === "paused") {
    return { ready: true, blockers: [], bypassed: "paused" };
  }

  const blockers: string[] = [];
  if (state.pendingQuestionnaire !== undefined) {
    blockers.push(`questionnaire '${state.pendingQuestionnaire.questionnaireId}' is still pending`);
  }
  for (const decision of state.decisions) {
    if (decision.blocking && (decision.status === "unresolved" || decision.status === "conflicted")) {
      blockers.push(`blocking decision '${decision.key}' is ${decision.status}`);
    }
  }
  if (state.planTurnRevision !== state.turnRevision) {
    blockers.push("the Plan Contract has not been written during this Deep Plan turn");
  }
  if (state.planAnswerRevision < state.answerRevision) {
    blockers.push("the Plan Contract predates the latest questionnaire answers");
  }
  for (const decision of state.decisions) {
    if (
      decision.blocking &&
      (decision.source === "user" || decision.source === "assumption") &&
      (decision.status === "resolved" || decision.status === "assumed") &&
      !planReflectsDecision(decision, plan)
    ) {
      blockers.push(`Plan context or assumptions do not reflect '${decision.key}'`);
    }
  }
  return { ready: blockers.length === 0, blockers };
}

export interface DeepPlanTurnStart {
  readonly turnKey: string;
  readonly taskEpochId?: string;
  readonly goalDigest: string;
  readonly workspaceIdentityDigest?: string;
}

export class DeepPlanController {
  #state: DeepPlanState;
  readonly #now: () => string;

  constructor(options: {
    readonly mode?: DeepPlanMode;
    readonly state?: DeepPlanState;
    readonly now?: () => string;
  } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = options.state === undefined
      ? createDeepPlanState(options.mode ?? "off", this.#now())
      : cloneState(options.state);
  }

  current(): DeepPlanState {
    return cloneState(this.#state);
  }

  setMode(mode: DeepPlanMode): void {
    if (this.#state.mode === mode) return;
    this.#commit({
      ...this.#state,
      mode,
      phase: mode === "off" ? "idle" : this.#state.phase,
    });
  }

  beginTurn(input: DeepPlanTurnStart): DeepPlanState {
    const turnKey = bounded(input.turnKey, "turnKey", 240);
    const goalDigest = bounded(input.goalDigest, "goalDigest", 240);
    if (this.#state.activeTurnKey === turnKey) return this.current();
    const workspaceChanged =
      this.#state.workspaceIdentityDigest !== undefined &&
      input.workspaceIdentityDigest !== undefined &&
      this.#state.workspaceIdentityDigest !== input.workspaceIdentityDigest;
    const goalChanged =
      this.#state.goalDigest !== undefined && this.#state.goalDigest !== goalDigest;

    if (goalChanged) {
      this.#state = {
        ...createDeepPlanState(this.#state.mode, this.#now()),
        activeTurnKey: turnKey,
        taskEpochId: input.taskEpochId,
        goalDigest,
        workspaceIdentityDigest: input.workspaceIdentityDigest,
        turnRevision: 1,
        phase: this.#state.mode === "on" ? "investigating" : "idle",
      };
      return this.current();
    }

    let decisions = this.#state.decisions;
    if (workspaceChanged) {
      decisions = decisions.filter((decision) => decision.source !== "repository");
    }
    const revising = ["review_ready", "completed"].includes(this.#state.phase);
    this.#commit({
      ...this.#state,
      activeTurnKey: turnKey,
      taskEpochId: input.taskEpochId,
      goalDigest,
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      turnRevision: this.#state.turnRevision + 1,
      planTurnRevision: undefined,
      planRevision: undefined,
      decisions,
      phase:
        this.#state.mode === "off"
          ? "idle"
          : this.#state.phase === "paused"
            ? "paused"
            : revising
              ? "revising"
              : "investigating",
    });
    return this.current();
  }

  recordDecision(decision: DeepPlanDecision): DeepPlanState {
    const key = bounded(decision.key, "decision key", 160);
    this.#commit({
      ...this.#state,
      decisions: replaceDecision(this.#state.decisions, {
        ...decision,
        key,
        ...(decision.evidenceRefs === undefined
          ? {}
          : {
              evidenceRefs: decision.evidenceRefs
                .map((entry) => sanitizeDeepPlanText(entry))
                .filter((entry) => entry.length > 0),
            }),
      }),
    });
    return this.current();
  }

  recordContradiction(input: {
    readonly decisionKey: string;
    readonly detail: string;
    readonly evidenceRefs?: readonly string[];
  }): DeepPlanState {
    const decisionKey = bounded(input.decisionKey, "decisionKey", 160);
    const detail = bounded(input.detail, "contradiction detail", 1_200);
    const evidenceRefs = (input.evidenceRefs ?? [])
      .map((entry) => sanitizeDeepPlanText(entry))
      .filter((entry) => entry.length > 0);
    const existing = this.#state.decisions.find((decision) => decision.key === decisionKey);
    const conflicted: DeepPlanDecision = existing === undefined
      ? {
          key: decisionKey,
          status: "conflicted",
          source: "repository",
          evidenceRefs,
          blocking: true,
        }
      : { ...existing, status: "conflicted", evidenceRefs };
    this.#commit({
      ...this.#state,
      decisions: replaceDecision(this.#state.decisions, conflicted),
      contradictions: [
        ...this.#state.contradictions,
        { decisionKey, detail, evidenceRefs, recordedAt: this.#now() },
      ],
    });
    return this.current();
  }

  openQuestionnaire(input: UserAskBatchInput): DeepPlanQuestionnaireOpenResult {
    const normalized = normalizeQuestionnaire(input, this.#now());
    const replay = resultFor(this.#state, normalized.questionnaireId);
    if (replay !== undefined) return { kind: "replay", result: replay };
    if (this.#state.pendingQuestionnaire !== undefined) {
      if (this.#state.pendingQuestionnaire.questionnaireId === normalized.questionnaireId) {
        return {
          kind: "pending",
          questionnaire: cloneQuestionnaire(this.#state.pendingQuestionnaire),
        };
      }
      throw new DeepPlanError(
        "QUESTIONNAIRE_PENDING",
        `questionnaire '${this.#state.pendingQuestionnaire.questionnaireId}' is already pending`,
      );
    }

    let decisions = this.#state.decisions;
    for (const question of normalized.questions) {
      const existing = decisions.find((decision) => decision.key === question.decisionKey);
      if (
        existing !== undefined &&
        (existing.status === "resolved" || existing.status === "assumed")
      ) {
        throw new DeepPlanError(
          "QUESTION_ALREADY_RESOLVED",
          `decision '${question.decisionKey}' is already ${existing.status}`,
        );
      }
      if (
        existing?.status === "conflicted" &&
        (question.revisitReason === undefined || question.revisitReason.length === 0)
      ) {
        throw new DeepPlanError(
          "QUESTION_ALREADY_RESOLVED",
          `revisiting conflicted decision '${question.decisionKey}' requires revisitReason`,
        );
      }
      decisions = replaceDecision(decisions, existing === undefined
        ? {
            key: question.decisionKey,
            status: "unresolved",
            source: "conversation",
            blocking: question.required,
          }
        : { ...existing, blocking: existing.blocking || question.required });
    }
    this.#commit({
      ...this.#state,
      phase: "questioning",
      round: this.#state.round + 1,
      pendingQuestionnaire: normalized,
      decisions,
      pausedReason: undefined,
    });
    return { kind: "opened", questionnaire: cloneQuestionnaire(normalized) };
  }

  updateQuestionnaireDraft(
    questionnaireId: string,
    answers: readonly DeepPlanAnswer[],
    activeQuestionIndex: number,
  ): DeepPlanState {
    const pending = this.#state.pendingQuestionnaire;
    if (pending === undefined || pending.questionnaireId !== questionnaireId) {
      throw new DeepPlanError("QUESTIONNAIRE_NOT_PENDING", "questionnaire is not pending");
    }
    const draftAnswers = normalizedAnswers(pending, answers, false);
    const clampedIndex = Math.max(
      0,
      Math.min(pending.questions.length - 1, Math.trunc(activeQuestionIndex)),
    );
    this.#commit({
      ...this.#state,
      pendingQuestionnaire: {
        ...pending,
        activeQuestionIndex: clampedIndex,
        draftAnswers,
      },
    });
    return this.current();
  }

  completeQuestionnaire(raw: UserAskBatchResult): UserAskBatchResult {
    const questionnaireId = sanitizeDeepPlanText(raw.questionnaireId);
    const replay = resultFor(this.#state, questionnaireId);
    if (replay !== undefined && this.#state.pendingQuestionnaire?.questionnaireId !== questionnaireId) {
      return replay;
    }
    const pending = this.#state.pendingQuestionnaire;
    if (pending === undefined || pending.questionnaireId !== questionnaireId) {
      throw new DeepPlanError("QUESTIONNAIRE_NOT_PENDING", "questionnaire is not pending");
    }
    if (!["submitted", "draft_now", "paused", "cancelled", "unavailable"].includes(raw.status)) {
      throw new DeepPlanError("ANSWER_INVALID", "questionnaire status is invalid");
    }
    if (raw.status === "draft_now" && !pending.allowDraftNow) {
      throw new DeepPlanError("ANSWER_INVALID", "this questionnaire does not allow draft-now");
    }
    const answers = normalizedAnswers(pending, raw.answers, raw.status === "submitted");
    const result: UserAskBatchResult = { questionnaireId, status: raw.status, answers };
    const now = this.#now();

    if (raw.status === "paused") {
      this.#commit({
        ...this.#state,
        phase: "paused",
        pendingQuestionnaire: { ...pending, draftAnswers: answers },
        pausedReason: "paused by user",
        questionnaireResults: this.#appendResult(result, now),
      });
      return cloneResult(result);
    }

    let decisions = this.#state.decisions;
    let answerRevision = this.#state.answerRevision;
    const records: DeepPlanAnswerRecord[] = [];
    if (raw.status === "submitted" || raw.status === "draft_now") {
      answerRevision += 1;
      for (const answer of answers) {
        const question = pending.questions.find((candidate) => candidate.id === answer.questionId);
        if (question === undefined) continue;
        decisions = replaceDecision(decisions, {
          key: question.decisionKey,
          status: "resolved",
          value: answerValue(question, answer),
          source: "user",
          blocking: question.required,
        });
        records.push({
          ...cloneAnswer(answer),
          questionnaireId,
          answerRevision,
          answeredAt: now,
        });
      }
    }
    if (raw.status === "draft_now") {
      for (const question of pending.questions) {
        const decision = decisions.find((candidate) => candidate.key === question.decisionKey);
        if (decision?.status === "resolved") continue;
        decisions = replaceDecision(decisions, {
          key: question.decisionKey,
          status: "assumed",
          value: "open decision; user requested a draft with current answers",
          source: "assumption",
          blocking: question.required,
        });
      }
    }
    this.#commit({
      ...this.#state,
      phase:
        raw.status === "cancelled"
          ? "cancelled"
          : raw.status === "unavailable"
            ? "paused"
            : raw.status === "draft_now"
              ? "drafting"
              : "investigating",
      pendingQuestionnaire: undefined,
      answers: [...this.#state.answers, ...records],
      decisions,
      questionnaireResults: this.#appendResult(result, now),
      answerRevision,
      draftNow: raw.status === "draft_now" || this.#state.draftNow,
      pausedReason: raw.status === "unavailable" ? "interactive input unavailable" : undefined,
    });
    return cloneResult(result);
  }

  resume(): DeepPlanState {
    const pending = this.#state.pendingQuestionnaire;
    if (this.#state.phase !== "paused") return this.current();
    this.#commit({
      ...this.#state,
      phase: pending === undefined ? "investigating" : "questioning",
      pausedReason: undefined,
      questionnaireResults: pending === undefined
        ? this.#state.questionnaireResults
        : this.#state.questionnaireResults.filter(
            (entry) =>
              entry.questionnaireId !== pending.questionnaireId ||
              entry.result.status !== "paused",
          ),
    });
    return this.current();
  }

  notePlanWritten(planRevision: number): DeepPlanState {
    if (!Number.isSafeInteger(planRevision) || planRevision < 0) {
      throw new RangeError("planRevision must be a non-negative safe integer");
    }
    this.#commit({
      ...this.#state,
      phase: "validating",
      planRevision,
      planAnswerRevision: this.#state.answerRevision,
      planTurnRevision: this.#state.turnRevision,
    });
    return this.current();
  }

  markReviewReady(): DeepPlanState {
    this.#commit({ ...this.#state, phase: "review_ready" });
    return this.current();
  }

  markCompleted(): DeepPlanState {
    this.#commit({ ...this.#state, phase: "completed" });
    return this.current();
  }

  #appendResult(
    result: UserAskBatchResult,
    completedAt: string,
  ): readonly DeepPlanQuestionnaireRecord[] {
    return [
      ...this.#state.questionnaireResults.filter(
        (entry) => entry.questionnaireId !== result.questionnaireId,
      ),
      { questionnaireId: result.questionnaireId, result: cloneResult(result), completedAt },
    ].slice(-MAX_RESULTS);
  }

  #commit(next: DeepPlanState): void {
    this.#state = {
      ...next,
      revision: this.#state.revision + 1,
      updatedAt: this.#now(),
    };
  }
}
