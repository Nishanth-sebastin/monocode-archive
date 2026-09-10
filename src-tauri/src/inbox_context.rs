//! Small provider switch for explicitly selected Inbox context. No background work.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, path::Path, time::Duration};
use tauri::{AppHandle, Url};

const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    provider: String,
    url: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    number: i64,
    #[serde(default)]
    cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    id: String,
    name: String,
    url: String,
    mime_type: String,
    size: Option<u64>,
    unavailable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    owner: String,
    description: Value,
    comments: Vec<Value>,
    files: Vec<ContextFile>,
    more: bool,
    adf: bool,
}

struct Loaded {
    document: Document,
    credential: (String, String),
}

fn text(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_default()
}
fn identity(value: &Value) -> Result<String, String> {
    let id = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|v| v.to_string()))
        .unwrap_or_default();
    if id.is_empty() {
        Err("The provider did not return an account identity".into())
    } else {
        Ok(id)
    }
}
fn encode(value: &str) -> String {
    url_component(value)
}
fn url_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn https(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid attachment URL")?;
    if raw.len() > 8192
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Only plain HTTPS provider URLs are supported".into());
    }
    Ok(url)
}

fn load(app: &AppHandle, ticket: &Ticket, pages: usize) -> Result<Loaded, String> {
    let url = https(&ticket.url)?;
    let pages = pages.clamp(1, 5);
    let mut document = Document {
        owner: String::new(),
        description: Value::Null,
        comments: vec![],
        files: vec![],
        more: false,
        adf: false,
    };
    let credential = match ticket.provider.as_str() {
        "jira" => {
            let site = url.origin().ascii_serialization();
            let config = crate::jira::require_config(app, &site)?;
            if ticket.id.is_empty() || !ticket.id.bytes().all(|b| b.is_ascii_digit()) {
                return Err("Invalid Jira issue ID".into());
            }
            let issue = crate::jira::request(
                &config,
                &format!("issue/{}", ticket.id),
                &[("fields", "description,attachment".into())],
            )?;
            if format!("{site}/browse/{}", text(&issue["key"])) != ticket.url {
                return Err("Jira ticket identity changed".into());
            }
            document.owner = format!(
                "jira:{site}:{}",
                identity(&crate::jira::request(&config, "myself", &[])?["accountId"])?
            );
            document.description = issue["fields"]["description"].clone();
            document.adf = true;
            for page in 0..pages {
                let result = crate::jira::request(
                    &config,
                    &format!("issue/{}/comment", ticket.id),
                    &[
                        ("maxResults", "50".into()),
                        ("startAt", (page * 50).to_string()),
                        ("orderBy", "-created".into()),
                    ],
                )?;
                let rows = result["comments"]
                    .as_array()
                    .ok_or("Invalid Jira comments")?;
                document.comments.extend(rows.iter().map(|row| json!({"id":row["id"], "body":row["body"], "author":row["author"]["displayName"], "createdAt":row["created"], "updatedAt":row["updated"]})));
                document.more =
                    result["total"].as_u64().unwrap_or(0) > document.comments.len() as u64;
                if rows.is_empty() || !document.more {
                    break;
                }
            }
            if let Some(files) = issue["fields"]["attachment"].as_array() {
                for file in files.iter().take(200) {
                    let id = identity(&file["id"])?;
                    if !id.bytes().all(|b| b.is_ascii_digit()) {
                        continue;
                    }
                    document.files.push(ContextFile {
                        url: format!("{site}/rest/api/3/attachment/content/{id}?redirect=false"),
                        id,
                        name: text(&file["filename"]),
                        mime_type: text(&file["mimeType"]),
                        size: file["size"].as_u64(),
                        unavailable: None,
                    });
                }
            }
            (
                "Authorization".into(),
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{}", config.email, config.token))
                ),
            )
        }
        "linear" => {
            let token = crate::linear::require_token(app)?;
            let mut cursor = Value::Null;
            for _ in 0..pages {
                let result = crate::linear::graphql_with_token(&token, "query($id:String!,$after:String){viewer{id} issue(id:$id){url description comments(first:50,after:$after,orderBy:createdAt){pageInfo{hasNextPage endCursor} nodes{id body createdAt updatedAt user{name} }}}}", json!({"id":ticket.id,"after":cursor}))?;
                if result["issue"]["url"] != ticket.url {
                    return Err("Linear ticket identity changed".into());
                }
                document.owner = format!("linear:{}", identity(&result["viewer"]["id"])?);
                document.description = result["issue"]["description"].clone();
                let comments = &result["issue"]["comments"];
                let rows = comments["nodes"]
                    .as_array()
                    .ok_or("Invalid Linear comments")?;
                document.comments.extend(rows.iter().map(|row| json!({"id":row["id"],"body":row["body"],"author":row["user"]["name"],"createdAt":row["createdAt"],"updatedAt":row["updatedAt"]})));
                document.more = comments["pageInfo"]["hasNextPage"] == true;
                let next = comments["pageInfo"]["endCursor"].clone();
                if !document.more || rows.is_empty() || next == cursor || next.is_null() {
                    break;
                }
                cursor = next;
            }
            (
                "Authorization".into(),
                crate::linear::linear_authorization(&token),
            )
        }
        "gitlab" => {
            let config = crate::gitlab::require_config(app)?;
            if url.origin().ascii_serialization() != config.url.trim_end_matches('/')
                || ticket.number < 1
                || !matches!(ticket.kind.as_str(), "issue" | "pr")
            {
                return Err("GitLab site or ticket changed".into());
            }
            let kind = if ticket.kind == "pr" {
                "merge_requests"
            } else {
                "issues"
            };
            let base = format!(
                "/projects/{}/{kind}/{}",
                encode(&ticket.repo),
                ticket.number
            );
            let issue = crate::gitlab::gitlab_get(&config, &base)?.value;
            if issue["web_url"] != ticket.url {
                return Err("GitLab ticket identity changed".into());
            }
            document.owner = format!(
                "gitlab:{}:{}",
                config.url,
                identity(&crate::gitlab::gitlab_get(&config, "/user")?.value["id"])?
            );
            document.description = issue["description"].clone();
            for page in 1..=pages {
                let response = crate::gitlab::gitlab_get(
                    &config,
                    &format!("{base}/notes?order_by=created_at&sort=desc&per_page=50&page={page}"),
                )?;
                let rows = response.value.as_array().ok_or("Invalid GitLab comments")?;
                document.comments.extend(rows.iter().filter(|r| r["system"] != true).map(|row| json!({"id":row["id"].to_string(),"body":row["body"],"author":row["author"]["name"],"createdAt":row["created_at"],"updatedAt":row["updated_at"]})));
                document.more = response.has_next_page;
                if !document.more || rows.is_empty() {
                    break;
                }
            }
            ("PRIVATE-TOKEN".into(), config.token)
        }
        "github" => {
            if url.host_str() != Some("github.com")
                || ticket.number < 1
                || ticket.repo.split('/').count() != 2
                || !ticket
                    .repo
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
            {
                return Err("Unsupported GitHub ticket identity".into());
            }
            let root = Path::new(&ticket.cwd);
            let get = |path: &str| -> Result<Value, String> {
                let raw = crate::fs::gh_checked(root, &["api", "--hostname", "github.com", path])
                    .map_err(|_| {
                    "GitHub context request failed. Check the selected host/account."
                })?;
                if raw.len() > 2 * 1024 * 1024 {
                    return Err("GitHub context page is too large".into());
                }
                serde_json::from_str(&raw).map_err(|_| "Invalid GitHub context response".into())
            };
            let base = format!("repos/{}/issues/{}", ticket.repo, ticket.number);
            let issue = get(&base)?;
            if issue["html_url"] != ticket.url {
                return Err("GitHub ticket identity changed".into());
            }
            document.owner = format!("github:github.com:{}", identity(&get("user")?["id"])?);
            document.description = issue["body"].clone();
            let last_page = issue["comments"].as_u64().unwrap_or(0).div_ceil(50).max(1) as usize;
            for offset in 0..pages.min(last_page) {
                let page = last_page - offset;
                let result = get(&format!("{base}/comments?per_page=50&page={page}"))?;
                let rows = result.as_array().ok_or("Invalid GitHub comments")?;
                document.comments.extend(rows.iter().map(|row| json!({"id":row["id"].to_string(),"body":row["body"],"author":row["user"]["login"],"createdAt":row["created_at"],"updatedAt":row["updated_at"]})));
                document.more = page > 1;
                if !document.more || rows.is_empty() {
                    break;
                }
            }
            if ticket.kind == "pr" {
                for (route, prefix) in [("reviews", "review"), ("comments", "inline")] {
                    for page in 1..=pages {
                        let result = get(&format!(
                            "repos/{}/pulls/{}/{route}?per_page=50&page={page}",
                            ticket.repo, ticket.number
                        ))?;
                        let rows = result.as_array().ok_or("Invalid GitHub review comments")?;
                        document.comments.extend(rows.iter().filter(|r| !text(&r["body"]).is_empty()).map(|row| json!({"id":format!("{prefix}:{}", row["id"]),"body":row["body"],"author":row["user"]["login"],"createdAt":row["created_at"].as_str().or(row["submitted_at"].as_str()).unwrap_or_default(),"updatedAt":row["updated_at"],"path":row["path"],"line":row["line"]})));
                        if rows.len() < 50 {
                            break;
                        }
                        if page == pages {
                            document.more = true;
                        }
                    }
                }
            }
            document
                .comments
                .sort_by(|a, b| text(&b["createdAt"]).cmp(&text(&a["createdAt"])));
            (String::new(), String::new()) // Resolved on the owning app host only when downloading.
        }
        _ => return Err("This Inbox provider does not support context selection yet".into()),
    };
    if !document.adf {
        let mut bodies = vec![text(&document.description)];
        bodies.extend(document.comments.iter().map(|c| text(&c["body"])));
        document.files = markdown_files(ticket, &bodies);
    }
    Ok(Loaded {
        document,
        credential,
    })
}

