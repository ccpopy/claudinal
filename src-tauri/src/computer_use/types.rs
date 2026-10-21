use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    View,
    Click,
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    #[serde(skip)]
    pub(crate) window_witness: Option<usize>,
    pub app_id: String,
    pub name: String,
    pub path: String,
    pub pid: u32,
    pub window_id: String,
    pub title: String,
    pub tier: Tier,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub runtime_id: String,
    pub request_id: String,
    pub generation: u64,
    pub app: AppInfo,
    pub tier: Tier,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub supported: bool,
    pub platform: String,
    pub state: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub managed: bool,
    pub reason: Option<String>,
}

impl Default for DriverStatus {
    fn default() -> Self {
        Self {
            supported: cfg!(windows),
            platform: std::env::consts::OS.into(),
            state: if cfg!(windows) {
                "notInstalled"
            } else {
                "unavailable"
            }
            .into(),
            path: None,
            version: None,
            managed: false,
            reason: (!cfg!(windows))
                .then(|| "Computer control is available on Windows only.".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime_id: String,
    pub cwd: String,
    pub enabled: bool,
    pub generation: u64,
    pub state: String,
    pub apps: Vec<AppInfo>,
    pub pending_requests: Vec<PermissionRequest>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    pub runtime_id: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStatus {
    pub state: String,
    pub reason: Option<String>,
}

impl Default for CleanupStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            reason: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub driver: DriverStatus,
    pub runtime: Option<RuntimeStatus>,
    pub controller: Option<Controller>,
    pub cleanup: CleanupStatus,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_lifetime_witness_is_never_serialized() {
        let app = AppInfo {
            window_witness: Some(12345),
            app_id: "a".into(),
            name: "fixture".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "2".into(),
            title: "fixture".into(),
            tier: Tier::Full,
        };
        let value = serde_json::to_value(app).unwrap();
        assert!(value.get("windowWitness").is_none());
        assert!(value.get("window_witness").is_none());
        assert!(!serde_json::to_string(&value).unwrap().contains("12345"));
    }
}
