use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryError {
    pub code: String,
    pub phase: String,
    pub runtime_id: String,
    pub delivery_certainty: String,
    pub os_error_code: Option<i32>,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum Error {
    #[error("{}", .0.message)]
    Delivery(DeliveryError),
    #[error("claude CLI not found in PATH")]
    CliNotFound,
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("which: {0}")]
    Which(#[from] which::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if let Self::Delivery(detail) = self {
            detail.serialize(serializer)
        } else {
            serializer.serialize_str(&self.to_string())
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
