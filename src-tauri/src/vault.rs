//! Encrypted vault: Argon2id key derivation + AES-256-GCM.
//!
//! On-disk format (JSON envelope):
//!   { "v":1, "kdf":{"m":..,"t":..,"p":..,"salt":b64}, "nonce":b64, "ct":b64 }
//! The envelope header (version + kdf params) is bound as AAD, so tampering
//! with parameters breaks decryption. Plaintext never touches the disk.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, anyhow, bail};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const VERSION: u32 = 1;
const KDF_M_KIB: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;

// ---------- data model (everything here is secret) ----------

#[derive(Serialize, Deserialize, Clone, Default, Zeroize, ZeroizeOnDrop)]
pub struct VaultData {
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub keys: Vec<SshKey>,
    #[serde(default)]
    pub tunnels: Vec<Tunnel>,
    #[serde(default)]
    pub secrets: Vec<Secret>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub git_accounts: Vec<GitAccount>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "key" | "password"
    pub auth: String,
    pub key_id: Option<String>,
    pub password: Option<String>,
    pub notes: String,
    /// SHA256 fingerprint of the trusted server host key (TOFU, confirmed by user).
    pub host_key_fp: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct SshKey {
    pub id: String,
    pub name: String,
    /// OpenSSH / PEM / PPK private key text.
    pub private_key: String,
    pub passphrase: Option<String>,
    pub public_key: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub created: u64,
    /// Offered by the built-in ssh-agent (git, ssh, VS Code).
    #[serde(default = "yes")]
    pub agent: bool,
}

fn yes() -> bool {
    true
}

/// Password-manager style entry.
#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct Secret {
    pub id: String,
    pub title: String,
    pub group: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub updated: u64,
}

#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub updated: u64,
}

/// A git remote identity, written to ~/.ssh/config as a host alias
/// (e.g. `github-work` -> github.com with a specific key).
#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct GitAccount {
    pub id: String,
    pub name: String,
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub key_id: String,
    pub host_key_fp: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Zeroize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub bind_addr: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub auto_start: bool,
}

#[derive(Serialize, Deserialize, Clone, Zeroize)]
#[serde(default)]
pub struct Settings {
    pub auto_lock_minutes: u32,
    pub close_on_lock: bool,
    pub agent_enabled: bool,
    /// Ask before every agent signature (cached per key for a few minutes).
    pub agent_confirm: bool,
    pub clipboard_clear_secs: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto_lock_minutes: 10, close_on_lock: false, agent_enabled: true, agent_confirm: true, clipboard_clear_secs: 30 }
    }
}

// ---------- envelope ----------

#[derive(Serialize, Deserialize)]
struct KdfParams {
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u32,
    kdf: KdfParams,
    nonce: String,
    ct: String,
}

fn aad(v: u32, kdf: &KdfParams) -> Vec<u8> {
    format!("skyvault|v={}|m={}|t={}|p={}|salt={}", v, kdf.m, kdf.t, kdf.p, kdf.salt).into_bytes()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    b
}

fn derive_key(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| anyhow!("argon2: {e}"))?;
    Ok(out)
}

/// An unlocked vault held in memory. Key and data are wiped on drop.
pub struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    path: PathBuf,
    pub data: VaultData,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        self.salt.zeroize();
    }
}

impl Unlocked {
    pub fn create(path: &Path, password: &str) -> Result<Self> {
        if path.exists() {
            bail!(msg!("vault_exists"));
        }
        let salt = random::<16>();
        let key = derive_key(password, &salt, KDF_M_KIB, KDF_T, KDF_P)?;
        let v = Self { key, salt, path: path.to_path_buf(), data: VaultData::default() };
        v.save()?;
        Ok(v)
    }

    pub fn open(path: &Path, password: &str) -> Result<Self> {
        let raw = std::fs::read_to_string(path).context(msg!("vault_read"))?;
        let env: Envelope = serde_json::from_str(&raw).context(msg!("vault_corrupt"))?;
        if env.v != VERSION {
            bail!(msg!("vault_version", env.v));
        }
        let salt_vec = B64.decode(&env.kdf.salt)?;
        let salt: [u8; 16] = salt_vec.as_slice().try_into().map_err(|_| anyhow!("salt"))?;
        let nonce_vec = B64.decode(&env.nonce)?;
        let nonce_arr: [u8; 12] = nonce_vec.as_slice().try_into().map_err(|_| anyhow!("nonce"))?;
        let ct = B64.decode(&env.ct)?;

        let key = derive_key(password, &salt, env.kdf.m, env.kdf.t, env.kdf.p)?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| anyhow!("key"))?;
        let aad = aad(env.v, &env.kdf);
        let pt = Zeroizing::new(
            cipher
                .decrypt(&Nonce::from(nonce_arr), Payload { msg: &ct, aad: &aad })
                .map_err(|_| anyhow!(msg!("wrong_password")))?,
        );
        let data: VaultData = serde_json::from_slice(&pt).context(msg!("vault_decrypt"))?;
        Ok(Self { key, salt, path: path.to_path_buf(), data })
    }

    /// Re-encrypts with a fresh nonce and writes atomically (tmp + rename).
    pub fn save(&self) -> Result<()> {
        let kdf = KdfParams { m: KDF_M_KIB, t: KDF_T, p: KDF_P, salt: B64.encode(self.salt) };
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref()).map_err(|_| anyhow!("key"))?;
        let nonce = random::<12>();
        let pt = Zeroizing::new(serde_json::to_vec(&self.data)?);
        let aad = aad(VERSION, &kdf);
        let ct = cipher
            .encrypt(&Nonce::from(nonce), Payload { msg: &pt, aad: &aad })
            .map_err(|_| anyhow!(msg!("encrypt_failed")))?;
        let env = Envelope { v: VERSION, kdf, nonce: B64.encode(nonce), ct: B64.encode(ct) };

        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&env)?)?;
        if self.path.exists() {
            let bak = self.path.with_extension("bak");
            let _ = std::fs::copy(&self.path, bak);
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        self.salt = random::<16>();
        self.key = derive_key(new_password, &self.salt, KDF_M_KIB, KDF_T, KDF_P)?;
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_password() {
        let dir = std::env::temp_dir().join(format!("skyvault-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("vault.skv");
        {
            let mut v = Unlocked::create(&path, "dogru-sifre").unwrap();
            v.data.hosts.push(Host { id: "h1".into(), name: "web1".into(), ..Default::default() });
            v.save().unwrap();
        }
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("web1"), "plaintext leaked to disk");

        let v = Unlocked::open(&path, "dogru-sifre").unwrap();
        assert_eq!(v.data.hosts[0].name, "web1");
        assert!(Unlocked::open(&path, "yanlis").is_err());

        let mut v = v;
        v.change_password("yeni").unwrap();
        drop(v);
        assert!(Unlocked::open(&path, "dogru-sifre").is_err());
        assert_eq!(Unlocked::open(&path, "yeni").unwrap().data.hosts.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
