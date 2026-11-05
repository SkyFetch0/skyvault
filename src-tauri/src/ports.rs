//! What a server listens on, read over SSH (`ss`/`netstat`, `docker ps`,
//! `incus list`) so the tunnel form can offer ports to pick. Nothing is
//! scanned: these are the server's own socket and container tables.

use std::collections::BTreeMap;

use serde::Serialize;

/// One remote command; each section is optional (no docker, no root, ...).
pub const SCRIPT: &str = "(ss -H -tlnp 2>/dev/null || ss -H -tln 2>/dev/null || netstat -tlnp 2>/dev/null || netstat -tln 2>/dev/null); \
echo @@DOCKER; docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null; \
echo @@DOCKERIP; docker ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}}|{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null; \
echo @@INCUS; incus list -c n4 -f csv 2>/dev/null; true";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ListenPort {
    pub port: u16,
    /// Bound addresses as reported (0.0.0.0, [::], 127.0.0.1, ...).
    pub addrs: Vec<String>,
    /// Address to use as the tunnel's remote host.
    pub target: String,
    pub process: String,
    /// Docker container that published this port, if any.
    pub container: Option<String>,
    /// Reachable from outside (bound to all interfaces), not only inside the server.
    pub public: bool,
    pub hint: Option<&'static str>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InnerTarget {
    /// "docker" | "incus"
    pub kind: &'static str,
    pub name: String,
    pub ips: Vec<String>,
    /// Container-side ports (exposed or published); empty if unknown.
    pub ports: Vec<u16>,
}

#[derive(Serialize, Debug)]
pub struct PortScan {
    pub ports: Vec<ListenPort>,
    pub targets: Vec<InnerTarget>,
    /// Socket tables are partial without root (no process names for other users).
    pub limited: bool,
}

fn hint(port: u16) -> Option<&'static str> {
    Some(match port {
        21 => "FTP",
        22 => "SSH",
        25 => "SMTP",
        53 => "DNS",
        80 => "HTTP",
        81 => "NPM admin?",
        443 => "HTTPS",
        3000 => "Web (Node/Grafana/Gitea)",
        3306 => "MySQL",
        5432 => "PostgreSQL",
        5601 => "Kibana",
        6379 => "Redis",
        8080 | 8081 | 8000 | 8888 => "Web",
        8123 => "ClickHouse HTTP",
        9000 => "ClickHouse / PHP-FPM",
        9090 => "Panel (SkyGuard/Cockpit)",
        9200 => "Elasticsearch",
        11211 => "Memcached",
        27017 => "MongoDB",
        _ => return None,
    })
}

/// "0.0.0.0:81" | "[::]:81" | "*:7722" | "127.0.0.1:9090" | "[fe80::1]%br0:53" -> (addr, port)
fn split_addr(s: &str) -> Option<(String, u16)> {
    let (addr, port) = s.rsplit_once(':')?;
    let port = port.parse().ok()?;
    let addr = addr.split('%').next()?.trim_start_matches('[').trim_end_matches(']').to_string();
    Some((addr, port))
}

fn is_any(a: &str) -> bool {
    matches!(a, "0.0.0.0" | "*" | "::" | "")
}

/// ss: users:(("sshd",pid=1,fd=3)) · netstat: 1234/sshd
fn process_of(tokens: &[&str]) -> String {
    let rest = tokens.get(5..).map(|t| t.join(" ")).unwrap_or_default();
    if let Some(i) = rest.find("((\"") {
        return rest[i + 3..].split('"').next().unwrap_or("").to_string();
    }
    tokens.last().and_then(|t| t.split_once('/')).map(|(_, n)| n.to_string()).unwrap_or_default()
}

pub fn parse_sockets(text: &str) -> Vec<ListenPort> {
    let mut by_port: BTreeMap<u16, ListenPort> = BTreeMap::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        // ss -H: LISTEN q q local peer [proc] · netstat: tcp q q local peer LISTEN [pid/proc]
        let local = match t.first() {
            Some(&"LISTEN") => t.get(3),
            Some(p) if p.starts_with("tcp") && t.get(5) == Some(&"LISTEN") => t.get(3),
            _ => None,
        };
        let Some((addr, port)) = local.and_then(|l| split_addr(l)) else { continue };
        if addr.starts_with("fe80") {
            continue; // link-local, only reachable on that interface
        }
        let process = if t[0] == "LISTEN" { process_of(&t) } else { t.get(6).and_then(|p| p.split_once('/')).map(|(_, n)| n.to_string()).unwrap_or_default() };
        let e = by_port.entry(port).or_insert_with(|| ListenPort {
            port,
            addrs: Vec::new(),
            target: String::new(),
            process: String::new(),
            container: None,
            public: false,
            hint: hint(port),
        });
        if !e.addrs.contains(&addr) {
            e.addrs.push(addr.clone());
        }
        if e.process.is_empty() {
            e.process = process;
        }
    }
    for p in by_port.values_mut() {
        p.public = p.addrs.iter().any(|a| is_any(a));
        let local = p.addrs.iter().any(|a| is_any(a) || a == "127.0.0.1" || a.starts_with("127."));
        p.target = if local {
            "127.0.0.1".into()
        } else if p.addrs.iter().any(|a| a == "::1") {
            "::1".into()
        } else {
            p.addrs.first().cloned().unwrap_or_default()
        };
    }
    by_port.into_values().collect()
}

