//! Cognito-authenticated access to the hosted Apricity data API.
//!
//! This module deliberately does not reuse `sync`: sync is an operator's S3
//! tool backed by AWS credentials, whereas these requests must carry the
//! signed-in person's Cognito token so AppSync can apply owner/group rules.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
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
    Import,
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
        Command::Import => import_library(&config),
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
    fn gql(&mut self, query: &str, variables: Value) -> Result<Value, String> {
        if self.token.expires_at <= now() + 60 {
            self.token = refresh(&self.config)?;
        }
        let v: Value = self
            .http
            .post(&self.config.graphql_url)
            .bearer_auth(&self.token.id_token)
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
            let data = api.gql("mutation Create($input: CreateScoreInput!) { createScore(input: $input) { id title } }", json!({"input": input}))?;
            let id = data["createScore"]["id"]
                .as_str()
                .ok_or("AppSync did not return a score id")?
                .to_string();
            reconcile_refs(&mut api, &id, refs)?;
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
            input["id"] = json!(id);
            api.gql(
                "mutation Update($input: UpdateScoreInput!) { updateScore(input: $input) { id } }",
                json!({"input": input}),
            )?;
            let id = input["id"].as_str().unwrap();
            reconcile_refs(&mut api, id, refs)?;
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

fn reconcile_refs(
    api: &mut Api,
    score_id: &str,
    refs: Vec<apricity_data::CatalogRef>,
) -> Result<(), String> {
    delete_refs(api, score_id)?;
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
        if clip_id.is_none() {
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
        let input = json!({"id": format!("sref_{}_{}", score_id, r.id_suffix), "scoreId": score_id, "clipAlias": r.alias, "source": r.source, "sampleId": sample_id, "samplePath": r.catalog_path, "clipName": r.clip_name, "clipId": clip_id, "start": start, "end": end, "kitPad": r.kit_pad});
        api.gql("mutation Create($input: CreateScoreRefInput!) { createScoreRef(input: $input) { id } }", json!({"input": input}))?;
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

fn import_library(config: &Config) -> Result<(), String> {
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
