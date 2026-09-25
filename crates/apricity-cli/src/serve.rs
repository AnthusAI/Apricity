//! `apricity serve`: one library over HTTP on 127.0.0.1 (design/storage.md section 4).
//!
//! Routes: `POST /graphql` (virtuus-appsync), `GET /amplify_outputs.json`,
//! `GET|HEAD|PUT|DELETE /files/*key` with byte ranges, and the built web app with the
//! cross-origin isolation headers `analysis/apricity_analyze/server.py` sets.

use apricity_data::files::content_type_for as content_type;
use apricity_data::{Files, FsFiles, Library};
use axum::{
    Router,
    body::Body,
    extract::{Path as UrlPath, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use virtuus_amplify::Contract;
use virtuus_appsync::{RouterOptions, router};

const CONTRACT_JSON: &str = include_str!("../../../contract/apricity.contract.json");
const SDL: &str = include_str!("../../../contract/appsync.graphql");
const MODEL_INTROSPECTION: &str = include_str!("../../../contract/model-introspection.json");

/// Everything the routes share.
#[derive(Clone)]
struct Shared {
    /// Scratch space for uploads (beside, not under, the files folder).
    scratch: PathBuf,
    files: Arc<RwLock<Box<dyn Files>>>,
    outputs: Arc<Value>,
    web: Option<PathBuf>,
}

/// Build the whole application for a library served at `origin` (e.g. `http://127.0.0.1:5181`).
pub fn app(library: Library, origin: &str, web: Option<PathBuf>) -> Result<Router, String> {
    let store = Box::new(FsFiles::new(library.path().join("files")));
    app_with_store(library, origin, web, store)
}

/// Like [`app`], serving `/files/*key` from any `Files` store (a folder, or S3).
pub fn app_with_store(
    library: Library,
    origin: &str,
    web: Option<PathBuf>,
    store: Box<dyn Files>,
) -> Result<Router, String> {
    let mut library = library;
    let api_key = library.ensure_api_key().map_err(|e| e.to_string())?;
    let metadata = library.metadata().clone();
    let scratch = library.path().to_path_buf();
    let contract = routable_contract()?;
    let introspection: Value =
        serde_json::from_str(MODEL_INTROSPECTION).map_err(|e| e.to_string())?;
    let outputs = json!({
        "version": "1.4",
        "data": {
            "url": format!("{origin}/graphql"),
            "aws_region": "local",
            "api_key": api_key,
            "default_authorization_type": "API_KEY",
            "authorization_types": [],
            "model_introspection": introspection,
        },
        "custom": { "apricity": {
            "mode": "local",
            "identity": { "sub": metadata.identity.sub, "groups": metadata.identity.groups },
        }},
    });
    let engine = Arc::new(Mutex::new(library.into_engine()));
    let graphql = router(
        engine,
        SDL,
        &contract,
        RouterOptions {
            api_key: Some(api_key),
            test_identities: false,
        },
    )
    .map_err(|e| e.to_string())?;
    let state = Shared {
        files: Arc::new(RwLock::new(store)),
        scratch,
        outputs: Arc::new(outputs),
        web,
    };
    Ok(Router::new()
        .route("/amplify_outputs.json", get(amplify_outputs))
        .route(
            "/files/*key",
            get(file_get)
                .head(file_head)
                .put(file_put)
                .delete(file_delete),
        )
        .fallback(static_file)
        .with_state(state)
        .merge(graphql)
        .layer(middleware::map_response(isolation_headers)))
}

/// The contract as virtuus-appsync can route it. A hasMany relationship with no child index in
/// the contract (today `Candidate.verdicts`: `Verdict` has no index on `candidateId`) cannot be
/// resolved, and the router refuses to build with one, so those fields are left as plain
/// parent-record fields (null) and a warning names them. Fixing it means adding the index in
/// `web/amplify/data/resource.ts` and regenerating the contract.
fn routable_contract() -> Result<Contract, String> {
    let mut json: Value = serde_json::from_str(CONTRACT_JSON).map_err(|e| e.to_string())?;
    if let Some(models) = json["models"].as_object_mut() {
        for (name, model) in models {
            let Some(rels) = model["relationships"].as_array_mut() else {
                continue;
            };
            rels.retain(|r| {
                let unresolvable = r["kind"] == "hasMany" && r.get("childIndex").is_none();
                if unresolvable {
                    eprintln!("warning: {name}.{} has no child index in the contract; it will resolve to null", r["field"].as_str().unwrap_or("?"));
                }
                !unresolvable
            });
        }
    }
    Contract::from_json(&json.to_string()).map_err(|e| e.to_string())
}

async fn isolation_headers(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    for (k, v) in [
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-embedder-policy", "require-corp"),
        ("cross-origin-resource-policy", "same-origin"),
    ] {
        h.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
    }
    h.entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    resp
}

async fn amplify_outputs(State(s): State<Shared>) -> axum::Json<Value> {
    axum::Json((*s.outputs).clone())
}

fn text(status: StatusCode, msg: &str) -> Response {
    (status, msg.to_string()).into_response()
}

/// Reject keys that could leave the files folder.
fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains(['\\', '\0'])
        && key.split('/').all(|seg| !seg.is_empty() && seg != "..")
}

/// A parsed `Range` header against a file of `size` bytes.
#[derive(Debug, PartialEq)]
enum Range {
    Whole,
    Bytes(u64, u64),
    Unsatisfiable,
}

/// Single `bytes=` ranges only; anything else that names a range is unsatisfiable.
fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(spec) = header else {
        return Range::Whole;
    };
    let Some(spec) = spec.trim().strip_prefix("bytes=") else {
        return Range::Unsatisfiable;
    };
    let Some((a, b)) = spec.split_once('-') else {
        return Range::Unsatisfiable;
    };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(a), Ok(b)) if a <= b => (a, b),
        (Ok(a), Err(_)) if b.is_empty() => (a, u64::MAX),
        (Err(_), Ok(n)) if a.is_empty() && n > 0 => (size.saturating_sub(n), u64::MAX),
        _ => return Range::Unsatisfiable,
    };
    if start >= size {
        return Range::Unsatisfiable;
    }
    Range::Bytes(start, end.min(size - 1))
}