fn markdown_files(ticket: &Ticket, bodies: &[String]) -> Vec<ContextFile> {
    // ponytail: uploaded Markdown links only, up to 200; use a parser if escaped-link support becomes necessary.
    let mut files = vec![];
    for body in bodies {
        for raw in body.split(|c: char| c.is_whitespace() || "\"'()<>[]".contains(c)) {
            let raw = raw.trim_end_matches([',', ';']);
            let candidate = if ticket.provider == "gitlab" && raw.starts_with("/uploads/") {
                match https(&ticket.url) {
                    Ok(base) => format!(
                        "{}/{}/-{raw}",
                        base.origin().ascii_serialization(),
                        ticket.repo
                    ),
                    Err(_) => continue,
                }
            } else {
                raw.to_string()
            };
            let Ok(url) = https(&candidate) else { continue };
            let path = url.path();
            let name = path.rsplit('/').next().unwrap_or("attachment").to_string();
            let known_file = path.contains("/uploads/")
                || path.contains("/user-attachments/")
                || path.contains("/assets/")
                || matches!(
                    url.host_str(),
                    Some("uploads.linear.app" | "user-images.githubusercontent.com")
                )
                || [
                    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".txt", ".log", ".zip",
                    ".csv", ".json", ".docx",
                ]
                .iter()
                .any(|ext| path.to_lowercase().ends_with(ext));
            if !known_file {
                continue;
            }
            let id = format!("{}{}", url.origin().ascii_serialization(), path);
            if files.iter().any(|file: &ContextFile| file.id == id) {
                continue;
            }
            let unavailable = download_url(ticket, &candidate).err();
            files.push(ContextFile {
                id,
                name,
                url: candidate,
                mime_type: String::new(),
                size: None,
                unavailable,
            });
            if files.len() >= 200 {
                return files;
            }
        }
    }
    files
}