fn port_range(s: &str) -> Vec<u16> {
    let (a, b) = s.split_once('-').unwrap_or((s, s));
    match (a.parse::<u16>(), b.parse::<u16>()) {
        (Ok(a), Ok(b)) if a <= b && b - a < 200 => (a..=b).collect(),
        _ => Vec::new(),
    }
}

/// `name|0.0.0.0:80-81->80-81/tcp, 9009/tcp` -> (host port -> container, container -> its ports)
fn parse_docker_ports(text: &str) -> (BTreeMap<u16, String>, BTreeMap<String, Vec<u16>>) {
    let mut published = BTreeMap::new();
    let mut inner: BTreeMap<String, Vec<u16>> = BTreeMap::new();
    for line in text.lines() {
        let Some((name, ports)) = line.split_once('|') else { continue };
        let own = inner.entry(name.to_string()).or_default();
        for p in ports.split(',').map(str::trim).filter(|p| p.ends_with("/tcp")) {
            let p = p.trim_end_matches("/tcp");
            let (host, cont) = match p.split_once("->") {
                Some((h, c)) => (Some(h), c),
                None => (None, p),
            };
            for c in port_range(cont) {
                if !own.contains(&c) {
                    own.push(c);
                }
            }
            if let Some(h) = host.and_then(|h| h.rsplit_once(':')) {
                for hp in port_range(h.1) {
                    published.entry(hp).or_insert_with(|| name.to_string());
                }
            }
        }
        own.sort_unstable();
    }
    (published, inner)
}

