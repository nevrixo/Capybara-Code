//! Durable daemon ownership, client attachment, and split-brain fencing.
//!
//! This module intentionally persists only local coordination facts. It does not
//! grant filesystem, process, or network authority; all such effects still cross
//! the runtime capability boundary.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{SessionStore, StoreError};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonState {
    Active,
    Stopped,
    Crashed,
}

impl DaemonState {
    fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Stopped => "stopped",
            Self::Crashed => "crashed",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "active" => Ok(Self::Active),
            "stopped" => Ok(Self::Stopped),
            "crashed" => Ok(Self::Crashed),
            _ => Err(invalid(format!("daemon state is unsupported: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInstanceInput {
    pub id: String,
    pub pid: i64,
    pub executable_digest: String,
    pub protocol_version: String,
    pub started_at: String,
    pub heartbeat_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInstanceRecord {
    pub id: String,
    pub pid: i64,
    pub executable_digest: String,
    pub protocol_version: String,
    pub started_at: String,
    pub heartbeat_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    pub state: DaemonState,
}

/// A prospective or renewal session-actor lease. The lease end must be strictly
/// later than now; callers never get an implicit infinite owner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOwnerLease {
    pub session_id: String,
    pub daemon_id: String,
    pub now: String,
    pub lease_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOwnerRecord {
    pub session_id: String,
    pub daemon_id: String,
    pub owner_epoch: i64,
    pub lease_expires_at: String,
    pub acquired_at: String,
    pub heartbeat_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum SessionOwnerClaim {
    Acquired { owner: SessionOwnerRecord },
    Renewed { owner: SessionOwnerRecord },
    TakenOver { owner: SessionOwnerRecord },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentMode {
    Control,
    Observer,
}

impl AttachmentMode {
    fn label(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Observer => "observer",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "control" => Ok(Self::Control),
            "observer" => Ok(Self::Observer),
            _ => Err(invalid(format!("attachment mode is unsupported: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientAttachmentInput {
    pub connection_id: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub mode: AttachmentMode,
    pub attached_at: String,
    pub last_event_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientAttachmentRecord {
    pub connection_id: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub mode: AttachmentMode,
    pub attached_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached_at: Option<String>,
    pub last_event_sequence: i64,
}

impl SessionStore {
    /// Register exactly one live daemon identity. Re-registering the same active
    /// process is a heartbeat; recycling an ID for a different binary or PID is
    /// rejected so a stale lock cannot impersonate a new daemon.
    pub fn register_daemon(
        &mut self,
        input: &DaemonInstanceInput,
    ) -> Result<DaemonInstanceRecord, StoreError> {
        validate_daemon_input(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT id, pid, executable_digest, protocol_version, started_at, heartbeat_at,
                        stopped_at, state
                 FROM daemon_instances WHERE id = ?1",
                params![input.id],
                read_daemon_instance,
            )
            .optional()?;
        let record = match existing {
            None => {
                tx.execute(
                    "INSERT INTO daemon_instances (
                        id, pid, executable_digest, protocol_version, started_at, heartbeat_at,
                        stopped_at, state
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'active')",
                    params![
                        input.id,
                        input.pid,
                        input.executable_digest,
                        input.protocol_version,
                        input.started_at,
                        input.heartbeat_at,
                    ],
                )?;
                DaemonInstanceRecord {
                    id: input.id.clone(),
                    pid: input.pid,
                    executable_digest: input.executable_digest.clone(),
                    protocol_version: input.protocol_version.clone(),
                    started_at: input.started_at.clone(),
                    heartbeat_at: input.heartbeat_at.clone(),
                    stopped_at: None,
                    state: DaemonState::Active,
                }
            }
            Some(existing) => {
                if existing.state != DaemonState::Active {
                    return Err(invalid(format!(
                        "daemon {} is terminal; start a new daemon id instead",
                        input.id
                    )));
                }
                if existing.pid != input.pid
                    || existing.executable_digest != input.executable_digest
                    || existing.protocol_version != input.protocol_version
                    || existing.started_at != input.started_at
                {
                    return Err(invalid(format!(
                        "daemon {} registration does not match its active identity",
                        input.id
                    )));
                }
                if input.heartbeat_at < existing.heartbeat_at {
                    return Err(invalid(format!(
                        "daemon {} heartbeat must not move backward",
                        input.id
                    )));
                }
                tx.execute(
                    "UPDATE daemon_instances SET heartbeat_at = ?2
                     WHERE id = ?1 AND state = 'active'",
                    params![input.id, input.heartbeat_at],
                )?;
                DaemonInstanceRecord {
                    heartbeat_at: input.heartbeat_at.clone(),
                    ..existing
                }
            }
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn daemon_instance(
        &self,
        daemon_id: &str,
    ) -> Result<Option<DaemonInstanceRecord>, StoreError> {
        validate_token("daemonId", daemon_id, 256)?;
        self.conn
            .query_row(
                "SELECT id, pid, executable_digest, protocol_version, started_at, heartbeat_at,
                        stopped_at, state
                 FROM daemon_instances WHERE id = ?1",
                params![daemon_id],
                read_daemon_instance,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Update only an active daemon. A stopped/crashed record cannot be revived by
    /// a late heartbeat.
    pub fn heartbeat_daemon(
        &mut self,
        daemon_id: &str,
        heartbeat_at: &str,
    ) -> Result<DaemonInstanceRecord, StoreError> {
        validate_token("daemonId", daemon_id, 256)?;
        validate_timestamp("heartbeatAt", heartbeat_at)?;
        let changed = self.conn.execute(
            "UPDATE daemon_instances SET heartbeat_at = ?2
             WHERE id = ?1 AND state = 'active' AND heartbeat_at <= ?2",
            params![daemon_id, heartbeat_at],
        )?;
        if changed == 0 {
            let existing = self.daemon_instance(daemon_id)?;
            return Err(invalid(match existing {
                Some(record) if record.state != DaemonState::Active => {
                    format!("daemon {daemon_id} is {}", record.state.label())
                }
                Some(_) => format!("daemon {daemon_id} heartbeat must not move backward"),
                None => format!("daemon {daemon_id} does not exist"),
            }));
        }
        self.daemon_instance(daemon_id)?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("daemon {daemon_id} after heartbeat"),
            })
    }

    /// Terminal daemon state is idempotent only when the stored terminal state
    /// already matches. Active owner rows remain until their leases expire or an
    /// explicit release succeeds, preserving the split-brain fence across crashes.
    pub fn stop_daemon(
        &mut self,
        daemon_id: &str,
        state: DaemonState,
        stopped_at: &str,
    ) -> Result<DaemonInstanceRecord, StoreError> {
        validate_token("daemonId", daemon_id, 256)?;
        validate_timestamp("stoppedAt", stopped_at)?;
        if state == DaemonState::Active {
            return Err(invalid("stop_daemon requires stopped or crashed state"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT id, pid, executable_digest, protocol_version, started_at, heartbeat_at,
                        stopped_at, state
                 FROM daemon_instances WHERE id = ?1",
                params![daemon_id],
                read_daemon_instance,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("daemon {daemon_id}"),
            })?;
        if existing.state != DaemonState::Active {
            if existing.state == state {
                return Ok(existing);
            }
            return Err(invalid(format!(
                "daemon {daemon_id} is already terminal as {}",
                existing.state.label()
            )));
        }
        if stopped_at < existing.heartbeat_at.as_str() {
            return Err(invalid(
                "stoppedAt must not precede the last daemon heartbeat",
            ));
        }
        tx.execute(
            "UPDATE daemon_instances SET state = ?2, stopped_at = ?3, heartbeat_at = ?3
             WHERE id = ?1 AND state = 'active'",
            params![daemon_id, state.label(), stopped_at],
        )?;
        let record = DaemonInstanceRecord {
            heartbeat_at: stopped_at.into(),
            stopped_at: Some(stopped_at.into()),
            state,
            ..existing
        };
        tx.commit()?;
        Ok(record)
    }

    /// Claim, renew, or take over a session actor lease. A different daemon cannot
    /// acquire until the old lease has expired. Every takeover increments epoch,
    /// which later guards heartbeat/release commits from the stale daemon.
    pub fn claim_session_owner(
        &mut self,
        lease: &SessionOwnerLease,
    ) -> Result<SessionOwnerClaim, StoreError> {
        validate_owner_lease(lease)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_session_exists(&tx, &lease.session_id)?;
        let daemon = ensure_active_daemon(&tx, &lease.daemon_id)?;
        if lease.now.as_str() < daemon.heartbeat_at.as_str() {
            return Err(invalid(
                "lease now must not precede the claimant daemon heartbeat",
            ));
        }
        let existing = tx
            .query_row(
                "SELECT session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at,
                        heartbeat_at
                 FROM session_owners WHERE session_id = ?1",
                params![lease.session_id],
                read_session_owner,
            )
            .optional()?;
        if let Some(owner) = existing.as_ref() {
            if lease.now.as_str() < owner.heartbeat_at.as_str() {
                return Err(invalid(
                    "lease now must not precede the current owner heartbeat",
                ));
            }
        }
        let result = match existing {
            None => {
                let owner = SessionOwnerRecord {
                    session_id: lease.session_id.clone(),
                    daemon_id: lease.daemon_id.clone(),
                    owner_epoch: 1,
                    lease_expires_at: lease.lease_expires_at.clone(),
                    acquired_at: lease.now.clone(),
                    heartbeat_at: lease.now.clone(),
                };
                insert_session_owner(&tx, &owner)?;
                SessionOwnerClaim::Acquired { owner }
            }
            Some(existing) if existing.lease_expires_at > lease.now => {
                if existing.daemon_id != lease.daemon_id {
                    return Err(StoreError::DaemonLeaseConflict {
                        session_id: lease.session_id.clone(),
                        owner_daemon_id: existing.daemon_id,
                        lease_expires_at: existing.lease_expires_at,
                    });
                }
                let owner = SessionOwnerRecord {
                    lease_expires_at: lease.lease_expires_at.clone(),
                    heartbeat_at: lease.now.clone(),
                    ..existing
                };
                update_session_owner(&tx, &owner)?;
                SessionOwnerClaim::Renewed { owner }
            }
            Some(existing) => {
                let owner_epoch = existing.owner_epoch.checked_add(1).ok_or_else(|| {
                    invalid(format!("session {} owner epoch overflow", lease.session_id))
                })?;
                let owner = SessionOwnerRecord {
                    session_id: lease.session_id.clone(),
                    daemon_id: lease.daemon_id.clone(),
                    owner_epoch,
                    lease_expires_at: lease.lease_expires_at.clone(),
                    acquired_at: lease.now.clone(),
                    heartbeat_at: lease.now.clone(),
                };
                update_session_owner(&tx, &owner)?;
                SessionOwnerClaim::TakenOver { owner }
            }
        };
        tx.commit()?;
        Ok(result)
    }

    /// Compare-and-swap renewal. The old owner may not revive an expired lease or
    /// advance the heartbeat after a takeover.
    pub fn renew_session_owner(
        &mut self,
        lease: &SessionOwnerLease,
        expected_owner_epoch: i64,
    ) -> Result<SessionOwnerRecord, StoreError> {
        validate_owner_lease(lease)?;
        if expected_owner_epoch < 1 {
            return Err(invalid("expectedOwnerEpoch must be positive"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let daemon = ensure_active_daemon(&tx, &lease.daemon_id)?;
        if lease.now.as_str() < daemon.heartbeat_at.as_str() {
            return Err(invalid(
                "lease now must not precede the claimant daemon heartbeat",
            ));
        }
        let existing = tx
            .query_row(
                "SELECT session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at,
                        heartbeat_at
                 FROM session_owners WHERE session_id = ?1",
                params![lease.session_id],
                read_session_owner,
            )
            .optional()?;
        let Some(existing) = existing else {
            return Err(StoreError::OwnerEpochConflict {
                session_id: lease.session_id.clone(),
                expected: expected_owner_epoch,
                actual: None,
            });
        };
        if existing.owner_epoch != expected_owner_epoch {
            return Err(StoreError::OwnerEpochConflict {
                session_id: lease.session_id.clone(),
                expected: expected_owner_epoch,
                actual: Some(existing.owner_epoch),
            });
        }
        if lease.now.as_str() < existing.heartbeat_at.as_str() {
            return Err(invalid(
                "lease now must not precede the current owner heartbeat",
            ));
        }
        if existing.daemon_id != lease.daemon_id || existing.lease_expires_at <= lease.now {
            return Err(StoreError::DaemonLeaseConflict {
                session_id: lease.session_id.clone(),
                owner_daemon_id: existing.daemon_id,
                lease_expires_at: existing.lease_expires_at,
            });
        }
        let owner = SessionOwnerRecord {
            lease_expires_at: lease.lease_expires_at.clone(),
            heartbeat_at: lease.now.clone(),
            ..existing
        };
        update_session_owner(&tx, &owner)?;
        tx.commit()?;
        Ok(owner)
    }

    /// Release only the exact epoch that owns the session. The row is retained
    /// with an explicit expiry so the next claimant increments the same monotonic
    /// epoch; deleting it would let a stale epoch be reused after re-acquisition.
    pub fn release_session_owner(
        &mut self,
        session_id: &str,
        daemon_id: &str,
        expected_owner_epoch: i64,
        released_at: &str,
    ) -> Result<SessionOwnerRecord, StoreError> {
        validate_token("sessionId", session_id, 256)?;
        validate_token("daemonId", daemon_id, 256)?;
        validate_timestamp("releasedAt", released_at)?;
        if expected_owner_epoch < 1 {
            return Err(invalid("expectedOwnerEpoch must be positive"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at,
                        heartbeat_at
                 FROM session_owners WHERE session_id = ?1",
                params![session_id],
                read_session_owner,
            )
            .optional()?;
        let Some(existing) = existing else {
            return Err(StoreError::OwnerEpochConflict {
                session_id: session_id.into(),
                expected: expected_owner_epoch,
                actual: None,
            });
        };
        if existing.owner_epoch != expected_owner_epoch {
            return Err(StoreError::OwnerEpochConflict {
                session_id: session_id.into(),
                expected: expected_owner_epoch,
                actual: Some(existing.owner_epoch),
            });
        }
        if existing.daemon_id != daemon_id {
            return Err(StoreError::DaemonLeaseConflict {
                session_id: session_id.into(),
                owner_daemon_id: existing.daemon_id,
                lease_expires_at: existing.lease_expires_at,
            });
        }
        if released_at < existing.heartbeat_at.as_str()
            || released_at > existing.lease_expires_at.as_str()
        {
            return Err(invalid(
                "releasedAt must be between the owner heartbeat and lease expiry",
            ));
        }
        let owner = SessionOwnerRecord {
            lease_expires_at: released_at.into(),
            heartbeat_at: released_at.into(),
            ..existing
        };
        update_session_owner(&tx, &owner)?;
        tx.commit()?;
        Ok(owner)
    }

    pub fn session_owner(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionOwnerRecord>, StoreError> {
        validate_token("sessionId", session_id, 256)?;
        self.conn
            .query_row(
                "SELECT session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at,
                        heartbeat_at
                 FROM session_owners WHERE session_id = ?1",
                params![session_id],
                read_session_owner,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Read expired owners without deleting them. A recovery coordinator can report
    /// these records before a replacement acquires the next epoch.
    pub fn expired_session_owners(&self, now: &str) -> Result<Vec<SessionOwnerRecord>, StoreError> {
        validate_timestamp("now", now)?;
        let mut statement = self.conn.prepare(
            "SELECT session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at,
                    heartbeat_at
             FROM session_owners WHERE lease_expires_at <= ?1
             ORDER BY lease_expires_at ASC, session_id ASC",
        )?;
        let rows = statement.query_map(params![now], read_session_owner)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Attach or reattach a client connection. Detach does not cancel a turn: the
    /// record only controls observation and interactive ownership policy above this
    /// storage boundary.
    pub fn attach_client(
        &mut self,
        input: &ClientAttachmentInput,
    ) -> Result<ClientAttachmentRecord, StoreError> {
        validate_attachment_input(input)?;
        if let Some(session_id) = &input.session_id {
            let exists = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
                params![session_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                return Err(StoreError::NotFound {
                    what: format!("session {session_id}"),
                });
            }
        }
        self.conn.execute(
            "INSERT INTO client_attachments (
                connection_id, client_id, session_id, mode, attached_at, detached_at,
                last_event_sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
             ON CONFLICT(connection_id) DO UPDATE SET
                client_id = excluded.client_id,
                session_id = excluded.session_id,
                mode = excluded.mode,
                attached_at = excluded.attached_at,
                detached_at = NULL,
                last_event_sequence = MAX(client_attachments.last_event_sequence,
                                          excluded.last_event_sequence)",
            params![
                input.connection_id,
                input.client_id,
                input.session_id,
                input.mode.label(),
                input.attached_at,
                input.last_event_sequence,
            ],
        )?;
        self.client_attachment(&input.connection_id)?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("attachment {} after attach", input.connection_id),
            })
    }

    pub fn client_attachment(
        &self,
        connection_id: &str,
    ) -> Result<Option<ClientAttachmentRecord>, StoreError> {
        validate_token("connectionId", connection_id, 256)?;
        self.conn
            .query_row(
                "SELECT connection_id, client_id, session_id, mode, attached_at, detached_at,
                        last_event_sequence
                 FROM client_attachments WHERE connection_id = ?1",
                params![connection_id],
                read_client_attachment,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn detach_client(
        &mut self,
        connection_id: &str,
        detached_at: &str,
        last_event_sequence: i64,
    ) -> Result<ClientAttachmentRecord, StoreError> {
        validate_token("connectionId", connection_id, 256)?;
        validate_timestamp("detachedAt", detached_at)?;
        validate_event_sequence(last_event_sequence)?;
        let changed = self.conn.execute(
            "UPDATE client_attachments
             SET detached_at = COALESCE(detached_at, ?2),
                 last_event_sequence = MAX(last_event_sequence, ?3)
             WHERE connection_id = ?1",
            params![connection_id, detached_at, last_event_sequence],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                what: format!("attachment {connection_id}"),
            });
        }
        self.client_attachment(connection_id)?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("attachment {connection_id} after detach"),
            })
    }

    pub fn advance_attachment_cursor(
        &mut self,
        connection_id: &str,
        last_event_sequence: i64,
    ) -> Result<ClientAttachmentRecord, StoreError> {
        validate_token("connectionId", connection_id, 256)?;
        validate_event_sequence(last_event_sequence)?;
        let changed = self.conn.execute(
            "UPDATE client_attachments
             SET last_event_sequence = MAX(last_event_sequence, ?2)
             WHERE connection_id = ?1",
            params![connection_id, last_event_sequence],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                what: format!("attachment {connection_id}"),
            });
        }
        self.client_attachment(connection_id)?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("attachment {connection_id} after cursor update"),
            })
    }

    pub fn active_client_attachments(
        &self,
        session_id: &str,
    ) -> Result<Vec<ClientAttachmentRecord>, StoreError> {
        validate_token("sessionId", session_id, 256)?;
        let mut statement = self.conn.prepare(
            "SELECT connection_id, client_id, session_id, mode, attached_at, detached_at,
                    last_event_sequence
             FROM client_attachments
             WHERE session_id = ?1 AND detached_at IS NULL
             ORDER BY attached_at ASC, connection_id ASC",
        )?;
        let rows = statement.query_map(params![session_id], read_client_attachment)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

fn invalid(detail: impl Into<String>) -> StoreError {
    StoreError::InvalidDaemonRecord {
        detail: detail.into(),
    }
}

fn validate_token(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!(
            "{field} must be a bounded non-empty token"
        )));
    }
    Ok(())
}

/// Lease comparisons are lexical in SQLite, so accept only the fixed-width UTC
/// format emitted by cbc_patch::now_iso8601. Offsets and variable precision would
/// make two representations of the same instant sort differently.
fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    if separators
        .iter()
        .any(|(index, expected)| bytes[*index] != *expected)
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }

    let year = decimal_component(bytes, 0, 4);
    let month = decimal_component(bytes, 5, 7);
    let day = decimal_component(bytes, 8, 10);
    let hour = decimal_component(bytes, 11, 13);
    let minute = decimal_component(bytes, 14, 16);
    let second = decimal_component(bytes, 17, 19);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid(format!(
            "{field} must be a valid canonical RFC 3339 UTC timestamp"
        )));
    }
    Ok(())
}

fn decimal_component(bytes: &[u8], start: usize, end: usize) -> u32 {
    bytes[start..end]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn validate_event_sequence(value: i64) -> Result<(), StoreError> {
    if value < 0 {
        return Err(invalid("lastEventSequence must not be negative"));
    }
    Ok(())
}

fn validate_daemon_input(input: &DaemonInstanceInput) -> Result<(), StoreError> {
    validate_token("daemonId", &input.id, 256)?;
    validate_token("executableDigest", &input.executable_digest, 512)?;
    validate_token("protocolVersion", &input.protocol_version, 128)?;
    validate_timestamp("startedAt", &input.started_at)?;
    validate_timestamp("heartbeatAt", &input.heartbeat_at)?;
    if input.pid <= 0 {
        return Err(invalid("daemon pid must be positive"));
    }
    if input.heartbeat_at < input.started_at {
        return Err(invalid("daemon heartbeatAt must not precede startedAt"));
    }
    Ok(())
}

fn validate_owner_lease(lease: &SessionOwnerLease) -> Result<(), StoreError> {
    validate_token("sessionId", &lease.session_id, 256)?;
    validate_token("daemonId", &lease.daemon_id, 256)?;
    validate_timestamp("now", &lease.now)?;
    validate_timestamp("leaseExpiresAt", &lease.lease_expires_at)?;
    if lease.lease_expires_at <= lease.now {
        return Err(invalid("leaseExpiresAt must be later than now"));
    }
    Ok(())
}

fn validate_attachment_input(input: &ClientAttachmentInput) -> Result<(), StoreError> {
    validate_token("connectionId", &input.connection_id, 256)?;
    validate_token("clientId", &input.client_id, 256)?;
    if let Some(session_id) = &input.session_id {
        validate_token("sessionId", session_id, 256)?;
    }
    validate_timestamp("attachedAt", &input.attached_at)?;
    validate_event_sequence(input.last_event_sequence)
}

fn ensure_session_exists(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<(), StoreError> {
    let exists = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![session_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound {
            what: format!("session {session_id}"),
        });
    }
    Ok(())
}

fn ensure_active_daemon(
    tx: &rusqlite::Transaction<'_>,
    daemon_id: &str,
) -> Result<DaemonInstanceRecord, StoreError> {
    let daemon = tx
        .query_row(
            "SELECT id, pid, executable_digest, protocol_version, started_at, heartbeat_at,
                    stopped_at, state
             FROM daemon_instances WHERE id = ?1",
            params![daemon_id],
            read_daemon_instance,
        )
        .optional()?;
    match daemon {
        Some(record) if record.state == DaemonState::Active => Ok(record),
        Some(record) => Err(invalid(format!(
            "daemon {daemon_id} is {}",
            record.state.label()
        ))),
        None => Err(StoreError::NotFound {
            what: format!("daemon {daemon_id}"),
        }),
    }
}

fn insert_session_owner(
    tx: &rusqlite::Transaction<'_>,
    owner: &SessionOwnerRecord,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO session_owners (
            session_id, daemon_id, owner_epoch, lease_expires_at, acquired_at, heartbeat_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            owner.session_id,
            owner.daemon_id,
            owner.owner_epoch,
            owner.lease_expires_at,
            owner.acquired_at,
            owner.heartbeat_at,
        ],
    )?;
    Ok(())
}

fn update_session_owner(
    tx: &rusqlite::Transaction<'_>,
    owner: &SessionOwnerRecord,
) -> Result<(), StoreError> {
    let changed = tx.execute(
        "UPDATE session_owners
         SET daemon_id = ?2, owner_epoch = ?3, lease_expires_at = ?4, acquired_at = ?5,
             heartbeat_at = ?6
         WHERE session_id = ?1",
        params![
            owner.session_id,
            owner.daemon_id,
            owner.owner_epoch,
            owner.lease_expires_at,
            owner.acquired_at,
            owner.heartbeat_at,
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::NotFound {
            what: format!("session owner {}", owner.session_id),
        });
    }
    Ok(())
}

fn read_daemon_instance(row: &rusqlite::Row<'_>) -> rusqlite::Result<DaemonInstanceRecord> {
    let raw_state: String = row.get(7)?;
    let state = DaemonState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(DaemonInstanceRecord {
        id: row.get(0)?,
        pid: row.get(1)?,
        executable_digest: row.get(2)?,
        protocol_version: row.get(3)?,
        started_at: row.get(4)?,
        heartbeat_at: row.get(5)?,
        stopped_at: row.get(6)?,
        state,
    })
}

fn read_session_owner(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionOwnerRecord> {
    Ok(SessionOwnerRecord {
        session_id: row.get(0)?,
        daemon_id: row.get(1)?,
        owner_epoch: row.get(2)?,
        lease_expires_at: row.get(3)?,
        acquired_at: row.get(4)?,
        heartbeat_at: row.get(5)?,
    })
}

fn read_client_attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClientAttachmentRecord> {
    let raw_mode: String = row.get(3)?;
    let mode = AttachmentMode::parse(&raw_mode).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(ClientAttachmentRecord {
        connection_id: row.get(0)?,
        client_id: row.get(1)?,
        session_id: row.get(2)?,
        mode,
        attached_at: row.get(4)?,
        detached_at: row.get(5)?,
        last_event_sequence: row.get(6)?,
    })
}
