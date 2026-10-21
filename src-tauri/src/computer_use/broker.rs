use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

use super::{
    driver::Driver,
    platform,
    state::{Capture, HeldInput},
    types::{AppInfo, Tier},
    Core,
};
use crate::error::{Error, Result};

pub(crate) const MAX_REQUEST: usize = 128 * 1024;
pub(crate) const MAX_RESPONSE: usize = 12 * 1024 * 1024;

pub(crate) async fn read_json(
    reader: &mut (impl AsyncBufRead + Unpin),
    limit: usize,
) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    let len = reader
        .take(limit as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .await?;
    if len == 0 {
        return Ok(None);
    }
    if len > limit || bytes.last() != Some(&b'\n') {
        return Err(Error::Other(
            "Computer gateway line exceeded its framing budget.".into(),
        ));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub(crate) async fn write_json(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &Value,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_RESPONSE {
        return Err(Error::Other(
            "Computer result exceeds its byte budget.".into(),
        ));
    }
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(3), async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| Error::Other("Computer gateway output timed out.".into()))??;
    Ok(())
}

pub(crate) async fn serve(core: Arc<Core>, listener: std::net::TcpListener) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let connections = Arc::new(tokio::sync::Semaphore::new(32));
    crate::child_process::disable_socket_inheritance(&listener);
    while let Ok((stream, address)) = listener.accept().await {
        // Per-action worker processes must never hold a gateway connection.
        crate::child_process::disable_socket_inheritance(&stream);
        if !address.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            continue;
        };
        let core = core.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let _ = connection(core, stream).await;
        });
    }
}

struct Connection {
    core: Arc<Core>,
    runtime_id: String,
    nonce: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let (matches, work) = {
            let mut state = self.core.lock();
            let matches = if let Some(runtime) = state.runtimes.get_mut(&self.runtime_id) {
                if runtime.connection.as_deref() == Some(&self.nonce) {
                    runtime.connection = None;
                    true
                } else {
                    false
                }
            } else {
                false
            };
            // Clearing the old connection and revoking its authority are one
            // barrier; a reconnect cannot slip between two separate locks.
            let work = if matches {
                state.revoke(&self.runtime_id, "gateway_disconnected", false)
            } else {
                None
            };
            (matches, work)
        };
        if matches {
            self.core.emit(Some(&self.runtime_id));
            self.core.schedule_cleanup(work);
        }
    }
}

async fn connection(core: Arc<Core>, stream: TcpStream) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let auth = tokio::time::timeout(Duration::from_secs(5), read_json(&mut reader, 4096))
        .await
        .map_err(|_| Error::Other("Computer gateway authentication timed out.".into()))??
        .ok_or_else(|| Error::Other("Computer gateway disconnected.".into()))?;
    let runtime_id = text(&auth, "runtimeId", 256)?.to_string();
    let token = text(&auth, "token", 128)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    {
        let mut state = core.lock();
        state.authenticate(&runtime_id, token)?;
        let runtime = state.runtimes.get_mut(&runtime_id).unwrap();
        if runtime.connection.is_some() {
            return Err(Error::Other(
                "A gateway is already connected to this captured runtime.".into(),
            ));
        }
        runtime.connection = Some(nonce.clone());
    }
    let _connection = Connection {
        core: core.clone(),
        runtime_id: runtime_id.clone(),
        nonce,
    };
    write_json(&mut write, &json!({"ok":true})).await?;
    let (messages, mut incoming) = tokio::sync::mpsc::channel(2);
    let read_task = tokio::spawn(async move {
        loop {
            let message = read_json(&mut reader, MAX_REQUEST).await;
            let terminal = !matches!(&message, Ok(Some(_)));
            if messages.send(message).await.is_err() || terminal {
                break;
            }
        }
    });
    let _reader_guard = AbortReader(read_task);
    loop {
        let Some(request) = incoming.recv().await.transpose()?.flatten() else {
            return Ok(());
        };
        let name = text(&request, "name", 64)?.to_string();
        let arguments = request
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let publication = if is_private_tool(&name) {
            let state = core.lock();
            let runtime = state.runtime(&runtime_id)?;
            Some((runtime.generation, runtime.revocations.subscribe()))
        } else {
            None
        };
        // No queued mutations. EOF/cancellation is observed even while driver work is in flight.
        let result = tokio::select! {
            biased;
            next = incoming.recv() => { let _ = next; return Err(Error::Other("Computer gateway disconnected or attempted concurrent actions.".into())); },
            result = dispatch(core.clone(), &runtime_id, &name, arguments) => result,
        };
        let mut response = match result {
            Ok(result) => result,
            Err(error) => tool_error(&error.to_string()),
        };
        if let Some((generation, mut revoked)) = publication {
            if core
                .lock()
                .runtimes
                .get(&runtime_id)
                .is_none_or(|runtime| runtime.generation != generation || !runtime.enabled)
            {
                response = tool_error("Computer access changed before result publication. No stale screenshot or action result was forwarded.");
                write_json(&mut write, &response).await?;
            } else {
                tokio::select! {
                    biased;
                    _ = revoked.changed() => return Err(Error::Other("Computer result publication was revoked.".into())),
                    result = write_json(&mut write, &response) => result?,
                }
            }
        } else {
            write_json(&mut write, &response).await?;
        }
    }
}

fn is_private_tool(name: &str) -> bool {
    matches!(
        name,
        "computer_observe"
            | "computer_click"
            | "computer_type"
            | "computer_key"
            | "computer_scroll"
    )
}

pub(crate) struct AbortReader(pub tokio::task::JoinHandle<()>);
impl Drop for AbortReader {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) fn message_reader<R: AsyncBufRead + Unpin + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> (
    AbortReader,
    tokio::sync::mpsc::Receiver<Result<Option<Value>>>,
) {
    let (send, receive) = tokio::sync::mpsc::channel(8);
    let task = tokio::spawn(async move {
        loop {
            let message = read_json(&mut reader, limit).await;
            let terminal = !matches!(&message, Ok(Some(_)));
            if send.send(message).await.is_err() || terminal {
                break;
            }
        }
    });
    (AbortReader(task), receive)
}