pub fn parse(output: &str) -> PortScan {
    let section = |name: &str| -> &str {
        let marker = format!("@@{name}\n");
        let Some(start) = output.find(&marker).map(|i| i + marker.len()) else { return "" };
        if output[start..].starts_with("@@") {
            return ""; // empty section
        }
        let end = output[start..].find("\n@@").map(|i| start + i + 1).unwrap_or(output.len());
        &output[start..end]
    };
    let sockets = output.split("@@DOCKER\n").next().unwrap_or("");
    let mut ports = parse_sockets(sockets);
    let limited = ports.iter().any(|p| p.process.is_empty());

    let (published, inner) = parse_docker_ports(section("DOCKER"));
    for p in &mut ports {
        if p.process == "docker-proxy" || p.process.is_empty() {
            p.container = published.get(&p.port).cloned();
        }
    }

    let mut targets = Vec::new();
    for line in section("DOCKERIP").lines() {
        let Some((name, ips)) = line.split_once('|') else { continue };
        let name = name.trim_start_matches('/').to_string();
        let ips: Vec<String> = ips.split_whitespace().map(String::from).collect();
        if ips.is_empty() {
            continue; // host network: its ports are already in the socket table
        }
        let ports = inner.get(&name).cloned().unwrap_or_default();
        targets.push(InnerTarget { kind: "docker", name, ips, ports });
    }
    // incus csv: name,"10.0.0.5 (eth0)\n172.17.0.1 (docker0)" (quoted multi-line when several)
    let mut cur: Option<InnerTarget> = None;
    for line in section("INCUS").lines() {
        let (name, rest) = match line.split_once(',') {
            Some((n, r)) => (Some(n), r),
            None => (None, line),
        };
        if let Some(n) = name {
            targets.extend(cur.take());
            cur = Some(InnerTarget { kind: "incus", name: n.trim_matches('"').to_string(), ips: Vec::new(), ports: Vec::new() });
        }
        if let (Some(t), Some(ip)) = (cur.as_mut(), rest.trim_matches('"').split_whitespace().next()) {
            if ip.parse::<std::net::Ipv4Addr>().is_ok() {
                t.ips.push(ip.to_string());
            }
        }
    }
    targets.extend(cur.filter(|t| !t.ips.is_empty()));
    targets.retain(|t| !t.ips.is_empty());
    PortScan { ports, targets, limited }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from a real `ss -H -tlnp` + docker/incus run on a Debian host.
    const SAMPLE: &str = r#"LISTEN 0      4096                          172.17.0.1:3049  0.0.0.0:* users:(("incusd",pid=1566086,fd=7),("incusd",pid=1566086,fd=3))
LISTEN 0      128                              0.0.0.0:22    0.0.0.0:* users:(("sshd",pid=1217351,fd=3))
LISTEN 0      4096                             0.0.0.0:81    0.0.0.0:* users:(("docker-proxy",pid=715181,fd=8))
LISTEN 0      4096                           127.0.0.1:9090  0.0.0.0:* users:(("panel",pid=3071587,fd=13))
LISTEN 0      4096                           127.0.0.1:3034  0.0.0.0:* users:(("docker-proxy",pid=133949,fd=8))
LISTEN 0      4096                                   *:7722        *:* users:(("incusd",pid=3169480,fd=7),("incusd",pid=3169480,fd=3))
LISTEN 0      128                                 [::]:22       [::]:* users:(("sshd",pid=1217351,fd=4))
LISTEN 0      4096                                [::]:81       [::]:* users:(("docker-proxy",pid=715189,fd=8))
LISTEN 0      32     [fe80::1266:6aff:feef:f6b7]%mybr0:53       [::]:* users:(("dnsmasq",pid=1209785,fd=11))
@@DOCKER
web-app|127.0.0.1:3034->3000/tcp
clickhouse|9009/tcp, 127.0.0.1:8124->8123/tcp, 127.0.0.1:9001->9000/tcp
nginx-app-1|0.0.0.0:80-81->80-81/tcp, [::]:80-81->80-81/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp
wireguard|0.0.0.0:51820->51820/udp, [::]:51820->51820/udp
panel|
@@DOCKERIP
/web-app|172.18.0.4
/clickhouse|172.19.0.2 172.20.0.3
/panel|
@@INCUS
mail-vm,10.17.217.10 (eth0)
game-vm,"10.17.217.20 (eth0)
172.17.0.1 (docker0)"
stopped-one,
"#;

    #[test]
    fn parses_real_output() {
        let s = parse(SAMPLE);
        let get = |p: u16| s.ports.iter().find(|x| x.port == p).unwrap();
        assert_eq!(s.ports.len(), 6, "{:?}", s.ports.iter().map(|p| p.port).collect::<Vec<_>>());
        assert!(!s.limited);

        let npm = get(81);
        assert_eq!((npm.target.as_str(), npm.public, npm.process.as_str()), ("127.0.0.1", true, "docker-proxy"));
        assert_eq!(npm.container.as_deref(), Some("nginx-app-1"));
        assert_eq!(npm.addrs, vec!["0.0.0.0", "::"]);

        let sg = get(9090);
        assert_eq!((sg.target.as_str(), sg.public, sg.process.as_str(), sg.container.as_ref()), ("127.0.0.1", false, "panel", None));
        assert_eq!(get(3034).container.as_deref(), Some("web-app"));
        assert_eq!(get(3049).target, "172.17.0.1"); // bound to one interface only
        assert!(get(7722).public);
        assert!(s.ports.iter().all(|p| p.port != 53)); // link-local skipped

        let ch = s.targets.iter().find(|t| t.name == "clickhouse").unwrap();
        assert_eq!(ch.ips, vec!["172.19.0.2", "172.20.0.3"]);
        assert_eq!(ch.ports, vec![8123, 9000, 9009]);
        assert!(!s.targets.iter().any(|t| t.name == "panel"));
        let x = s.targets.iter().find(|t| t.name == "game-vm").unwrap();
        assert_eq!((x.kind, x.ips.clone()), ("incus", vec!["10.17.217.20".to_string(), "172.17.0.1".to_string()]));
        assert!(s.targets.iter().any(|t| t.name == "mail-vm"));
        assert!(!s.targets.iter().any(|t| t.name == "stopped-one"));
    }

    #[test]
    fn parses_netstat_and_non_root() {
        let s = parse("tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd\ntcp6       0      0 :::8080                 :::*                    LISTEN      -\n@@DOCKER\n@@DOCKERIP\n@@INCUS\n");
        assert_eq!(s.ports.iter().map(|p| (p.port, p.process.as_str(), p.public)).collect::<Vec<_>>(), vec![(22, "sshd", true), (8080, "", true)]);
        assert!(s.limited);
        let s = parse("LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\n@@DOCKER\n");
        assert_eq!((s.ports[0].port, s.ports[0].process.as_str()), (5432, ""));
    }
}
