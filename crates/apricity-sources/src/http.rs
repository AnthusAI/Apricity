//! The real network fetcher.

use crate::{FetchError, Fetcher};
use std::io::Write;
use std::time::Duration;

pub const USER_AGENT: &str = "ApricitySampleFetcher/0.1";

pub struct HttpFetcher {
    agent: ureq::Agent,
}

impl Default for HttpFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpFetcher {
    pub fn new() -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .user_agent(USER_AGENT)
            .timeout_global(Some(Duration::from_secs(600)))
            .build()
            .into();
        Self { agent }
    }
}

impl Fetcher for HttpFetcher {
    fn get(&self, url: &str, out: &mut dyn Write) -> Result<(), FetchError> {
        let resp = self.agent.get(url).call().map_err(|e| FetchError(e.to_string()))?;
        let mut body = resp.into_body();
        std::io::copy(&mut body.as_reader(), out)?;
        Ok(())
    }
    fn backoff(&self, attempt: u32) {
        std::thread::sleep(Duration::from_secs(u64::from(attempt) * 2));
    }
}