pub(crate) fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
}
fn tool_json(value: impl serde::Serialize) -> Result<Value> {
    let value = serde_json::to_value(value)?;
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string(&value)?}],"structuredContent":value}),
    )
}

pub(crate) async fn dispatch(
    core: Arc<Core>,
    runtime_id: &str,
    name: &str,
    arguments: Value,
) -> Result<Value> {
    core.lock().runtime(runtime_id)?;
    match name {
        "computer_status" => {
            fields(&arguments, &[])?;
            tool_json(core.status(Some(runtime_id)))
        }
        "computer_list_apps" => {
            fields(&arguments, &[])?;
            tool_json(json!({"apps":core.list_apps(runtime_id).await?}))
        }
        "computer_request_app" => {
            fields(&arguments, &["appId"])?;
            tool_json(
                core.request_app(runtime_id, text(&arguments, "appId", 256)?)
                    .await?,
            )
        }
        "computer_wait" => {
            fields(&arguments, &["seconds"])?;
            let seconds = arguments
                .get("seconds")
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|seconds| seconds.is_finite() && (0.1..=10.0).contains(seconds))
                        .ok_or_else(|| {
                            Error::Other("Wait seconds must be between 0.1 and 10.".into())
                        })
                })
                .transpose()?
                .unwrap_or(1.0);
            let mut revoked = core.lock().enabled(runtime_id)?.revocations.subscribe();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs_f64(seconds)) => {}
                _ = revoked.changed() => {
                    return Err(Error::Other("Computer access changed during the wait.".into()));
                }
            }
            core.lock().enabled(runtime_id)?;
            tool_json(json!({"waitedSeconds":seconds}))
        }
        "computer_observe" | "computer_click" | "computer_type" | "computer_key"
        | "computer_scroll" => execute(core, runtime_id, name, arguments).await,
        _ => Err(Error::Other(
            "This computer tool is not exposed by Claudinal.".into(),
        )),
    }
}

fn fields(arguments: &Value, allowed: &[&str]) -> Result<()> {
    let object = arguments
        .as_object()
        .ok_or_else(|| Error::Other("Computer tool arguments must be an object.".into()))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Error::Other(
            "Computer tool contains an unsupported argument.".into(),
        ));
    }
    Ok(())
}
fn text<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= maximum)
        .ok_or_else(|| Error::Other(format!("Computer {key} must be a bounded nonempty string.")))
}
fn number(value: &Value, key: &str, maximum: f64) -> Result<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0 && *number < maximum)
        .ok_or_else(|| {
            Error::Other(format!(
                "Computer {key} is outside the observed image bounds."
            ))
        })
}
/// The host supplies all driver target/scope/delivery fields. None are pass-through.
fn translate(
    core: &Core,
    id: &str,
    generation: u64,
    app: &AppInfo,
    name: &str,
    arguments: &Value,
) -> Result<(String, Value, Vec<u16>, bool)> {
    let allowed: &[&str] = match name {
        "computer_observe" => &["appId", "includeTree"],
        "computer_click" => &["appId", "x", "y", "captureId", "button", "clickCount"],
        "computer_type" => &["appId", "text"],
        "computer_key" => &["appId", "key", "modifiers"],
        "computer_scroll" => &["appId", "direction", "amount"],
        _ => return Err(Error::Other("Unsupported computer action.".into())),
    };
    fields(arguments, allowed)?;
    if app.tier == Tier::View && name != "computer_observe" {
        return Err(Error::Other(
            "This app has view-only access; input is blocked.".into(),
        ));
    }
    if app.tier == Tier::Click && matches!(name, "computer_type" | "computer_key") {
        return Err(Error::Other(
            "Terminals and development apps have click-only access; typing and keys are blocked."
                .into(),
        ));
    }
    let window_id = app
        .window_id
        .parse::<u64>()
        .map_err(|_| Error::Other("Invalid captured window identity.".into()))?;
    let mut output = json!({"pid":app.pid,"window_id":window_id});
    let mut keys = Vec::new();
    if name == "computer_observe" {
        let include_tree = arguments
            .get("includeTree")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| Error::Other("includeTree must be boolean.".into()))
            })
            .transpose()?
            .unwrap_or(true);
        // Always read only the approved UIA tree through the driver. Pixels
        // come exclusively from the host PrintWindow worker, never its fallback.
        output["include_accessibility_tree"] = json!(true);
        output["include_screenshot"] = json!(false);
        output["max_image_dimension"] = json!(1372);
        output["max_elements"] = json!(250);
        output["max_depth"] = json!(20);
        output["timeout_ms"] = json!(1500);
        if !include_tree {
            output["max_elements"] = json!(1);
            output["max_depth"] = json!(1);
        }
        return Ok(("get_window_state".into(), output, keys, false));
    }
    output["delivery_mode"] = json!("background");
    output["scope"] = json!("window");
    let mut state = core.lock();
    state.authorize(id, generation, &app.app_id)?;
    let foreground_keys = state.foreground_keys;
    let runtime = state.runtimes.get_mut(id).unwrap();
    let capture = runtime.captures.get_mut(&app.app_id).filter(|capture| capture.created.elapsed() < Duration::from_secs(60))
        .ok_or_else(|| Error::Other("Observe this exact approved window before acting. Old grounding is never reused after revoke.".into()))?;
    if capture.consumed {
        return Err(Error::Other("This observation was already used by an action. Observe again before the next mutation.".into()));
    }
    match name {
        "computer_click" => {
            let capture_id = text(arguments, "captureId", 256)?;
            if capture.id != capture_id || capture.consumed {
                return Err(Error::Other("This capture has expired or was already consumed. Observe again before clicking.".into()));
            }
            output["x"] = json!(number(arguments, "x", capture.width)?);
            output["y"] = json!(number(arguments, "y", capture.height)?);
            let button = match arguments.get("button") {
                None => "left",
                Some(value) => match value.as_str() {
                    Some("left") => "left",
                    Some("right") => "right",
                    _ => return Err(Error::Other("Click button must be left or right.".into())),
                },
            };
            let count = match arguments.get("clickCount") {
                None => 1,
                Some(value) => match value.as_u64() {
                    Some(count @ 1..=2) => count,
                    _ => return Err(Error::Other("clickCount must be 1 or 2.".into())),
                },
            };
            if button == "right" && count != 1 {
                return Err(Error::Other(
                    "Right click supports a single click only.".into(),
                ));
            }
            output["capture_id"] = json!(capture_id);
            output["button"] = json!(button);
            output["count"] = json!(count);
            capture.consumed = true;
            Ok(("click".into(), output, keys, true))
        }
        "computer_type" => {
            let value = text(arguments, "text", 2048)?;
            if value.contains(['\r', '\n']) {
                keys.push(0x0D);
            }
            output["text"] = json!(value);
            output["delay_ms"] = json!(0);
            capture.consumed = true;
            Ok(("type_text".into(), output, keys, false))
        }
        "computer_key" => {
            let key = text(arguments, "key", 16)?;
            let modifiers: Vec<String> = match arguments.get("modifiers") {
                Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
                    Error::Other("Key modifiers must be an array of strings.".into())
                })?,
                None => Vec::new(),
            };
            let chord = super::keyboard::Chord::parse(key, &modifiers)?;
            output["key"] = json!(chord.key);
            output["modifiers"] = json!(chord.modifiers);
            if !chord.modifiers.is_empty() {
                if foreground_keys {
                    output["delivery_mode"] = json!("foreground");
                    // No driver receives foreground authority. The host checks
                    // both the setting and runtime again at actual dispatch.
                    capture.consumed = true;
                    return Ok(("foreground_key".into(), output, keys, false));
                }
                output["command"] = serde_json::to_value(chord.background_command()?)?;
                capture.consumed = true;
                return Ok(("edit_shortcut".into(), output, keys, false));
            }
            keys = chord.virtual_keys();
            capture.consumed = true;
            Ok(("press_key".into(), output, keys, false))
        }
        "computer_scroll" => {
            let direction = text(arguments, "direction", 8)?;
            if !["up", "down", "left", "right"].contains(&direction) {
                return Err(Error::Other("Unsupported scroll direction.".into()));
            }
            let amount = arguments
                .get("amount")
                .map(|value| {
                    value
                        .as_u64()
                        .ok_or_else(|| Error::Other("Scroll amount must be an integer.".into()))
                })
                .transpose()?
                .unwrap_or(3);
            if !(1..=10).contains(&amount) {
                return Err(Error::Other(
                    "Scroll amount must be between 1 and 10.".into(),
                ));
            }
            output["direction"] = json!(direction);
            output["amount"] = json!(amount);
            capture.consumed = true;
            Ok(("scroll".into(), output, keys, false))
        }
        _ => unreachable!(),
    }
}

