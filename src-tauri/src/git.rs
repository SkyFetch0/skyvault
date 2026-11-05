//! Git integration: host aliases in ~/.ssh/config that pin a vault key
//! (by its public half) to a remote, and pointing git at Windows OpenSSH so
//! it can talk to the built-in agent.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result, bail};

const BEGIN: &str = "# >>> SkyVault (managed block, do not edit)";
const END: &str = "# <<< SkyVault";
/// Marker written by early builds; still recognized so the block is replaced, not duplicated.
const LEGACY_BEGIN: &str = "# >>> SkyVault (otomatik yönetilir, elle düzenlemeyin)";
pub const WINDOWS_SSH: &str = "C:/Windows/System32/OpenSSH/ssh.exe";

pub struct Alias {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub public_key: String,
}

/// ~/.ssh, overridable with SKYVAULT_SSH_DIR for tests.
pub fn ssh_dir() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("SKYVAULT_SSH_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).context(msg!("home_not_found"))?;
    Ok(PathBuf::from(home).join(".ssh"))
}

pub fn valid_alias(a: &str) -> bool {
    !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

pub(crate) fn strip_block(config: &str) -> String {
    let mut out = Vec::new();
    let mut inside = false;
    for line in config.lines() {
        if line.trim() == BEGIN || line.trim() == LEGACY_BEGIN {
            inside = true;
        } else if line.trim() == END {
            inside = false;
        } else if !inside {
            out.push(line);
        }
    }
    out.join("\n").trim_end().to_string()
}

/// Aliases already declared by the user outside our block (theirs would win).
pub fn conflicts(aliases: &[String]) -> Result<Vec<String>> {
    let path = ssh_dir()?.join("config");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let user = strip_block(&text);
    let mut found = Vec::new();
    for line in user.lines() {
        let l = line.trim();
        if l.len() > 5 && l[..5].eq_ignore_ascii_case("host ") {
            for name in l[5..].split_whitespace() {
                if aliases.iter().any(|a| a == name) && !found.contains(&name.to_string()) {
                    found.push(name.to_string());
                }
            }
        }
    }
    Ok(found)
}

/// Rewrites the managed block and the public-key files it references.
/// Only public keys are written; private keys stay in the vault/agent.
pub fn apply(aliases: &[Alias], agent_pipe: Option<&str>) -> Result<PathBuf> {
    let dir = ssh_dir()?;
    let keys_dir = dir.join("skyvault");
    std::fs::create_dir_all(&keys_dir)?;
    for e in std::fs::read_dir(&keys_dir)?.flatten() {
        if e.path().extension().is_some_and(|x| x == "pub") {
            let _ = std::fs::remove_file(e.path());
        }
    }

    let mut block = vec![BEGIN.to_string()];
    for a in aliases {
        if !valid_alias(&a.alias) {
            bail!(msg!("alias_invalid", a.alias));
        }
        let pubfile = keys_dir.join(format!("{}.pub", a.alias));
        std::fs::write(&pubfile, format!("{}\n", a.public_key.trim()))?;
        block.push(format!("Host {}", a.alias));
        block.push(format!("    HostName {}", a.hostname));
        if a.port != 22 {
            block.push(format!("    Port {}", a.port));
        }
        block.push(format!("    User {}", a.user));
        block.push(format!("    IdentityFile \"{}\"", pubfile.display().to_string().replace('\\', "/")));
        block.push("    IdentitiesOnly yes".into());
        if let Some(p) = agent_pipe {
            block.push(format!("    IdentityAgent {p}"));
        }
        block.push(String::new());
    }
    block.push(END.to_string());

    let path = dir.join("config");
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    let bak = dir.join("config.skyvault.bak");
    if !old.is_empty() && !bak.exists() {
        std::fs::write(&bak, &old)?;
    }
    let mut new = strip_block(&old);
    if !aliases.is_empty() {
        if !new.is_empty() {
            new.push_str("\n\n");
        }
        new.push_str(&block.join("\n"));
    }
    new.push('\n');
    let tmp = path.with_extension("skyvault.tmp");
    std::fs::write(&tmp, new)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

fn git() -> Command {
    let mut c = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

pub fn ssh_command() -> Option<String> {
    let out = git().args(["config", "--global", "core.sshCommand"]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

pub fn git_found() -> bool {
    git().arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Normalizes what the user typed into something git's sh will run:
/// backslashes become slashes and an existing path with spaces gets quoted.
pub fn normalize_ssh_command(v: &str) -> Result<String> {
    let v = v.trim();
    if v.is_empty() || v.contains(['\n', '\r']) {
        bail!(msg!("command_invalid"));
    }
    let v = v.replace('\\', "/");
    if v.contains(' ') && !v.starts_with('"') && std::path::Path::new(&v).is_file() {
        return Ok(format!("\"{v}\""));
    }
    Ok(v)
}

/// Sets global core.sshCommand, or removes it (None) so git uses its own ssh.
pub fn set_ssh_command(value: Option<&str>) -> Result<()> {
    let mut c = git();
    c.args(["config", "--global"]);
    match value {
        Some(v) => c.args(["core.sshCommand", &normalize_ssh_command(v)?]),
        None => c.args(["--unset", "core.sshCommand"]),
    };
    let st = c.status().context(msg!("git_not_found"))?;
    // --unset exits 5 when nothing was set, which is already the goal.
    if !st.success() && !(value.is_none() && st.code() == Some(5)) {
        bail!(msg!("git_config_failed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_block_is_replaced_not_duplicated() {
        let dir = std::env::temp_dir().join(format!("skyvault-ssh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: test-only env override, single test touching it.
        unsafe { std::env::set_var("SKYVAULT_SSH_DIR", &dir) };
        let legacy = format!("{LEGACY_BEGIN}\nHost gh-work\n    HostName old\n{END}\n");
        std::fs::write(dir.join("config"), format!("Host mine\n    HostName example.com\n\n{legacy}")).unwrap();

        let a = |alias: &str| Alias {
            alias: alias.into(),
            hostname: "github.com".into(),
            port: 22,
            user: "git".into(),
            public_key: "ssh-ed25519 AAAA test".into(),
        };
        apply(&[a("gh-work")], None).unwrap();
        apply(&[a("gh-work"), a("gh-home")], Some(FALLBACK)).unwrap();
        let cfg = std::fs::read_to_string(dir.join("config")).unwrap();
        assert_eq!(cfg.matches(BEGIN).count(), 1);
        assert!(cfg.starts_with("Host mine\n"));
        assert!(cfg.contains("Host gh-home") && cfg.contains("IdentitiesOnly yes"));
        assert!(cfg.contains("IdentityAgent "));
        assert!(dir.join("skyvault/gh-home.pub").exists());
        assert_eq!(conflicts(&["mine".into(), "gh-work".into()]).unwrap(), vec!["mine".to_string()]);

        apply(&[], None).unwrap();
        let cfg = std::fs::read_to_string(dir.join("config")).unwrap();
        assert_eq!(cfg, "Host mine\n    HostName example.com\n");
        assert!(!dir.join("skyvault/gh-home.pub").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ssh_command_is_normalized() {
        assert_eq!(normalize_ssh_command(r"C:\Windows\System32\OpenSSH\ssh.exe").unwrap(), WINDOWS_SSH);
        assert_eq!(normalize_ssh_command("  ssh -v ").unwrap(), "ssh -v");
        assert!(normalize_ssh_command("ssh\nrm -rf").is_err());
        assert!(normalize_ssh_command(" ").is_err());
    }

    const FALLBACK: &str = crate::agent::FALLBACK_PIPE;
}
