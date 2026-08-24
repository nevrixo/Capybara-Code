//! Durable, revision-fenced materialized AgentGraph state.
//!
//! Canonical audit events remain in the session event stream. This module stores
//! only queryable graph state and rejects invalid DAG/state transitions before a
//! scheduler can observe them after daemon restart.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{reject_credential_payload, SessionStore, StoreError};

pub const MAX_AGENT_GRAPH_NODES: usize = 10_000;
pub const MAX_AGENT_GRAPH_DEPTH: i64 = 64;
pub const MAX_AGENT_GRAPH_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_GRAPH_IDENTIFIER_BYTES: usize = 256;
const MAX_ATTEMPTS_PER_NODE: i64 = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentGraphState {
    Active,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Blocked,
}

impl AgentGraphState {
    fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Blocked => "blocked",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "blocked" => Ok(Self::Blocked),
            _ => Err(invalid(format!("unsupported graph state: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentNodeState {
    Created,
    Queued,
    WaitingDependency,
    WaitingBudget,
    WaitingApproval,
    WaitingMessage,
    Dispatching,
    Running,
    Paused,
    Reconciling,
    Completed,
    Partial,
    Failed,
    Cancelled,
    Blocked,
    Inactive,
}

impl AgentNodeState {
    fn label(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Queued => "queued",
            Self::WaitingDependency => "waiting_dependency",
            Self::WaitingBudget => "waiting_budget",
            Self::WaitingApproval => "waiting_approval",
            Self::WaitingMessage => "waiting_message",
            Self::Dispatching => "dispatching",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Reconciling => "reconciling",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Blocked => "blocked",
            Self::Inactive => "inactive",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "created" => Ok(Self::Created),
            "queued" => Ok(Self::Queued),
            "waiting_dependency" => Ok(Self::WaitingDependency),
            "waiting_budget" => Ok(Self::WaitingBudget),
            "waiting_approval" => Ok(Self::WaitingApproval),
            "waiting_message" => Ok(Self::WaitingMessage),
            "dispatching" => Ok(Self::Dispatching),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "reconciling" => Ok(Self::Reconciling),
            "completed" => Ok(Self::Completed),
            "partial" => Ok(Self::Partial),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "blocked" => Ok(Self::Blocked),
            "inactive" => Ok(Self::Inactive),
            _ => Err(invalid(format!("unsupported node state: {raw}"))),
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Partial
                | Self::Failed
                | Self::Cancelled
                | Self::Blocked
                | Self::Inactive
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentEdgeKind {
    DependsOn,
    ParentChild,
    Handoff,
    ReviewOf,
    Verifies,
    Merges,
}

impl AgentEdgeKind {
    fn label(self) -> &'static str {
        match self {
            Self::DependsOn => "depends_on",
            Self::ParentChild => "parent_child",
            Self::Handoff => "handoff",
            Self::ReviewOf => "review_of",
            Self::Verifies => "verifies",
            Self::Merges => "merges",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "depends_on" => Ok(Self::DependsOn),
            "parent_child" => Ok(Self::ParentChild),
            "handoff" => Ok(Self::Handoff),
            "review_of" => Ok(Self::ReviewOf),
            "verifies" => Ok(Self::Verifies),
            "merges" => Ok(Self::Merges),
            _ => Err(invalid(format!("unsupported edge kind: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentNodeCreate {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_node_id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub title: String,
    pub task: serde_json::Value,
    pub model_profile: String,
    pub permission_scope: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub max_attempts: i64,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGraphCreate {
    pub id: String,
    pub session_id: String,
    pub workspace_identity_digest: String,
    pub max_depth: i64,
    pub budget: serde_json::Value,
    pub root: AgentNodeCreate,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGraphRecord {
    pub id: String,
    pub session_id: String,
    pub workspace_identity_digest: String,
    pub root_node_id: String,
    pub state: AgentGraphState,
    pub revision: i64,
    pub max_depth: i64,
    pub budget: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentNodeRecord {
    pub id: String,
    pub graph_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_node_id: Option<String>,
    pub depth: i64,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub title: String,
    pub task: serde_json::Value,
    pub state: AgentNodeState,
    pub model_profile: String,
    pub permission_scope: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_attempt_id: Option<String>,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<serde_json::Value>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEdgeCreate {
    pub id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: AgentEdgeKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEdgeRecord {
    pub id: String,
    pub graph_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: AgentEdgeKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentNodeTransition {
    pub expected_graph_revision: i64,
    pub expected_node_revision: i64,
    pub state: AgentNodeState,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphStateTransition {
    pub expected_graph_revision: i64,
    pub state: AgentGraphState,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGraphMutation<T> {
    pub graph: AgentGraphRecord,
    pub value: T,
}

impl SessionStore {
    /// Create a graph and its root node atomically. A restored graph therefore
    /// cannot observe a root identifier with no corresponding node projection.
    pub fn create_agent_graph(
        &mut self,
        input: &AgentGraphCreate,
    ) -> Result<AgentGraphMutation<AgentNodeRecord>, StoreError> {
        validate_graph_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_session_workspace(&tx, &input.session_id, &input.workspace_identity_digest)?;
        let graph = AgentGraphRecord {
            id: input.id.clone(),
            session_id: input.session_id.clone(),
            workspace_identity_digest: input.workspace_identity_digest.clone(),
            root_node_id: input.root.id.clone(),
            state: AgentGraphState::Active,
            revision: 1,
            max_depth: input.max_depth,
            budget: input.budget.clone(),
            created_at: input.created_at.clone(),
            updated_at: input.created_at.clone(),
        };
        tx.execute(
            "INSERT INTO agent_graphs (
                id, session_id, workspace_identity_digest, root_node_id, state, revision,
                max_depth, budget_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?8)",
            params![
                graph.id,
                graph.session_id,
                graph.workspace_identity_digest,
                graph.root_node_id,
                graph.state.label(),
                graph.max_depth,
                serde_json::to_string(&graph.budget)?,
                graph.created_at,
            ],
        )?;
        let root = insert_node(
            &tx,
            &graph.id,
            &input.root,
            0,
            AgentNodeState::Created,
            1,
            &input.created_at,
        )?;
        tx.commit()?;
        Ok(AgentGraphMutation { graph, value: root })
    }

    pub fn agent_graph(&self, graph_id: &str) -> Result<Option<AgentGraphRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        self.conn
            .query_row(
                "SELECT id, session_id, workspace_identity_digest, root_node_id, state,
                        revision, max_depth, budget_json, created_at, updated_at
                 FROM agent_graphs WHERE id = ?1",
                params![graph_id],
                read_graph,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn agent_nodes(&self, graph_id: &str) -> Result<Vec<AgentNodeRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        let mut statement = self.conn.prepare(
            "SELECT id, graph_id, parent_node_id, depth, role, name, title, task_json,
                    state, model_profile, permission_scope_json, worktree_id, active_attempt_id,
                    attempt_count, max_attempts, priority, result_json, blocked_reason_json,
                    revision, created_at, updated_at, terminal_at
             FROM agent_nodes WHERE graph_id = ?1
             ORDER BY depth ASC, priority DESC, created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![graph_id], read_node)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn agent_node(&self, node_id: &str) -> Result<Option<AgentNodeRecord>, StoreError> {
        validate_identifier("nodeId", node_id, "agt_")?;
        self.conn
            .query_row(
                "SELECT id, graph_id, parent_node_id, depth, role, name, title, task_json,
                        state, model_profile, permission_scope_json, worktree_id, active_attempt_id,
                        attempt_count, max_attempts, priority, result_json, blocked_reason_json,
                        revision, created_at, updated_at, terminal_at
                 FROM agent_nodes WHERE id = ?1",
                params![node_id],
                read_node,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Add a non-root node under a parent, checking graph revision, parent graph,
    /// and depth in the same immediate transaction.
    pub fn add_agent_node(
        &mut self,
        graph_id: &str,
        expected_graph_revision: i64,
        input: &AgentNodeCreate,
        at: &str,
    ) -> Result<AgentGraphMutation<AgentNodeRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        validate_node_create(input)?;
        validate_timestamp("at", at)?;
        let parent_id = input
            .parent_node_id
            .as_deref()
            .ok_or_else(|| invalid("non-root nodes require parentNodeId"))?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let graph = require_graph(&tx, graph_id)?;
        ensure_graph_revision(&graph, expected_graph_revision)?;
        ensure_graph_mutable(&graph)?;
        let node_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM agent_nodes WHERE graph_id = ?1",
            params![graph_id],
            |row| row.get(0),
        )?;
        if node_count >= MAX_AGENT_GRAPH_NODES as i64 {
            return Err(invalid(format!(
                "graph {graph_id} reached the {} node limit",
                MAX_AGENT_GRAPH_NODES
            )));
        }
        let parent = require_node(&tx, parent_id)?;
        if parent.graph_id != graph_id {
            return Err(invalid("parent node belongs to a different graph"));
        }
        let depth = parent
            .depth
            .checked_add(1)
            .ok_or_else(|| invalid("agent node depth overflow"))?;
        if depth > graph.max_depth || depth > MAX_AGENT_GRAPH_DEPTH {
            return Err(invalid(format!(
                "node depth {depth} exceeds graph maxDepth {}",
                graph.max_depth
            )));
        }
        let node = insert_node(&tx, graph_id, input, depth, AgentNodeState::Created, 1, at)?;
        let graph = advance_graph(&tx, &graph, at)?;
        tx.commit()?;
        Ok(AgentGraphMutation { graph, value: node })
    }

    pub fn agent_edges(&self, graph_id: &str) -> Result<Vec<AgentEdgeRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        let mut statement = self.conn.prepare(
            "SELECT id, graph_id, from_node_id, to_node_id, kind, required, condition_json,
                    created_at
             FROM agent_edges WHERE graph_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![graph_id], read_edge)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

impl SessionStore {
    /// Add an edge only after endpoint ownership and the incremental dependency
    /// DAG invariant are checked under the graph revision fence.
    pub fn add_agent_edge(
        &mut self,
        graph_id: &str,
        expected_graph_revision: i64,
        input: &AgentEdgeCreate,
    ) -> Result<AgentGraphMutation<AgentEdgeRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        validate_edge_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let graph = require_graph(&tx, graph_id)?;
        ensure_graph_revision(&graph, expected_graph_revision)?;
        ensure_graph_mutable(&graph)?;
        let from = require_node(&tx, &input.from_node_id)?;
        let to = require_node(&tx, &input.to_node_id)?;
        if from.graph_id != graph_id || to.graph_id != graph_id {
            return Err(invalid("edge endpoints must belong to the target graph"));
        }
        if input.from_node_id == input.to_node_id {
            return Err(invalid("agent graph edge cannot point to itself"));
        }
        if input.kind == AgentEdgeKind::ParentChild
            && (to.parent_node_id.as_deref() != Some(&from.id) || to.depth != from.depth + 1)
        {
            return Err(invalid(
                "parent_child edge must match the child node parent and depth",
            ));
        }
        if input.kind == AgentEdgeKind::DependsOn
            && depends_on_would_cycle(&tx, graph_id, &input.from_node_id, &input.to_node_id)?
        {
            return Err(invalid("depends_on edge would introduce a cycle"));
        }
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_edges
                WHERE graph_id = ?1 AND from_node_id = ?2 AND to_node_id = ?3 AND kind = ?4
             )",
            params![
                graph_id,
                input.from_node_id,
                input.to_node_id,
                input.kind.label()
            ],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(invalid("duplicate graph edge"));
        }
        let condition_json = input
            .condition
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        tx.execute(
            "INSERT INTO agent_edges (
                id, graph_id, from_node_id, to_node_id, kind, required, condition_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.id,
                graph_id,
                input.from_node_id,
                input.to_node_id,
                input.kind.label(),
                i64::from(input.required),
                condition_json,
                input.created_at,
            ],
        )?;
        let edge = AgentEdgeRecord {
            id: input.id.clone(),
            graph_id: graph_id.into(),
            from_node_id: input.from_node_id.clone(),
            to_node_id: input.to_node_id.clone(),
            kind: input.kind,
            required: input.required,
            condition: input.condition.clone(),
            created_at: input.created_at.clone(),
        };
        let graph = advance_graph(&tx, &graph, &input.created_at)?;
        tx.commit()?;
        Ok(AgentGraphMutation { graph, value: edge })
    }
}

impl SessionStore {
    /// Apply a node transition under both graph and node CAS fences. Late worker
    /// output cannot overwrite a scheduler decision made after a restart.
    pub fn transition_agent_node(
        &mut self,
        graph_id: &str,
        node_id: &str,
        transition: &AgentNodeTransition,
    ) -> Result<AgentGraphMutation<AgentNodeRecord>, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        validate_identifier("nodeId", node_id, "agt_")?;
        validate_node_transition(transition)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let graph = require_graph(&tx, graph_id)?;
        ensure_graph_revision(&graph, transition.expected_graph_revision)?;
        let node = require_node(&tx, node_id)?;
        if node.graph_id != graph_id {
            return Err(invalid("node belongs to a different graph"));
        }
        ensure_node_revision(&node, transition.expected_node_revision)?;
        if !node_transition_allowed(node.state, transition.state) {
            return Err(invalid(format!(
                "invalid node state transition {} -> {}",
                node.state.label(),
                transition.state.label()
            )));
        }
        if transition.state == AgentNodeState::Blocked && transition.blocked_reason.is_none() {
            return Err(invalid("blocked node transition requires blockedReason"));
        }
        if transition.state != AgentNodeState::Blocked && transition.blocked_reason.is_some() {
            return Err(invalid(
                "blockedReason is only valid for blocked node state",
            ));
        }
        if !transition.state.is_terminal() && transition.result.is_some() {
            return Err(invalid("non-terminal node transition cannot set a result"));
        }
        let revision = node
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("agent node revision overflow"))?;
        let terminal_at = transition
            .state
            .is_terminal()
            .then(|| transition.at.clone());
        let changed = tx.execute(
            "UPDATE agent_nodes
             SET state = ?2, result_json = ?3, blocked_reason_json = ?4, revision = ?5,
                 updated_at = ?6, terminal_at = ?7
             WHERE id = ?1 AND revision = ?8",
            params![
                node_id,
                transition.state.label(),
                transition
                    .result
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                transition
                    .blocked_reason
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                revision,
                transition.at,
                terminal_at,
                node.revision,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::AgentNodeRevisionConflict {
                node_id: node_id.into(),
                expected: transition.expected_node_revision,
                actual: agent_node_revision(&tx, node_id)?,
            });
        }
        let value = AgentNodeRecord {
            state: transition.state,
            result: transition.result.clone(),
            blocked_reason: transition.blocked_reason.clone(),
            revision,
            updated_at: transition.at.clone(),
            terminal_at,
            ..node
        };
        let graph = advance_graph(&tx, &graph, &transition.at)?;
        tx.commit()?;
        Ok(AgentGraphMutation { graph, value })
    }

    pub fn transition_agent_graph(
        &mut self,
        graph_id: &str,
        transition: &GraphStateTransition,
    ) -> Result<AgentGraphRecord, StoreError> {
        validate_identifier("graphId", graph_id, "grf_")?;
        validate_timestamp("at", &transition.at)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let graph = require_graph(&tx, graph_id)?;
        ensure_graph_revision(&graph, transition.expected_graph_revision)?;
        if !graph_transition_allowed(graph.state, transition.state) {
            return Err(invalid(format!(
                "invalid graph state transition {} -> {}",
                graph.state.label(),
                transition.state.label()
            )));
        }
        let revision = graph
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("agent graph revision overflow"))?;
        let changed = tx.execute(
            "UPDATE agent_graphs SET state = ?2, revision = ?3, updated_at = ?4
             WHERE id = ?1 AND revision = ?5",
            params![
                graph_id,
                transition.state.label(),
                revision,
                transition.at,
                graph.revision
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::GraphRevisionConflict {
                graph_id: graph_id.into(),
                expected: transition.expected_graph_revision,
                actual: graph_revision(&tx, graph_id)?,
            });
        }
        let result = AgentGraphRecord {
            state: transition.state,
            revision,
            updated_at: transition.at.clone(),
            ..graph
        };
        tx.commit()?;
        Ok(result)
    }
}

fn invalid(detail: impl Into<String>) -> StoreError {
    StoreError::InvalidAgentGraph {
        detail: detail.into(),
    }
}

fn validate_graph_create(input: &AgentGraphCreate) -> Result<(), StoreError> {
    validate_identifier("graphId", &input.id, "grf_")?;
    validate_identifier("sessionId", &input.session_id, "ses_")?;
    validate_bounded_text(
        "workspaceIdentityDigest",
        &input.workspace_identity_digest,
        MAX_GRAPH_IDENTIFIER_BYTES,
    )?;
    if input.max_depth < 0 || input.max_depth > MAX_AGENT_GRAPH_DEPTH {
        return Err(invalid(format!(
            "maxDepth must be between 0 and {MAX_AGENT_GRAPH_DEPTH}"
        )));
    }
    validate_json_object("budget", &input.budget)?;
    validate_timestamp("createdAt", &input.created_at)?;
    validate_node_create(&input.root)?;
    if input.root.parent_node_id.is_some() {
        return Err(invalid("root node must not have parentNodeId"));
    }
    Ok(())
}

fn validate_node_create(input: &AgentNodeCreate) -> Result<(), StoreError> {
    validate_identifier("nodeId", &input.id, "agt_")?;
    if let Some(parent_id) = &input.parent_node_id {
        validate_identifier("parentNodeId", parent_id, "agt_")?;
    }
    validate_bounded_text("role", &input.role, 128)?;
    if let Some(name) = &input.name {
        validate_bounded_text("name", name, 256)?;
    }
    validate_bounded_text("title", &input.title, 512)?;
    validate_bounded_text("modelProfile", &input.model_profile, 256)?;
    if let Some(worktree_id) = &input.worktree_id {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
    }
    if input.max_attempts < 1 || input.max_attempts > MAX_ATTEMPTS_PER_NODE {
        return Err(invalid(format!(
            "maxAttempts must be between 1 and {MAX_ATTEMPTS_PER_NODE}"
        )));
    }
    validate_json_object("task", &input.task)?;
    validate_json_object("permissionScope", &input.permission_scope)
}

fn validate_edge_create(input: &AgentEdgeCreate) -> Result<(), StoreError> {
    validate_identifier("edgeId", &input.id, "edg_")?;
    validate_identifier("fromNodeId", &input.from_node_id, "agt_")?;
    validate_identifier("toNodeId", &input.to_node_id, "agt_")?;
    validate_timestamp("createdAt", &input.created_at)?;
    if let Some(condition) = &input.condition {
        validate_json_object("condition", condition)?;
    }
    Ok(())
}

fn validate_node_transition(transition: &AgentNodeTransition) -> Result<(), StoreError> {
    if transition.expected_graph_revision < 1 {
        return Err(invalid("expectedGraphRevision must be positive"));
    }
    if transition.expected_node_revision < 1 {
        return Err(invalid("expectedNodeRevision must be positive"));
    }
    validate_timestamp("at", &transition.at)?;
    if let Some(result) = &transition.result {
        validate_json_object("result", result)?;
    }
    if let Some(reason) = &transition.blocked_reason {
        validate_json_object("blockedReason", reason)?;
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str, required_prefix: &str) -> Result<(), StoreError> {
    if !value.starts_with(required_prefix)
        || value.len() > MAX_GRAPH_IDENTIFIER_BYTES
        || value.len() == required_prefix.len()
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!(
            "{field} must be a bounded identifier beginning with {required_prefix}"
        )));
    }
    Ok(())
}

fn validate_bounded_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{field} must be bounded non-empty text")));
    }
    if cbc_redaction::redact_patterns_only(value).report.redacted() {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 96
        || !value.contains('T')
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{field} must be an ISO-8601 timestamp")));
    }
    Ok(())
}

fn validate_json_object(field: &str, value: &serde_json::Value) -> Result<(), StoreError> {
    if !value.is_object() {
        return Err(invalid(format!("{field} must be a JSON object")));
    }
    reject_credential_payload(value)?;
    let serialized = serde_json::to_string(value)?;
    if serialized.len() > MAX_AGENT_GRAPH_PAYLOAD_BYTES {
        return Err(invalid(format!(
            "{field} exceeds the {MAX_AGENT_GRAPH_PAYLOAD_BYTES} byte limit"
        )));
    }
    if cbc_redaction::redact_patterns_only(&serialized)
        .report
        .redacted()
    {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

fn ensure_session_workspace(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    workspace_identity_digest: &str,
) -> Result<(), StoreError> {
    let workspace = tx
        .query_row(
            "SELECT workspaces.canonical_path_hash
             FROM sessions JOIN workspaces ON workspaces.id = sessions.workspace_id WHERE sessions.id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("session {session_id}"),
        })?;
    if workspace != workspace_identity_digest {
        return Err(invalid(
            "graph workspaceIdentityDigest does not match its session workspace fingerprint",
        ));
    }
    Ok(())
}

fn require_graph(
    tx: &rusqlite::Transaction<'_>,
    graph_id: &str,
) -> Result<AgentGraphRecord, StoreError> {
    tx.query_row(
        "SELECT id, session_id, workspace_identity_digest, root_node_id, state,
                revision, max_depth, budget_json, created_at, updated_at
         FROM agent_graphs WHERE id = ?1",
        params![graph_id],
        read_graph,
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound {
        what: format!("agent graph {graph_id}"),
    })
}

fn require_node(
    tx: &rusqlite::Transaction<'_>,
    node_id: &str,
) -> Result<AgentNodeRecord, StoreError> {
    tx.query_row(
        "SELECT id, graph_id, parent_node_id, depth, role, name, title, task_json,
                state, model_profile, permission_scope_json, worktree_id, active_attempt_id,
                attempt_count, max_attempts, priority, result_json, blocked_reason_json,
                revision, created_at, updated_at, terminal_at
         FROM agent_nodes WHERE id = ?1",
        params![node_id],
        read_node,
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound {
        what: format!("agent node {node_id}"),
    })
}

fn insert_node(
    tx: &rusqlite::Transaction<'_>,
    graph_id: &str,
    input: &AgentNodeCreate,
    depth: i64,
    state: AgentNodeState,
    revision: i64,
    at: &str,
) -> Result<AgentNodeRecord, StoreError> {
    tx.execute(
        "INSERT INTO agent_nodes (
            id, graph_id, parent_node_id, depth, role, name, title, task_json, state,
            model_profile, permission_scope_json, worktree_id, active_attempt_id,
            attempt_count, max_attempts, priority, result_json, blocked_reason_json,
            revision, created_at, updated_at, terminal_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, 0, ?13, ?14,
            NULL, NULL, ?15, ?16, ?16, NULL
         )",
        params![
            input.id,
            graph_id,
            input.parent_node_id,
            depth,
            input.role,
            input.name,
            input.title,
            serde_json::to_string(&input.task)?,
            state.label(),
            input.model_profile,
            serde_json::to_string(&input.permission_scope)?,
            input.worktree_id,
            input.max_attempts,
            input.priority,
            revision,
            at,
        ],
    )?;
    Ok(AgentNodeRecord {
        id: input.id.clone(),
        graph_id: graph_id.into(),
        parent_node_id: input.parent_node_id.clone(),
        depth,
        role: input.role.clone(),
        name: input.name.clone(),
        title: input.title.clone(),
        task: input.task.clone(),
        state,
        model_profile: input.model_profile.clone(),
        permission_scope: input.permission_scope.clone(),
        worktree_id: input.worktree_id.clone(),
        active_attempt_id: None,
        attempt_count: 0,
        max_attempts: input.max_attempts,
        priority: input.priority,
        result: None,
        blocked_reason: None,
        revision,
        created_at: at.into(),
        updated_at: at.into(),
        terminal_at: None,
    })
}

fn ensure_graph_revision(
    graph: &AgentGraphRecord,
    expected_graph_revision: i64,
) -> Result<(), StoreError> {
    if expected_graph_revision < 1 || graph.revision != expected_graph_revision {
        return Err(StoreError::GraphRevisionConflict {
            graph_id: graph.id.clone(),
            expected: expected_graph_revision,
            actual: Some(graph.revision),
        });
    }
    Ok(())
}

fn ensure_node_revision(
    node: &AgentNodeRecord,
    expected_node_revision: i64,
) -> Result<(), StoreError> {
    if expected_node_revision < 1 || node.revision != expected_node_revision {
        return Err(StoreError::AgentNodeRevisionConflict {
            node_id: node.id.clone(),
            expected: expected_node_revision,
            actual: Some(node.revision),
        });
    }
    Ok(())
}

fn ensure_graph_mutable(graph: &AgentGraphRecord) -> Result<(), StoreError> {
    if graph.state != AgentGraphState::Active {
        return Err(invalid(format!(
            "graph {} is {}, not active",
            graph.id,
            graph.state.label()
        )));
    }
    Ok(())
}

fn advance_graph(
    tx: &rusqlite::Transaction<'_>,
    graph: &AgentGraphRecord,
    at: &str,
) -> Result<AgentGraphRecord, StoreError> {
    let revision = graph
        .revision
        .checked_add(1)
        .ok_or_else(|| invalid("agent graph revision overflow"))?;
    let changed = tx.execute(
        "UPDATE agent_graphs SET revision = ?2, updated_at = ?3 WHERE id = ?1 AND revision = ?4",
        params![graph.id, revision, at, graph.revision],
    )?;
    if changed != 1 {
        return Err(StoreError::GraphRevisionConflict {
            graph_id: graph.id.clone(),
            expected: graph.revision,
            actual: graph_revision(tx, &graph.id)?,
        });
    }
    Ok(AgentGraphRecord {
        revision,
        updated_at: at.into(),
        ..graph.clone()
    })
}

fn graph_revision(
    tx: &rusqlite::Transaction<'_>,
    graph_id: &str,
) -> Result<Option<i64>, StoreError> {
    tx.query_row(
        "SELECT revision FROM agent_graphs WHERE id = ?1",
        params![graph_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(StoreError::from)
}

fn agent_node_revision(
    tx: &rusqlite::Transaction<'_>,
    node_id: &str,
) -> Result<Option<i64>, StoreError> {
    tx.query_row(
        "SELECT revision FROM agent_nodes WHERE id = ?1",
        params![node_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(StoreError::from)
}

fn depends_on_would_cycle(
    tx: &rusqlite::Transaction<'_>,
    graph_id: &str,
    from_node_id: &str,
    to_node_id: &str,
) -> Result<bool, StoreError> {
    tx.query_row(
        "WITH RECURSIVE reachable(node_id) AS (
            SELECT to_node_id
            FROM agent_edges
            WHERE graph_id = ?1 AND from_node_id = ?2 AND kind = 'depends_on'
            UNION
            SELECT edge.to_node_id
            FROM agent_edges AS edge
            JOIN reachable ON edge.from_node_id = reachable.node_id
            WHERE edge.graph_id = ?1 AND edge.kind = 'depends_on'
         )
         SELECT EXISTS(SELECT 1 FROM reachable WHERE node_id = ?3)",
        params![graph_id, to_node_id, from_node_id],
        |row| row.get(0),
    )
    .map_err(StoreError::from)
}

fn node_transition_allowed(from: AgentNodeState, to: AgentNodeState) -> bool {
    use AgentNodeState as State;
    match from {
        State::Created => matches!(to, State::Queued | State::Cancelled | State::Blocked),
        State::Queued => matches!(
            to,
            State::WaitingDependency
                | State::WaitingBudget
                | State::Dispatching
                | State::Paused
                | State::Cancelled
                | State::Blocked
        ),
        State::WaitingDependency | State::WaitingBudget | State::WaitingMessage => matches!(
            to,
            State::Queued | State::Paused | State::Cancelled | State::Blocked
        ),
        State::WaitingApproval => matches!(
            to,
            State::Running | State::Paused | State::Cancelled | State::Blocked
        ),
        State::Dispatching => matches!(
            to,
            State::Running | State::Queued | State::Failed | State::Cancelled | State::Blocked
        ),
        State::Running => matches!(
            to,
            State::WaitingApproval
                | State::WaitingMessage
                | State::Paused
                | State::Reconciling
                | State::Completed
                | State::Partial
                | State::Failed
                | State::Cancelled
                | State::Blocked
        ),
        State::Paused => matches!(
            to,
            State::Queued
                | State::WaitingDependency
                | State::WaitingApproval
                | State::Cancelled
                | State::Blocked
        ),
        State::Reconciling => matches!(
            to,
            State::Queued
                | State::Completed
                | State::Partial
                | State::Failed
                | State::Cancelled
                | State::Blocked
        ),
        State::Partial | State::Failed | State::Blocked => {
            matches!(to, State::Queued | State::Cancelled)
        }
        State::Completed | State::Cancelled | State::Inactive => false,
    }
}

fn graph_transition_allowed(from: AgentGraphState, to: AgentGraphState) -> bool {
    use AgentGraphState as State;
    match from {
        State::Active => matches!(
            to,
            State::Paused | State::Completed | State::Failed | State::Cancelled | State::Blocked
        ),
        State::Paused => matches!(to, State::Active | State::Cancelled | State::Blocked),
        State::Blocked => matches!(to, State::Active | State::Cancelled),
        State::Completed | State::Failed | State::Cancelled => false,
    }
}

fn read_graph(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentGraphRecord> {
    let raw_state: String = row.get(4)?;
    let state = AgentGraphState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AgentGraphRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        workspace_identity_digest: row.get(2)?,
        root_node_id: row.get(3)?,
        state,
        revision: row.get(5)?,
        max_depth: row.get(6)?,
        budget: json_column(row.get(7)?, 7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentNodeRecord> {
    let raw_state: String = row.get(8)?;
    let state = AgentNodeState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AgentNodeRecord {
        id: row.get(0)?,
        graph_id: row.get(1)?,
        parent_node_id: row.get(2)?,
        depth: row.get(3)?,
        role: row.get(4)?,
        name: row.get(5)?,
        title: row.get(6)?,
        task: json_column(row.get(7)?, 7)?,
        state,
        model_profile: row.get(9)?,
        permission_scope: json_column(row.get(10)?, 10)?,
        worktree_id: row.get(11)?,
        active_attempt_id: row.get(12)?,
        attempt_count: row.get(13)?,
        max_attempts: row.get(14)?,
        priority: row.get(15)?,
        result: optional_json_column(row.get(16)?, 16)?,
        blocked_reason: optional_json_column(row.get(17)?, 17)?,
        revision: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        terminal_at: row.get(21)?,
    })
}

fn read_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentEdgeRecord> {
    let raw_kind: String = row.get(4)?;
    let kind = AgentEdgeKind::parse(&raw_kind).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AgentEdgeRecord {
        id: row.get(0)?,
        graph_id: row.get(1)?,
        from_node_id: row.get(2)?,
        to_node_id: row.get(3)?,
        kind,
        required: row.get::<_, i64>(5)? != 0,
        condition: optional_json_column(row.get(6)?, 6)?,
        created_at: row.get(7)?,
    })
}

fn json_column(raw: String, index: usize) -> rusqlite::Result<serde_json::Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn optional_json_column(
    raw: Option<String>,
    index: usize,
) -> rusqlite::Result<Option<serde_json::Value>> {
    raw.map(|value| json_column(value, index)).transpose()
}