fn download_url(ticket: &Ticket, raw: &str) -> Result<String, String> {
    let url = https(raw)?;
    let host = url.host_str().unwrap_or_default();
    match ticket.provider.as_str() {
        "linear" if host == "uploads.linear.app" => Ok(raw.into()),
        "github" if crate::inbox_media::allowed_github_attachment(raw) => Ok(raw.into()),
        "jira"
            if url.origin() == https(&ticket.url)?.origin()
                && url.path().starts_with("/rest/api/3/attachment/content/") =>
        {
            Ok(raw.into())
        }
        "gitlab" if url.origin() == https(&ticket.url)?.origin() => {
            let prefix = format!("/{}/-/uploads/", ticket.repo);
            let alternate = format!("/{}/uploads/", ticket.repo);
            let suffix = url
                .path()
                .strip_prefix(&prefix)
                .or_else(|| url.path().strip_prefix(&alternate))
                .ok_or("Only files uploaded to this GitLab project can be attached")?;
            let (secret, name) = suffix.split_once('/').ok_or("Invalid GitLab upload")?;
            if secret.len() != 32
                || !secret.bytes().all(|b| b.is_ascii_hexdigit())
                || name.is_empty()
                || name.contains('/')
            {
                return Err("Invalid GitLab upload".into());
            }
            Ok(format!(
                "{}/api/v4/projects/{}/uploads/{secret}/{name}",
                url.origin().ascii_serialization(),
                encode(&ticket.repo)
            ))
        }
        _ => Err("External or unsupported file link — open it in the provider instead".into()),
    }
}

#[tauri::command]
pub async fn inbox_context_document(
    app: AppHandle,
    ticket: Ticket,
    pages: usize,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load(&app, &ticket, pages).map(|loaded| loaded.document)
    })
    .await
    .map_err(|_| "Context read task failed")?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    data: String,
    mime_type: String,
    name: String,
    size: usize,
}

