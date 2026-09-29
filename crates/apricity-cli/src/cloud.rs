//! Cognito-authenticated access to the hosted Apricity data API.
//!
//! This module deliberately does not reuse `sync`: sync is an operator's S3
//! tool backed by AWS credentials, whereas these requests must carry the
//! signed-in person's Cognito token so AppSync can apply owner/group rules.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::seq::SliceRandom;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const SERVICE: &str = "apricity";
const ACCOUNT: &str = "cognito-refresh-token";
const DEFAULT_OUTPUTS_URL: &str = "https://apricity.anth.us/amplify_outputs.json";
const DEFAULT_CALLBACK: &str = "http://127.0.0.1:5181/";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub struct Config {
    pub domain: String,
    pub client_id: String,
    pub graphql_url: String,
    pub identity_pool_id: Option<String>,
    pub user_pool_id: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub callback: String,
}

#[derive(Debug, Clone)]
struct Tokens {
    id_token: String,
    expires_at: u64,
}

pub enum Command {
    Login,
    Logout,
    Whoami,
    Score(ScoreCommand),
    Import { from: Option<PathBuf>, path: Option<String> },
    Lab(LabCommand),
    Cycle(CycleCommand),
}

pub enum LabCommand {
    Start { scene_score_id: String, title: String, brief: Option<String>, json: bool },
    List { json: bool },
    Get { id: String, json: bool },
}

pub enum CycleCommand {
    Publish {
        score: PathBuf,
        incumbent_score_id: String,
        incumbent_audio: PathBuf,
        candidates: Vec<(PathBuf, PathBuf)>,
        question: Option<String>,
        title: Option<String>,
        lab: Option<String>,
        json: bool,
    },
    List { json: bool },
    Pull { cycle_id: String, close: bool, json: bool },
    Attach { cycle_id: String, lab: String, json: bool },
}

pub enum ScoreCommand {
    Create {
        file: PathBuf,
        title: Option<String>,
        folder: Option<String>,
        kind: Option<String>,
        tags: Vec<String>,
    },
    Get {
        id: String,
        out: Option<PathBuf>,
    },
    List,
    Update {
        id: String,
        file: PathBuf,
        title: Option<String>,
        folder: Option<String>,
        kind: Option<String>,
        tags: Vec<String>,
    },
    Delete {
        id: String,
        yes: bool,
    },
}

pub fn run(command: Command) -> Result<(), String> {
    let config = Config::load()?;
    match command {
        Command::Login => login(&config),
        Command::Logout => logout(&config),
        Command::Whoami => whoami(&config),
        Command::Score(command) => score(&config, command),
        Command::Import { from, path } => import_library(&config, from.as_deref(), path.as_deref()),
        Command::Lab(command) => lab(&config, command),
        Command::Cycle(command) => cycle(&config, command),
    }
}

impl Config {
    fn load() -> Result<Self, String> {
        let raw = if let Ok(path) = std::env::var("APRICITY_AMPLIFY_OUTPUTS") {
            std::fs::read_to_string(path)
                .map_err(|e| format!("could not read APRICITY_AMPLIFY_OUTPUTS: {e}"))?
        } else if let Ok(url) = std::env::var("APRICITY_AMPLIFY_OUTPUTS_URL") {
            get_text(&url)?
        } else if let Some(path) = ["web/amplify_outputs.json", "amplify_outputs.json"]
            .iter()
            .map(Path::new)
            .find(|p| p.exists())
        {
            std::fs::read_to_string(path)
                .map_err(|e| format!("could not read {}: {e}", path.display()))?
        } else {
            get_text(DEFAULT_OUTPUTS_URL)?
        };
        let v: Value =
            serde_json::from_str(&raw).map_err(|e| format!("invalid Amplify outputs: {e}"))?;
        let auth = &v["auth"];
        let oauth = &auth["oauth"];
        let domain = std::env::var("APRICITY_COGNITO_DOMAIN")
            .ok()
            .or_else(|| oauth["domain"].as_str().map(str::to_owned))
            .ok_or("Amplify outputs has no auth.oauth.domain")?;
        let client_id = std::env::var("APRICITY_COGNITO_CLIENT_ID")
            .ok()
            .or_else(|| auth["user_pool_client_id"].as_str().map(str::to_owned))
            .ok_or("Amplify outputs has no auth.user_pool_client_id")?;
        let graphql_url = std::env::var("APRICITY_GRAPHQL_URL")
            .ok()
            .or_else(|| v["data"]["url"].as_str().map(str::to_owned))
            .or_else(|| {
                v["data"]["aws_appsync_graphqlEndpoint"]
                    .as_str()
                    .map(str::to_owned)
            })
            .ok_or("Amplify outputs has no data GraphQL URL")?;
        Ok(Self {
            domain: domain.trim_end_matches('/').to_string(),
            client_id,
            graphql_url,
            identity_pool_id: auth["identity_pool_id"].as_str().map(str::to_owned),
            user_pool_id: auth["user_pool_id"].as_str().map(str::to_owned),
            region: auth["aws_region"].as_str().map(str::to_owned),
            bucket: v["storage"]["bucket_name"].as_str().map(str::to_owned),
            callback: std::env::var("APRICITY_COGNITO_REDIRECT_URI")
                .unwrap_or_else(|_| DEFAULT_CALLBACK.to_string()),
        })
    }
}

fn keyring() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {e}"))
}
fn get_text(url: &str) -> Result<String, String> {
    http()?
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not fetch {url}: {e}"))?
        .text()
        .map_err(|e| format!("could not read {url}: {e}"))
}