fn check_key(key: &str) -> Result<(), Box<Response>> {
    if safe_key(key) {
        Ok(())
    } else {
        Err(Box::new(text(StatusCode::BAD_REQUEST, "invalid file key")))
    }
}

/// Response status, headers and byte span for a file of `size` bytes and the request's Range
/// header; `Err` is the finished 416 when the range cannot be satisfied.
fn range_plan(
    size: u64,
    headers: &HeaderMap,
    ctype: &str,
) -> Result<(axum::http::response::Builder, u64, u64), Box<Response>> {
    let range = parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        size,
    );
    let (status, start, len) = match range {
        Range::Whole => (StatusCode::OK, 0, size),
        Range::Bytes(a, b) => (StatusCode::PARTIAL_CONTENT, a, b - a + 1),
        Range::Unsatisfiable => {
            return Err(Box::new(
                Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .body(Body::empty())
                    .unwrap(),
            ));
        }
    };
    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len);
    if status == StatusCode::PARTIAL_CONTENT {
        resp = resp.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + len - 1),
        );
    }
    Ok((resp, start, len))
}

/// A folder file (the built web app): metadata and bytes from the filesystem.
async fn serve_path(path: &Path, headers: &HeaderMap, head: bool, ctype: &str) -> Response {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return text(StatusCode::NOT_FOUND, "not found");
    };
    if !meta.is_file() {
        return text(StatusCode::NOT_FOUND, "not found");
    }
    let (resp, start, len) = match range_plan(meta.len(), headers, ctype) {
        Ok(p) => p,
        Err(r) => return *r,
    };
    if head {
        return resp.body(Body::empty()).unwrap();
    }
    let read = async {
        let mut f = tokio::fs::File::open(path).await?;
        f.seek(std::io::SeekFrom::Start(start)).await?;
        let mut buf = Vec::with_capacity(len as usize);
        f.take(len).read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(buf)
    };
    match read.await {
        Ok(buf) => resp.body(Body::from(buf)).unwrap(),
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// A file from the `Files` store, by `stat` and `read_range` only: nothing here assumes the
/// store is a folder, so an S3 store serves the same way.
async fn serve_stored(s: Shared, key: String, headers: HeaderMap, head: bool) -> Response {
    if let Err(r) = check_key(&key) {
        return *r;
    }
    let ctype = content_type(&key);
    let done = tokio::task::spawn_blocking(move || -> Response {
        let files = s.files.read().unwrap();
        let size = match files.stat(&key) {
            Ok(Some(m)) => m.size,
            Ok(None) => return text(StatusCode::NOT_FOUND, "not found"),
            Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
        let (resp, start, len) = match range_plan(size, &headers, ctype) {
            Ok(p) => p,
            Err(r) => return *r,
        };
        if head {
            return resp.body(Body::empty()).unwrap();
        }
        match files.read_range(&key, start, len) {
            Ok(buf) => resp.body(Body::from(buf)).unwrap(),
            Err(apricity_data::files::Error::NotFound(_)) => {
                text(StatusCode::NOT_FOUND, "not found")
            }
            Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    })
    .await;
    done.unwrap_or_else(|e| text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
}

async fn file_get(
    State(s): State<Shared>,
    UrlPath(key): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    serve_stored(s, key, headers, false).await
}

async fn file_head(
    State(s): State<Shared>,
    UrlPath(key): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    serve_stored(s, key, headers, true).await
}

async fn file_put(
    State(s): State<Shared>,
    UrlPath(key): UrlPath<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(r) = check_key(&key) {
        return *r;
    }
    let ctype = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut tmp = tempfile_in(&s.scratch)?;
        std::io::Write::write_all(&mut tmp.1, &body).map_err(|e| e.to_string())?;
        drop(tmp.1);
        let mut files = s.files.write().unwrap();
        let existed = files.stat(&key).map_err(|e| e.to_string())?.is_some();
        let put = files.put(&key, &tmp.0, ctype.as_deref());
        let _ = std::fs::remove_file(&tmp.0);
        let r = put.map_err(|e| e.to_string())?;
        Ok(json!({"key": r.key, "sha256": r.sha256, "size": r.size, "created": !existed}))
    })
    .await;
    match result {
        Ok(Ok(v)) => {
            let status = if v["created"] == true {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, axum::Json(v)).into_response()
        }
        Ok(Err(e)) => text(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// A uniquely named scratch file beside the files folder (same filesystem, not under `files/`).
fn tempfile_in(dir: &Path) -> Result<(PathBuf, std::fs::File), String> {
    let path = dir.join(format!(".upload-{}", uuid_like()));
    let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    Ok((path, f))
}

fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{t}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

async fn file_delete(State(s): State<Shared>, UrlPath(key): UrlPath<String>) -> Response {
    if let Err(r) = check_key(&key) {
        return *r;
    }
    let done = tokio::task::spawn_blocking(move || {
        let files = s.files.read().unwrap();
        match files.stat(&key) {
            Ok(Some(_)) => {}
            Ok(None) => return text(StatusCode::NOT_FOUND, "not found"),
            Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
        match files.delete(&key) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    })
    .await;
    done.unwrap_or_else(|e| text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
}

/// The built web app: `/` is index.html, other paths are files under the web directory.
async fn static_file(
    State(s): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let Some(web) = s.web.as_ref().filter(|w| w.is_dir()) else {
        return text(
            StatusCode::NOT_FOUND,
            "the web app is not built: run `npm run build` in web/ (or pass --web <dir>)",
        );
    };
    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if !safe_key(rel) {
        return text(StatusCode::BAD_REQUEST, "invalid path");
    }
    serve_path(
        &web.join(rel),
        &headers,
        method == Method::HEAD,
        content_type(rel),
    )
    .await
}

/// Open the library and serve it until the process is stopped.
pub fn run(library: &Path, port: u16, web: Option<PathBuf>) -> Result<(), String> {
    let lib = Library::open(library, None).map_err(|e| format!("{}: {e}", library.display()))?;
    let web = web.or_else(|| Some(PathBuf::from("web/dist")).filter(|p| p.is_dir()));
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let app = app(lib, &format!("http://{addr}"), web.clone())?;
        match &web {
            Some(w) => println!("web app: {}", w.display()),
            None => println!("web app: not built (web/dist missing); / will answer 404"),
        }
        println!("listening on http://{addr}");
        axum::serve(listener, app).await.map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    const WAV: &[u8] = b"0123456789abcdefghij";

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        web: PathBuf,
        key: String,
        app: Router,
    }

    fn fixture(with_web: bool) -> Fixture {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("lib");
        let mut lib = Library::create(&root).unwrap();
        let key = lib.ensure_api_key().unwrap();
        std::fs::create_dir_all(root.join("files/audio/c1")).unwrap();
        std::fs::write(root.join("files/audio/c1/a.wav"), WAV).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        let web = dir.path().join("dist");
        if with_web {
            std::fs::create_dir_all(web.join("assets")).unwrap();
            std::fs::write(web.join("index.html"), "<html>app</html>").unwrap();
            std::fs::write(web.join("assets/x.js"), "1").unwrap();
        }
        let app = app(lib, "http://127.0.0.1:5181", Some(web.clone())).unwrap();
        Fixture {
            _dir: dir,
            root,
            web,
            key,
            app,
        }
    }

    async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let resp = app.clone().oneshot(req).await.unwrap();
        let (status, headers) = (resp.status(), resp.headers().clone());
        (
            status,
            headers,
            to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
    }

    fn req(method: &str, uri: &str, extra: &[(&str, &str)], body: &[u8]) -> Request<Body> {
        let mut b = Request::builder().method(method).uri(uri);
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        b.body(Body::from(body.to_vec())).unwrap()
    }

    fn gql(key: Option<&str>, query: &str) -> Request<Body> {
        let mut extra = vec![("content-type", "application/json")];
        if let Some(k) = key {
            extra.push(("x-api-key", k));
        }
        req(
            "POST",
            "/graphql",
            &extra,
            json!({ "query": query }).to_string().as_bytes(),
        )
    }

    async fn range(f: &Fixture, r: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        send(
            &f.app,
            req("GET", "/files/audio/c1/a.wav", &[("range", r)], b""),
        )
        .await
    }

    #[tokio::test]
    async fn graphql_without_key_is_401_and_with_key_returns_data() {
        let f = fixture(false);
        let (status, _, _) = send(&f.app, gql(None, "{ listClips { items { id } } }")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) =
            send(&f.app, gql(Some("wrong"), "{ listClips { items { id } } }")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let create = "mutation { createClip(input: {id: \"c1\", recordingId: \"r1\", path: \"p/a.wav\", collection: \"p\", title: \"A\", audio: {key: \"audio/c1/a.wav\", sha256: \"x\", size: 20}}) { id } }".to_string();
        let (status, _, body) = send(&f.app, gql(Some(&f.key), &create)).await;
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status, StatusCode::OK, "{v}");
        assert!(v.get("errors").is_none(), "{v}");
        let (status, _, body) = send(
            &f.app,
            gql(Some(&f.key), "{ listClips { items { id title } } }"),
        )
        .await;
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["data"]["listClips"]["items"][0]["id"], "c1");
        assert_eq!(v["data"]["listClips"]["items"][0]["title"], "A");
    }

    #[tokio::test]
    async fn amplify_outputs_describes_the_library() {
        let f = fixture(false);
        let (status, headers, body) =
            send(&f.app, req("GET", "/amplify_outputs.json", &[], b"")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            headers[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("application/json")
        );
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["data"]["url"], "http://127.0.0.1:5181/graphql");
        assert_eq!(v["data"]["api_key"], f.key.as_str());
        assert_eq!(v["data"]["aws_region"], "local");
        assert_eq!(v["data"]["default_authorization_type"], "API_KEY");
        assert_eq!(v["data"]["authorization_types"], json!([]));
        assert!(v["data"]["model_introspection"]["models"]["Clip"].is_object());
        assert_eq!(v["custom"]["apricity"]["mode"], "local");
        assert_eq!(v["custom"]["apricity"]["identity"]["sub"], "local");
        assert!(v.get("auth").is_none() && v.get("storage").is_none());
    }

    #[tokio::test]
    async fn api_key_is_stable_across_opens() {
        let f = fixture(false);
        let mut again = Library::open(&f.root, None).unwrap();
        assert_eq!(again.ensure_api_key().unwrap(), f.key);
    }

    #[tokio::test]
    async fn file_get_whole_and_head() {
        let f = fixture(false);
        let (status, h, body) = send(&f.app, req("GET", "/files/audio/c1/a.wav", &[], b"")).await;
        assert_eq!((status, body.as_slice()), (StatusCode::OK, WAV));
        assert_eq!(h[header::ACCEPT_RANGES], "bytes");
        assert_eq!(h[header::CONTENT_TYPE], "audio/wav");
        let (status, h, body) = send(&f.app, req("HEAD", "/files/audio/c1/a.wav", &[], b"")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(h[header::CONTENT_LENGTH], "20");
        assert!(body.is_empty());
        let (status, _, _) = send(&f.app, req("GET", "/files/audio/none.wav", &[], b"")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = send(&f.app, req("HEAD", "/files/audio/none.wav", &[], b"")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = send(&f.app, req("GET", "/files/audio", &[], b"")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn range_requests() {
        let f = fixture(false);
        let (s, h, b) = range(&f, "bytes=2-5").await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, &WAV[2..6]));
        assert_eq!(h[header::CONTENT_RANGE], "bytes 2-5/20");
        assert_eq!(h[header::CONTENT_LENGTH], "4");
        let (s, h, b) = range(&f, "bytes=15-").await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, &WAV[15..]));
        assert_eq!(h[header::CONTENT_RANGE], "bytes 15-19/20");
        let (s, h, b) = range(&f, "bytes=-4").await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, &WAV[16..]));
        assert_eq!(h[header::CONTENT_RANGE], "bytes 16-19/20");
        let (s, h, b) = range(&f, "bytes=10-999").await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, &WAV[10..]));
        assert_eq!(h[header::CONTENT_RANGE], "bytes 10-19/20");
        let (s, _, b) = range(&f, "bytes=-999").await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, WAV));
        let (s, h, b) = send(
            &f.app,
            req(
                "HEAD",
                "/files/audio/c1/a.wav",
                &[("range", "bytes=0-3")],
                b"",
            ),
        )
        .await;
        assert_eq!(
            (s, h[header::CONTENT_RANGE].to_str().unwrap(), b.len()),
            (StatusCode::PARTIAL_CONTENT, "bytes 0-3/20", 0)
        );
    }

    #[tokio::test]
    async fn bad_ranges_are_416_with_size() {
        let f = fixture(false);
        for r in [
            "bytes=20-",
            "bytes=20-30",
            "bytes=5-2",
            "bytes=-0",
            "bytes=0-1,4-5",
            "bytes=x-y",
            "items=0-1",
            "bytes=",
            "bytes=-",
        ] {
            let (s, h, b) = range(&f, r).await;
            assert_eq!(s, StatusCode::RANGE_NOT_SATISFIABLE, "{r}");
            assert_eq!(h[header::CONTENT_RANGE], "bytes */20", "{r}");
            assert!(b.is_empty());
        }
    }

    #[tokio::test]
    async fn put_then_get_then_delete() {
        let f = fixture(false);
        let (s, _, body) = send(
            &f.app,
            req(
                "PUT",
                "/files/documents/r1/x.pdf",
                &[("content-type", "application/pdf")],
                b"%PDF-1",
            ),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["size"], 6);
        assert_eq!(v["key"], "documents/r1/x.pdf");
        assert_eq!(
            std::fs::read(f.root.join("files/documents/r1/x.pdf")).unwrap(),
            b"%PDF-1"
        );
        let (s, h, b) = send(&f.app, req("GET", "/files/documents/r1/x.pdf", &[], b"")).await;
        assert_eq!(
            (s, b.as_slice(), h[header::CONTENT_TYPE].to_str().unwrap()),
            (StatusCode::OK, &b"%PDF-1"[..], "application/pdf")
        );
        let (s, _, _) = send(&f.app, req("PUT", "/files/documents/r1/x.pdf", &[], b"new")).await;
        assert_eq!(s, StatusCode::OK);
        let (_, _, b) = send(&f.app, req("GET", "/files/documents/r1/x.pdf", &[], b"")).await;
        assert_eq!(b, b"new");
        let (s, _, _) = send(&f.app, req("DELETE", "/files/documents/r1/x.pdf", &[], b"")).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let (s, _, _) = send(&f.app, req("GET", "/files/documents/r1/x.pdf", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _, _) = send(&f.app, req("DELETE", "/files/documents/r1/x.pdf", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let leftovers: Vec<_> = std::fs::read_dir(&f.root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".upload"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn keys_cannot_escape_the_files_folder() {
        let f = fixture(false);
        for uri in [
            "/files/../secret.txt",
            "/files/audio/../../../secret.txt",
            "/files/%2e%2e/secret.txt",
            "/files/audio/%2e%2e/%2e%2e/secret.txt",
            "/files/a%5Cb",
            "/files//x",
            "/files/audio//a.wav",
        ] {
            for m in ["GET", "HEAD", "PUT", "DELETE"] {
                let (s, _, b) = send(&f.app, req(m, uri, &[], b"pwn")).await;
                assert!(
                    s == StatusCode::BAD_REQUEST || s == StatusCode::NOT_FOUND,
                    "{m} {uri} -> {s}"
                );
                assert_ne!(b, b"outside");
            }
        }
        let (s, _, _) = send(&f.app, req("PUT", "/files/%2e%2e/evil.txt", &[], b"pwn")).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(!f.root.join("evil.txt").exists());
        assert_eq!(
            std::fs::read(f.root.join("../secret.txt")).unwrap(),
            b"outside"
        );
    }

    #[tokio::test]
    async fn static_app_has_isolation_headers() {
        let f = fixture(true);
        let (s, h, b) = send(&f.app, req("GET", "/", &[], b"")).await;
        assert_eq!(
            (s, b.as_slice()),
            (StatusCode::OK, &b"<html>app</html>"[..])
        );
        assert_eq!(h["cross-origin-opener-policy"], "same-origin");
        assert_eq!(h["cross-origin-embedder-policy"], "require-corp");
        assert_eq!(h["cross-origin-resource-policy"], "same-origin");
        assert_eq!(h[header::CACHE_CONTROL], "no-store");
        assert!(
            h[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        let (s, h, _) = send(&f.app, req("GET", "/assets/x.js", &[], b"")).await;
        assert_eq!(s, StatusCode::OK);
        assert!(
            h[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/javascript")
        );
        let (s, _, _) = send(&f.app, req("GET", "/assets/missing.js", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _, _) = send(&f.app, req("GET", "/../secret.txt", &[], b"")).await;
        assert!(s == StatusCode::BAD_REQUEST || s == StatusCode::NOT_FOUND);
        let (s, _, _) = send(&f.app, req("POST", "/", &[], b"")).await;
        assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
        // isolation headers also ride on API and file responses
        let (_, h, _) = send(&f.app, req("GET", "/amplify_outputs.json", &[], b"")).await;
        assert_eq!(h["cross-origin-embedder-policy"], "require-corp");
    }

    #[tokio::test]
    async fn missing_web_app_says_so_with_a_404() {
        let f = fixture(false);
        assert!(!f.web.exists());
        let (s, h, b) = send(&f.app, req("GET", "/", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert!(String::from_utf8_lossy(&b).contains("not built"));
        assert_eq!(h["cross-origin-opener-policy"], "same-origin");
    }

    /// A store that has no local path and answers only through `stat`/`read_range`, as S3 does.
    struct RemoteLike(FsFiles);

    impl Files for RemoteLike {
        fn put(
            &mut self,
            k: &str,
            s: &Path,
            c: Option<&str>,
        ) -> apricity_data::files::Result<apricity_data::FileRef> {
            self.0.put(k, s, c)
        }
        fn get(&self, k: &str, d: &Path) -> apricity_data::files::Result<()> {
            self.0.get(k, d)
        }
        fn read_range(&self, k: &str, s: u64, l: u64) -> apricity_data::files::Result<Vec<u8>> {
            self.0.read_range(k, s, l)
        }
        fn stat(&self, k: &str) -> apricity_data::files::Result<Option<apricity_data::FileMeta>> {
            self.0.stat(k)
        }
        fn list(&self, p: &str) -> apricity_data::files::Result<Vec<apricity_data::FileMeta>> {
            self.0.list(p)
        }
        fn head(&self, k: &str) -> apricity_data::files::Result<Option<apricity_data::FileRef>> {
            self.0.head(k)
        }
        fn delete(&self, k: &str) -> apricity_data::files::Result<()> {
            self.0.delete(k)
        }
        fn path(&self, _: &str) -> Option<PathBuf> {
            None
        }
    }

    #[tokio::test]
    async fn a_store_with_no_local_path_serves_ranges_head_put_and_delete() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("lib");
        let lib = Library::create(&root).unwrap();
        std::fs::create_dir_all(root.join("files/audio/c1")).unwrap();
        std::fs::write(root.join("files/audio/c1/a.wav"), WAV).unwrap();
        let store = Box::new(RemoteLike(FsFiles::new(root.join("files"))));
        let app = app_with_store(lib, "http://127.0.0.1:5181", None, store).unwrap();
        let (s, h, b) = send(
            &app,
            req(
                "GET",
                "/files/audio/c1/a.wav",
                &[("range", "bytes=2-5")],
                b"",
            ),
        )
        .await;
        assert_eq!((s, b.as_slice()), (StatusCode::PARTIAL_CONTENT, &WAV[2..6]));
        assert_eq!(h[header::CONTENT_RANGE], "bytes 2-5/20");
        let (s, h, b) = send(&app, req("HEAD", "/files/audio/c1/a.wav", &[], b"")).await;
        assert_eq!(
            (s, h[header::CONTENT_LENGTH].to_str().unwrap(), b.len()),
            (StatusCode::OK, "20", 0)
        );
        let (s, _, _) = send(
            &app,
            req(
                "GET",
                "/files/audio/c1/a.wav",
                &[("range", "bytes=20-")],
                b"",
            ),
        )
        .await;
        assert_eq!(s, StatusCode::RANGE_NOT_SATISFIABLE);
        let (s, _, _) = send(&app, req("GET", "/files/audio/none.wav", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _, _) = send(&app, req("PUT", "/files/documents/x.txt", &[], b"hi")).await;
        assert_eq!(s, StatusCode::CREATED);
        let (s, _, _) = send(&app, req("PUT", "/files/documents/x.txt", &[], b"hi2")).await;
        assert_eq!(s, StatusCode::OK);
        let (_, _, b) = send(&app, req("GET", "/files/documents/x.txt", &[], b"")).await;
        assert_eq!(b, b"hi2");
        let (s, _, _) = send(&app, req("DELETE", "/files/documents/x.txt", &[], b"")).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let (s, _, _) = send(&app, req("DELETE", "/files/documents/x.txt", &[], b"")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[test]
    fn range_parser_edges() {
        assert_eq!(parse_range(None, 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-0"), 10), Range::Bytes(0, 0));
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-5"), 3), Range::Bytes(0, 2));
    }
}
