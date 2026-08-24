//! Durable App Server client identities and event-subscription cursors.
//!
//! The App Server owns transport authentication and live delivery. This module
//! owns only the durable facts needed for safe resume: a stable client identity,
//! a session-bound subscription, and a monotonic acknowledged journal cursor.

use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{SessionStore, StoreError};

pub const MAX_APP_SUBSCRIPTIONS_PER_CLIENT: usize = 64;
pub const MAX_APP_FILTER_ENTRIES: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppClientKind {
    Tui,
    Cli,
    Ide,
    Sdk,
    Ci,
    PluginHost,
}

impl AppClientKind {
    fn label(self) -> &'static str {
        match self {
            Self::Tui => "tui",
            Self::Cli => "cli",
            Self::Ide => "ide",
            Self::Sdk => "sdk",
            Self::Ci => "ci",
            Self::PluginHost => "plugin-host",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "tui" => Ok(Self::Tui),
            "cli" => Ok(Self::Cli),
            "ide" => Ok(Self::Ide),
            "sdk" => Ok(Self::Sdk),
            "ci" => Ok(Self::Ci),
            "plugin-host" => Ok(Self::PluginHost),
            _ => Err(invalid(format!("unsupported app client kind: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppClientUpsert {
    pub client_id: String,
    pub name: String,
    pub kind: AppClientKind,
    pub version: String,
    pub seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppClientRecord {
    pub client_id: String,
    pub name: String,
    pub kind: AppClientKind,
    pub version: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppSubscriptionState {
    Active,
    Paused,
    Closed,
}

impl AppSubscriptionState {
    fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Closed => "closed",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "closed" => Ok(Self::Closed),
            _ => Err(invalid(format!(
                "unsupported app subscription state: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppEventFilter {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub visibility: Vec<String>,
    #[serde(default)]
    pub include_ephemeral: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSubscriptionCreate {
    pub id: String,
    pub client_id: String,
    pub session_id: String,
    pub filter: AppEventFilter,
    pub initial_acked_sequence: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSubscriptionRecord {
    pub id: String,
    pub client_id: String,
    pub session_id: String,
    pub state: AppSubscriptionState,
    pub filter: AppEventFilter,
    pub last_acked_sequence: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSubscriptionAck {
    pub subscription_id: String,
    pub client_id: String,
    pub sequence: i64,
    pub at: String,
}

impl SessionStore {
    /// Register or refresh one durable local App Protocol client. Client kind is
    /// immutable: a reused ID cannot silently change its authority class.
    pub fn upsert_app_client(
        &mut self,
        input: &AppClientUpsert,
    ) -> Result<AppClientRecord, StoreError> {
        validate_client_upsert(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = app_client_in_tx(&tx, &input.client_id)? {
            if existing.kind != input.kind {
                return Err(invalid("a client ID cannot change its durable client kind"));
            }
            if input.seen_at < existing.last_seen_at {
                tx.commit()?;
                return Ok(existing);
            }
            if input.seen_at == existing.last_seen_at {
                if existing.name != input.name || existing.version != input.version {
                    return Err(invalid(
                        "a client refresh at the same timestamp must preserve identity metadata",
                    ));
                }
                tx.commit()?;
                return Ok(existing);
            }
            tx.execute(
                "UPDATE app_clients SET name = ?2, version = ?3, last_seen_at = ?4
                 WHERE client_id = ?1",
                params![
                    &input.client_id,
                    &input.name,
                    &input.version,
                    &input.seen_at
                ],
            )?;
            let record = AppClientRecord {
                client_id: input.client_id.clone(),
                name: input.name.clone(),
                kind: input.kind,
                version: input.version.clone(),
                first_seen_at: existing.first_seen_at,
                last_seen_at: input.seen_at.clone(),
            };
            tx.commit()?;
            return Ok(record);
        }
        tx.execute(
            "INSERT INTO app_clients (
                client_id, name, kind, version, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                &input.client_id,
                &input.name,
                input.kind.label(),
                &input.version,
                &input.seen_at,
            ],
        )?;
        let record = AppClientRecord {
            client_id: input.client_id.clone(),
            name: input.name.clone(),
            kind: input.kind,
            version: input.version.clone(),
            first_seen_at: input.seen_at.clone(),
            last_seen_at: input.seen_at.clone(),
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn app_client(&self, client_id: &str) -> Result<Option<AppClientRecord>, StoreError> {
        validate_identifier("clientId", client_id, 256)?;
        self.conn
            .query_row(
                "SELECT client_id, name, kind, version, first_seen_at, last_seen_at
                 FROM app_clients WHERE client_id = ?1",
                params![client_id],
                read_app_client,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Create an active subscription with a cursor known to exist in the
    /// session journal. Retried creations are idempotent only when every durable
    /// input is identical.
    pub fn create_app_subscription(
        &mut self,
        input: &AppSubscriptionCreate,
    ) -> Result<AppSubscriptionRecord, StoreError> {
        validate_subscription_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_app_client(&tx, &input.client_id)?;
        let head = require_session_head(&tx, &input.session_id)?;
        if input.initial_acked_sequence > head {
            return Err(StoreError::AppSubscriptionCursorAhead {
                subscription_id: input.id.clone(),
                requested: input.initial_acked_sequence,
                head,
            });
        }
        if let Some(existing) = app_subscription_in_tx(&tx, &input.id)? {
            ensure_subscription_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }
        let active_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM event_subscriptions
             WHERE client_id = ?1 AND state IN ('active', 'paused')",
            params![&input.client_id],
            |row| row.get(0),
        )?;
        if active_count >= MAX_APP_SUBSCRIPTIONS_PER_CLIENT as i64 {
            return Err(invalid(format!(
                "client has reached the {MAX_APP_SUBSCRIPTIONS_PER_CLIENT} subscription limit",
            )));
        }
        tx.execute(
            "INSERT INTO event_subscriptions (
                id, client_id, session_id, state, filter_json,
                last_acked_sequence, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?6)",
            params![
                &input.id,
                &input.client_id,
                &input.session_id,
                serde_json::to_string(&input.filter)?,
                input.initial_acked_sequence,
                &input.created_at,
            ],
        )?;
        let record = AppSubscriptionRecord {
            id: input.id.clone(),
            client_id: input.client_id.clone(),
            session_id: input.session_id.clone(),
            state: AppSubscriptionState::Active,
            filter: input.filter.clone(),
            last_acked_sequence: input.initial_acked_sequence,
            created_at: input.created_at.clone(),
            updated_at: input.created_at.clone(),
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn app_subscription(
        &self,
        subscription_id: &str,
    ) -> Result<Option<AppSubscriptionRecord>, StoreError> {
        validate_identifier("subscriptionId", subscription_id, 256)?;
        self.conn
            .query_row(
                subscription_select_sql(),
                params![subscription_id],
                read_subscription,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_app_subscriptions(
        &self,
        client_id: &str,
    ) -> Result<Vec<AppSubscriptionRecord>, StoreError> {
        validate_identifier("clientId", client_id, 256)?;
        let mut statement = self.conn.prepare(
            "SELECT id, client_id, session_id, state, filter_json,
                    last_acked_sequence, created_at, updated_at
             FROM event_subscriptions WHERE client_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![client_id], read_subscription)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Advance an acknowledgement cursor monotonically. Replayed or delayed ACKs
    /// never move the cursor backwards, and an ACK beyond journal head is rejected.
    pub fn acknowledge_app_subscription(
        &mut self,
        ack: &AppSubscriptionAck,
    ) -> Result<AppSubscriptionRecord, StoreError> {
        validate_subscription_ack(ack)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut record = require_owned_subscription(&tx, &ack.subscription_id, &ack.client_id)?;
        if record.state == AppSubscriptionState::Closed {
            return Err(invalid(
                "a closed app subscription cannot acknowledge events",
            ));
        }
        let head = require_session_head(&tx, &record.session_id)?;
        if ack.sequence > head {
            return Err(StoreError::AppSubscriptionCursorAhead {
                subscription_id: ack.subscription_id.clone(),
                requested: ack.sequence,
                head,
            });
        }
        if ack.sequence > record.last_acked_sequence {
            let updated_at = if ack.at > record.updated_at {
                ack.at.clone()
            } else {
                record.updated_at.clone()
            };
            tx.execute(
                "UPDATE event_subscriptions
                 SET last_acked_sequence = ?3, updated_at = ?4
                 WHERE id = ?1 AND client_id = ?2 AND last_acked_sequence < ?3",
                params![
                    &ack.subscription_id,
                    &ack.client_id,
                    ack.sequence,
                    &updated_at
                ],
            )?;
            record.last_acked_sequence = ack.sequence;
            record.updated_at = updated_at;
        }
        tx.commit()?;
        Ok(record)
    }

    /// Pause, reactivate, or close a subscription. Closed rows remain durable for
    /// audit/replay inspection and are terminal.
    pub fn set_app_subscription_state(
        &mut self,
        subscription_id: &str,
        client_id: &str,
        state: AppSubscriptionState,
        at: &str,
    ) -> Result<AppSubscriptionRecord, StoreError> {
        validate_identifier("subscriptionId", subscription_id, 256)?;
        validate_identifier("clientId", client_id, 256)?;
        validate_timestamp("at", at)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut record = require_owned_subscription(&tx, subscription_id, client_id)?;
        if record.state == AppSubscriptionState::Closed && state != AppSubscriptionState::Closed {
            return Err(invalid("a closed app subscription cannot be reactivated"));
        }
        if record.state != state {
            let updated_at = if at > record.updated_at.as_str() {
                at.to_owned()
            } else {
                record.updated_at.clone()
            };
            tx.execute(
                "UPDATE event_subscriptions SET state = ?3, updated_at = ?4
                 WHERE id = ?1 AND client_id = ?2",
                params![subscription_id, client_id, state.label(), &updated_at],
            )?;
            record.state = state;
            record.updated_at = updated_at;
        }
        tx.commit()?;
        Ok(record)
    }
}

fn invalid(detail: impl Into<String>) -> StoreError {
    StoreError::InvalidAppServer {
        detail: detail.into(),
    }
}

fn validate_client_upsert(input: &AppClientUpsert) -> Result<(), StoreError> {
    validate_identifier("clientId", &input.client_id, 256)?;
    validate_text("clientName", &input.name, 256)?;
    validate_text("clientVersion", &input.version, 128)?;
    validate_timestamp("seenAt", &input.seen_at)
}

fn validate_subscription_create(input: &AppSubscriptionCreate) -> Result<(), StoreError> {
    validate_identifier("subscriptionId", &input.id, 256)?;
    validate_identifier("clientId", &input.client_id, 256)?;
    validate_identifier("sessionId", &input.session_id, 256)?;
    if input.initial_acked_sequence < 0 {
        return Err(invalid("initialAckedSequence must be non-negative"));
    }
    validate_filter(&input.filter)?;
    validate_timestamp("createdAt", &input.created_at)
}

fn validate_subscription_ack(ack: &AppSubscriptionAck) -> Result<(), StoreError> {
    validate_identifier("subscriptionId", &ack.subscription_id, 256)?;
    validate_identifier("clientId", &ack.client_id, 256)?;
    if ack.sequence < 0 {
        return Err(invalid("ack sequence must be non-negative"));
    }
    validate_timestamp("ackAt", &ack.at)
}

fn validate_filter(filter: &AppEventFilter) -> Result<(), StoreError> {
    for (field, values) in [("kinds", &filter.kinds), ("visibility", &filter.visibility)] {
        if values.len() > MAX_APP_FILTER_ENTRIES {
            return Err(invalid(format!(
                "{field} exceeds the {MAX_APP_FILTER_ENTRIES} item limit",
            )));
        }
        let mut unique = BTreeSet::new();
        for value in values {
            validate_text(field, value, 128)?;
            if !unique.insert(value.as_str()) {
                return Err(invalid(format!("{field} contains duplicate values")));
            }
        }
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(invalid(format!(
            "{field} must be a bounded opaque identifier"
        )));
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{field} must be bounded non-secret text")));
    }
    if cbc_redaction::redact_patterns_only(value).report.redacted() {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds",
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
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds",
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
            "{field} must be a valid canonical RFC 3339 UTC timestamp",
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

fn app_client_in_tx(
    tx: &rusqlite::Transaction<'_>,
    client_id: &str,
) -> Result<Option<AppClientRecord>, StoreError> {
    tx.query_row(
        "SELECT client_id, name, kind, version, first_seen_at, last_seen_at
         FROM app_clients WHERE client_id = ?1",
        params![client_id],
        read_app_client,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_app_client(
    tx: &rusqlite::Transaction<'_>,
    client_id: &str,
) -> Result<AppClientRecord, StoreError> {
    app_client_in_tx(tx, client_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("app client {client_id}"),
    })
}

fn require_session_head(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<i64, StoreError> {
    tx.query_row(
        "SELECT last_event_sequence FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound {
        what: format!("session {session_id}"),
    })
}

fn subscription_select_sql() -> &'static str {
    "SELECT id, client_id, session_id, state, filter_json,
            last_acked_sequence, created_at, updated_at
     FROM event_subscriptions WHERE id = ?1"
}

fn app_subscription_in_tx(
    tx: &rusqlite::Transaction<'_>,
    subscription_id: &str,
) -> Result<Option<AppSubscriptionRecord>, StoreError> {
    tx.query_row(
        subscription_select_sql(),
        params![subscription_id],
        read_subscription,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_owned_subscription(
    tx: &rusqlite::Transaction<'_>,
    subscription_id: &str,
    client_id: &str,
) -> Result<AppSubscriptionRecord, StoreError> {
    let record =
        app_subscription_in_tx(tx, subscription_id)?.ok_or_else(|| StoreError::NotFound {
            what: format!("app subscription {subscription_id}"),
        })?;
    if record.client_id != client_id {
        return Err(StoreError::NotFound {
            what: format!("app subscription {subscription_id}"),
        });
    }
    Ok(record)
}

fn ensure_subscription_replay(
    existing: &AppSubscriptionRecord,
    input: &AppSubscriptionCreate,
) -> Result<(), StoreError> {
    if existing.client_id != input.client_id
        || existing.session_id != input.session_id
        || existing.filter != input.filter
        || existing.created_at != input.created_at
    {
        return Err(invalid(
            "subscription ID is already bound to different durable metadata",
        ));
    }
    Ok(())
}

fn read_app_client(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppClientRecord> {
    let kind = AppClientKind::parse(&row.get::<_, String>(2)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AppClientRecord {
        client_id: row.get(0)?,
        name: row.get(1)?,
        kind,
        version: row.get(3)?,
        first_seen_at: row.get(4)?,
        last_seen_at: row.get(5)?,
    })
}

fn read_subscription(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppSubscriptionRecord> {
    let state = AppSubscriptionState::parse(&row.get::<_, String>(3)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let filter = serde_json::from_str(&row.get::<_, String>(4)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AppSubscriptionRecord {
        id: row.get(0)?,
        client_id: row.get(1)?,
        session_id: row.get(2)?,
        state,
        filter,
        last_acked_sequence: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
