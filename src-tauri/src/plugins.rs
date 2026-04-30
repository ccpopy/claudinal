//! Claude Code 原生插件 / 技能的读取与命令封装。
//!
//! 设计：读 → 直接读文件系统（更可靠），写 → spawn `claude plugin` 子命令（避免破坏 schema）。
//!
//! 关键路径（与 Claude Code 一致）：
//! - 已安装插件：`~/.claude/plugins/installed_plugins.json`
//! - 已添加 marketplace：`~/.claude/plugins/known_marketplaces.json`
//! - marketplace 缓存：`~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json`
//! - 用户技能：`~/.claude/skills/<name>/SKILL.md`
//! - 项目技能：`<cwd>/.claude/skills/<name>/SKILL.md`
//! - 插件携带技能：`<plugin-cache>/skills/<name>/SKILL.md`

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct InstalledPlugin {
    /// 形如 `frontend-design@claude-plugins-official`
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    /// "user" / "project" / "local"
    pub scope: String,
    pub install_path: Option<String>,
    pub project_path: Option<String>,
    pub installed_at: Option<String>,
    pub last_updated: Option<String>,
    /// 来自 marketplace.json 的描述（可能为空）
    pub description: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Marketplace {
    pub name: String,
    /// 来自 known_marketplaces.json 的 source.repo（github 类型）或 url
    pub source: Option<String>,
    pub install_location: Option<String>,
    pub last_updated: Option<String>,
    /// marketplace 中可装的插件清单（来自 marketplace.json）
    pub plugins: Vec<MarketplacePlugin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketplacePlugin {
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    /// 来源："user" / "project" / "plugin:<id>"
    pub source: String,
    pub path: String,
    pub disable_model_invocation: bool,
    pub user_invocable: bool,
}

fn home() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))
}

fn read_json_file(path: &Path) -> Result<Option<Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(Some(v))
}

fn marketplaces_root() -> Result<PathBuf> {
    Ok(home()?.join(".claude").join("plugins"))
}