fn http() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("could not initialize HTTP client: {e}"))
}
fn domain_url(domain: &str) -> String {
    if domain.starts_with("https://") {
        domain.to_string()
    } else {
        format!("https://{domain}")
    }
}
fn random_urlsafe(bytes: usize) -> String {
    let mut out = vec![0; bytes];
    rand::TryRngCore::try_fill_bytes(&mut rand::rngs::OsRng, &mut out)
        .expect("OS randomness unavailable");
    URL_SAFE_NO_PAD.encode(out)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn login(config: &Config) -> Result<(), String> {
    if config.callback != DEFAULT_CALLBACK {
        return Err(format!(
            "APRICITY_COGNITO_REDIRECT_URI must be {DEFAULT_CALLBACK}"
        ));
    }
    let callback =
        Url::parse(&config.callback).map_err(|e| format!("invalid callback URL: {e}"))?;
    let listener = TcpListener::bind(("127.0.0.1", callback.port().unwrap_or(5181)))
        .map_err(|e| format!("login callback port 5181 is unavailable: {e}"))?;
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let state = random_urlsafe(32);
    let verifier = random_urlsafe(64);
    let mut url = Url::parse(&format!("{}/oauth2/authorize", domain_url(&config.domain)))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.callback)
        .append_pair("scope", "openid email profile")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    if webbrowser::open(url.as_str()).is_err() {
        eprintln!("Open this URL to continue login:\n{url}");
    }
    let (mut stream, _) = listener
        .accept()
        .map_err(|e| format!("could not receive login callback: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(300)))
        .map_err(|e| e.to_string())?;
    let request = read_http_head(&mut stream)?;
    let target = request
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or("malformed login callback")?;
    let returned =
        Url::parse(&format!("http://localhost{target}")).map_err(|_| "malformed login callback")?;
    if returned.path() != "/" {
        return Err("login callback used an unexpected path".into());
    }
    let pairs: std::collections::HashMap<_, _> = returned.query_pairs().into_owned().collect();
    if pairs.get("state").is_none_or(|s| s != &state) {
        return Err("login callback state did not match".into());
    }
    if let Some(error) = pairs.get("error") {
        return Err(format!("Cognito authorization failed: {error}"));
    }
    let code = pairs
        .get("code")
        .ok_or("login callback did not include an authorization code")?;
    let token = http()?
        .post(format!("{}/oauth2/token", domain_url(&config.domain)))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", config.client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", config.callback.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not exchange login code: {e}"))?
        .json::<Value>()
        .map_err(|e| e.to_string())?;
    let refresh = token["refresh_token"]
        .as_str()
        .ok_or("Cognito did not issue a refresh token")?;
    keyring()?
        .set_password(refresh)
        .map_err(|e| format!("could not save refresh token in keychain: {e}"))?;
    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nApricity login complete. You can close this page.");
    println!(
        "Signed in as {}.",
        identity(&token).unwrap_or_else(|| "authenticated user".into())
    );
    Ok(())
}

/// Read just an HTTP request's headers. Browsers keep the connection open while
/// waiting for our response, so waiting for EOF here would deadlock the login.
fn read_http_head(stream: &mut impl Read) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = stream
            .read(&mut chunk)
            .map_err(|e| format!("could not read login callback: {e}"))?;
        if read == 0 {
            return Err("login callback ended before HTTP headers".into());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > 16 * 1024 {
            return Err("login callback headers are too large".into());
        }
    }
    String::from_utf8(bytes).map_err(|_| "login callback was not valid HTTP text".into())
}

fn refresh(config: &Config) -> Result<Tokens, String> {
    let token = keyring()?.get_password().map_err(|_| {
        "No Apricity application session is available. Run `apricity login`.".to_string()
    })?;
    let response = http()?
        .post(format!("{}/oauth2/token", domain_url(&config.domain)))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", config.client_id.as_str()),
            ("refresh_token", token.as_str()),
        ])
        .send()
        .map_err(|e| format!("could not refresh session: {e}"))?;
    if !response.status().is_success() {
        let _ = keyring()?.delete_credential();
        return Err("Apricity session expired or was revoked. Run `apricity login`.".into());
    }
    let v: Value = response
        .json()
        .map_err(|e| format!("invalid token response: {e}"))?;
    let id_token = v["id_token"]
        .as_str()
        .ok_or("Cognito refresh did not return an ID token")?
        .to_string();
    Ok(Tokens {
        id_token,
        expires_at: now() + v["expires_in"].as_u64().unwrap_or(3600),
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn identity(v: &Value) -> Option<String> {
    let token = v["id_token"]
        .as_str()
        .or_else(|| v["access_token"].as_str())?;
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    ["email", "cognito:username", "username", "sub"]
        .iter()
        .find_map(|k| claims[*k].as_str().map(str::to_owned))
}
fn whoami(config: &Config) -> Result<(), String> {
    let token = refresh(config)?;
    println!(
        "{}",
        jwt_identity(&token.id_token).unwrap_or_else(|| "authenticated user".into())
    );
    Ok(())
}
fn jwt_identity(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    ["email", "cognito:username", "username", "sub"]
        .iter()
        .find_map(|k| claims[*k].as_str().map(str::to_owned))
}
fn logout(config: &Config) -> Result<(), String> {
    if let Ok(refresh) = keyring()?.get_password() {
        let _ = http()?
            .post(format!("{}/oauth2/revoke", domain_url(&config.domain)))
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("token", refresh.as_str()),
            ])
            .send();
    }
    let _ = keyring()?.delete_credential();
    println!("Signed out.");
    Ok(())
}

struct Api {
    config: Config,
    token: Tokens,
    http: Client,
}
impl Api {
    fn new(config: &Config) -> Result<Self, String> {
        Ok(Self {
            config: config.clone(),
            token: refresh(config)?,
            http: http()?,
        })
    }
    /// A fresh ID token, refreshing first if the cached one is about to expire. Used both by `gql`
    /// and by anything (like the identity-pool credentials exchange for S3) that needs the token
    /// directly rather than through a GraphQL call.
    fn id_token(&mut self) -> Result<String, String> {
        if self.token.expires_at <= now() + 60 {
            self.token = refresh(&self.config)?;
        }
        Ok(self.token.id_token.clone())
    }
    fn gql(&mut self, query: &str, variables: Value) -> Result<Value, String> {
        let id_token = self.id_token()?;
        let v: Value = self
            .http
            .post(&self.config.graphql_url)
            .bearer_auth(&id_token)
            .json(&json!({"query": query, "variables": variables}))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("AppSync request failed: {e}"))?
            .json()
            .map_err(|e| format!("invalid AppSync response: {e}"))?;
        if let Some(errors) = v["errors"].as_array() {
            return Err(errors
                .iter()
                .filter_map(|e| e["message"].as_str())
                .collect::<Vec<_>>()
                .join("; "));
        }
        Ok(v["data"].clone())
    }
}

fn score(config: &Config, command: ScoreCommand) -> Result<(), String> {
    let mut api = Api::new(config)?;
    match command {
        ScoreCommand::Create {
            file,
            title,
            folder,
            kind,
            tags,
        } => {
            let (input, refs) = score_input(&file, title, folder, kind, tags)?;
            let resolved = resolve_refs(&mut api, refs)?;
            let data = api.gql("mutation Create($input: CreateScoreInput!) { createScore(input: $input) { id title } }", json!({"input": input}))?;
            let id = data["createScore"]["id"]
                .as_str()
                .ok_or("AppSync did not return a score id")?
                .to_string();
            reconcile_refs(&mut api, &id, resolved)?;
            println!("{id}");
        }
        ScoreCommand::Get { id, out } => {
            let data = api.gql(
                "query Get($id: ID!) { getScore(id: $id) { id text } }",
                json!({"id": id}),
            )?;
            let text = data["getScore"]["text"].as_str().ok_or("score not found")?;
            if let Some(out) = out {
                std::fs::write(&out, text).map_err(|e| format!("{}: {e}", out.display()))?;
            } else {
                print!("{text}");
            }
        }
        ScoreCommand::List => {
            let data = api.gql(
                "query List { listScores(limit: 1000) { items { id title folder format owner } } }",
                json!({}),
            )?;
            for s in data["listScores"]["items"].as_array().into_iter().flatten() {
                println!(
                    "{}\t{}/{}.{}",
                    s["id"].as_str().unwrap_or(""),
                    s["folder"].as_str().unwrap_or(""),
                    s["title"].as_str().unwrap_or(""),
                    s["format"].as_str().unwrap_or("apr")
                );
            }
        }
        ScoreCommand::Update {
            id,
            file,
            title,
            folder,
            kind,
            tags,
        } => {
            let (mut input, refs) = score_input(&file, title, folder, kind, tags)?;
            let resolved = resolve_refs(&mut api, refs)?;
            input["id"] = json!(id);
            api.gql(
                "mutation Update($input: UpdateScoreInput!) { updateScore(input: $input) { id } }",
                json!({"input": input}),
            )?;
            let id = input["id"].as_str().unwrap();
            reconcile_refs(&mut api, id, resolved)?;
            println!("{id}");
        }
        ScoreCommand::Delete { id, yes } => {
            if !yes {
                return Err("refusing to delete without --yes".into());
            }
            delete_refs(&mut api, &id)?;
            api.gql(
                "mutation Delete($input: DeleteScoreInput!) { deleteScore(input: $input) { id } }",
                json!({"input": {"id": id}}),
            )?;
            println!("deleted {id}");
        }
    };
    Ok(())
}

fn score_input(
    file: &Path,
    title: Option<String>,
    folder: Option<String>,
    kind: Option<String>,
    tags: Vec<String>,
) -> Result<(Value, Vec<apricity_data::CatalogRef>), String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    apricity_score::parse_score(&text, file).map_err(|e| e.join("; "))?;
    let relative = file
        .strip_prefix(std::env::current_dir().unwrap_or_default())
        .ok();
    let file_title = file
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or("score file needs a UTF-8 stem")?
        .to_string();
    let folder = folder.unwrap_or_else(|| {
        relative
            .and_then(|p| p.parent())
            .and_then(|p| p.to_str())
            .filter(|s| !s.is_empty() && *s != ".")
            .unwrap_or("scores")
            .replace('\\', "/")
    });
    let title = title.unwrap_or(file_title);
    let format = file.extension().and_then(|e| e.to_str()).unwrap_or("apr");
    if !matches!(format, "apr" | "yaml") {
        return Err("score file must end in .apr or .yaml".into());
    }
    let refs = apricity_data::catalog_refs(&text, &folder, &format!("{title}.{format}"))
        .map_err(|errors| errors.join("; "))?;
    let id = format!("scr_{}_{}_{}", folder.replace('/', "_"), title, format);
    let mut input =
        json!({"id": id, "title": title, "folder": folder, "format": format, "text": text});
    if let Some(kind) = kind {
        input["kind"] = json!(kind);
    }
    if !tags.is_empty() {
        input["tags"] = json!(tags);
    }
    Ok((input, refs))
}

