//! Native process bridge for published semantic cluster reads.

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::{Instant, timeout_at},
};

const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_CHILDREN: usize = 2;
const DEADLINE: Duration = Duration::from_secs(30);

/// Startup-only configuration for the public cluster projection.
///
/// No request can alter paths, enablement, or the executable.  Disabled is the
/// default supplied by the existing serve constructors.
#[derive(Clone, Debug)]
pub struct ClusterConfig {
    enabled: bool,
    controls_enabled: bool,
    curator_id: Option<String>,
    library: PathBuf,
    python: Option<PathBuf>,
    deadline: Duration,
    max_output: usize,
    max_children: usize,
}

impl ClusterConfig {
    pub fn disabled(library: impl Into<PathBuf>) -> Self {
        Self {
            enabled: false,
            controls_enabled: false,
            curator_id: None,
            library: library.into(),
            python: None,
            deadline: DEADLINE,
            max_output: MAX_OUTPUT,
            max_children: MAX_CHILDREN,
        }
    }

    /// Construct the enabled form from an already trusted, absolute executable.
    pub fn enabled(library: impl Into<PathBuf>, python: PathBuf) -> Result<Self, String> {
        if !python.is_absolute() {
            return Err("--cluster-python must be an absolute executable path".into());
        }
        let python =
            std::fs::canonicalize(&python).map_err(|e| format!("{}: {e}", python.display()))?;
        let metadata =
            std::fs::metadata(&python).map_err(|e| format!("{}: {e}", python.display()))?;
        if !metadata.is_file() {
            return Err(format!("{} is not an executable file", python.display()));
        }
        #[cfg(unix)]
        if std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
            return Err(format!("{} is not executable", python.display()));
        }
        let library = library.into();
        let library =
            std::fs::canonicalize(&library).map_err(|e| format!("{}: {e}", library.display()))?;
        if !library.is_dir() {
            return Err(format!("{} is not a library directory", library.display()));
        }
        Ok(Self {
            enabled: true,
            controls_enabled: false,
            curator_id: None,
            library,
            python: Some(python),
            deadline: DEADLINE,
            max_output: MAX_OUTPUT,
            max_children: MAX_CHILDREN,
        })
    }

    pub fn enabled_flag(&self) -> bool {
        self.enabled
    }

    pub fn controls_enabled_flag(&self) -> bool { self.controls_enabled }

    pub fn without_public_reads(mut self) -> Self {
        self.enabled = false;
        self
    }

    /// Enable the entirely separate local curator-control bridge.  The
    /// identity is startup configuration, never a browser/header field.
    pub fn with_curator_controls(mut self, curator_id: String) -> Result<Self, String> {
        if curator_id.is_empty() || curator_id.len() > 160
            || !curator_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) {
            return Err("--cluster-curator-id must be 1..160 safe identifier characters".into());
        }
        if self.python.is_none() { return Err("--cluster-python is required with curator controls".into()); }
        self.controls_enabled = true;
        self.curator_id = Some(curator_id);
        Ok(self)
    }

    #[cfg(test)]
    fn with_test_limits(
        mut self,
        deadline: Duration,
        max_output: usize,
        max_children: usize,
    ) -> Self {
        self.deadline = deadline;
        self.max_output = max_output;
        self.max_children = max_children;
        self
    }
}

#[derive(Clone)]
struct Bridge {
    config: Arc<ClusterConfig>,
    active: Arc<AtomicUsize>,
}