/// 读 marketplace.json 抽出 plugin 描述（用于 List 视图补全描述/作者）。
fn read_marketplace_plugins(name: &str) -> Vec<MarketplacePlugin> {
    let Ok(root) = marketplaces_root() else {
        return Vec::new();
    };
    let path = root
        .join("marketplaces")
        .join(name)
        .join(".claude-plugin")
        .join("marketplace.json");
    let Ok(Some(value)) = read_json_file(&path) else {
        return Vec::new();
    };
    let Some(arr) = value.get("plugins").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|p| {
            let name = p.get("name")?.as_str()?.to_string();
            let description = p.get("description").and_then(Value::as_str).map(str::to_string);
            let author = p
                .get("author")
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let homepage = p.get("homepage").and_then(Value::as_str).map(str::to_string);
            let category = p.get("category").and_then(Value::as_str).map(str::to_string);
            Some(MarketplacePlugin {
                name,
                description,
                author,
                homepage,
                category,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_installed_plugins() -> Result<Vec<InstalledPlugin>> {
    let root = marketplaces_root()?;
    let installed_path = root.join("installed_plugins.json");
    let Some(value) = read_json_file(&installed_path)? else {
        return Ok(Vec::new());
    };
    let Some(plugins) = value.get("plugins").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };

    // 缓存每个 marketplace 的描述，避免重复 IO。
    let mut market_cache: std::collections::HashMap<String, Vec<MarketplacePlugin>> =
        std::collections::HashMap::new();

    let mut out = Vec::new();
    for (id, entries) in plugins {
        let (name, marketplace) = match id.split_once('@') {
            Some((n, m)) => (n.to_string(), m.to_string()),
            None => (id.clone(), String::new()),
        };
        let market_plugins = market_cache
            .entry(marketplace.clone())
            .or_insert_with(|| read_marketplace_plugins(&marketplace));
        let meta = market_plugins.iter().find(|p| p.name == name);

        let entries = match entries.as_array() {
            Some(a) => a,
            None => continue,
        };
        for entry in entries {
            let scope = entry
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string();
            let version = entry.get("version").and_then(Value::as_str).map(str::to_string);
            let install_path = entry
                .get("installPath")
                .and_then(Value::as_str)
                .map(str::to_string);
            let project_path = entry
                .get("projectPath")
                .and_then(Value::as_str)
                .map(str::to_string);
            let installed_at = entry
                .get("installedAt")
                .and_then(Value::as_str)
                .map(str::to_string);
            let last_updated = entry
                .get("lastUpdated")
                .and_then(Value::as_str)
                .map(str::to_string);
            out.push(InstalledPlugin {
                id: id.clone(),
                name: name.clone(),
                marketplace: marketplace.clone(),
                version,
                scope,
                install_path,
                project_path,
                installed_at,
                last_updated,
                description: meta.and_then(|m| m.description.clone()),
                author: meta.and_then(|m| m.author.clone()),
                homepage: meta.and_then(|m| m.homepage.clone()),
                category: meta.and_then(|m| m.category.clone()),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn list_marketplaces() -> Result<Vec<Marketplace>> {
    let root = marketplaces_root()?;
    let known_path = root.join("known_marketplaces.json");
    let Some(value) = read_json_file(&known_path)? else {
        return Ok(Vec::new());
    };
    let Some(obj) = value.as_object() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, meta) in obj {
        let source = meta
            .pointer("/source/repo")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                meta.pointer("/source/url")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let install_location = meta
            .get("installLocation")
            .and_then(Value::as_str)
            .map(str::to_string);
        let last_updated = meta
            .get("lastUpdated")
            .and_then(Value::as_str)
            .map(str::to_string);
        let plugins = read_marketplace_plugins(name);
        out.push(Marketplace {
            name: name.clone(),
            source,
            install_location,
            last_updated,
            plugins,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 解析 SKILL.md 顶部 YAML frontmatter（不依赖外部 yaml 库；只取我们关心的几个字段）。
fn parse_skill_md(path: &Path, source: String) -> Option<Skill> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        // 没 frontmatter，仍把目录名当作 skill name
        let name = path.parent()?.file_name()?.to_string_lossy().to_string();
        return Some(Skill {
            name,
            description: None,
            source,
            path: path.display().to_string(),
            disable_model_invocation: false,
            user_invocable: true,
        });
    }
    let after = &trimmed[3..];
    let end = after.find("\n---").or_else(|| after.find("\r\n---"))?;
    let body = &after[..end];

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut disable_invoke = false;
    let mut user_invocable = true;

    let mut current_key: Option<String> = None;
    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            continue;
        }
        // 简单 YAML：只处理 `key: value` 单行，多行字符串用首行截断。
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_lowercase();
            let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
            current_key = Some(key.clone());
            match key.as_str() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                "disable-model-invocation" => {
                    disable_invoke = value == "true"
                }
                "user-invocable" => {
                    user_invocable = value != "false"
                }
                _ => {}
            }
        } else if let Some(k) = current_key.as_deref() {
            // 续行（折叠成空格），仅 description 用得上
            if k == "description" {
                if let Some(prev) = description.as_mut() {
                    prev.push(' ');
                    prev.push_str(line.trim());
                }
            }
        }
    }

    let resolved_name = name.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed".to_string())
    });

    Some(Skill {
        name: resolved_name,
        description,
        source,
        path: path.display().to_string(),
        disable_model_invocation: disable_invoke,
        user_invocable,
    })
}

fn scan_skill_dir(root: &Path, source: String, out: &mut Vec<Skill>) {
    if !root.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let skill_md = p.join("SKILL.md");
        if skill_md.is_file() {
            if let Some(s) = parse_skill_md(&skill_md, source.clone()) {
                out.push(s);
            }
        }
    }
}

#[tauri::command]
pub async fn list_skills(cwd: Option<String>) -> Result<Vec<Skill>> {
    let mut out = Vec::new();
    // 用户级
    let user_dir = home()?.join(".claude").join("skills");
    scan_skill_dir(&user_dir, "user".to_string(), &mut out);
    // 项目级
    if let Some(cwd) = cwd.as_deref() {
        let proj_dir = Path::new(cwd).join(".claude").join("skills");
        scan_skill_dir(&proj_dir, "project".to_string(), &mut out);
    }
    // 已安装插件携带的技能（扫 cache 下每个插件的 skills/）
    let plugins_cache = home()?.join(".claude").join("plugins").join("cache");
    if plugins_cache.is_dir() {
        // cache/<marketplace>/<plugin>/<version>/skills/...
        if let Ok(market_iter) = std::fs::read_dir(&plugins_cache) {
            for market in market_iter.flatten() {
                if !market.path().is_dir() {
                    continue;
                }
                let market_name = market.file_name().to_string_lossy().to_string();
                if let Ok(plugin_iter) = std::fs::read_dir(market.path()) {
                    for plugin in plugin_iter.flatten() {
                        if !plugin.path().is_dir() {
                            continue;
                        }
                        let plugin_name = plugin.file_name().to_string_lossy().to_string();
                        // 进一步进入版本目录
                        if let Ok(ver_iter) = std::fs::read_dir(plugin.path()) {
                            for ver in ver_iter.flatten() {
                                let skills_dir = ver.path().join("skills");
                                if skills_dir.is_dir() {
                                    let src = format!("plugin:{plugin_name}@{market_name}");
                                    scan_skill_dir(&skills_dir, src, &mut out);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    /// add / update / remove / install / uninstall / enable / disable / list
    pub action: String,
    /// "marketplace" 或 "plugin"
    pub kind: String,
    /// 主参数：marketplace 名 或 plugin@marketplace 或 owner/repo
    pub target: Option<String>,
    /// install/uninstall 的 scope（user / project / local）
    pub scope: Option<String>,
    /// project scope 用的 cwd
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PluginCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// 调用 `claude plugin ...` 子命令；同步等待结果。
#[tauri::command]
pub async fn run_plugin_command(args: PluginCommand) -> Result<PluginCommandResult> {
    let claude = crate::proc::spawn::find_claude()?;
    let mut cmd_args: Vec<String> = vec!["plugin".into()];
    match args.kind.as_str() {
        "marketplace" => {
            cmd_args.push("marketplace".into());
            cmd_args.push(args.action.clone());
            if let Some(t) = args.target.as_deref().filter(|s| !s.is_empty()) {
                cmd_args.push(t.to_string());
            }
        }
        "plugin" => {
            cmd_args.push(args.action.clone());
            if let Some(t) = args.target.as_deref().filter(|s| !s.is_empty()) {
                cmd_args.push(t.to_string());
            }
            if let Some(scope) = args.scope.as_deref().filter(|s| !s.is_empty()) {
                cmd_args.push("--scope".into());
                cmd_args.push(scope.to_string());
            }
        }
        other => return Err(Error::Other(format!("invalid plugin kind: {other}"))),
    }

    let mut cmd = tokio::process::Command::new(&claude);
    cmd.args(&cmd_args);
    if let Some(cwd) = args.cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.current_dir(cwd);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Other(format!("spawn claude plugin: {e}")))?;
    let exit_code = output.status.code().unwrap_or(-1);
    Ok(PluginCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code,
    })
}