/// Called between actions on the blocking pool. Keep a lapsing driver in State
/// until reaping succeeds, so stop/disconnect still owns it and the desktop lease.
pub(super) fn reuse_or_retire_driver(
    core: &Core,
    id: &str,
    generation: u64,
    app_id: &str,
) -> Result<Option<Arc<Driver>>> {
    let retiring = {
        let state = core.lock();
        state.authorize(id, generation, app_id)?;
        let Some(driver) = state.driver.clone() else {
            return Ok(None);
        };
        if !driver.needs_rotation() {
            return Ok(Some(driver));
        }
        driver.kill();
        driver
    };
    // Reaping may block, but authority revocation must remain immediate.
    retiring.reap()?;
    let mut state = core.lock();
    state.authorize(id, generation, app_id)?;
    if !state
        .driver
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, &retiring))
    {
        return Err(Error::Other("Driver renewal was superseded.".into()));
    }
    state.driver = None;
    Ok(None)
}

async fn execute(core: Arc<Core>, id: &str, name: &str, arguments: Value) -> Result<Value> {
    let _action = core.action.clone().try_lock_owned().map_err(|_| {
        Error::Other("A computer action is already in flight. No action has been queued.".into())
    })?;
    let app_id = text(&arguments, "appId", 256)?.to_string();
    let (generation, app) = {
        let state = core.lock();
        let generation = state.enabled(id)?.generation;
        (generation, state.authorize(id, generation, &app_id)?)
    };
    let (driver_name, driver_args, keys, mouse) =
        translate(&core, id, generation, &app, name, &arguments)?;
    let click_geometry = if name == "computer_click" {
        Some(
            core.lock()
                .runtimes
                .get(id)
                .and_then(|runtime| runtime.captures.get(&app_id))
                .and_then(|capture| capture.geometry.clone())
                .ok_or_else(|| {
                    Error::Other("This image has no host capture geometry. Observe again.".into())
                })?,
        )
    } else {
        None
    };
    // A closed or replaced window loses only its own grant; others stay usable.
    if let Err(error) = platform::revalidate(&app) {
        let dropped = {
            let mut state = core.lock();
            let current = state
                .runtimes
                .get(id)
                .is_some_and(|runtime| runtime.generation == generation);
            current
                .then(|| state.revoke_app(id, &app_id).ok())
                .flatten()
        };
        if let Some(dropped) = dropped {
            platform::remove_window_witness(&dropped);
            core.emit(Some(id));
        }
        return Err(error);
    }
    let core_spawn = core.clone();
    let id_spawn = id.to_string();
    let app_spawn = app.clone();
    let driver_result = if name == "computer_click"
        || matches!(driver_name.as_str(), "edit_shortcut" | "foreground_key")
    {
        None
    } else {
        Some(
            tokio::task::spawn_blocking(move || -> Result<(Arc<Driver>, bool)> {
                platform::revalidate(&app_spawn)?;
                if let Some(driver) =
                    reuse_or_retire_driver(&core_spawn, &id_spawn, generation, &app_spawn.app_id)?
                {
                    return Ok((driver, false));
                }
                platform::revalidate(&app_spawn)?;
                let mut state = core_spawn.lock();
                state.authorize(&id_spawn, generation, &app_spawn.app_id)?;
                let evidence = state
                    .evidence
                    .clone()
                    .ok_or_else(|| Error::Other("Driver verification is unavailable.".into()))?;
                let apps = state
                    .enabled(&id_spawn)?
                    .grants
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                let driver = Driver::start_in(&evidence, &apps, false, &core_spawn.data_dir)?;
                state.driver = Some(driver.clone());
                Ok((driver, true))
            })
            .await
            .map_err(|error| Error::Other(error.to_string()))?,
        )
    };
    // Failures before any input could reach the app are ordinary tool errors.
    // Only a failed driver start or an uncertain delivery revokes the runtime.
    let revoke_on_error = std::sync::atomic::AtomicBool::new(true);
    let result = async {
        let driver = if let Some(driver) = driver_result {
            let (driver, fresh) = driver?;
            if fresh {
                driver.initialize().await?;
            }
            Some(driver)
        } else {
            None
        };
        revoke_on_error.store(false, std::sync::atomic::Ordering::Relaxed);
        // Check after every awaited preparation, immediately before private observation/input.
        platform::revalidate(&app)?;
        if name == "computer_click" {
            platform::ensure_posted_click(&app)?;
        }
        let targets = if keys.is_empty() && !mouse {
            Vec::new()
        } else {
            platform::input_targets(&app)?
        };
        {
            let mut state = core.lock();
            state.authorize(id, generation, &app_id)?;
            revoke_on_error.store(true, std::sync::atomic::Ordering::Relaxed);
            if name == "computer_observe" {
                state.runtimes.get_mut(id).unwrap().captures.remove(&app_id);
            }
            state.held = Some(HeldInput {
                app: app.clone(),
                targets: targets.clone(),
                keys: keys.clone(),
                mouse,
            });
            state.runtimes.get_mut(id).unwrap().state = "active".into();
        }
        core.emit(Some(id));
        let mut geometry = None;
        let mut result = if name == "computer_click" {
            run_window_operation(
                core.clone(),
                id,
                generation,
                &app,
                json!({"operation":"click","geometry":click_geometry,
                "x":driver_args["x"],"y":driver_args["y"],
                "button":driver_args["button"],"count":driver_args["count"]}),
            )
            .await?
        } else if driver_name == "edit_shortcut" {
            run_window_operation(core.clone(), id, generation, &app,
                json!({"operation":"edit_shortcut","command":driver_args["command"]})).await?
        } else if driver_name == "foreground_key" {
            let core = core.clone();
            let id = id.to_string();
            let app = app.clone();
            let chord = super::keyboard::Chord::parse(
                driver_args["key"].as_str().unwrap(),
                &serde_json::from_value::<Vec<String>>(driver_args["modifiers"].clone())?,
            )?;
            tokio::task::spawn_blocking(move || {
                // Hold authority through the one-batch input. Stop either wins
                // before dispatch or observes an already fully released chord.
                let state = core.lock();
                state.authorize(&id, generation, &app.app_id)?;
                if !state.foreground_keys {
                    return Err(Error::Other("Foreground shortcuts were disabled.".into()));
                }
                super::foreground::press(&app, &chord)
            }).await.map_err(|error| Error::Other(error.to_string()))??
        } else {
            let result = driver
                .as_ref()
                .ok_or_else(|| Error::Other("Driver is unavailable.".into()))?
                .call(&driver_name, driver_args)
                .await?;
            reject_driver_pixels(&result)?;
            result
        };
        if name == "computer_observe"
            && !result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            let captured = run_window_operation(
                core.clone(),
                id,
                generation,
                &app,
                json!({"operation":"capture"}),
            )
            .await?;
            if captured.get("isError").and_then(Value::as_bool) == Some(true) {
                result = captured;
            } else {
            let captured_geometry = captured
                .get("geometry")
                .filter(|geometry| geometry.is_object())
                .cloned()
                .ok_or_else(|| Error::Other("Window capture returned no geometry.".into()))?;
            let width = captured_geometry
                .get("screenshot_width")
                .and_then(Value::as_u64)
                .filter(|width| *width > 0 && *width <= 1372)
                .ok_or_else(|| Error::Other("Window image width is invalid.".into()))?;
            let height = captured_geometry
                .get("screenshot_height")
                .and_then(Value::as_u64)
                .filter(|height| *height > 0 && *height <= 1372)
                .ok_or_else(|| Error::Other("Window image height is invalid.".into()))?;
            let left = captured_geometry
                .get("left")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::Other("Capture origin is missing.".into()))?;
            let top = captured_geometry
                .get("top")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::Other("Capture origin is missing.".into()))?;
            let right = captured_geometry
                .get("right")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::Other("Capture bounds are missing.".into()))?;
            let bottom = captured_geometry
                .get("bottom")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::Other("Capture bounds are missing.".into()))?;
            let image = captured
                .get("content")
                .and_then(Value::as_array)
                .filter(|parts| {
                    parts.len() == 1
                        && parts[0].get("type").and_then(Value::as_str) == Some("image")
                        && parts[0].get("mimeType").and_then(Value::as_str) == Some("image/png")
                })
                .ok_or_else(|| Error::Other("Window capture returned no safe PNG.".into()))?
                .clone();
            if arguments.get("includeTree").and_then(Value::as_bool) == Some(false) {
                result["content"] = json!([]);
                result["structuredContent"] = json!({});
            }
            result
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| Error::Other("Driver tree content is invalid.".into()))?
                .extend(image);
            if !result
                .get("structuredContent")
                .is_some_and(Value::is_object)
            {
                result["structuredContent"] = json!({});
            }
            result["structuredContent"]["capture_id"] =
                json!(format!("host-{}", uuid::Uuid::new_v4()));
            result["structuredContent"]["screenshot_width"] = json!(width);
            result["structuredContent"]["screenshot_height"] = json!(height);
            result["structuredContent"]["screenshot_mime_type"] = json!("image/png");
            result["structuredContent"]["window_bounds"] =
                json!({"x":left,"y":top,"width":right-left,"height":bottom-top});
            result["structuredContent"]["tree_frame_coordinate_space"]=json!("native_screen_pixels");
            result["structuredContent"]["screenshot_coordinate_space"]=json!("host_window_image_pixels");
            result.get_mut("content").and_then(Value::as_array_mut).unwrap().insert(0,json!({"type":"text","text":"Use screenshot-local image pixels for computer_click. Accessibility frames, when present, use native screen pixels and must be translated through window_bounds and screenshot dimensions."}));
            geometry = Some(captured_geometry);
            }
        }
        platform::revalidate(&app)?;
        {
            let state = core.lock();
            state.authorize(id, generation, &app_id)?;
        }
        if result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            platform::release_background_input(&app, &targets, &keys, mouse)?;
        }
        {
            let mut state = core.lock();
            state.authorize(id, generation, &app_id)?;
            state.held = None;
            state.runtimes.get_mut(id).unwrap().state = "granted".into();
            if name == "computer_observe" {
                record_observation(&mut state, id, &app_id, &result);
                if let Some(capture) = state
                    .runtimes
                    .get_mut(id)
                    .unwrap()
                    .captures
                    .get_mut(&app_id)
                {
                    capture.geometry = geometry;
                }
            } else if result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                state.runtimes.get_mut(id).unwrap().captures.remove(&app_id);
            }
        }
        core.emit(Some(id));
        let host_diagnostic = matches!(driver_name.as_str(), "edit_shortcut" | "foreground_key")
            .then(|| result.get("content").and_then(Value::as_array)
                .and_then(|parts| parts.first()).and_then(|part| part.get("text"))
                .and_then(Value::as_str).map(|text| text.chars().take(512).collect::<String>()))
            .flatten().filter(|_| result.get("isError").and_then(Value::as_bool) == Some(true));
        let mut result = normalize_result(name, &app_id, result);
        if let Some(diagnostic) = host_diagnostic {
            result["structuredContent"]["diagnostic"] = json!(diagnostic);
            result["content"].as_array_mut().unwrap().push(json!({"type":"text","text":diagnostic}));
        }
        if driver_name == "foreground_key" {
            result["structuredContent"]["requestedDelivery"] = json!("foreground");
            if let Some(text) = result["content"][0]["text"].as_str() {
                result["content"][0]["text"] = json!(text.replace("Requested delivery: background.", "Requested delivery: foreground."));
            }
        }
        Ok(result)
    }
    .await;
    if result.is_err() && !revoke_on_error.load(std::sync::atomic::Ordering::Relaxed) {
        // Nothing was dispatched. Retire grounding so the model observes again.
        if let Some(runtime) = core.lock().runtimes.get_mut(id) {
            if runtime.generation == generation {
                runtime.captures.remove(&app_id);
            }
        }
        return result;
    }
    if result.is_err() {
        core.revoke_if_generation(id, generation, "driver_failed");
    }
    result
}

