/**
 * Per-session actor: sequential mailbox, attach/detach, and control lease.
 *
 * Observers may attach concurrently. Exactly one controller holds the
 * interactive control lease at a time. Detach never cancels an in-flight turn.
 */

export type SessionLifecycle =
  | "loading"
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_user_input"
  | "paused"
  | "recovering"
  | "closed"
  | "failed";

export type SessionCommandKind =
  | "submit_turn"
  | "cancel_turn"
  | "attach_client"
  | "detach_client"
  | "resolve_approval"
  | "mark_waiting_user_input"
  | "resolve_user_input"
  | "steal_control"
  | "pause_session"
  | "resume_session"
  | "snapshot_session"
  | "close_session";

export interface InteractiveLease {
  readonly sessionId: string;
  readonly clientId: string;
  readonly leaseRevision: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

export interface AttachedClient {
  readonly connectionId: string;
  readonly clientId: string;
  readonly mode: "observer" | "controller";
  readonly attachedAt: string;
  readonly eventCursor: number;
}

export interface SessionActorState {
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly lifecycle: SessionLifecycle;
  readonly revision: number;
  readonly activeTurnId?: string;
  readonly attachedClients: readonly AttachedClient[];
  readonly controlLease?: InteractiveLease;
  readonly lastJournalSequence: number;
  readonly pendingApprovalIds: readonly string[];
  readonly pendingUserInputId?: string;
  readonly ownerEpoch: number;
}

export type SessionCommand =
  | {
    readonly kind: "attach_client";
    readonly connectionId: string;
    readonly clientId: string;
    readonly mode: "observer" | "controller";
    readonly eventCursor?: number;
  }
  | {
    readonly kind: "detach_client";
    readonly connectionId: string;
  }
  | {
    readonly kind: "submit_turn";
    readonly turnId: string;
    readonly clientId: string;
    readonly prompt: string;
  }
  | {
    readonly kind: "cancel_turn";
    readonly clientId: string;
    readonly turnId?: string;
  }
  | {
    readonly kind: "resolve_approval";
    readonly clientId: string;
    readonly approvalId: string;
  }
  | {
    readonly kind: "steal_control";
    readonly clientId: string;
    readonly connectionId: string;
  }
  | { readonly kind: "pause_session"; readonly clientId: string }
  | { readonly kind: "resume_session"; readonly clientId: string }
  | { readonly kind: "snapshot_session" }
  | { readonly kind: "close_session"; readonly clientId?: string }
  | {
    readonly kind: "mark_waiting_approval";
    readonly approvalId: string;
  }
  | {
    readonly kind: "clear_approval";
    readonly approvalId: string;
  }
  | {
    readonly kind: "mark_waiting_user_input";
    readonly questionnaireId: string;
  }
  | {
    readonly kind: "resolve_user_input";
    readonly clientId: string;
    readonly questionnaireId: string;
  }
  | {
    readonly kind: "set_journal_sequence";
    readonly sequence: number;
  };

export interface SessionActorOptions {
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly ownerEpoch?: number;
  readonly controlLeaseSeconds?: number;
  readonly now?: () => string;
}

export class SessionActorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionActorError";
    this.code = code;
  }
}

type InternalCommand = SessionCommand & { readonly resolve: (state: SessionActorState) => void; readonly reject: (error: Error) => void };

export class SessionActor {
  readonly #sessionId: string;
  readonly #workspaceIdentityDigest: string;
  readonly #controlLeaseSeconds: number;
  readonly #now: () => string;
  readonly #clients = new Map<string, AttachedClient>();
  readonly #pendingApprovalIds = new Set<string>();
  #pendingUserInputId: string | undefined;
  #lifecycle: SessionLifecycle = "idle";
  #revision = 0;
  #activeTurnId: string | undefined;
  #controlLease: InteractiveLease | undefined;
  #leaseRevision = 0;
  #lastJournalSequence = 0;
  #ownerEpoch: number;
  #queue: InternalCommand[] = [];
  #pumping = false;
  #closed = false;

