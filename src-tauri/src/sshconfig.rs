//! Reads ~/.ssh/config so existing hosts, their IdentityFile keys and
//! LocalForward lines can be imported into the vault in one go.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Forward {
    pub bind_addr: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Entry {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<String>,
    pub forwards: Vec<Forward>,
    pub proxy_jump: Option<String>,
}

fn is_pattern(a: &str) -> bool {
    a.contains(['*', '?', '!'])
}

/// "3000" | "127.0.0.1:3000" | "[::1]:3000" -> (bind, port)
fn split_bind(s: &str) -> Option<(String, u16)> {
    match s.rsplit_once(':') {
        Some((b, p)) => Some((b.trim_start_matches('[').trim_end_matches(']').to_string(), p.parse().ok()?)),
        None => Some(("127.0.0.1".into(), s.parse().ok()?)),
    }
}

fn forward(v: &str) -> Option<Forward> {
    let mut it = v.split_whitespace();
    let (bind_addr, local_port) = split_bind(it.next()?)?;
    let (remote_host, remote_port) = split_bind(it.next()?)?;
    let bind_addr = if bind_addr.is_empty() || bind_addr == "localhost" { "127.0.0.1".into() } else { bind_addr };
    Some(Forward { bind_addr, local_port, remote_host, remote_port })
}

/// Expands ~ and %d to the home dir; relative paths are relative to ~/.ssh.
pub fn expand(path: &str, home: &Path) -> PathBuf {
    let p = path.trim_matches('"').replace("%d", &home.display().to_string());
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home.join(rest);
    }
    let pb = PathBuf::from(&p);
    if pb.is_absolute() { pb } else { home.join(".ssh").join(pb) }
}

/// Parses Host blocks; wildcard hosts and Match blocks are ignored.
pub fn parse(text: &str, default_user: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, val) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(i) => (&line[..i], line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim()),
            None => (line, ""),
        };
        let key = key.to_ascii_lowercase();
        match key.as_str() {
            "host" => {
                current.clear();
                for a in val.split_whitespace().filter(|a| !is_pattern(a)) {
                    out.push(Entry { alias: a.to_string(), port: 22, ..Default::default() });
                    current.push(out.len() - 1);
                }
                continue;
            }
            "match" => {
                current.clear();
                continue;
            }
            _ => {}
        }
        for &i in &current {
            let e = &mut out[i];
            // First value wins, as in ssh.
            match key.as_str() {
                "hostname" if e.hostname.is_empty() => e.hostname = val.to_string(),
                "user" if e.user.is_empty() => e.user = val.to_string(),
                "port" => e.port = val.parse().unwrap_or(e.port),
                "identityfile" => e.identity_files.push(val.trim_matches('"').to_string()),
                "localforward" => e.forwards.extend(forward(val)),
                "proxyjump" | "proxycommand" if e.proxy_jump.is_none() && !val.eq_ignore_ascii_case("none") => e.proxy_jump = Some(val.to_string()),
                _ => {}
            }
        }
    }
    for e in &mut out {
        if e.hostname.is_empty() {
            e.hostname = e.alias.clone();
        }
        if e.user.is_empty() {
            e.user = default_user.to_string();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts_keys_and_forwards() {
        let cfg = r#"
Host *
    ServerAliveInterval 30

Host web1 w1
    HostName 203.0.113.10
    User root
    IdentityFile ~/.ssh/web1-root.pem
    IdentitiesOnly yes

Host gitea
    HostName=203.0.113.20
    User gitproxy
    IdentityFile "C:\Users\me\.ssh\id_edge"
    LocalForward 3000 127.0.0.1:3000
    LocalForward 127.0.0.1:2222 127.0.0.1:2222
    LocalForward [::1]:3909 db.internal:3909

Host jumped
    HostName 127.0.0.1
    Port 2222
    ProxyJump web1

Match host foo
    User nobody
"#;
        let e = parse(cfg, "me");
        assert_eq!(e.iter().map(|x| x.alias.as_str()).collect::<Vec<_>>(), vec!["web1", "w1", "gitea", "jumped"]);
        assert_eq!((e[0].hostname.as_str(), e[0].user.as_str(), e[0].port), ("203.0.113.10", "root", 22));
        assert_eq!(e[1].identity_files, vec!["~/.ssh/web1-root.pem"]);
        assert_eq!(e[2].identity_files, vec![r"C:\Users\me\.ssh\id_edge"]);
        assert_eq!(e[2].forwards.len(), 3);
        assert_eq!(e[2].forwards[0], Forward { bind_addr: "127.0.0.1".into(), local_port: 3000, remote_host: "127.0.0.1".into(), remote_port: 3000 });
        assert_eq!(e[2].forwards[2], Forward { bind_addr: "::1".into(), local_port: 3909, remote_host: "db.internal".into(), remote_port: 3909 });
        assert_eq!((e[3].port, e[3].user.as_str(), e[3].proxy_jump.as_deref()), (2222, "me", Some("web1")));

        let home = Path::new(r"C:\Users\me");
        assert_eq!(expand("~/.ssh/web1-root.pem", home), home.join(".ssh/web1-root.pem"));
        assert_eq!(expand("id_rsa", home), home.join(".ssh").join("id_rsa"));
    }
}