fn reject_driver_pixels(result: &Value) -> Result<()> {
    if result
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|part| part.get("type").and_then(Value::as_str) == Some("image"))
        })
    {
        return Err(Error::Other("Driver returned pixels although capture was disabled. Computer access has been revoked.".into()));
    }
    Ok(())
}

async fn run_window_operation(
    core: Arc<Core>,
    id: &str,
    generation: u64,
    app: &AppInfo,
    mut request: Value,
) -> Result<Value> {
    let is_capture = request.get("operation").and_then(Value::as_str) == Some("capture");
    let worker = {
        let mut state = core.lock();
        state.authorize(id, generation, &app.app_id)?;
        request["identity"] = platform::worker_identity(app)?;
        let executable = core
            .worker_executable
            .clone()
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)?;
        let worker = super::window_executor::Worker::start(&executable, request)?;
        state.worker = Some(worker.clone());
        worker
    };
    let result = worker.receive().await;
    if result.is_err() {
        worker.kill();
    }
    let reaper = worker.clone();
    let reaped = tokio::task::spawn_blocking(move || reaper.reap())
        .await
        .map_err(|error| Error::Other(error.to_string()))?;
    // Keep the registered worker on unconfirmed exit so revoke still owns it
    // and cannot release the desktop lease ahead of a surviving helper.
    reaped?;
    {
        let mut state = core.lock();
        state.authorize(id, generation, &app.app_id)?;
        if state
            .worker
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &worker))
        {
            state.worker = None;
        }
    }
    let result=result.map_err(|error|if is_capture&&error.to_string().contains("Target-window operation failed") {
        Error::Other("Window-only capture failed or is unsupported; no desktop capture fallback was attempted.".into())
    }else{error})?;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Err(Error::Other(error.chars().take(1024).collect()));
    }
    Ok(result)
}