  constructor(options: SessionActorOptions) {
    this.#sessionId = options.sessionId;
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#ownerEpoch = options.ownerEpoch ?? 1;
    this.#controlLeaseSeconds = options.controlLeaseSeconds ?? 30;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get state(): SessionActorState {
    return this.#snapshot();
  }

  bumpOwnerEpoch(): number {
    this.#ownerEpoch += 1;
    this.#revision += 1;
    return this.#ownerEpoch;
  }

  async dispatch(command: SessionCommand): Promise<SessionActorState> {
    if (this.#closed && command.kind !== "snapshot_session") {
      throw new SessionActorError("SESSION_CLOSED", "session actor is closed");
    }
    return await new Promise<SessionActorState>((resolve, reject) => {
      this.#queue.push({ ...command, resolve, reject } as InternalCommand);
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        const command = this.#queue.shift()!;
        try {
          this.#apply(command);
          command.resolve(this.#snapshot());
        } catch (error) {
          command.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.#pumping = false;
      if (this.#queue.length > 0) void this.#pump();
    }
  }

  #apply(command: SessionCommand): void {
    switch (command.kind) {
      case "attach_client":
        this.#attach(command);
        return;
      case "detach_client":
        this.#detach(command.connectionId);
        return;
      case "submit_turn":
        this.#requireController(command.clientId);
        this.#lifecycle = "running";
        this.#activeTurnId = command.turnId;
        this.#pendingUserInputId = undefined;
        this.#revision += 1;
        return;
      case "cancel_turn":
        this.#requireController(command.clientId);
        this.#activeTurnId = undefined;
        this.#pendingUserInputId = undefined;
        this.#lifecycle = this.#pendingApprovalIds.size > 0 ? "waiting_approval" : "idle";
        this.#revision += 1;
        return;
      case "resolve_approval":
        this.#requireController(command.clientId);
        this.#pendingApprovalIds.delete(command.approvalId);
        this.#lifecycle = this.#activeTurnId !== undefined ? "running" : "idle";
        this.#revision += 1;
        return;
      case "steal_control":
        this.#grantControl(command.clientId, command.connectionId);
        return;
      case "pause_session":
        this.#requireController(command.clientId);
        this.#lifecycle = "paused";
        this.#revision += 1;
        return;
      case "resume_session":
        this.#requireController(command.clientId);
        this.#lifecycle = this.#pendingUserInputId !== undefined
          ? "waiting_user_input"
          : this.#activeTurnId !== undefined ? "running" : "idle";
        this.#revision += 1;
        return;
      case "snapshot_session":
        return;
      case "close_session":
        if (command.clientId !== undefined) this.#requireController(command.clientId);
        this.#lifecycle = "closed";
        this.#closed = true;
        this.#clients.clear();
        this.#controlLease = undefined;
        this.#pendingUserInputId = undefined;
        this.#revision += 1;
        return;
      case "mark_waiting_approval":
        this.#pendingApprovalIds.add(command.approvalId);
        this.#lifecycle = "waiting_approval";
        this.#revision += 1;
        return;
      case "clear_approval":
        this.#pendingApprovalIds.delete(command.approvalId);
        if (this.#lifecycle === "waiting_approval" && this.#pendingApprovalIds.size === 0) {
          this.#lifecycle = this.#activeTurnId !== undefined ? "running" : "idle";
        }
        this.#revision += 1;
        return;
      case "mark_waiting_user_input":
        if (
          this.#pendingUserInputId === command.questionnaireId &&
          this.#lifecycle === "waiting_user_input"
        ) return;
        this.#pendingUserInputId = command.questionnaireId;
        this.#lifecycle = "waiting_user_input";
        this.#revision += 1;
        return;
      case "resolve_user_input":
        this.#requireController(command.clientId);
        if (this.#pendingUserInputId !== command.questionnaireId) {
          throw new SessionActorError(
            "SESSION_USER_INPUT_MISMATCH",
            "questionnaire does not match the pending user input",
          );
        }
        this.#pendingUserInputId = undefined;
        this.#lifecycle = this.#pendingApprovalIds.size > 0
          ? "waiting_approval"
          : this.#activeTurnId !== undefined ? "running" : "idle";
        this.#revision += 1;
        return;
      case "set_journal_sequence":
        if (command.sequence < this.#lastJournalSequence) {
          throw new SessionActorError("SESSION_CURSOR_INVALID", "journal sequence must be monotonic");
        }
        this.#lastJournalSequence = command.sequence;
        return;
    }
  }

  #attach(command: Extract<SessionCommand, { kind: "attach_client" }>): void {
    if (this.#clients.has(command.connectionId)) {
      throw new SessionActorError("SESSION_ALREADY_ATTACHED", "connection already attached");
    }
    const attachedAt = this.#now();
    const client: AttachedClient = {
      connectionId: command.connectionId,
      clientId: command.clientId,
      mode: command.mode,
      attachedAt,
      eventCursor: command.eventCursor ?? this.#lastJournalSequence,
    };
    this.#clients.set(command.connectionId, client);
    if (command.mode === "controller") {
      if (this.#controlLease !== undefined && this.#controlLease.clientId !== command.clientId) {
        // Attach as observer-capable connection until steal_control is explicit.
        this.#clients.set(command.connectionId, { ...client, mode: "observer" });
      } else {
        this.#grantControl(command.clientId, command.connectionId);
      }
    }
    this.#revision += 1;
  }

  #detach(connectionId: string): void {
    const existing = this.#clients.get(connectionId);
    if (existing === undefined) {
      throw new SessionActorError("SESSION_NOT_ATTACHED", "connection is not attached");
    }
    this.#clients.delete(connectionId);
    if (this.#controlLease?.clientId === existing.clientId) {
      const stillPresent = [...this.#clients.values()].some((client) => client.clientId === existing.clientId);
      if (!stillPresent) {
        this.#controlLease = undefined;
      }
    }
    // Intentionally leave activeTurnId / pending approvals intact.
    this.#revision += 1;
  }

  #grantControl(clientId: string, connectionId: string): void {
    if (!this.#clients.has(connectionId)) {
      throw new SessionActorError("SESSION_NOT_ATTACHED", "control requires an attached connection");
    }
    const now = this.#now();
    this.#leaseRevision += 1;
    this.#controlLease = {
      sessionId: this.#sessionId,
      clientId,
      leaseRevision: this.#leaseRevision,
      grantedAt: now,
      expiresAt: new Date(Date.parse(now) + this.#controlLeaseSeconds * 1_000).toISOString(),
    };
    const current = this.#clients.get(connectionId)!;
    this.#clients.set(connectionId, { ...current, mode: "controller" });
    this.#revision += 1;
  }

  #requireController(clientId: string): void {
    if (this.#controlLease === undefined || this.#controlLease.clientId !== clientId) {
      throw new SessionActorError("SESSION_CONTROL_HELD", "client does not hold the control lease");
    }
  }

  #snapshot(): SessionActorState {
    return {
      sessionId: this.#sessionId,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      lifecycle: this.#lifecycle,
      revision: this.#revision,
      ...(this.#activeTurnId !== undefined ? { activeTurnId: this.#activeTurnId } : {}),
      attachedClients: [...this.#clients.values()],
      ...(this.#controlLease !== undefined ? { controlLease: this.#controlLease } : {}),
      lastJournalSequence: this.#lastJournalSequence,
      pendingApprovalIds: [...this.#pendingApprovalIds],
      ...(this.#pendingUserInputId === undefined
        ? {}
        : { pendingUserInputId: this.#pendingUserInputId }),
      ownerEpoch: this.#ownerEpoch,
    };
  }
}
