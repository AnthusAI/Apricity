//! `S3Files`: the `Files` store over an S3 bucket (an Amplify Storage bucket).
//!
//! Keys are library-relative paths, optionally under a key prefix, so the bucket holds exactly
//! the library's layout. Reads by range are real ranged GETs, `stat` is a HEAD, `list` pages
//! through ListObjectsV2. Credentials come from the standard AWS provider chain (environment,
//! shared config and SSO profiles, instance roles); nothing here reads, stores or logs them.
//!
//! The `Files` trait is synchronous, so a store owns a small tokio runtime and blocks on each
//! request. Call it from plain threads or `spawn_blocking`, never from inside an async task.

use crate::files::{Error, FileMeta, FileRef, Files, Result, check_key, sha256_file, valid_key};
use aws_sdk_s3::Client;
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::primitives::ByteStream;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// A bucket (and optional key prefix) used as a `Files` store.
pub struct S3Files {
    client: Client,
    bucket: String,
    /// Empty, or ends with `/`.
    prefix: String,
    rt: tokio::runtime::Runtime,
}

/// The object metadata field that carries a file's SHA-256, so `head` never downloads.
const SHA_META: &str = "sha256";

fn remote(e: impl std::fmt::Display) -> Error {
    Error::Remote(e.to_string())
}

fn status<E>(e: &SdkError<E>) -> Option<u16> {
    e.raw_response().map(|r| r.status().as_u16())
}