fn normalize_result(tool: &str, app_id: &str, mut result: Value) -> Value {
    if tool == "computer_observe" {
        return result;
    }
    let raw = result
        .get("structuredContent")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut reported = serde_json::Map::new();
    for key in [
        "effect",
        "verified",
        "path",
        "route",
        "mode",
        "delivery",
        "delivery_mode",
        "code",
        "error_code",
    ] {
        if let Some(value) = raw.get(key) {
            if value.is_boolean()
                || value.as_str().is_some_and(|value| value.len() <= 256)
                || value.is_number()
            {
                reported.insert(key.into(), value.clone());
            }
        }
    }
    if let Some(mode) = raw
        .pointer("/delivery/mode")
        .and_then(Value::as_str)
        .filter(|mode| mode.len() <= 256)
    {
        reported.insert("mode".into(), json!(mode));
    }
    let failed = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let effect = reported
        .get("effect")
        .and_then(Value::as_str)
        .unwrap_or(if failed {
            "refused or unknown"
        } else {
            "unverifiable"
        });
    let text = format!("{tool} returned. Driver-reported application effect: {effect}. Requested delivery: background. Observe the approved app with computer_observe before another action; uncertain input is never automatically replayed.");
    let diagnostic = if failed {
        safe_driver_diagnostic(&result)
    } else {
        None
    };
    let images = result
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("image"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut content = vec![json!({"type":"text","text":text})];
    if let Some(diagnostic) = diagnostic.as_ref() {
        content.push(json!({"type":"text","text":format!("Driver diagnostic: {diagnostic}")}));
    }
    content.extend(images);
    result["content"] = json!(content);
    result["structuredContent"] = json!({"appId":app_id,"requestedDelivery":"background","driverReported":reported,"diagnostic":diagnostic,
        "next_call":{"name":"computer_observe","arguments":{"appId":app_id}}});
    result
}

fn safe_driver_diagnostic(result: &Value) -> Option<String> {
    let text = result
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .take(4)
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.chars().take(4096).collect::<String>();
    let lower = text.to_ascii_lowercase();
    if lower.contains("uipi") || lower.contains("integrity") || lower.contains("elevated") {
        return Some(
            "Windows denied background input to an app at a different integrity level.".into(),
        );
    }
    if lower.contains("postmessage") {
        return Some("Windows rejected a posted input message to the approved app.".into());
    }
    if lower.contains("background_unavailable") || lower.contains("unsupported") {
        return Some(
            "The driver could not deliver this background action to the approved app.".into(),
        );
    }
    let safe = text
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            ![
                "foreground",
                "delivery_mode",
                "get_window_state",
                "press_key",
                "type_text",
                "next_call",
                "retry",
            ]
            .iter()
            .any(|word| lower.contains(word))
        })
        .collect::<Vec<_>>()
        .join(" ");
    let safe = safe.chars().take(512).collect::<String>();
    (!safe.trim().is_empty()).then_some(safe)
}

