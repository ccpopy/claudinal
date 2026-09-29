//! Durable request IDs: a lost reply must never turn a retry into a second spend.
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::error::{Error, Result};
use crate::oauth_reset::ResetOutcome;

const LEASE_SECONDS: i64 = 60;
const RETRY_SECONDS: i64 = 600;

#[derive(Clone)]
pub(crate) struct Owner {
    pub account: String,
    pub org: String,
}

struct Record {
    id: String,
    account: String,
    org: String,
    grant: String,
    started: i64,
    lease: i64,
    outcome: Option<String>,
}

pub(crate) enum Reservation {
    Send(String),
    Answer(ResetOutcome),
}

fn unavailable(_: impl std::fmt::Display) -> Error {
    Error::Other("无法读取或保存重置操作记录，本次未发送。请稍后再试".into())
}

fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(unavailable)?;
    }
    let conn = Connection::open(path).map_err(unavailable)?;
    conn.busy_timeout(Duration::from_secs(1))
        .map_err(unavailable)?;
    conn.execute_batch(
        "PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS reset_operations (
           id TEXT PRIMARY KEY, account TEXT NOT NULL, org TEXT NOT NULL,
           grant_id TEXT NOT NULL, started INTEGER NOT NULL, lease INTEGER NOT NULL,
           outcome TEXT
         );
         CREATE INDEX IF NOT EXISTS reset_pending ON reset_operations(account, org, grant_id);",
    )
    .map_err(unavailable)?;
    Ok(conn)
}

fn lookup(conn: &Connection, owner: &Owner, grant: &str, id: &str) -> Result<Option<Record>> {
    let record = conn
        .query_row(
            "SELECT id, account, org, grant_id, started, lease, outcome FROM reset_operations
         WHERE id=?1 OR (account=?2 AND org=?3 AND grant_id=?4 AND outcome IS NULL)
         ORDER BY (id=?1) DESC, started DESC LIMIT 1",
            params![id, owner.account, owner.org, grant],
            |row| {
                Ok(Record {
                    id: row.get(0)?,
                    account: row.get(1)?,
                    org: row.get(2)?,
                    grant: row.get(3)?,
                    started: row.get(4)?,
                    lease: row.get(5)?,
                    outcome: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(unavailable)?;
    if record
        .as_ref()
        .is_some_and(|r| r.account != owner.account || r.org != owner.org || r.grant != grant)
    {
        return Err(Error::Other(
            "重置操作与当前账号不一致，请关闭确认框后刷新".into(),
        ));
    }
    Ok(record)
}

pub(crate) fn has_operation(path: &Path, owner: &Owner, grant: &str, id: &str) -> Result<bool> {
    Ok(lookup(&open(path)?, owner, grant, id)?.is_some())
}

pub(crate) fn reserve(
    path: &Path,
    owner: &Owner,
    grant: &str,
    id: &str,
    now: i64,
    allow_new: bool,
) -> Result<Reservation> {
    let mut conn = open(path)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let existing = lookup(&tx, owner, grant, id)?;
    let request_id = if let Some(record) = existing {
        if let Some(outcome) = record.outcome {
            return Ok(Reservation::Answer(
                serde_json::from_str(&outcome).map_err(unavailable)?,
            ));
        }
        if now < record.started || now - record.started >= RETRY_SECONDS {
            return Ok(Reservation::Answer(ResetOutcome::new("unknown_expired")));
        }
        if record.lease > now {
            return Ok(Reservation::Answer(ResetOutcome::retry(
                "in_flight",
                record.lease,
            )));
        }
        tx.execute(
            "UPDATE reset_operations SET lease=?2 WHERE id=?1",
            params![record.id, now + LEASE_SECONDS],
        )
        .map_err(unavailable)?;
        record.id
    } else {
        if !allow_new {
            return Err(Error::Other(
                "重置操作记录已变化，请关闭确认框后刷新".into(),
            ));
        }
        tx.execute("INSERT INTO reset_operations(id, account, org, grant_id, started, lease) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, owner.account, owner.org, grant, now, now + LEASE_SECONDS]).map_err(unavailable)?;
        id.to_owned()
    };
    // Commit the pending operation before any mutation is sent upstream.
    tx.commit().map_err(unavailable)?;
    Ok(Reservation::Send(request_id))
}

pub(crate) fn settle(path: &Path, id: &str, outcome: &ResetOutcome) -> Result<()> {
    let conn = open(path)?;
    let json = serde_json::to_string(outcome).map_err(unavailable)?;
    if conn
        .execute(
            "UPDATE reset_operations SET outcome=?2 WHERE id=?1 AND outcome IS NULL",
            params![id, json],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(unavailable("missing operation"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_lease_reuses_the_original_id_and_replays_settled_answers() {
        let dir = std::env::temp_dir().join(format!("claudinal-reset-{}", uuid::Uuid::new_v4()));
        let path = dir.join("reset.sqlite");
        let owner = Owner {
            account: "account-a".into(),
            org: "org-a".into(),
        };
        assert!(
            matches!(reserve(&path, &owner, "grant", "first", 1000, true).unwrap(), Reservation::Send(id) if id == "first")
        );
        // A new connection / window / app instance cannot bypass the pending operation.
        assert!(
            matches!(reserve(&path, &owner, "grant", "second", 1010, true).unwrap(), Reservation::Answer(r) if r.code == "in_flight")
        );
        assert!(
            matches!(reserve(&path, &owner, "grant", "second", 1061, true).unwrap(), Reservation::Send(id) if id == "first")
        );
        settle(&path, "first", &ResetOutcome::new("reset")).unwrap();
        assert!(
            matches!(reserve(&path, &owner, "grant", "first", 1062, true).unwrap(), Reservation::Answer(r) if r.code == "reset")
        );
        assert!(reserve(
            &path,
            &Owner {
                account: "other".into(),
                org: "org-a".into()
            },
            "grant",
            "first",
            1062,
            true
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_outcome_cannot_be_retried_outside_the_deduplication_window() {
        let dir = std::env::temp_dir().join(format!("claudinal-reset-{}", uuid::Uuid::new_v4()));
        let path = dir.join("reset.sqlite");
        let owner = Owner {
            account: "account".into(),
            org: "org".into(),
        };
        reserve(&path, &owner, "grant", "first", 1000, true).unwrap();
        for now in [999, 1600, 2000] {
            assert!(
                matches!(reserve(&path, &owner, "grant", "new-id", now, true).unwrap(), Reservation::Answer(r) if r.code == "unknown_expired")
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