#[tauri::command]
pub async fn inbox_context_download(
    app: AppHandle,
    ticket: Ticket,
    pages: usize,
    owner: String,
    file_id: String,
) -> Result<Download, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Re-read under the current account; client-provided URLs never authorize downloads.
        let loaded = load(&app, &ticket, pages)?;
        if loaded.document.owner != owner {
            return Err("The account changed. Review context again.".into());
        }
        let file = loaded
            .document
            .files
            .iter()
            .find(|f| f.id == file_id)
            .ok_or("The attachment is no longer on this ticket. Review context again.")?;
        if let Some(reason) = &file.unavailable {
            return Err(reason.clone());
        }
        if file.size.is_some_and(|size| size > MAX_BYTES as u64) {
            return Err("Attachment exceeds 20 MiB".into());
        }
        let url = download_url(&ticket, &file.url)?;
        let (bytes, mime) = if ticket.provider == "github" {
            let token = crate::inbox_media::github_auth_token()
                .ok_or("Connect the same GitHub account on the app host to download attachments")?;
            let auth = format!("Bearer {token}");
            let response = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(20))
                .redirects(0)
                .build()
                .get("https://api.github.com/user")
                .set("Authorization", &auth)
                .set("User-Agent", "MonoCode")
                .call()
                .map_err(|_| "Cannot verify the app-host GitHub account")?;
            let mut raw = String::new();
            response
                .into_reader()
                .take(64 * 1024)
                .read_to_string(&mut raw)
                .map_err(|_| "Invalid GitHub account response")?;
            let viewer: Value =
                serde_json::from_str(&raw).map_err(|_| "Invalid GitHub account response")?;
            if format!("github:github.com:{}", identity(&viewer["id"])?) != owner {
                return Err(
                    "App-host and ticket GitHub accounts differ. Reconnect before attaching files."
                        .into(),
                );
            }
            let bytes = crate::inbox_media::fetch_with_token(&url, Some(token))?;
            (bytes, file.mime_type.clone())
        } else {
            let response = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(20))
                .redirects(0)
                .build()
                .get(&url)
                .set(&loaded.credential.0, &loaded.credential.1)
                .call()
                .map_err(|_| "Attachment download failed. Check access and retry.")?;
            if response.status() != 200 {
                return Err(
                    "Provider redirected or rejected the attachment. Open it in the provider."
                        .into(),
                );
            }
            let mime = response
                .header("Content-Type")
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or_default()
                .to_string();
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read attachment")?;
            (bytes, mime)
        };
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err("Attachment is empty or exceeds 20 MiB".into());
        }
        if matches!(
            mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) && image_mime(&bytes).is_none()
        {
            return Err("Attachment bytes do not match the provider's image type".into());
        }
        let mime = image_mime(&bytes)
            .unwrap_or(if mime.is_empty() {
                "application/octet-stream"
            } else {
                &mime
            })
            .to_string();
        if mime == "text/html" || mime == "application/xhtml+xml" {
            return Err(
                "HTML responses cannot be attached; the provider may require sign-in".into(),
            );
        }
        Ok(Download {
            size: bytes.len(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type: mime,
            name: file.name.clone(),
        })
    })
    .await
    .map_err(|_| "Attachment task failed")?
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ticket(provider: &str, url: &str) -> Ticket {
        Ticket {
            provider: provider.into(),
            url: url.into(),
            id: "1".into(),
            repo: "team/project".into(),
            kind: "issue".into(),
            number: 1,
            cwd: String::new(),
        }
    }
    #[test]
    fn files_are_unique_and_provider_scoped() {
        let t = ticket("gitlab", "https://gitlab.com/team/project/-/issues/1");
        let body = "![shot](/uploads/0123456789abcdef0123456789abcdef/shot.png) [again](/uploads/0123456789abcdef0123456789abcdef/shot.png) [other](https://evil.test/secret.pdf)";
        let files = markdown_files(&t, &[body.into()]);
        assert_eq!(files.len(), 2);
        assert!(files[0].unavailable.is_none());
        assert!(files[1].unavailable.is_some());
        assert!(download_url(&t, &files[0].url)
            .unwrap()
            .contains("projects/team%2Fproject/uploads/"));
        assert!(download_url(
            &t,
            "https://gitlab.com/other/project/-/uploads/0123456789abcdef0123456789abcdef/a.png"
        )
        .is_err());
        assert!(https("https://token@uploads.linear.app/a").is_err());
        assert!(https("https://uploads.linear.app:8443/a").is_err());
        assert!(download_url(
            &ticket("linear", "https://linear.app/team/issue/A-1"),
            "https://uploads.linear.app.evil.test/a.png"
        )
        .is_err());
    }
}