fn record_observation(state: &mut super::state::State, id: &str, app_id: &str, result: &Value) {
    let runtime = state.runtimes.get_mut(id).unwrap();
    runtime.captures.remove(app_id);
    let content = result.get("structuredContent").unwrap_or(&Value::Null);
    let capture = content.get("capture_id").and_then(Value::as_str);
    let width = content.get("screenshot_width").and_then(Value::as_f64);
    let height = content.get("screenshot_height").and_then(Value::as_f64);
    let has_image = result
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                part.get("type").and_then(Value::as_str) == Some("image")
                    && part.get("mimeType").and_then(Value::as_str) == Some("image/png")
            })
        });
    if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !has_image
    {
        return;
    }
    if let (Some(capture), Some(width), Some(height)) = (capture, width, height) {
        if !capture.is_empty()
            && capture.len() <= 256
            && width > 0.0
            && height > 0.0
            && width <= 1372.0
            && height <= 1372.0
        {
            runtime.captures.insert(
                app_id.into(),
                Capture {
                    id: capture.into(),
                    width,
                    height,
                    created: Instant::now(),
                    consumed: false,
                    geometry: None,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_use::keyboard::key_code;
    #[tokio::test]
    async fn gateway_framing_rejects_oversized_and_partial_json() {
        assert!(read_json(&mut &b"123456\n"[..], 4).await.is_err());
        assert!(read_json(&mut &b"{}"[..], 4).await.is_err());
        assert_eq!(
            read_json(&mut &b"{}\n"[..], 4).await.unwrap(),
            Some(json!({}))
        );
    }
    #[test]
    fn no_shell_target_scope_or_foreground_passthrough() {
        assert!(fields(&json!({"appId":"a","scope":"desktop"}), &["appId"]).is_err());
        assert!(fields(
            &json!({"appId":"a","delivery_mode":"foreground"}),
            &["appId"]
        )
        .is_err());
        assert!(key_code("win").is_none());
    }
    #[test]
    fn driver_observations_are_tree_only_and_unexpected_pixels_are_rejected() {
        let (core, app) = authorized();
        for include_tree in [true, false] {
            let (name, args, _, _) = translate(
                &core,
                "a",
                1,
                &app,
                "computer_observe",
                &json!({"appId":app.app_id,"includeTree":include_tree}),
            )
            .unwrap();
            assert_eq!(name, "get_window_state");
            assert_eq!(args["include_screenshot"], false);
            assert_eq!(args["include_accessibility_tree"], true);
        }
        assert!(reject_driver_pixels(
            &json!({"content":[{"type":"image","mimeType":"image/png","data":"untrusted"}]})
        )
        .is_err());
        assert!(reject_driver_pixels(
            &json!({"content":[{"type":"text","text":"approved UIA tree"}]})
        )
        .is_ok());
    }
    fn authorized() -> (Core, AppInfo) {
        let mut state = super::super::state::State::default();
        state.register("a", "fixture", true).unwrap();
        let app = AppInfo {
            window_witness: None,
            app_id: "captured-window".into(),
            name: "fixture".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "2".into(),
            title: "fixture".into(),
            tier: Tier::Full,
        };
        state
            .runtimes
            .get_mut("a")
            .unwrap()
            .grants
            .insert(app.app_id.clone(), app.clone());
        state.owner = Some("a".into());
        let core = Core {
            app: None,
            state: std::sync::Mutex::new(state),
            action: Arc::new(tokio::sync::Mutex::new(())),
            broker_port: 1,
            data_dir: std::env::temp_dir(),
            worker_executable: None,
        };
        (core, app)
    }
    #[test]
    fn late_action_failure_cannot_revoke_a_recovered_generation() {
        let (core, app) = authorized();
        let core = Arc::new(core);
        // Recovery completed before an old in-flight action reports its error.
        core.lock().runtimes.get_mut("a").unwrap().generation = 2;
        assert!(!core.revoke_if_generation("a", 1, "driver_failed"));
        assert!(core.lock().authorize("a", 2, &app.app_id).is_ok());
        assert!(core.revoke_if_generation("a", 2, "driver_failed"));
        assert!(core.lock().authorize("a", 2, &app.app_id).is_err());
        assert!(!core.lock().runtimes["a"].enabled);
    }
    fn observe(core: &Core, app: &AppInfo) {
        record_observation(
            &mut core.lock(),
            "a",
            &app.app_id,
            &json!({"content":[{"type":"image","mimeType":"image/png","data":"fixture"}],
            "structuredContent":{"capture_id":"capture-1","screenshot_width":600,"screenshot_height":400}}),
        );
    }
    #[test]
    fn every_mutation_consumes_grounding_and_cannot_replay_or_click_old_pixels() {
        let (core, app) = authorized();
        observe(&core, &app);
        translate(
            &core,
            "a",
            1,
            &app,
            "computer_type",
            &json!({"appId":app.app_id,"text":"hello"}),
        )
        .unwrap();
        assert!(translate(
            &core,
            "a",
            1,
            &app,
            "computer_click",
            &json!({"appId":app.app_id,"x":1,"y":1,"captureId":"capture-1"})
        )
        .is_err());
        for (name, arguments) in [
            ("computer_key", json!({"appId":app.app_id,"key":"tab"})),
            (
                "computer_scroll",
                json!({"appId":app.app_id,"direction":"down"}),
            ),
        ] {
            observe(&core, &app);
            translate(&core, "a", 1, &app, name, &arguments).unwrap();
            assert!(translate(&core, "a", 1, &app, name, &arguments).is_err());
        }
    }
    #[test]
    fn click_variants_are_bounded_and_key_aliases_use_driver_names() {
        let (core, app) = authorized();
        for (extra, button, count) in [
            (json!({}), "left", 1),
            (json!({"button":"right"}), "right", 1),
            (json!({"clickCount":2}), "left", 2),
        ] {
            observe(&core, &app);
            let mut arguments = json!({"appId":app.app_id,"x":1,"y":1,"captureId":"capture-1"});
            for (key, value) in extra.as_object().unwrap() {
                arguments[key] = value.clone();
            }
            let (_, dispatched, _, mouse) =
                translate(&core, "a", 1, &app, "computer_click", &arguments).unwrap();
            assert_eq!(dispatched["button"], button);
            assert_eq!(dispatched["count"], count);
            assert!(mouse);
        }
        for invalid in [
            json!({"button":"middle"}),
            json!({"clickCount":3}),
            json!({"button":"right","clickCount":2}),
        ] {
            observe(&core, &app);
            let mut arguments = json!({"appId":app.app_id,"x":1,"y":1,"captureId":"capture-1"});
            for (key, value) in invalid.as_object().unwrap() {
                arguments[key] = value.clone();
            }
            assert!(translate(&core, "a", 1, &app, "computer_click", &arguments).is_err());
            assert!(!core.lock().runtimes["a"].captures[&app.app_id].consumed);
        }
        for (alias, canonical, code) in [
            ("Enter", "return", 0x0D),
            ("esc", "escape", 0x1B),
            ("backspace", "backspace", 0x08),
            ("ins", "insert", 0x2D),
        ] {
            observe(&core, &app);
            let (_, dispatched, keys, _) = translate(
                &core,
                "a",
                1,
                &app,
                "computer_key",
                &json!({"appId":app.app_id,"key":alias}),
            )
            .unwrap();
            assert_eq!(dispatched["key"], canonical);
            assert_eq!(keys, vec![code]);
        }
    }
    #[test]
    fn shortcuts_use_semantic_or_explicit_foreground_routes_without_plain_key_fallback() {
        let (core, app) = authorized();
        observe(&core, &app);
        let args = json!({"appId":app.app_id,"key":"A","modifiers":["ctrl"]});
        let (route, output, keys, mouse) =
            translate(&core, "a", 1, &app, "computer_key", &args).unwrap();
        assert_eq!(route, "edit_shortcut");
        assert_eq!(output["command"], "select_all");
        assert!(keys.is_empty() && !mouse);
        assert!(core.lock().runtimes["a"].captures[&app.app_id].consumed);
        observe(&core, &app);
        let copy = json!({"appId":app.app_id,"key":"c","modifiers":["ctrl"]});
        assert!(translate(&core, "a", 1, &app, "computer_key", &copy).is_err());
        assert!(!core.lock().runtimes["a"].captures[&app.app_id].consumed);
        core.lock().foreground_keys = true;
        let (route, output, keys, _) =
            translate(&core, "a", 1, &app, "computer_key", &copy).unwrap();
        assert_eq!(route, "foreground_key");
        assert_eq!(output["delivery_mode"], "foreground");
        assert!(
            keys.is_empty(),
            "one-batch shortcuts never register held background keys"
        );
        observe(&core, &app);
        let injected =
            json!({"appId":app.app_id,"key":"a","modifiers":["ctrl"],"delivery_mode":"foreground"});
        assert!(translate(&core, "a", 1, &app, "computer_key", &injected).is_err());
    }

    #[test]
    fn foreground_setting_does_not_upgrade_ide_or_system_app_permissions() {
        let (core, mut app) = authorized();
        core.lock().foreground_keys = true;
        for path in [
            r"C:\Apps\Antigravity IDE.exe",
            r"C:\Windows\System32\Taskmgr.exe",
            r"C:\Windows\ImmersiveControlPanel\SystemSettings.exe",
        ] {
            app.path = path.into();
            app.tier = platform::tier(path);
            observe(&core, &app);
            for (name, arguments) in [
                (
                    "computer_type",
                    json!({"appId":app.app_id,"text":"blocked"}),
                ),
                (
                    "computer_key",
                    json!({"appId":app.app_id,"key":"a","modifiers":["ctrl"]}),
                ),
            ] {
                assert!(
                    translate(&core, "a", 1, &app, name, &arguments).is_err(),
                    "{path}"
                );
            }
            if app.tier == Tier::View {
                assert!(translate(
                    &core,
                    "a",
                    1,
                    &app,
                    "computer_click",
                    &json!({"appId":app.app_id,"captureId":"capture-1","x":0,"y":0})
                )
                .is_err());
            }
            assert!(!core.lock().runtimes["a"].captures[&app.app_id].consumed);
            assert!(translate(
                &core,
                "a",
                1,
                &app,
                "computer_observe",
                &json!({"appId":app.app_id})
            )
            .is_ok());
        }
    }
    #[tokio::test]
    async fn wait_is_bounded_and_requires_enabled_access() {
        let (core, _) = authorized();
        let core = Arc::new(core);
        let waited = dispatch(core.clone(), "a", "computer_wait", json!({"seconds":0.1}))
            .await
            .unwrap();
        assert_eq!(waited["structuredContent"]["waitedSeconds"], 0.1);
        for seconds in [0.0, 11.0] {
            assert!(dispatch(
                core.clone(),
                "a",
                "computer_wait",
                json!({"seconds":seconds})
            )
            .await
            .is_err());
        }
        let waiting = tokio::spawn(dispatch(
            core.clone(),
            "a",
            "computer_wait",
            json!({"seconds":5}),
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        core.lock().revoke("a", "user_take_back", false);
        assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }
    #[test]
    fn failed_or_non_image_observation_retires_previous_capture() {
        let (core, app) = authorized();
        observe(&core, &app);
        record_observation(
            &mut core.lock(),
            "a",
            &app.app_id,
            &json!({"isError":true,"content":[{"type":"text","text":"capture failed"}]}),
        );
        assert!(core.lock().runtimes["a"].captures.is_empty());
        observe(&core, &app);
        record_observation(
            &mut core.lock(),
            "a",
            &app.app_id,
            &json!({"structuredContent":{"capture_id":"fake","screenshot_width":1,"screenshot_height":1}}),
        );
        assert!(core.lock().runtimes["a"].captures.is_empty());
    }
    #[test]
    fn malformed_optional_button_and_tier_upgrade_never_dispatch() {
        let (core, mut app) = authorized();
        observe(&core, &app);
        assert!(translate(
            &core,
            "a",
            1,
            &app,
            "computer_click",
            &json!({"appId":app.app_id,"x":1,"y":1,"captureId":"capture-1","button":false})
        )
        .is_err());
        assert!(!core.lock().runtimes["a"].captures[&app.app_id].consumed);
        app.tier = Tier::View;
        assert!(translate(
            &core,
            "a",
            1,
            &app,
            "computer_click",
            &json!({"appId":app.app_id,"x":1,"y":1,"captureId":"capture-1"})
        )
        .is_err());
        app.tier = Tier::Click;
        assert!(translate(
            &core,
            "a",
            1,
            &app,
            "computer_key",
            &json!({"appId":app.app_id,"key":"a"})
        )
        .is_err());
    }
    #[test]
    fn scroll_cannot_select_global_input_even_when_legacy_result_labels_are_unknown() {
        let (core, app) = authorized();
        observe(&core, &app);
        let arguments = json!({"appId":app.app_id,"direction":"down","amount":2});
        for (field, value) in [
            ("scope", json!("desktop")),
            ("delivery_mode", json!("foreground")),
            ("pid", json!(999)),
            ("window_id", json!(999)),
            ("x", json!(100)),
            ("y", json!(100)),
            ("element_token", json!("untrusted")),
        ] {
            let mut injected = arguments.clone();
            injected[field] = value;
            assert!(translate(&core, "a", 1, &app, "computer_scroll", &injected).is_err());
            assert!(!core.lock().runtimes["a"].captures[&app.app_id].consumed);
        }
        let (name, dispatched, keys, mouse) =
            translate(&core, "a", 1, &app, "computer_scroll", &arguments).unwrap();
        // Pinned ScrollTool uses SendInput only for window-less desktop pixels
        // or explicit foreground mode. This shape reaches its exact-HWND
        // WM_VSCROLL branch, irrespective of its generic legacy result labels.
        assert_eq!(name, "scroll");
        assert_eq!(
            dispatched,
            json!({"pid":1,"window_id":2,"scope":"window",
            "delivery_mode":"background","direction":"down","amount":2})
        );
        assert!(keys.is_empty());
        assert!(!mouse);
        let result = normalize_result(
            "computer_scroll",
            &app.app_id,
            json!({"content":[{"type":"text","text":"Scrolled pid 1 down via 2× SB_LINEDOWN message(s)."}],
                "structuredContent":{"effect":"unverifiable","route":"global_input","delivery":{"mode":"unknown"}}}),
        );
        assert_eq!(
            result["structuredContent"]["requestedDelivery"],
            "background"
        );
        assert_eq!(
            result["structuredContent"]["driverReported"]["route"],
            "global_input"
        );
        assert_eq!(
            result["structuredContent"]["driverReported"]["mode"],
            "unknown"
        );
        assert_eq!(
            result["structuredContent"]["driverReported"]["effect"],
            "unverifiable"
        );
    }
    #[test]
    fn action_results_only_recommend_managed_tools_and_preserve_reported_effect_route() {
        let result = normalize_result(
            "computer_key",
            "approved",
            json!({"content":[{"type":"text","text":"Retry delivery_mode:foreground with press_key, then get_window_state(pid=7)."}],
            "structuredContent":{"effect":"unverifiable","route":"global_input","delivery":{"mode":"unknown"},"escalation":{"delivery_mode":"foreground"},"next_call":{"name":"get_window_state","arguments":{"pid":7,"window_id":8}}}}),
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("foreground"));
        assert!(!serialized.contains("get_window_state"));
        assert!(!serialized.contains("press_key"));
        assert_eq!(
            result["structuredContent"]["driverReported"]["route"],
            "global_input"
        );
        assert_eq!(
            result["structuredContent"]["driverReported"]["mode"],
            "unknown"
        );
        assert_eq!(
            result["structuredContent"]["driverReported"]["effect"],
            "unverifiable"
        );
        assert_eq!(
            result["structuredContent"]["next_call"],
            json!({"name":"computer_observe","arguments":{"appId":"approved"}})
        );
    }
    #[test]
    fn text_only_driver_errors_keep_safe_failure_diagnostics() {
        let denied = normalize_result(
            "computer_key",
            "a",
            json!({"isError":true,"content":[{"type":"text","text":"PostMessageW failed: access denied. Retry delivery_mode:foreground with press_key."}]}),
        );
        assert_eq!(
            denied["structuredContent"]["diagnostic"],
            "Windows rejected a posted input message to the approved app."
        );
        assert_eq!(denied["isError"], true);
        assert!(!serde_json::to_string(&denied)
            .unwrap()
            .contains("foreground"));
        let failed = normalize_result(
            "computer_type",
            "a",
            json!({"isError":true,"content":[{"type":"text","text":"The target stopped responding before text delivery."}]}),
        );
        assert!(failed["structuredContent"]["diagnostic"]
            .as_str()
            .unwrap()
            .contains("stopped responding"));
    }
}