/// Resolve every declared score asset before changing the Score record.  A named
/// clip is not optional: a missing Clip would let the record save but leaves the
/// browser unable to compile it.
fn resolve_refs(api: &mut Api, refs: Vec<apricity_data::CatalogRef>) -> Result<Vec<Value>, String> {
    let mut resolved = Vec::with_capacity(refs.len());
    for r in refs {
        let mut sample_id = r.sample_id.clone();
        if sample_id.is_none() {
            if let Some(path) = &r.catalog_path {
                let found = api.gql("query Sample($path: String!) { samplesByPath(path: $path, limit: 1) { items { id } } }", json!({"path": path}))?;
                sample_id = found["samplesByPath"]["items"]
                    .as_array()
                    .and_then(|v| v.first())
                    .and_then(|v| v["id"].as_str())
                    .map(str::to_owned);
            }
        }
        let mut clip_id = r.clip_id.clone();
        let mut start = None;
        let mut end = None;
        if let Some(id) = clip_id.as_deref() {
            let found = api.gql("query Clip($id: ID!) { getClip(id: $id) { id sampleId start end } }", json!({"id": id}))?;
            let clip = &found["getClip"];
            if clip.is_null() { return Err(format!("score asset `{}`: no production clip `{id}`", r.alias)); }
            if clip["sampleId"].as_str() != Some(&sample_id.clone().unwrap_or_default()) {
                return Err(format!("score asset `{}`: production clip `{id}` belongs to another sample", r.alias));
            }
            start = clip["start"].as_f64();
            end = clip["end"].as_f64();
        } else {
            if let (Some(sample), Some(name)) = (&sample_id, &r.clip_name) {
                let found = api.gql("query Clips($id: ID!) { clipsBySample(sampleId: $id, limit: 1000) { items { id name start end } } }", json!({"id": sample}))?;
                if let Some(clip) = found["clipsBySample"]["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|v| v["name"].as_str() == Some(name))
                {
                    clip_id = clip["id"].as_str().map(str::to_owned);
                    start = clip["start"].as_f64();
                    end = clip["end"].as_f64();
                }
            }
        }
        let sample = sample_id.ok_or_else(|| {
            format!(
                "score asset `{}`: no production sample at `{}`",
                r.alias,
                r.catalog_path.as_deref().unwrap_or(&r.source)
            )
        })?;
        if r.clip_name.is_some() || r.clip_id.is_some() {
            if clip_id.is_none() {
                let clip = r.clip_name.as_deref().or(r.clip_id.as_deref()).unwrap_or_default();
                return Err(format!(
                    "score asset `{}`: no production clip `{clip}` on sample `{sample}`",
                    r.alias
                ));
            }
            if start.is_none() || end.is_none() {
                return Err(format!(
                    "score asset `{}`: production clip `{}` has no playable span",
                    r.alias,
                    r.clip_name.as_deref().or(r.clip_id.as_deref()).unwrap_or_default()
                ));
            }
        }
        resolved.push(json!({"clipAlias": r.alias, "sampleId": sample, "samplePath": r.catalog_path, "clipName": r.clip_name, "clipId": clip_id, "start": start, "end": end, "suffix": r.id_suffix}));
    }
    Ok(resolved)
}

/// Write the fully validated desired reference set, then remove obsolete rows.
/// This deliberately never clears the old set before the replacements exist.
fn reconcile_refs(api: &mut Api, score_id: &str, refs: Vec<Value>) -> Result<(), String> {
    let existing = api.gql(
        "query Refs($id: ID!) { refsByScore(scoreId: $id, limit: 1000) { items { id } } }",
        json!({"id": score_id}),
    )?;
    let existing_ids: BTreeSet<String> = existing["refsByScore"]["items"]
        .as_array().into_iter().flatten().filter_map(|v| v["id"].as_str().map(str::to_owned)).collect();
    let mut wanted = BTreeSet::new();
    for r in refs {
        let suffix = r["suffix"].as_str().ok_or("resolved score reference has no suffix")?;
        let id = format!("sref_{score_id}_{suffix}");
        wanted.insert(id.clone());
        let input = json!({"id": id, "scoreId": score_id, "clipAlias": r["clipAlias"], "sampleId": r["sampleId"], "samplePath": r["samplePath"], "clipName": r["clipName"], "clipId": r["clipId"], "start": r["start"], "end": r["end"]});
        let operation = if existing_ids.contains(&id) {
            "mutation Put($input: UpdateScoreRefInput!) { updateScoreRef(input: $input) { id } }"
        } else {
            "mutation Put($input: CreateScoreRefInput!) { createScoreRef(input: $input) { id } }"
        };
        api.gql(operation, json!({"input": input}))?;
    }
    for old in existing["refsByScore"]["items"].as_array().into_iter().flatten() {
        if let Some(id) = old["id"].as_str().filter(|id| !wanted.contains(*id)) {
            api.gql("mutation Delete($input: DeleteScoreRefInput!) { deleteScoreRef(input: $input) { id } }", json!({"input": {"id": id}}))?;
        }
    }
    Ok(())
}

fn delete_refs(api: &mut Api, score_id: &str) -> Result<(), String> {
    let existing = api.gql(
        "query Refs($id: ID!) { refsByScore(scoreId: $id, limit: 1000) { items { id } } }",
        json!({"id": score_id}),
    )?;
    for old in existing["refsByScore"]["items"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(id) = old["id"].as_str() {
            api.gql("mutation Delete($input: DeleteScoreRefInput!) { deleteScoreRef(input: $input) { id } }", json!({"input": {"id": id}}))?;
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------- labs and listening cycles
//
// A lab groups the listening cycles published while working one scene (Kanbus apricitus-e59a0b). Unlike
// `import_library`/`ScoreCommand`, publishing audio needs identity-pool credentials (not the bucket
// owner's AWS credentials `sync` uses): the signed-in person's own Cognito identity, so `owner` and the
// `files/cycles/{entity_id}/*` storage rule apply to *them*, the way the web app's own uploads work.

/// `payload` as pretty JSON when `json_flag`, else `prose(payload)`.
fn emit(json_flag: bool, payload: &Value, prose: impl FnOnce(&Value)) {
    if json_flag {
        println!("{}", serde_json::to_string_pretty(payload).unwrap_or_default());
    } else {
        prose(payload);
    }
}

/// A short random id ("lab_1a2b3c4d5e6f7890"), the same shape as the local backend's `uuid4().hex[:16]`.
fn random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 8];
    rand::TryRngCore::try_fill_bytes(&mut rand::rngs::OsRng, &mut bytes)
        .expect("OS randomness unavailable");
    format!("{prefix}_{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn content_type_for(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// The `owner` value AppSync would inject for this ID token on an `allow.owner()` field ("<sub>::<username>",
/// the same computation `web/src/data/auth.ts`'s `ownerValue()` makes client-side), needed to query
/// `labsByOwner` -- the owner is otherwise set automatically and never read back from the token elsewhere.
fn owner_value(id_token: &str) -> Result<String, String> {
    let claims = jwt_claims(id_token).ok_or("Cognito returned an invalid ID token")?;
    let sub = claims["sub"].as_str().ok_or("ID token has no sub claim")?;
    let username = claims["cognito:username"]
        .as_str()
        .or_else(|| claims["username"].as_str())
        .unwrap_or(sub);
    Ok(format!("{sub}::{username}"))
}

/// Cognito identity-pool credentials for the signed-in person (GetId, GetCredentialsForIdentity): the same
/// exchange `import_library` uses for its curator-only S3 access, but here for anyone signed in, so their own
/// uploads land under their own `files/cycles/{identityId}/...` prefix.
fn identity_credentials(config: &Config, id_token: &str) -> Result<(String, aws_credential_types::Credentials), String> {
    let region = config.region.as_deref().ok_or("Amplify outputs has no auth.aws_region")?;
    let pool = config.identity_pool_id.as_deref().ok_or("Amplify outputs has no auth.identity_pool_id")?;
    let user_pool = config.user_pool_id.as_deref().ok_or("Amplify outputs has no auth.user_pool_id")?;
    let provider = format!("cognito-idp.{region}.amazonaws.com/{user_pool}");
    let identity_endpoint = format!("https://cognito-identity.{region}.amazonaws.com/");
    let id: Value = http()?
        .post(&identity_endpoint)
        .header("X-Amz-Target", "AWSCognitoIdentityService.GetId")
        .header("Content-Type", "application/x-amz-json-1.1")
        .json(&json!({"IdentityPoolId": pool, "Logins": {provider.clone(): id_token}}))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not obtain Cognito Identity: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let identity_id = id["IdentityId"].as_str().ok_or("Cognito Identity did not return an identity ID")?.to_string();
    let credentials: Value = http()?
        .post(&identity_endpoint)
        .header("X-Amz-Target", "AWSCognitoIdentityService.GetCredentialsForIdentity")
        .header("Content-Type", "application/x-amz-json-1.1")
        .json(&json!({"IdentityId": identity_id, "Logins": {provider: id_token}}))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not obtain temporary storage credentials: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let c = &credentials["Credentials"];
    let access = c["AccessKeyId"].as_str().ok_or("Cognito Identity returned no access key")?;
    let secret = c["SecretKey"].as_str().ok_or("Cognito Identity returned no secret key")?;
    let session = c["SessionToken"].as_str().ok_or("Cognito Identity returned no session token")?;
    Ok((
        identity_id,
        aws_credential_types::Credentials::new(access, secret, Some(session.to_string()), None, "apricity-cognito"),
    ))
}

fn s3_client(config: &Config, credentials: aws_credential_types::Credentials, runtime: &tokio::runtime::Runtime) -> Result<aws_sdk_s3::Client, String> {
    let region = config.region.as_deref().ok_or("Amplify outputs has no auth.aws_region")?.to_string();
    Ok(runtime.block_on(async {
        let sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region))
            .credentials_provider(credentials)
            .load()
            .await;
        aws_sdk_s3::Client::new(&sdk_config)
    }))
}

fn lab(config: &Config, command: LabCommand) -> Result<(), String> {
    let mut api = Api::new(config)?;
    match command {
        LabCommand::Start { scene_score_id, title, brief, json: json_flag } => {
            let scene = api.gql("query Get($id: ID!) { getScore(id: $id) { id } }", json!({"id": scene_score_id}))?;
            if scene["getScore"].is_null() {
                return Err(format!("no such cloud score: {scene_score_id} (publish or import it first)"));
            }
            let id = random_id("lab");
            let input = json!({"id": id, "title": title, "brief": brief, "sceneScoreId": scene_score_id, "status": "open"});
            api.gql("mutation Create($input: CreateLabInput!) { createLab(input: $input) { id } }", json!({"input": input}))?;
            emit(json_flag, &json!({"id": id, "title": title, "brief": brief, "sceneScoreId": scene_score_id}), |v| {
                println!("{}", v["id"].as_str().unwrap_or(""));
            });
        }
        LabCommand::List { json: json_flag } => {
            let id_token = api.id_token()?;
            let owner = owner_value(&id_token)?;
            let data = api.gql(
                "query List($owner: String!) { labsByOwner(owner: $owner, sortDirection: DESC, limit: 1000) { items { id title brief sceneScoreId status createdAt } } }",
                json!({"owner": owner}),
            )?;
            let labs = data["labsByOwner"]["items"].clone();
            emit(json_flag, &json!({"labs": labs}), |v| {
                for l in v["labs"].as_array().into_iter().flatten() {
                    println!("{}\t{}\t{}", l["id"].as_str().unwrap_or(""), l["status"].as_str().unwrap_or(""), l["title"].as_str().unwrap_or(""));
                }
            });
        }
        LabCommand::Get { id, json: json_flag } => {
            let data = api.gql(
                "query Get($id: ID!) { getLab(id: $id) { id title brief sceneScoreId status createdAt } }",
                json!({"id": id}),
            )?;
            if data["getLab"].is_null() {
                return Err(format!("no such lab: {id}"));
            }
            emit(json_flag, &data["getLab"], |v| {
                println!("{}\t{}\t{}", v["id"].as_str().unwrap_or(""), v["status"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or(""));
            });
        }
    }
    Ok(())
}

fn cycle(config: &Config, command: CycleCommand) -> Result<(), String> {
    match command {
        CycleCommand::Publish { score, incumbent_score_id, incumbent_audio, candidates, question, title, lab, json: json_flag } => {
            publish_cycle(config, score, incumbent_score_id, incumbent_audio, candidates, question, title, lab, json_flag)
        }
        CycleCommand::List { json: json_flag } => {
            let mut api = Api::new(config)?;
            let data = api.gql(
                "query List($status: CycleStatus) { listListeningCycles(filter: {status: {eq: $status}}, limit: 1000) { items { id title question options { letter } status createdAt labId } } }",
                json!({"status": "open"}),
            )?;
            let cycles = data["listListeningCycles"]["items"].clone();
            emit(json_flag, &json!({"cycles": cycles}), |v| {
                for c in v["cycles"].as_array().into_iter().flatten() {
                    let n = c["options"].as_array().map(|a| a.len()).unwrap_or(0);
                    println!("{}  {}  ({n} options)", c["id"].as_str().unwrap_or(""), c["title"].as_str().unwrap_or(""));
                }
            });
            Ok(())
        }
        CycleCommand::Pull { cycle_id, close, json: json_flag } => pull_cycle(config, cycle_id, close, json_flag),
        CycleCommand::Attach { cycle_id, lab, json: json_flag } => {
            let mut api = Api::new(config)?;
            api.gql(
                "mutation Update($input: UpdateListeningCycleInput!) { updateListeningCycle(input: $input) { id labId } }",
                json!({"input": {"id": cycle_id, "labId": lab}}),
            )?;
            emit(json_flag, &json!({"cycleId": cycle_id, "labId": lab}), |_| println!("attached {cycle_id} to lab {lab}"));
            Ok(())
        }
    }
}

/// The letters (A, B, C, ... up to `n`), Fisher-Yates shuffled so the blind key isn't guessable from a
/// deterministic seed the way `apricity_analyze.cycle.publish`'s `--seed` is -- there is no `--seed` here
/// (the cloud CLI has no test-fixture need for a fixed shuffle).
fn shuffled_letters(n: usize) -> Vec<char> {
    const LETTERS: [char; 4] = ['A', 'B', 'C', 'D'];
    let mut letters: Vec<char> = LETTERS[..n].to_vec();
    letters.shuffle(&mut rand::rng());
    letters
}

struct PreparedCycleOption {
    letter: char,
    score_id: String,
    score_input: Option<Value>,
    key: String,
    audio: Vec<u8>,
    content_type: &'static str,
    sha256: String,
}

trait CyclePublishOps {
    fn create_score(&mut self, input: &Value) -> Result<(), String>;
    fn upload_audio(&mut self, key: &str, bytes: Vec<u8>, content_type: &str)
    -> Result<(), String>;
    fn create_cycle(&mut self, input: &Value) -> Result<(), String>;
    fn delete_score(&mut self, id: &str) -> Result<(), String>;
    fn delete_audio(&mut self, key: &str) -> Result<(), String>;
    fn delete_cycle(&mut self, id: &str) -> Result<(), String>;
}

fn rollback_cycle_publish(
    ops: &mut impl CyclePublishOps,
    cycle_id: &str,
    scores: &[String],
    keys: &[String],
    cycle_attempted: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    if cycle_attempted {
        if let Err(e) = ops.delete_cycle(cycle_id) {
            errors.push(format!("cycle {cycle_id}: {e}"));
        }
    }
    for key in keys.iter().rev() {
        if let Err(e) = ops.delete_audio(key) {
            errors.push(format!("audio {key}: {e}"));
        }
    }
    for id in scores.iter().rev() {
        if let Err(e) = ops.delete_score(id) {
            errors.push(format!("score {id}: {e}"));
        }
    }
    errors
}

fn publish_prepared_cycle(
    ops: &mut impl CyclePublishOps,
    cycle_id: &str,
    mut prepared: Vec<PreparedCycleOption>,
    setup_scores: Vec<(String, Value)>,
    mut cycle_input: Value,
) -> Result<Vec<Value>, String> {
    let mut created_scores = Vec::new();
    let mut attempted_keys = Vec::new();
    let mut cycle_attempted = false;
    let result = (|| {
        let mut options = Vec::with_capacity(prepared.len());
        for (id, input) in setup_scores {
            created_scores.push(id);
            ops.create_score(&input)?;
        }
        for option in prepared.drain(..) {
            if let Some(input) = &option.score_input {
                created_scores.push(option.score_id.clone());
                ops.create_score(input)?;
            }
            // Include the attempted key too: a failed response can follow a successful remote write.
            attempted_keys.push(option.key.clone());
            let size = option.audio.len();
            ops.upload_audio(&option.key, option.audio, option.content_type)?;
            options.push(json!({
                "letter": option.letter.to_string(),
                "scoreId": option.score_id,
                "audio": {
                    "key": option.key,
                    "sha256": option.sha256,
                    "size": size,
                    "contentType": option.content_type
                }
            }));
        }
        options.sort_by(|a, b| a["letter"].as_str().cmp(&b["letter"].as_str()));
        cycle_input["options"] = json!(options);
        cycle_attempted = true;
        ops.create_cycle(&cycle_input)?;
        Ok(options)
    })();
    result.map_err(|error| {
        let cleanup = rollback_cycle_publish(
            ops,
            cycle_id,
            &created_scores,
            &attempted_keys,
            cycle_attempted,
        );
        if cleanup.is_empty() {
            error
        } else {
            format!("{error}; cleanup also failed: {}", cleanup.join("; "))
        }
    })
}

struct LiveCyclePublishOps<'a> {
    api: &'a mut Api,
    s3: &'a aws_sdk_s3::Client,
    runtime: &'a tokio::runtime::Runtime,
    bucket: &'a str,
}

impl CyclePublishOps for LiveCyclePublishOps<'_> {
    fn create_score(&mut self, input: &Value) -> Result<(), String> {
        self.api.gql(
            "mutation Create($input: CreateScoreInput!) { createScore(input: $input) { id } }",
            json!({"input": input}),
        )?;
        Ok(())
    }

    fn upload_audio(
        &mut self,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), String> {
        self.runtime
            .block_on(
                self.s3
                    .put_object()
                    .bucket(self.bucket)
                    .key(format!("files/{key}"))
                    .body(bytes.into())
                    .content_type(content_type)
                    .send(),
            )
            .map(|_| ())
            .map_err(|e| {
                let detail = e
                    .as_service_error()
                    .map(|service| {
                        let meta = service.meta();
                        format!(
                            "{}: {}",
                            meta.code().unwrap_or("unknown S3 error"),
                            meta.message().unwrap_or("no service message")
                        )
                    })
                    .unwrap_or_else(|| e.to_string());
                format!("S3 upload failed for {key}: {detail}")
            })
    }

    fn create_cycle(&mut self, input: &Value) -> Result<(), String> {
        self.api.gql("mutation Create($input: CreateListeningCycleInput!) { createListeningCycle(input: $input) { id } }", json!({"input": input}))?;
        Ok(())
    }

    fn delete_score(&mut self, id: &str) -> Result<(), String> {
        self.api.gql(
            "mutation Delete($input: DeleteScoreInput!) { deleteScore(input: $input) { id } }",
            json!({"input": {"id": id}}),
        )?;
        Ok(())
    }

    fn delete_audio(&mut self, key: &str) -> Result<(), String> {
        self.runtime
            .block_on(
                self.s3
                    .delete_object()
                    .bucket(self.bucket)
                    .key(format!("files/{key}"))
                    .send(),
            )
            .map(|_| ())
            .map_err(|e| format!("S3 delete failed for {key}: {e}"))
    }

    fn delete_cycle(&mut self, id: &str) -> Result<(), String> {
        self.api.gql("mutation Delete($input: DeleteListeningCycleInput!) { deleteListeningCycle(input: $input) { id } }", json!({"input": {"id": id}}))?;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn publish_cycle(
    config: &Config,
    score: PathBuf,
    incumbent_score_id: String,
    incumbent_audio: PathBuf,
    candidates: Vec<(PathBuf, PathBuf)>,
    question: Option<String>,
    title: Option<String>,
    lab: Option<String>,
    json_flag: bool,
) -> Result<(), String> {
    if candidates.is_empty() {
        return Err("at least one --candidate APR AUDIO is required (repeatable)".into());
    }
    let n = 1 + candidates.len();
    if n > 4 {
        return Err(format!("at most 4 options (A-D); got {n}"));
    }
    let mut api = Api::new(config)?;

    // The incumbent must exist in the cloud to fork from; if it doesn't (published only locally so far),
    // create a hidden copy so the cycle still has something real to point at.
    let existing = api.gql(
        "query Get($id: ID!) { getScore(id: $id) { id forkRoot } }",
        json!({"id": incumbent_score_id}),
    )?;
    let hidden_incumbent = existing["getScore"].is_null();
    let fork_root = if hidden_incumbent {
        incumbent_score_id.clone()
    } else {
        existing["getScore"]["forkRoot"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| incumbent_score_id.clone())
    };

    let cycle_id = random_id("cyc");
    let folder = format!("cycles/{cycle_id}");
    let letters = shuffled_letters(n);

    let id_token = api.id_token()?;
    let (identity_id, credentials) = identity_credentials(config, &id_token)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let s3 = s3_client(config, credentials, &runtime)?;
    let bucket = config
        .bucket
        .as_deref()
        .ok_or("Amplify outputs has no storage.bucket_name")?;

    struct Slot {
        existing_score_id: Option<String>,
        apr: PathBuf,
        audio: PathBuf,
    }
    let mut slots = vec![Slot {
        existing_score_id: Some(incumbent_score_id.clone()),
        apr: score.clone(),
        audio: incumbent_audio,
    }];
    slots.extend(candidates.into_iter().map(|(apr, audio)| Slot {
        existing_score_id: None,
        apr,
        audio,
    }));

    // Read every local input before creating any cloud records or objects. Local file errors cannot leave
    // a half-published cycle behind.
    let mut prepared = Vec::with_capacity(slots.len());
    let mut setup_scores = Vec::new();
    if hidden_incumbent {
        let text =
            std::fs::read_to_string(&score).map_err(|e| format!("{}: {e}", score.display()))?;
        let stem = score
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("incumbent")
            .to_string();
        setup_scores.push((incumbent_score_id.clone(), json!({"id": incumbent_score_id, "title": stem, "folder": "cycles/incumbents", "format": "apr", "text": text, "tags": ["candidate"]})));
    }
    for (letter, slot) in letters.iter().zip(slots.into_iter()) {
        let (sid, score_input) = if let Some(id) = slot.existing_score_id {
            (id, None)
        } else {
            let candidate_title = slot
                .apr
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("candidate")
                .to_string();
            let sid = format!("scr_{}_{}_apr", folder.replace('/', "_"), candidate_title);
            let text = std::fs::read_to_string(&slot.apr)
                .map_err(|e| format!("{}: {e}", slot.apr.display()))?;
            let input = json!({"id": sid, "title": candidate_title, "folder": folder, "format": "apr", "text": text, "tags": ["candidate"], "forkOf": incumbent_score_id, "forkRoot": fork_root});
            (sid, Some(input))
        };
        let audio_bytes =
            std::fs::read(&slot.audio).map_err(|e| format!("{}: {e}", slot.audio.display()))?;
        let ext = slot
            .audio
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("m4a");
        let content_type = content_type_for(ext);
        let sha256 = format!("{:x}", Sha256::digest(&audio_bytes));
        // library-relative, matching the web's expectation (files/<key>); the identity id in the path is
        // what makes `allow.entity("identity")` grant this upload (web/amplify/storage/resource.ts).
        let key = format!("cycles/{identity_id}/{cycle_id}/{letter}.{ext}");
        prepared.push(PreparedCycleOption {
            letter: *letter,
            score_id: sid,
            score_input,
            key,
            audio: audio_bytes,
            content_type,
            sha256,
        });
    }

    let cycle_title = title.unwrap_or_else(|| {
        let stem = score
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("cycle");
        format!(
            "{stem}: {}",
            question.as_deref().unwrap_or("which is better?")
        )
    });
    let mut input = json!({"id": cycle_id, "title": cycle_title, "question": question, "incumbentScoreId": incumbent_score_id, "status": "open"});
    if let Some(lab_id) = &lab {
        input["labId"] = json!(lab_id);
    }
    let mut ops = LiveCyclePublishOps {
        api: &mut api,
        s3: &s3,
        runtime: &runtime,
        bucket,
    };
    let options = publish_prepared_cycle(&mut ops, &cycle_id, prepared, setup_scores, input)?;

    let count = options.len();
    emit(
        json_flag,
        &json!({"cycleId": cycle_id, "options": options}),
        |_| {
            println!("published {cycle_id}: {count} options");
        },
    );
    Ok(())
}

fn pull_cycle(config: &Config, cycle_id: String, close: bool, json_flag: bool) -> Result<(), String> {
    let mut api = Api::new(config)?;
    let data = api.gql(
        "query Get($id: ID!) { getListeningCycle(id: $id) { id createdAt options { letter scoreId } } }",
        json!({"id": cycle_id}),
    )?;
    let cyc = data["getListeningCycle"].clone();
    if cyc.is_null() {
        return Err(format!("no such cycle: {cycle_id}"));
    }
    let since = cyc["createdAt"].as_str().unwrap_or("").to_string();
    let score_to_letter: std::collections::HashMap<String, String> = cyc["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| Some((o["scoreId"].as_str()?.to_string(), o["letter"].as_str()?.to_string())))
        .collect();

    // `listRatings` only returns what the caller's own Cognito session can see -- Rating is owner-only,
    // with no admin/curator read rule (unlike CycleVerdict) -- so this sees the signed-in person's own
    // star ratings on the cycle's options, not necessarily everyone's.
    let ratings = api.gql(
        "query List($t: RatingTarget) { listRatings(filter: {targetType: {eq: $t}}, limit: 1000) { items { targetId owner stars ratedAt } } }",
        json!({"t": "score"}),
    )?;
    let mut entries = Vec::new();
    for r in ratings["listRatings"]["items"].as_array().into_iter().flatten() {
        let Some(target) = r["targetId"].as_str() else { continue };
        let Some(letter) = score_to_letter.get(target) else { continue };
        if r["ratedAt"].as_str().unwrap_or("") < since.as_str() {
            continue; // rated before this cycle existed: not a vote in it
        }
        entries.push(json!({"kind": "cycle-verdict", "cycleId": cycle_id, "type": "rating", "judge": r["owner"], "letter": letter, "stars": r["stars"], "ratedAt": r["ratedAt"]}));
    }

    let verdicts = api.gql(
        "query List($id: ID!) { verdictsByCycle(cycleId: $id, limit: 1000) { items { judge best notes { letter note } note savedAt } } }",
        json!({"id": cycle_id}),
    )?;
    for v in verdicts["verdictsByCycle"]["items"].as_array().into_iter().flatten() {
        entries.push(json!({"kind": "cycle-verdict", "cycleId": cycle_id, "type": "verdict", "judge": v["judge"], "best": v["best"], "notes": v["notes"], "note": v["note"], "savedAt": v["savedAt"]}));
    }

    if close {
        api.gql(
            "mutation Update($input: UpdateListeningCycleInput!) { updateListeningCycle(input: $input) { id } }",
            json!({"input": {"id": cycle_id, "status": "closed"}}),
        )?;
    }

    let count = entries.len();
    emit(json_flag, &json!({"entries": entries, "closed": close}), |v| {
        for e in v["entries"].as_array().into_iter().flatten() {
            println!("{e}");
        }
        println!("{count} finding(s){}", if close { "; cycle closed" } else { "" });
    });
    Ok(())
}

fn import_library(config: &Config, from: Option<&Path>, path: Option<&str>) -> Result<(), String> {
    if let Some(root) = from {
        return import_repository_library(config, root, path);
    }
    if path.is_some() { return Err("--path requires --from".into()); }
    let token = refresh(config)?;
    let claims = jwt_claims(&token.id_token).ok_or("Cognito returned an invalid ID token")?;
    let groups: BTreeSet<&str> = claims["cognito:groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !groups.contains("admins") || !groups.contains("curators") {
        return Err("sample import requires both admins and curators membership".into());
    }
    let region = config
        .region
        .as_deref()
        .ok_or("Amplify outputs has no auth.aws_region")?;
    let pool = config
        .identity_pool_id
        .as_deref()
        .ok_or("Amplify outputs has no auth.identity_pool_id")?;
    let user_pool = config
        .user_pool_id
        .as_deref()
        .ok_or("Amplify outputs has no auth.user_pool_id")?;
    let bucket = config
        .bucket
        .as_deref()
        .ok_or("Amplify outputs has no storage.bucket_name")?;
    let provider = format!("cognito-idp.{region}.amazonaws.com/{user_pool}");
    let identity_endpoint = format!("https://cognito-identity.{region}.amazonaws.com/");
    let id: Value = http()?
        .post(&identity_endpoint)
        .header("X-Amz-Target", "AWSCognitoIdentityService.GetId")
        .header("Content-Type", "application/x-amz-json-1.1")
        .json(&json!({"IdentityPoolId": pool, "Logins": {provider.clone(): token.id_token}}))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not obtain Cognito Identity: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let identity_id = id["IdentityId"]
        .as_str()
        .ok_or("Cognito Identity did not return an identity ID")?;
    let credentials: Value = http()?
        .post(&identity_endpoint)
        .header(
            "X-Amz-Target",
            "AWSCognitoIdentityService.GetCredentialsForIdentity",
        )
        .header("Content-Type", "application/x-amz-json-1.1")
        .json(&json!({"IdentityId": identity_id, "Logins": {provider: token.id_token}}))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not obtain temporary storage credentials: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let c = &credentials["Credentials"];
    let access = c["AccessKeyId"]
        .as_str()
        .ok_or("Cognito Identity returned no access key")?;
    let secret = c["SecretKey"]
        .as_str()
        .ok_or("Cognito Identity returned no secret key")?;
    let session = c["SessionToken"]
        .as_str()
        .ok_or("Cognito Identity returned no session token")?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let sdk = runtime.block_on(async {
        let credentials = aws_credential_types::Credentials::new(
            access,
            secret,
            Some(session.to_string()),
            None,
            "apricity-cognito",
        );
        let sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .credentials_provider(credentials)
            .load()
            .await;
        aws_sdk_s3::Client::new(&sdk_config)
    });
    let models = [
        "Recording",
        "Sample",
        "Clip",
        "Marker",
        "Candidate",
        "Verdict",
        "Crate",
        "CrateItem",
        "Score",
        "ScoreRef",
    ];
    let mut api = Api::new(config)?;
    let mut created = 0usize;
    let mut updated = 0usize;
    for model in models {
        let mut continuation = None;
        loop {
            let response = runtime
                .block_on(
                    sdk.list_objects_v2()
                        .bucket(bucket)
                        .prefix(format!("{model}/"))
                        .set_continuation_token(continuation.clone())
                        .send(),
                )
                .map_err(|e| format!("could not list {model}/: {e}"))?;
            for object in response.contents() {
                let Some(key) = object.key() else { continue };
                if !key.ends_with(".json") {
                    continue;
                }
                let object = runtime
                    .block_on(sdk.get_object().bucket(bucket).key(key).send())
                    .map_err(|e| format!("could not download {key}: {e}"))?;
                let bytes = runtime
                    .block_on(object.body.collect())
                    .map_err(|e| format!("could not read {key}: {e}"))?;
                let record: Value = serde_json::from_slice(&bytes.into_bytes())
                    .map_err(|e| format!("{key}: invalid JSON: {e}"))?;
                let input = import_input(&record);
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| format!("{key}: record has no id"))?;
                let got = api.gql(
                    &format!("query Get($id: ID!) {{ get{model}(id: $id) {{ id }} }}"),
                    json!({"id": id}),
                )?;
                let operation = if got[format!("get{model}")].is_null() {
                    created += 1;
                    format!(
                        "mutation Put($input: Create{model}Input!) {{ create{model}(input: $input) {{ id }} }}"
                    )
                } else {
                    updated += 1;
                    format!(
                        "mutation Put($input: Update{model}Input!) {{ update{model}(input: $input) {{ id }} }}"
                    )
                };
                api.gql(&operation, json!({"input": input}))?;
            }
            continuation = response.next_continuation_token().map(str::to_owned);
            if continuation.is_none() {
                break;
            }
        }
    }
    println!("imported library records: {created} created, {updated} updated");
    Ok(())
}

/// Additive manifest synchronization for a checked-out repository.  Audio is
/// deliberately verified rather than guessed: a manifest without its matching
/// audio is reported, and no unusable Sample is invented.  Existing production
/// Samples retain their media keys; this pass makes their annotations available
/// as cloud Clip and Marker records.
fn import_repository_library(config: &Config, root: &Path, only_path: Option<&str>) -> Result<(), String> {
    let token = refresh(config)?;
    let claims = jwt_claims(&token.id_token).ok_or("Cognito returned an invalid ID token")?;
    let groups: BTreeSet<&str> = claims["cognito:groups"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !groups.contains("admins") || !groups.contains("curators") {
        return Err("sample import requires both admins and curators membership".into());
    }
    let samples = root.join("samples");
    if !samples.is_dir() { return Err(format!("{} has no samples directory", root.display())); }
    let mut manifests = Vec::new();
    collect_manifests(&samples, &mut manifests)?;
    if let Some(path) = only_path {
        let wanted = path.trim_start_matches("samples/");
        manifests.retain(|manifest| {
            manifest.strip_prefix(&samples).ok().map(|p| p.to_string_lossy().trim_end_matches(".apricity.json") == wanted).unwrap_or(false)
        });
        if manifests.is_empty() { return Err(format!("no manifest for samples/{wanted}")); }
    }
    let mut api = Api::new(config)?;
    let mut created = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut failures = Vec::new();
    for manifest_path in manifests {
        let audio_path = PathBuf::from(manifest_path.to_string_lossy().trim_end_matches(".apricity.json"));
        // A thin checkout can carry the manifest without the large audio file.
        // The existing production Sample remains usable in that case; synchronize
        // its annotations and report the absent local media for a later upload.
        if !audio_path.is_file() {
            failures.push(format!("{}: local audio absent; synchronizing annotations onto existing production media", audio_path.display()));
        }
        let rel = audio_path.strip_prefix(&samples).map_err(|_| format!("{} is outside samples", audio_path.display()))?
            .to_string_lossy().replace('\\', "/");
        let sample = api.gql("query Sample($path: String!) { samplesByPath(path: $path, limit: 1) { items { id } } }", json!({"path": rel}))?;
        let Some(sample_id) = sample["samplesByPath"]["items"].as_array().and_then(|v| v.first()).and_then(|v| v["id"].as_str()) else {
            skipped += 1;
            failures.push(format!("{rel}: production Sample is absent (run the media/sample bootstrap first)"));
            continue;
        };
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?)
            .map_err(|e| format!("{}: invalid manifest: {e}", manifest_path.display()))?;
        for clip in manifest["annotations"]["clips"].as_array().into_iter().flatten() {
            let (Some(name), Some(start), Some(end)) = (clip["name"].as_str(), clip["start"].as_f64(), clip["end"].as_f64()) else { failures.push(format!("{rel}: malformed clip annotation")); continue };
            let id = apricity_data::ids::migrated_clip_id(sample_id, name);
            let source = clip["source"].as_str().filter(|s| ["ml", "user", "curated"].contains(s)).unwrap_or("ml");
            let tags: Vec<&str> = clip["tags"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let kind = tags.first().copied().filter(|k| ["loop", "break", "hit", "phrase", "section", "chop", "other"].contains(k));
            let evidence = if clip["evidence"].is_null() { Value::Null } else { json!(clip["evidence"].to_string()) };
            let exists = api.gql("query Clip($id: ID!) { getClip(id: $id) { id } }", json!({"id": id}))?["getClip"].is_object();
            let input = json!({"id": id, "sampleId": sample_id, "name": name, "start": start, "end": end, "source": source, "kind": kind, "tags": tags, "evidence": evidence});
            let operation = if exists { "mutation Put($input: UpdateClipInput!) { updateClip(input: $input) { id } }" } else { "mutation Put($input: CreateClipInput!) { createClip(input: $input) { id } }" };
            api.gql(operation, json!({"input": input}))?;
            if exists { updated += 1 } else { created += 1 }
        }
        for marker in manifest["annotations"]["markers"].as_array().into_iter().flatten() {
            let (Some(name), Some(seconds)) = (marker["name"].as_str(), marker["seconds"].as_f64()) else { failures.push(format!("{rel}: malformed marker annotation")); continue };
            let id = apricity_data::ids::migrated_marker_id(sample_id, name, seconds);
            let exists = api.gql("query Marker($id: ID!) { getMarker(id: $id) { id } }", json!({"id": id}))?["getMarker"].is_object();
            let source = marker["source"].as_str().filter(|s| ["ml", "user", "curated"].contains(s));
            let input = json!({"id": id, "sampleId": sample_id, "name": name, "seconds": seconds, "source": source, "note": marker["note"]});
            let operation = if exists { "mutation Put($input: UpdateMarkerInput!) { updateMarker(input: $input) { id } }" } else { "mutation Put($input: CreateMarkerInput!) { createMarker(input: $input) { id } }" };
            api.gql(operation, json!({"input": input}))?;
            if exists { updated += 1 } else { created += 1 }
        }
    }
    println!("repository assets: {created} created, {updated} updated, {skipped} skipped");
    if !failures.is_empty() { eprintln!("asset import warnings:\n{}", failures.join("\n")); }
    Ok(())
}

fn collect_manifests(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() { collect_manifests(&path, out)?; }
        else if path.to_string_lossy().ends_with(".apricity.json") { out.push(path); }
    }
    Ok(())
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}
fn import_input(record: &Value) -> Value {
    let mut input = record.clone();
    let Some(object) = input.as_object_mut() else {
        return input;
    };
    object.remove("__typename");
    object.remove("createdAt");
    object.remove("updatedAt");
    object.remove("recording");
    object.remove("sample");
    object.remove("clip");
    object.remove("refs");
    for value in object.values_mut() {
        if value.is_object() || value.is_array() { /* AppSync accepts FileRef/list values directly; AWSJSON records are already strings in library files. */
        }
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_is_s256_and_state_is_urlsafe() {
        assert_eq!(
            challenge("verifier"),
            "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ"
        );
        assert!(!random_urlsafe(32).contains('='));
    }
    #[test]
    fn score_input_derives_hosted_score_identity() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("beat.apr");
        std::fs::write(&p, "tempo 90\nkey C\nbars 1\n").unwrap();
        let (v, refs) = score_input(&p, None, None, None, vec![]).unwrap();
        assert_eq!(v["folder"], "scores");
        assert_eq!(v["title"], "beat");
        assert!(refs.is_empty());
    }

    #[test]
    fn repository_import_finds_nested_manifests() {
        let d = tempfile::tempdir().unwrap();
        let nested = d.path().join("one/two");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("sample.wav.apricity.json"), "{}").unwrap();
        std::fs::write(nested.join("ignored.json"), "{}").unwrap();
        let mut found = Vec::new();
        collect_manifests(d.path(), &mut found).unwrap();
        assert_eq!(found, vec![nested.join("sample.wav.apricity.json")]);
    }
    // ----------------------------------------------------------------------- labs and listening cycles

    /// An unsigned JWT-shaped token carrying just these claims (`jwt_claims` never checks the signature).
    fn fake_id_token(claims: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn owner_value_is_sub_colon_colon_username() {
        let token = fake_id_token(json!({"sub": "sub-123", "cognito:username": "ryan"}));
        assert_eq!(owner_value(&token).unwrap(), "sub-123::ryan");
    }

    #[test]
    fn owner_value_falls_back_to_the_sub_without_a_username_claim() {
        let token = fake_id_token(json!({"sub": "sub-123"}));
        assert_eq!(owner_value(&token).unwrap(), "sub-123::sub-123");
    }

    #[test]
    fn random_id_has_the_given_prefix_and_sixteen_hex_chars() {
        let id = random_id("lab");
        let (prefix, rest) = id.split_once('_').unwrap();
        assert_eq!(prefix, "lab");
        assert_eq!(rest.len(), 16);
        assert!(rest.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(random_id("cyc"), random_id("cyc")); // vanishingly unlikely to collide
    }

    #[test]
    fn content_type_for_known_and_unknown_extensions() {
        assert_eq!(content_type_for("m4a"), "audio/mp4");
        assert_eq!(content_type_for("MP3"), "audio/mpeg");
        assert_eq!(content_type_for("xyz"), "application/octet-stream");
    }

    #[test]
    fn shuffled_letters_are_the_first_n_letters_in_some_order() {
        for n in 1..=4 {
            let mut letters = shuffled_letters(n);
            letters.sort();
            assert_eq!(letters, ['A', 'B', 'C', 'D'][..n]);
        }
    }

    #[derive(Default)]
    struct FakeCyclePublishOps {
        events: Vec<String>,
        fail_upload: Option<String>,
        fail_cycle: bool,
        cycle: Option<Value>,
    }

    impl CyclePublishOps for FakeCyclePublishOps {
        fn create_score(&mut self, input: &Value) -> Result<(), String> {
            self.events
                .push(format!("score+:{}", input["id"].as_str().unwrap()));
            Ok(())
        }
        fn upload_audio(&mut self, key: &str, _: Vec<u8>, _: &str) -> Result<(), String> {
            self.events.push(format!("audio+:{key}"));
            if self.fail_upload.as_deref() == Some(key) {
                Err("AccessDenied: test denial".into())
            } else {
                Ok(())
            }
        }
        fn create_cycle(&mut self, input: &Value) -> Result<(), String> {
            self.events.push("cycle+".into());
            if self.fail_cycle {
                return Err("cycle write failed".into());
            }
            self.cycle = Some(input.clone());
            Ok(())
        }
        fn delete_score(&mut self, id: &str) -> Result<(), String> {
            self.events.push(format!("score-:{id}"));
            Ok(())
        }
        fn delete_audio(&mut self, key: &str) -> Result<(), String> {
            self.events.push(format!("audio-:{key}"));
            Ok(())
        }
        fn delete_cycle(&mut self, id: &str) -> Result<(), String> {
            self.events.push(format!("cycle-:{id}"));
            Ok(())
        }
    }

    fn prepared_options() -> Vec<PreparedCycleOption> {
        ['A', 'B', 'C']
            .into_iter()
            .map(|letter| PreparedCycleOption {
                letter,
                score_id: format!("scr_{letter}"),
                score_input: Some(json!({"id": format!("scr_{letter}")})),
                key: format!("cycles/identity/cyc_test/{letter}.m4a"),
                audio: vec![1, 2, 3],
                content_type: "audio/mp4",
                sha256: "hash".into(),
            })
            .collect()
    }

    #[test]
    fn cycle_publish_uploads_three_options_then_creates_cycle() {
        let mut ops = FakeCyclePublishOps::default();
        let options = publish_prepared_cycle(
            &mut ops,
            "cyc_test",
            prepared_options(),
            vec![],
            json!({"id": "cyc_test"}),
        )
        .unwrap();
        assert_eq!(options.len(), 3);
        assert_eq!(ops.cycle.unwrap()["options"].as_array().unwrap().len(), 3);
        assert_eq!(ops.events.last().unwrap(), "cycle+");
    }

    #[test]
    fn third_upload_failure_cleans_partial_cycle_publish_and_keeps_service_error() {
        let mut ops = FakeCyclePublishOps {
            fail_upload: Some("cycles/identity/cyc_test/C.m4a".into()),
            ..Default::default()
        };
        let err = publish_prepared_cycle(
            &mut ops,
            "cyc_test",
            prepared_options(),
            vec![],
            json!({"id": "cyc_test"}),
        )
        .unwrap_err();
        assert!(err.contains("AccessDenied: test denial"), "{err}");
        assert!(
            ops.events
                .contains(&"audio-:cycles/identity/cyc_test/C.m4a".into())
        );
        for letter in ['A', 'B', 'C'] {
            assert!(ops.events.contains(&format!("score-:scr_{letter}")));
        }
        assert!(!ops.events.contains(&"cycle-:cyc_test".into()));
        assert!(!ops.events.contains(&"cycle+".into()));
    }

    #[test]
    fn cycle_record_failure_removes_all_uploaded_objects_and_scores() {
        let mut ops = FakeCyclePublishOps {
            fail_cycle: true,
            ..Default::default()
        };
        let err = publish_prepared_cycle(
            &mut ops,
            "cyc_test",
            prepared_options(),
            vec![],
            json!({"id": "cyc_test"}),
        )
        .unwrap_err();
        assert!(err.contains("cycle write failed"), "{err}");
        assert!(ops.events.contains(&"cycle-:cyc_test".into()));
        for letter in ['A', 'B', 'C'] {
            assert!(
                ops.events
                    .contains(&format!("audio-:cycles/identity/cyc_test/{letter}.m4a"))
            );
            assert!(ops.events.contains(&format!("score-:scr_{letter}")));
        }
    }

    #[test]
    fn publish_cycle_refuses_no_candidates_and_too_many_options() {
        let config = Config {
            domain: "d".into(), client_id: "c".into(), graphql_url: "g".into(),
            identity_pool_id: None, user_pool_id: None, region: None, bucket: None, callback: DEFAULT_CALLBACK.into(),
        };
        let d = tempfile::tempdir().unwrap();
        let score = d.path().join("incumbent.apr");
        std::fs::write(&score, "tempo 120\n").unwrap();
        let err = publish_cycle(&config, score.clone(), "scr_x".into(), score.clone(), vec![], None, None, None, false).unwrap_err();
        assert!(err.contains("at least one --candidate"), "{err}");
        let four_candidates = vec![(score.clone(), score.clone()); 4];
        let err = publish_cycle(&config, score.clone(), "scr_x".into(), score, four_candidates, None, None, None, false).unwrap_err();
        assert!(err.contains("at most 4 options"), "{err}");
    }

    #[test]
    fn callback_reader_stops_at_headers_without_waiting_for_eof() {
        let mut input =
            std::io::Cursor::new(b"GET /?code=x HTTP/1.1\r\nHost: localhost\r\n\r\nbody".to_vec());
        assert!(
            read_http_head(&mut input)
                .unwrap()
                .starts_with("GET /?code=x HTTP/1.1")
        );
    }
}