impl Bridge {
    fn new(config: ClusterConfig) -> Self {
        Self {
            config: Arc::new(config),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn try_acquire(&self) -> Option<ActiveChild> {
        let mut current = self.active.load(Ordering::Acquire);
        loop {
            if current >= self.config.max_children {
                return None;
            }
            match self.active.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(ActiveChild(self.active.clone())),
                Err(next) => current = next,
            }
        }
    }

    async fn request(&self, raw_query: Option<&str>) -> Response {
        // Rollout gating is deliberately before parsing, spawning, or any disk access.
        if !self.config.enabled {
            return unavailable();
        }
        let query = match parse_query(raw_query) {
            Ok(query) => query,
            Err(()) => return bad_request(),
        };
        let Some(_active) = self.try_acquire() else {
            return unavailable();
        };
        let body = match self.invoke(query).await {
            Ok((status, body)) => return (status, axum::Json(body)).into_response(),
            Err(()) => json!({"error": "service unavailable"}),
        };
        (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response()
    }

    async fn curator_request(&self, body: Bytes) -> Response {
        // This is intentionally a different rollout gate and route from
        // public reads.  It must not infer authority from the request.
        if !self.config.controls_enabled { return unavailable(); }
        if body.len() > MAX_INPUT { return bad_request(); }
        let value: Value = match serde_json::from_slice(&body) {
            Ok(value @ Value::Object(_)) => value,
            _ => return bad_request(),
        };
        let Some(_active) = self.try_acquire() else { return unavailable(); };
        let Some(curator_id) = self.config.curator_id.as_deref() else { return unavailable(); };
        match self.invoke_module(value, "apricity_analyze.cluster_curator_http", Some(curator_id)).await {
            Ok((status, body)) => (status, axum::Json(body)).into_response(),
            Err(()) => (StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error": "service unavailable"}))).into_response(),
        }
    }

    async fn invoke(&self, query: Value) -> Result<(StatusCode, Value), ()> {
        self.invoke_module(query, "apricity_analyze.cluster_http", None).await
    }

    async fn invoke_module(&self, query: Value, module: &str, curator_id: Option<&str>) -> Result<(StatusCode, Value), ()> {
        let stdin = serde_json::to_vec(&query).map_err(|_| ())?;
        if stdin.len() > MAX_INPUT {
            return Err(());
        }
        let python = self.config.python.as_ref().ok_or(())?;
        let library = self.config.library.to_str().ok_or(())?;
        let controls = self.config.library.join("semantic/clusters/control");
        let runs = self.config.library.join("semantic/clusters");
        let controls = controls.to_str().ok_or(())?;
        let runs = runs.to_str().ok_or(())?;
        let mut command = Command::new(python);
        command.args(["-m", module, "--library", library, "--controls-root", controls, "--runs-root", runs, "--enabled"]);
        if let Some(curator_id) = curator_id { command.args(["--curator-id", curator_id]); }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // A cancelled HTTP future drops this Child. Tokio then terminates and reaps it.
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let ends_at = Instant::now() + self.config.deadline;
        let write = async {
            let mut pipe = child.stdin.take().ok_or(())?;
            pipe.write_all(&stdin).await.map_err(|_| ())?;
            pipe.shutdown().await.map_err(|_| ())
        };
        if !matches!(timeout_at(ends_at, write).await, Ok(Ok(()))) {
            stop_and_reap(&mut child).await;
            return Err(());
        }
        let stdout = child.stdout.take().ok_or(())?;
        let mut output = tokio::spawn(read_limited(stdout, self.config.max_output));
        let result = timeout_at(ends_at, async {
            tokio::select! {
                status = child.wait() => {
                    let status = status.map_err(|_| ())?;
                    let bytes = (&mut output).await.map_err(|_| ())??;
                    if !status.success() { return Err(()); }
                    Ok(bytes)
                }
                bytes = &mut output => {
                    let bytes = bytes.map_err(|_| ())??;
                    let status = child.wait().await.map_err(|_| ())?;
                    if !status.success() { return Err(()); }
                    Ok(bytes)
                }
            }
        })
        .await;
        let bytes = match result {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(())) | Err(_) => {
                output.abort();
                stop_and_reap(&mut child).await;
                return Err(());
            }
        };
        parse_envelope(&bytes)
    }
}

/// Add the bounded bridge route with its own state, without affecting the existing routes.
pub fn router(config: ClusterConfig) -> Router {
    Router::new()
        .route("/semantic/clusters", get(get_clusters))
        .route("/semantic/cluster-curator", post(post_curator))
        .with_state(Bridge::new(config))
}

async fn get_clusters(State(bridge): State<Bridge>, uri: Uri) -> Response {
    bridge.request(uri.query()).await
}

async fn post_curator(State(bridge): State<Bridge>, body: Bytes) -> Response {
    bridge.curator_request(body).await
}

struct ActiveChild(Arc<AtomicUsize>);

impl Drop for ActiveChild {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn stop_and_reap(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn read_limited(
    mut stdout: tokio::process::ChildStdout,
    limit: usize,
) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = stdout.read(&mut chunk).await.map_err(|_| ())?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(count) > limit {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

fn parse_query(raw: Option<&str>) -> Result<Value, ()> {
    let mut query = Map::new();
    if let Some(raw) = raw {
        let bytes = raw.as_bytes();
        if bytes.iter().enumerate().any(|(i, byte)| {
            *byte == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
        }) {
            return Err(());
        }
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            let key = key.into_owned();
            if !matches!(
                key.as_str(),
                "view" | "run" | "preset" | "order" | "cluster" | "limit"
            ) || query.contains_key(&key)
            {
                return Err(());
            }
            query.insert(key, Value::String(value.into_owned()));
        }
    }
    let view = query
        .get("view")
        .and_then(Value::as_str)
        .unwrap_or("leaderboard");
    if !matches!(view, "leaderboard" | "detail" | "map" | "list") {
        return Err(());
    }
    if let Some(run) = query.get("run").and_then(Value::as_str) {
        if run.len() != 64
            || !run
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(());
        }
    }
    if let Some(preset) = query.get("preset").and_then(Value::as_str) {
        if !matches!(preset, "broad" | "useful" | "fine") {
            return Err(());
        }
    }
    let order = query.get("order").and_then(Value::as_str);
    match view {
        "leaderboard"
            if query.contains_key("cluster")
                || query.contains_key("limit")
                || order.is_some_and(|v| !matches!(v, "samples" | "clips")) =>
        {
            return Err(());
        }
        "detail"
            if !query.contains_key("cluster")
                || query.contains_key("limit")
                || order.is_some_and(|v| !matches!(v, "similarity" | "rating")) =>
        {
            return Err(());
        }
        "map" if query.contains_key("cluster") || query.contains_key("order") => return Err(()),
        "list"
            if query.contains_key("cluster")
                || query.contains_key("limit")
                || query.contains_key("order") =>
        {
            return Err(());
        }
        _ => {}
    }
    if let Some(cluster) = query.remove("cluster") {
        let cluster = cluster.as_str().ok_or(())?;
        let Some((run, label)) = cluster.split_once(':') else {
            return Err(());
        };
        if run.len() != 64
            || !run
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || label.is_empty()
        {
            return Err(());
        }
        match query.get("run").and_then(Value::as_str) {
            Some(existing) if existing != run => return Err(()),
            Some(_) => {}
            None => {
                query.insert("run".into(), Value::String(run.into()));
            }
        }
        // The public URL carries the complete run-bound identity.  The Python
        // projection also uses that complete identity when looking up a row in
        // the immutable manifest; never reduce it to its numeric label.
        query.insert("clusterId".into(), Value::String(cluster.into()));
    }
    if let Some(limit) = query.get("limit").and_then(Value::as_str) {
        let limit: u64 = limit.parse().map_err(|_| ())?;
        if !(1..=10_000).contains(&limit) {
            return Err(());
        }
        query.insert("limit".into(), Value::Number(limit.into()));
    }
    Ok(Value::Object(query))
}

fn parse_envelope(bytes: &[u8]) -> Result<(StatusCode, Value), ()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        #[serde(rename = "statusCode")]
        status_code: u16,
        body: Value,
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| ())?;
    let status = StatusCode::from_u16(envelope.status_code).map_err(|_| ())?;
    if !matches!(
        status,
        StatusCode::OK
            | StatusCode::BAD_REQUEST
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND
            | StatusCode::SERVICE_UNAVAILABLE
    ) {
        return Err(());
    }
    Ok((status, envelope.body))
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(json!({"error": "service unavailable"})),
    )
        .into_response()
}
fn bad_request() -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({"error": "bad request"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;
    use tower::ServiceExt;

    fn script(dir: &TempDir, name: &str, text: &str) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{text}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    async fn call(app: &Router, uri: &str) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    async fn post_json(app: &Router, uri: &str, value: Value) -> (StatusCode, Value) {
        let response = app.clone().oneshot(Request::builder().method("POST").uri(uri)
            .header("content-type", "application/json").body(Body::from(value.to_string())).unwrap()).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn direct_harmless_child_returns_only_the_envelope_body() {
        let dir = TempDir::new().unwrap();
        let child = script(
            &dir,
            "ok",
            "[ \"$1\" = -m ] && [ \"$2\" = apricity_analyze.cluster_http ] || exit 9\necho '{\"statusCode\":200,\"body\":{\"ok\":true}}'",
        );
        let config = ClusterConfig::enabled(dir.path(), child).unwrap();
        let app = router(config);
        assert_eq!(
            call(&app, "/semantic/clusters?view=leaderboard").await,
            (StatusCode::OK, json!({"ok": true}))
        );
    }

    #[tokio::test]
    async fn curator_controls_are_disabled_by_default_and_use_only_startup_identity() {
        let dir = TempDir::new().unwrap();
        assert_eq!(post_json(&router(ClusterConfig::disabled(dir.path())), "/semantic/cluster-curator",
                             json!({"op":"preview","runId":"a".repeat(64),"curator":true})).await.0,
                   StatusCode::SERVICE_UNAVAILABLE);
        let child = script(&dir, "curator", "[ \"$2\" = apricity_analyze.cluster_curator_http ] && [ \"${11}\" = curator-1 ] || exit 9\necho '{\"statusCode\":403,\"body\":{\"error\":\"forbidden\"}}'");
        let config = ClusterConfig::enabled(dir.path(), child).unwrap().without_public_reads()
            .with_curator_controls("curator-1".into()).unwrap();
        let app = router(config);
        assert_eq!(post_json(&app, "/semantic/cluster-curator", json!({"op":"preview","runId":"a".repeat(64)})).await,
                   (StatusCode::FORBIDDEN, json!({"error":"forbidden"})));
        assert_eq!(call(&app, "/semantic/clusters").await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn detail_query_preserves_the_complete_run_bound_cluster_identity() {
        let run = "a".repeat(64);
        let value = parse_query(Some(&format!("view=detail&cluster={run}%3A12"))).unwrap();
        assert_eq!(value["run"], run);
        assert_eq!(value["clusterId"], format!("{}:12", "a".repeat(64)));
    }

    #[tokio::test]
    async fn child_404_exit_failure_and_bad_envelope_are_sanitized() {
        let dir = TempDir::new().unwrap();
        for (name, program, expected) in [
            (
                "missing",
                "echo '{\"statusCode\":404,\"body\":{\"error\":\"not found\"}}'",
                StatusCode::NOT_FOUND,
            ),
            ("failed", "exit 2", StatusCode::SERVICE_UNAVAILABLE),
            ("malformed", "echo nope", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let child = script(&dir, name, program);
            let config = ClusterConfig::enabled(dir.path(), child).unwrap();
            assert_eq!(
                call(&router(config), "/semantic/clusters").await.0,
                expected
            );
        }
    }

    #[tokio::test]
    async fn capacity_timeout_and_overflow_stop_and_reap_children() {
        let dir = TempDir::new().unwrap();
        let slow = script(
            &dir,
            "slow",
            "sleep 1\necho '{\"statusCode\":200,\"body\":{}}'",
        );
        let config = ClusterConfig::enabled(dir.path(), slow)
            .unwrap()
            .with_test_limits(Duration::from_secs(2), 1024, 2);
        let app = router(config);
        let first_app = app.clone();
        let first = tokio::spawn(async move { call(&first_app, "/semantic/clusters").await });
        let second_app = app.clone();
        let second = tokio::spawn(async move { call(&second_app, "/semantic/clusters").await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            call(&app, "/semantic/clusters").await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let _ = tokio::join!(first, second);

        let pid = dir.path().join("pid");
        let sleeper = script(
            &dir,
            "sleeper",
            &format!("echo $$ > {}\nsleep 10", pid.display()),
        );
        let config = ClusterConfig::enabled(dir.path(), sleeper)
            .unwrap()
            .with_test_limits(Duration::from_millis(250), 1024, 1);
        assert_eq!(
            call(&router(config), "/semantic/clusters").await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let process = std::fs::read_to_string(&pid).unwrap();
        let gone = std::process::Command::new("/bin/kill")
            .args(["-0", process.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!gone.success(), "timed-out child was not reaped");

        let cancelled_pid = dir.path().join("cancelled-pid");
        let cancellable = script(
            &dir,
            "cancellable",
            &format!("echo $$ > {}\nsleep 10", cancelled_pid.display()),
        );
        let config = ClusterConfig::enabled(dir.path(), cancellable)
            .unwrap()
            .with_test_limits(Duration::from_secs(2), 1024, 1);
        let cancel_app = router(config);
        let request_app = cancel_app.clone();
        let request = tokio::spawn(async move { call(&request_app, "/semantic/clusters").await });
        for _ in 0..50 {
            if cancelled_pid.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancelled_pid.exists(), "cancellable child did not start");
        request.abort();
        let _ = request.await;
        let process = std::fs::read_to_string(&cancelled_pid).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let gone = std::process::Command::new("/bin/kill")
            .args(["-0", process.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!gone.success(), "cancelled child was not reaped");

        let overflow = script(&dir, "overflow", "head -c 2048 /dev/zero");
        let config = ClusterConfig::enabled(dir.path(), overflow)
            .unwrap()
            .with_test_limits(Duration::from_secs(1), 32, 1);
        assert_eq!(
            call(&router(config), "/semantic/clusters").await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