impl S3Files {
    /// Connect to `bucket` using the standard AWS credential and region provider chain;
    /// `region` overrides the configured region.
    pub fn connect(bucket: &str, prefix: Option<&str>, region: Option<&str>) -> Result<S3Files> {
        let rt = runtime()?;
        let config = rt.block_on(async {
            let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());
            if let Some(r) = region {
                loader = loader.region(aws_config::Region::new(r.to_string()));
            }
            loader.load().await
        });
        if config.region().is_none() {
            return Err(Error::Remote(
                "no AWS region: pass --region or set AWS_REGION / a profile region".into(),
            ));
        }
        S3Files::with_runtime(Client::new(&config), bucket, prefix, rt)
    }

    /// Wrap an already configured client (a custom endpoint, for instance).
    pub fn from_client(client: Client, bucket: &str, prefix: Option<&str>) -> Result<S3Files> {
        S3Files::with_runtime(client, bucket, prefix, runtime()?)
    }

    fn with_runtime(
        client: Client,
        bucket: &str,
        prefix: Option<&str>,
        rt: tokio::runtime::Runtime,
    ) -> Result<S3Files> {
        let trimmed = prefix.unwrap_or("").trim_matches('/');
        if !trimmed.is_empty() && !valid_key(trimmed) {
            return Err(Error::InvalidKey(trimmed.to_string()));
        }
        if bucket.is_empty() {
            return Err(Error::Remote("empty bucket name".into()));
        }
        let prefix = if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}/")
        };
        Ok(S3Files {
            client,
            bucket: bucket.to_string(),
            prefix,
            rt,
        })
    }

    /// `s3://bucket/prefix`, for messages and sync state.
    pub fn id(&self) -> String {
        format!("s3://{}/{}", self.bucket, self.prefix)
    }

    fn object_key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    /// A GET for `key`, optionally with a `Range` header. `None` when the key does not exist.
    fn fetch(
        &self,
        key: &str,
        range: Option<String>,
    ) -> Result<Option<aws_sdk_s3::operation::get_object::GetObjectOutput>> {
        let req = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(self.object_key(key))
            .set_range(range);
        match self.rt.block_on(req.send()) {
            Ok(out) => Ok(Some(out)),
            Err(e) if status(&e) == Some(404) => Ok(None),
            Err(e) => Err(remote(aws_sdk_s3::error::DisplayErrorContext(&e))),
        }
    }

    fn head_raw(
        &self,
        key: &str,
    ) -> Result<Option<aws_sdk_s3::operation::head_object::HeadObjectOutput>> {
        let req = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(self.object_key(key));
        match self.rt.block_on(req.send()) {
            Ok(out) => Ok(Some(out)),
            Err(e) if status(&e) == Some(404) => Ok(None),
            Err(e) => Err(remote(aws_sdk_s3::error::DisplayErrorContext(&e))),
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(Error::Io)
}

impl Files for S3Files {
    fn put(&mut self, key: &str, src_path: &Path, content_type: Option<&str>) -> Result<FileRef> {
        check_key(key)?;
        let (sha256, size) = sha256_file(src_path)?;
        let out = self.rt.block_on(async {
            let body = ByteStream::from_path(src_path).await.map_err(remote)?;
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(self.object_key(key))
                .body(body)
                .content_length(size as i64)
                .set_content_type(content_type.map(String::from))
                .metadata(SHA_META, &sha256)
                .send()
                .await
                .map_err(|e| remote(aws_sdk_s3::error::DisplayErrorContext(&e)))
        });
        out?;
        Ok(FileRef {
            key: key.to_string(),
            sha256,
            size,
            content_type: content_type.map(String::from),
        })
    }

    fn get(&self, key: &str, dst_path: &Path) -> Result<()> {
        check_key(key)?;
        let Some(mut out) = self.fetch(key, None)? else {
            return Err(Error::NotFound(key.to_string()));
        };
        self.rt.block_on(async {
            let mut file = tokio::fs::File::create(dst_path).await?;
            while let Some(chunk) = out.body.try_next().await.map_err(remote)? {
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            Ok(())
        })
    }

    fn read_range(&self, key: &str, start: u64, len: u64) -> Result<Vec<u8>> {
        check_key(key)?;
        if len == 0 {
            return match self.head_raw(key)? {
                Some(_) => Ok(Vec::new()),
                None => Err(Error::NotFound(key.to_string())),
            };
        }
        let range = format!("bytes={start}-{}", start.saturating_add(len - 1));
        let req = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(self.object_key(key))
            .range(range);
        match self.rt.block_on(async {
            let out = req.send().await?;
            Ok::<_, SdkError<_>>(out.body.collect().await)
        }) {
            Ok(body) => Ok(body.map_err(remote)?.into_bytes().to_vec()),
            Err(e) if status(&e) == Some(404) => Err(Error::NotFound(key.to_string())),
            // The range starts at or past the end of the object: no bytes.
            Err(e) if status(&e) == Some(416) => Ok(Vec::new()),
            Err(e) => Err(remote(aws_sdk_s3::error::DisplayErrorContext(&e))),
        }
    }

    fn stat(&self, key: &str) -> Result<Option<FileMeta>> {
        check_key(key)?;
        Ok(self.head_raw(key)?.map(|h| FileMeta {
            key: key.to_string(),
            size: h.content_length().unwrap_or(0).max(0) as u64,
            version: h.e_tag().map(String::from),
        }))
    }

    fn list(&self, prefix: &str) -> Result<Vec<FileMeta>> {
        let full = format!("{}{prefix}", self.prefix);
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&full)
                .set_continuation_token(token.take());
            let page = self
                .rt
                .block_on(req.send())
                .map_err(|e| remote(aws_sdk_s3::error::DisplayErrorContext(&e)))?;
            for obj in page.contents() {
                let Some(full_key) = obj.key() else { continue };
                let Some(key) = full_key.strip_prefix(&self.prefix) else {
                    continue;
                };
                if key.is_empty() || key.ends_with('/') {
                    continue; // a folder marker, not a file
                }
                out.push(FileMeta {
                    key: key.to_string(),
                    size: obj.size().unwrap_or(0).max(0) as u64,
                    version: obj.e_tag().map(String::from),
                });
            }
            match (
                page.is_truncated().unwrap_or(false),
                page.next_continuation_token(),
            ) {
                (true, Some(next)) => token = Some(next.to_string()),
                _ => break,
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    fn head(&self, key: &str) -> Result<Option<FileRef>> {
        check_key(key)?;
        let Some(h) = self.head_raw(key)? else {
            return Ok(None);
        };
        let size = h.content_length().unwrap_or(0).max(0) as u64;
        let content_type = h.content_type().map(String::from);
        if let Some(sha256) = h.metadata().and_then(|m| m.get(SHA_META)) {
            return Ok(Some(FileRef {
                key: key.to_string(),
                sha256: sha256.clone(),
                size,
                content_type,
            }));
        }
        // Uploaded by something other than this store (no recorded hash): hash the content.
        let Some(mut out) = self.fetch(key, None)? else {
            return Ok(None);
        };
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        self.rt.block_on(async {
            while let Some(chunk) = out.body.try_next().await.map_err(remote)? {
                hasher.update(&chunk);
                total += chunk.len() as u64;
            }
            Ok::<_, Error>(())
        })?;
        Ok(Some(FileRef {
            key: key.to_string(),
            sha256: format!("{:x}", hasher.finalize()),
            size: total,
            content_type,
        }))
    }

    fn delete(&self, key: &str) -> Result<()> {
        check_key(key)?;
        let req = self
            .client
            .delete_object()
            .bucket(&self.bucket)
            .key(self.object_key(key));
        match self.rt.block_on(req.send()) {
            Ok(_) => Ok(()),
            Err(e) if status(&e) == Some(404) => Ok(()),
            Err(e) => Err(remote(aws_sdk_s3::error::DisplayErrorContext(&e))),
        }
    }

    fn path(&self, _key: &str) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FsFiles;
    use crate::sync::{self, Direction, Options, State, StepKind};
    use axum::body::Bytes;
    use axum::extract::State as AxState;
    use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
    use axum::response::{IntoResponse, Response};
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    const BUCKET: &str = "bkt";
    /// The fake never returns more than this many keys per list page, so paging is exercised.
    const PAGE: usize = 2;

    struct Obj {
        body: Vec<u8>,
        meta: BTreeMap<String, String>,
        ctype: String,
    }

    #[derive(Clone, Debug)]
    struct Logged {
        method: String,
        path: String,
        query: String,
        headers: HeaderMap,
    }

    #[derive(Default)]
    struct Fake {
        objects: Mutex<BTreeMap<String, Obj>>,
        log: Mutex<Vec<Logged>>,
    }

    fn decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%'
                && i + 2 < b.len()
                && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
        String::from_utf8(out).unwrap()
    }

    fn xml_error(status: StatusCode, code: &str) -> Response {
        (status, [("content-type", "application/xml")], format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>{code}</Message><RequestId>r</RequestId></Error>")).into_response()
    }

    fn etag(body: &[u8]) -> String {
        format!("\"{}\"", &format!("{:x}", Sha256::digest(body))[..32])
    }

    async fn handle(
        AxState(fake): AxState<Arc<Fake>>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let path = uri.path().to_string();
        let query = uri.query().unwrap_or("").to_string();
        fake.log.lock().unwrap().push(Logged {
            method: method.to_string(),
            path: path.clone(),
            query: query.clone(),
            headers: headers.clone(),
        });
        let trimmed = path.trim_start_matches('/');
        let (bucket, key) = trimmed.split_once('/').unwrap_or((trimmed, ""));
        if bucket != BUCKET {
            return xml_error(StatusCode::NOT_FOUND, "NoSuchBucket");
        }
        let key = decode(key);
        let params: BTreeMap<String, String> = query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (decode(k), decode(v))
            })
            .collect();
        let mut objects = fake.objects.lock().unwrap();
        if key.is_empty() && method == Method::GET {
            assert_eq!(params.get("list-type").map(String::as_str), Some("2"));
            let prefix = params.get("prefix").cloned().unwrap_or_default();
            let after = params
                .get("continuation-token")
                .cloned()
                .unwrap_or_default();
            let matching: Vec<_> = objects
                .iter()
                .filter(|(k, _)| k.starts_with(&prefix) && k.as_str() > after.as_str())
                .collect();
            let page: Vec<_> = matching.iter().take(PAGE).collect();
            let truncated = matching.len() > PAGE;
            let mut xml = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{BUCKET}</Name><Prefix>{prefix}</Prefix><KeyCount>{}</KeyCount><MaxKeys>{PAGE}</MaxKeys><IsTruncated>{truncated}</IsTruncated>",
                page.len()
            );
            if truncated {
                xml += &format!(
                    "<NextContinuationToken>{}</NextContinuationToken>",
                    page.last().unwrap().0
                );
            }
            for (k, o) in &page {
                let k = k.replace('&', "&amp;").replace('<', "&lt;");
                xml += &format!(
                    "<Contents><Key>{k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>{}</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                    etag(&o.body).replace('"', "&quot;"),
                    o.body.len()
                );
            }
            xml += "</ListBucketResult>";
            return (StatusCode::OK, [("content-type", "application/xml")], xml).into_response();
        }
        match method {
            Method::PUT => {
                assert!(
                    headers
                        .get("content-encoding")
                        .is_none_or(|v| !v.to_str().unwrap().contains("aws-chunked")),
                    "fake does not decode aws-chunked bodies"
                );
                let meta = headers
                    .iter()
                    .filter_map(|(k, v)| {
                        k.as_str()
                            .strip_prefix("x-amz-meta-")
                            .map(|n| (n.to_string(), v.to_str().unwrap().to_string()))
                    })
                    .collect();
                let ctype = headers
                    .get("content-type")
                    .map(|v| v.to_str().unwrap().to_string())
                    .unwrap_or_default();
                let tag = etag(&body);
                objects.insert(
                    key,
                    Obj {
                        body: body.to_vec(),
                        meta,
                        ctype,
                    },
                );
                (StatusCode::OK, [("etag", tag)]).into_response()
            }
            Method::DELETE => {
                objects.remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            Method::GET | Method::HEAD => {
                let Some(o) = objects.get(&key) else {
                    return if method == Method::HEAD {
                        StatusCode::NOT_FOUND.into_response()
                    } else {
                        xml_error(StatusCode::NOT_FOUND, "NoSuchKey")
                    };
                };
                let size = o.body.len();
                let mut h = HeaderMap::new();
                h.insert("etag", HeaderValue::from_str(&etag(&o.body)).unwrap());
                h.insert("accept-ranges", HeaderValue::from_static("bytes"));
                h.insert(
                    "content-type",
                    HeaderValue::from_str(&o.ctype)
                        .unwrap_or(HeaderValue::from_static("binary/octet-stream")),
                );
                for (k, v) in &o.meta {
                    h.insert(
                        axum::http::HeaderName::from_bytes(format!("x-amz-meta-{k}").as_bytes())
                            .unwrap(),
                        HeaderValue::from_str(v).unwrap(),
                    );
                }
                let (status, slice) = match headers.get("range").map(|v| v.to_str().unwrap()) {
                    None => (StatusCode::OK, &o.body[..]),
                    Some(r) => {
                        let spec = r.strip_prefix("bytes=").expect("bytes range");
                        let (a, b) = spec.split_once('-').unwrap();
                        let a: usize = a.parse().unwrap();
                        let b: usize = b.parse().unwrap();
                        if a >= size {
                            return xml_error(StatusCode::RANGE_NOT_SATISFIABLE, "InvalidRange");
                        }
                        let b = b.min(size - 1);
                        h.insert(
                            "content-range",
                            HeaderValue::from_str(&format!("bytes {a}-{b}/{size}")).unwrap(),
                        );
                        (StatusCode::PARTIAL_CONTENT, &o.body[a..=b])
                    }
                };
                h.insert("content-length", HeaderValue::from(slice.len()));
                if method == Method::HEAD {
                    // HEAD reports the length the GET would have.
                    return (status, h).into_response();
                }
                (status, h, slice.to_vec()).into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    struct Server {
        fake: Arc<Fake>,
        url: String,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Server {
        fn start() -> Server {
            let fake = Arc::new(Fake::default());
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let (stop, rx) = tokio::sync::oneshot::channel::<()>();
            let app = axum::Router::new()
                .fallback(handle)
                .layer(axum::extract::DefaultBodyLimit::disable())
                .with_state(fake.clone());
            let thread = std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                        axum::serve(listener, app)
                            .with_graceful_shutdown(async {
                                let _ = rx.await;
                            })
                            .await
                            .unwrap();
                    });
            });
            Server {
                fake,
                url,
                stop: Some(stop),
                thread: Some(thread),
            }
        }

        fn store(&self, prefix: Option<&str>) -> S3Files {
            use aws_sdk_s3::config::{
                BehaviorVersion, Credentials, Region, RequestChecksumCalculation,
                ResponseChecksumValidation,
            };
            // The SDK's default trailing checksum uses aws-chunked framing, which this small fake
            // does not decode; everything else is the SDK's normal signed request.
            let cfg = aws_sdk_s3::Config::builder()
                .behavior_version(BehaviorVersion::latest())
                .region(Region::new("us-east-1"))
                .endpoint_url(&self.url)
                .force_path_style(true)
                .credentials_provider(Credentials::new(
                    "AKIDTESTONLY",
                    "not-a-real-secret",
                    None,
                    None,
                    "test",
                ))
                .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
                .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
                .build();
            S3Files::from_client(Client::from_conf(cfg), BUCKET, prefix).unwrap()
        }

        fn log(&self) -> Vec<Logged> {
            self.fake.log.lock().unwrap().clone()
        }

        fn count(&self, method: &str) -> usize {
            self.log().iter().filter(|l| l.method == method).count()
        }

        fn insert(&self, key: &str, body: &[u8], meta: &[(&str, &str)]) {
            self.fake.objects.lock().unwrap().insert(
                key.to_string(),
                Obj {
                    body: body.to_vec(),
                    meta: meta
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                    ctype: String::new(),
                },
            );
        }

        fn keys(&self) -> Vec<String> {
            self.fake.objects.lock().unwrap().keys().cloned().collect()
        }

        fn body(&self, key: &str) -> Option<Vec<u8>> {
            self.fake
                .objects
                .lock()
                .unwrap()
                .get(key)
                .map(|o| o.body.clone())
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(s) = self.stop.take() {
                let _ = s.send(());
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    const WAV: &[u8] = b"0123456789abcdefghij";

    fn src(dir: &Path, body: &[u8]) -> PathBuf {
        let p = dir.join("src.bin");
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn put_writes_the_prefixed_key_with_hash_metadata_and_signed_request() {
        let server = Server::start();
        let mut s3 = server.store(Some("/libs/main/"));
        let dir = tempfile::tempdir().unwrap();
        let r = s3
            .put(
                "audio/c 1/a b.wav",
                &src(dir.path(), WAV),
                Some("audio/wav"),
            )
            .unwrap();
        assert_eq!(server.keys(), vec!["libs/main/audio/c 1/a b.wav"]);
        assert_eq!(server.body("libs/main/audio/c 1/a b.wav").unwrap(), WAV);
        let expected = format!("{:x}", Sha256::digest(WAV));
        assert_eq!((r.size, r.sha256.as_str()), (20, expected.as_str()));
        {
            let objects = server.fake.objects.lock().unwrap();
            let o = &objects["libs/main/audio/c 1/a b.wav"];
            assert_eq!(o.meta["sha256"], expected);
            assert_eq!(o.ctype, "audio/wav");
        }
        let put = server
            .log()
            .into_iter()
            .find(|l| l.method == "PUT")
            .unwrap();
        let auth = put.headers["authorization"].to_str().unwrap();
        assert!(
            auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDTESTONLY/"),
            "{auth}"
        );
        assert!(!auth.contains("not-a-real-secret"));
        assert_eq!(put.headers["content-length"], "20");
        assert_eq!(s3.id(), "s3://bkt/libs/main/");
    }

    #[test]
    fn ranged_reads_are_real_range_requests() {
        let server = Server::start();
        let mut s3 = server.store(None);
        let dir = tempfile::tempdir().unwrap();
        s3.put("audio/c1/a.wav", &src(dir.path(), WAV), None)
            .unwrap();
        assert_eq!(s3.read_range("audio/c1/a.wav", 2, 4).unwrap(), b"2345");
        assert_eq!(s3.read_range("audio/c1/a.wav", 15, 10).unwrap(), b"fghij");
        assert!(s3.read_range("audio/c1/a.wav", 20, 5).unwrap().is_empty());
        assert!(s3.read_range("audio/c1/a.wav", 3, 0).unwrap().is_empty());
        let ranges: Vec<String> = server
            .log()
            .iter()
            .filter(|l| l.method == "GET")
            .map(|l| l.headers["range"].to_str().unwrap().to_string())
            .collect();
        assert_eq!(ranges, vec!["bytes=2-5", "bytes=15-24", "bytes=20-24"]);
        assert!(
            server
                .log()
                .iter()
                .all(|l| l.method != "GET" || l.headers.contains_key("range")),
            "no whole-object GET was made"
        );
        assert!(matches!(s3.read_range("nope", 0, 1), Err(Error::NotFound(k)) if k == "nope"));
        assert!(matches!(
            s3.read_range("nope", 0, 0),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn stat_and_head_use_head_requests_and_missing_is_none() {
        let server = Server::start();
        let mut s3 = server.store(Some("p"));
        let dir = tempfile::tempdir().unwrap();
        s3.put("x/y.json", &src(dir.path(), b"{}"), None).unwrap();
        let before = server.count("GET");
        let m = s3.stat("x/y.json").unwrap().unwrap();
        assert_eq!((m.key.as_str(), m.size), ("x/y.json", 2));
        assert!(m.version.unwrap().starts_with('"'));
        let h = s3.head("x/y.json").unwrap().unwrap();
        assert_eq!(h.sha256, format!("{:x}", Sha256::digest(b"{}")));
        assert_eq!(
            server.count("GET"),
            before,
            "hash came from object metadata, no download"
        );
        assert!(s3.stat("x/none").unwrap().is_none());
        assert!(s3.head("x/none").unwrap().is_none());
        assert!(
            server
                .log()
                .iter()
                .any(|l| l.method == "HEAD" && l.path == "/bkt/p/x/y.json")
        );
    }

    #[test]
    fn head_hashes_the_content_when_no_hash_was_recorded() {
        let server = Server::start();
        server.insert("audio/x.wav", WAV, &[]);
        let s3 = server.store(None);
        let h = s3.head("audio/x.wav").unwrap().unwrap();
        assert_eq!(
            (h.size, h.sha256),
            (20, format!("{:x}", Sha256::digest(WAV)))
        );
    }

    #[test]
    fn list_pages_strips_the_prefix_and_ignores_other_prefixes_and_folder_markers() {
        let server = Server::start();
        for k in [
            "lib/tables/A/1.json",
            "lib/tables/A/2.json",
            "lib/tables/B/1.json",
            "lib/files/audio/a.wav",
            "lib/files/",
            "other/tables/A/9.json",
        ] {
            server.insert(k, b"12", &[]);
        }
        let s3 = server.store(Some("lib"));
        let all = s3.list("").unwrap();
        assert_eq!(
            all.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(),
            vec![
                "files/audio/a.wav",
                "tables/A/1.json",
                "tables/A/2.json",
                "tables/B/1.json"
            ]
        );
        assert!(all.iter().all(|m| m.size == 2 && m.version.is_some()));
        let lists = server
            .log()
            .iter()
            .filter(|l| l.method == "GET" && l.query.contains("list-type=2"))
            .count();
        assert!(
            lists >= 3,
            "5 keys at {PAGE} per page need several requests, saw {lists}"
        );
        let some = s3.list("tables/A/").unwrap();
        assert_eq!(some.len(), 2);
        assert!(
            server
                .log()
                .iter()
                .any(|l| l.query.contains("prefix=lib%2Ftables%2FA%2F")
                    || l.query.contains("prefix=lib/tables/A/"))
        );
    }

    #[test]
    fn get_downloads_to_a_file_and_delete_removes() {
        let server = Server::start();
        let mut s3 = server.store(None);
        let dir = tempfile::tempdir().unwrap();
        s3.put("a/b.bin", &src(dir.path(), WAV), None).unwrap();
        let dst = dir.path().join("out.bin");
        s3.get("a/b.bin", &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), WAV);
        let missing = dir.path().join("never");
        assert!(matches!(
            s3.get("a/none", &missing),
            Err(Error::NotFound(_))
        ));
        assert!(!missing.exists());
        s3.delete("a/b.bin").unwrap();
        assert!(server.keys().is_empty());
        s3.delete("a/b.bin").unwrap();
        assert_eq!(server.count("DELETE"), 2);
    }

    #[test]
    fn bad_keys_never_reach_the_network_and_a_wrong_bucket_is_an_error() {
        let server = Server::start();
        let mut s3 = server.store(None);
        let dir = tempfile::tempdir().unwrap();
        for k in ["../x", "/abs", "a//b", "a\\b"] {
            assert!(matches!(
                s3.put(k, &src(dir.path(), b"x"), None),
                Err(Error::InvalidKey(_))
            ));
            assert!(matches!(s3.stat(k), Err(Error::InvalidKey(_))));
            assert!(matches!(s3.read_range(k, 0, 1), Err(Error::InvalidKey(_))));
            assert!(matches!(
                s3.get(k, &dir.path().join("o")),
                Err(Error::InvalidKey(_))
            ));
        }
        assert!(server.log().is_empty());
        assert!(S3Files::from_client(s3.client.clone(), BUCKET, Some("a/../b")).is_err());
        assert!(S3Files::from_client(s3.client.clone(), "", None).is_err());
        let wrong = S3Files::from_client(s3.client.clone(), "nobucket", None).unwrap();
        assert!(matches!(wrong.list(""), Err(Error::Remote(m)) if m.contains("NoSuchBucket")));
    }

    fn write(root: &Path, key: &str, body: &[u8]) {
        let p = root.join(key);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn sync_through_s3_pushes_differences_pulls_into_a_fresh_library_and_reports_conflicts() {
        let server = Server::start();
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        write(&a, "tables/Sample/c1.json", b"{\"id\":\"c1\"}");
        write(&a, "files/audio/c1/a.wav", &[9u8; 3000]);
        write(&a, "files/analysis/c1/h.json", b"{}");
        write(&a, ".virtuus/lock", b"x");
        write(&a, "apricity-library.json", b"{\"api_key\":\"k\"}");
        let mut state = State::default();
        let id = "s3://bkt/hub/";
        let opts = |d, prefer| Options {
            direction: d,
            delete: false,
            prefer,
        };

        let mut local = FsFiles::new(&a);
        let mut remote = server.store(Some("hub"));
        let r = sync::run(
            &mut local,
            &mut remote,
            &a.join(".sync-tmp"),
            &mut state,
            id,
            &opts(Direction::Push, None),
            false,
        )
        .unwrap();
        assert_eq!(r.pushed, 3);
        assert_eq!(
            server.keys(),
            vec![
                "hub/files/analysis/c1/h.json",
                "hub/files/audio/c1/a.wav",
                "hub/tables/Sample/c1.json"
            ]
        );
        assert_eq!(
            server.body("hub/files/audio/c1/a.wav").unwrap(),
            vec![9u8; 3000]
        );

        let puts = server.count("PUT");
        let r = sync::run(
            &mut local,
            &mut remote,
            &a.join(".sync-tmp"),
            &mut state,
            id,
            &opts(Direction::Push, None),
            false,
        )
        .unwrap();
        assert_eq!(r.pushed, 0);
        assert_eq!(
            server.count("PUT"),
            puts,
            "nothing changed, nothing uploaded"
        );

        write(&a, "tables/Sample/c1.json", b"{\"id\":\"c1\",\"t\":1}");
        let heads = server.count("HEAD");
        let r = sync::run(
            &mut local,
            &mut remote,
            &a.join(".sync-tmp"),
            &mut state,
            id,
            &opts(Direction::Push, None),
            false,
        )
        .unwrap();
        assert_eq!(r.pushed, 1);
        assert_eq!(server.count("PUT"), puts + 1);
        assert_eq!(
            server.count("HEAD") - heads,
            1,
            "one HEAD to record the uploaded object; unchanged objects are not HEADed again"
        );

        // A second library pulls everything, byte for byte.
        let b = dir.path().join("b");
        std::fs::create_dir_all(&b).unwrap();
        let mut state_b = State::default();
        let mut local_b = FsFiles::new(&b);
        let r = sync::run(
            &mut local_b,
            &mut remote,
            &b.join(".sync-tmp"),
            &mut state_b,
            id,
            &opts(Direction::Pull, None),
            false,
        )
        .unwrap();
        assert_eq!(r.pulled, 3);
        for k in [
            "tables/Sample/c1.json",
            "files/audio/c1/a.wav",
            "files/analysis/c1/h.json",
        ] {
            assert_eq!(
                std::fs::read(b.join(k)).unwrap(),
                std::fs::read(a.join(k)).unwrap(),
                "{k}"
            );
        }
        assert!(!b.join("apricity-library.json").exists() && !b.join(".virtuus").exists());

        // Both change the same file: reported, neither side touched.
        write(&a, "tables/Sample/c1.json", b"from a");
        write(&b, "tables/Sample/c1.json", b"from b");
        sync::run(
            &mut local,
            &mut remote,
            &a.join(".sync-tmp"),
            &mut state,
            id,
            &opts(Direction::Push, None),
            false,
        )
        .unwrap();
        let r = sync::run(
            &mut local_b,
            &mut remote,
            &b.join(".sync-tmp"),
            &mut state_b,
            id,
            &opts(Direction::Pull, None),
            false,
        )
        .unwrap();
        assert_eq!(r.plan.conflicts.len(), 1);
        assert_eq!(
            std::fs::read(b.join("tables/Sample/c1.json")).unwrap(),
            b"from b"
        );
        assert_eq!(server.body("hub/tables/Sample/c1.json").unwrap(), b"from a");
        let r = sync::run(
            &mut local_b,
            &mut remote,
            &b.join(".sync-tmp"),
            &mut state_b,
            id,
            &opts(Direction::Pull, Some(sync::Prefer::Remote)),
            false,
        )
        .unwrap();
        assert_eq!(r.pulled, 1);
        assert_eq!(
            std::fs::read(b.join("tables/Sample/c1.json")).unwrap(),
            b"from a"
        );
        assert!(r.plan.steps.iter().all(|s| s.kind == StepKind::Pull));
    }
}
