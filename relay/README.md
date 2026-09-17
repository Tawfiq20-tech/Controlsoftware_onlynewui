# Onefinity Relay — deployment guide

The relay is a small Node service you host yourself. Machines connect **out** to it over `wss://`,
phones open its web app over `https://`, and it routes messages between them. It also handles
accounts, pairing, per-machine sharing, file staging, camera snapshots, rate limits and an audit
log. There is no third-party service in the path.

The relay is **not** the safety gate. Permission tiers, the deadman, the latency guard and the alarm
lock are enforced on the machine (see `REMOTE_ACCESS_DOCUMENTATION.md`). A fully compromised relay can
still only do what the machine operator has granted on the machine screen.

```
[Phone] --HTTPS/WSS--> [Caddy :443] --HTTP/WS--> [relay 127.0.0.1:8787] <--WSS (outbound)-- [Machine PC :4000] --USB--> [Board]
```

Contents: [1 Requirements](#1-requirements) · [2 VPS setup](#2-vps-setup-debian-or-ubuntu) ·
[3 Operations](#3-operations) · [4 Backups and restore](#4-backups-and-restore) ·
[5 Upgrades](#5-upgrades) · [6 Configuration reference](#6-configuration-reference) ·
[7 Local development and tests](#7-local-development-and-tests) ·
[8 What the relay host can see](#8-what-the-relay-host-can-see) · [9 Troubleshooting](#9-troubleshooting)

---

## 1. Requirements

| Item | Requirement |
|---|---|
| Server | Debian 12 or Ubuntu 22.04/24.04, x86-64 or arm64, 1 vCPU, 512 MB RAM is enough for a few machines |
| Node | 22.x, **≥ 22.13** (`node:sqlite` without a flag). 22.23.2 matches the machine runtime. `relay/package.json` accepts `>=22.13 <25` |
| DNS | An A/AAAA record (e.g. `relay.example.com`) pointing at the server |
| Ports | Inbound TCP 22, 80, 443. Port 8787 is never exposed |
| Reverse proxy | Caddy ≥ 2.7 (for `stream_close_delay`) |
| Dependencies | None to install. `ws` 8.21.3 is vendored in `relay/node_modules/ws`. `node:sqlite` is built in |

`node:sqlite` is still marked experimental in Node 22. It is used only in `server/store/db.js`, and
the Node version is pinned. Do not upgrade Node across major versions without running the relay test
suite first (§7).

---

## 2. VPS setup (Debian or Ubuntu)

Run everything as a sudo-capable user. Replace `relay.example.com` and `you@example.com` throughout.

### 2.1 Install Node

```sh
NODE_VERSION=v22.23.2
ARCH=x64            # arm64 on ARM servers
cd /tmp
curl -fsSLO https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz
curl -fsSLO https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt
grep " node-$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /opt/node
sudo tar -xJf node-$NODE_VERSION-linux-$ARCH.tar.xz -C /opt/node --strip-components=1
/opt/node/bin/node -v     # v22.23.2
```

### 2.2 Service user and directories

```sh
sudo useradd --system --home /var/lib/onefinity-relay --shell /usr/sbin/nologin onefinity-relay
```

- **Code:** `/opt/onefinity-relay` — a copy of the repository's `relay/` directory, including
  `node_modules/ws`, `server/`, `web/`, `deploy/` and `package.json`. `tests/` is optional.
- **Data:** `/var/lib/onefinity-relay` — created by systemd `StateDirectory=` (mode 0700, owned by
  the service user) on first start. Do not create it by hand as root.

Copy the code from a git checkout (Linux line endings matter for `deploy/backup.sh`):

```sh
git clone <your repository URL> /tmp/onefinity-src          # or scp/rsync the relay/ folder
sudo mkdir -p /opt/onefinity-relay
sudo cp -a /tmp/onefinity-src/relay/. /opt/onefinity-relay/
sudo rm -rf /opt/onefinity-relay/data                      # never ship a dev data dir
sudo chown -R root:root /opt/onefinity-relay
sudo chmod -R a+rX,go-w /opt/onefinity-relay
sudo sed -i 's/\r$//' /opt/onefinity-relay/deploy/backup.sh # only needed if copied from Windows
```

The code directory stays root-owned and read-only for the service; `ProtectSystem=strict` enforces
that at runtime as well.

### 2.3 Firewall

```sh
sudo ufw allow 22,80,443/tcp
sudo ufw allow 443/udp        # optional: HTTP/3 for page loads; WebSockets use TCP
sudo ufw enable
```

Port 80 must stay open: Caddy uses it for the ACME HTTP challenge and the HTTPS redirect. The relay
binds to `127.0.0.1:8787`, so it is unreachable from outside even without a firewall; do not open 8787.

### 2.4 Caddy

Install Caddy from its official apt repository (<https://caddyserver.com/docs/install#debian-ubuntu-raspbian>),
then:

```sh
sudo cp /opt/onefinity-relay/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/relay.example.com/relay.YOURDOMAIN/' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`deploy/Caddyfile`:

```
relay.example.com {
    encode gzip
    header -Server
    request_body {
        max_size 110MB
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
        header_up X-Forwarded-For {remote_host}
        stream_close_delay 5m
        transport http {
            keepalive 30s
        }
    }
    log {
        output file /var/log/caddy/relay-access.log
        format json
    }
}
```

Why each setting is there:

| Setting | Reason |
|---|---|
| automatic HTTPS | Caddy obtains and renews the certificate. The relay refuses a non-`https://` public URL unless it runs in loopback development mode |
| `request_body max_size 110MB` | Above the relay's own upload cap (`RELAY_MAX_UPLOAD_MB`, at most 100) so the relay, not Caddy, produces the error |
| `flush_interval -1` | Streams responses (file downloads to machines, JPEG snapshots) without buffering |
| `header_up X-Forwarded-For {remote_host}` | **Replaces** any client-supplied value. With `RELAY_TRUST_PROXY=1` the relay takes the last entry as the client IP, which is only trustworthy because Caddy overwrote it. Login lockouts and pairing limits are keyed on this IP |
| `transport http { keepalive 30s }` | Caddy's idle upstream connections must close **before** Node's `keepAliveTimeout` (65 s). Otherwise Caddy can reuse a connection Node has just closed, and because Caddy does not retry non-idempotent requests, uploads (`PUT`), pairing claims and logins fail with sporadic **502** errors |
| `stream_close_delay 5m` | On `caddy reload`, existing WebSockets stay open for up to 5 minutes instead of all machines and phones being disconnected at once |
| `log … format json` | Access log. No secrets appear in it: machines authenticate with a header and browsers with a cookie, never with URL parameters, and Caddy redacts `Cookie`/`Authorization` headers in logs |

WebSocket upgrades (`/ws/device`, `/ws/client`) pass through `reverse_proxy` with no extra config.

### 2.5 Environment file

```sh
sudo install -o root -g root -m 0600 /opt/onefinity-relay/deploy/relay.env.example /etc/onefinity-relay.env
sudoedit /etc/onefinity-relay.env      # set RELAY_PUBLIC_URL=https://relay.YOURDOMAIN
```

Required values for this setup (already set in the example): `RELAY_HOST=127.0.0.1`,
`RELAY_PORT=8787`, `RELAY_PUBLIC_URL=https://relay.example.com`, `RELAY_DATA_DIR=/var/lib/onefinity-relay`,
`RELAY_TRUST_PROXY=1`. Every variable is described in §6. The file is 0600 root; systemd reads it
before dropping privileges.

`RELAY_PUBLIC_URL` must be exactly the origin phones use (scheme + host, no trailing path). The relay
rejects browser WebSockets and state-changing requests whose `Origin` differs, and it gives machines a
`wss://` URL derived from it.

### 2.6 systemd unit

```sh
sudo cp /opt/onefinity-relay/deploy/onefinity-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onefinity-relay
sudo systemctl status onefinity-relay
curl -s http://127.0.0.1:8787/api/health        # {"ok":true,"version":"1.0.0","protocol":1}
curl -s https://relay.example.com/api/health
```

`deploy/onefinity-relay.service` runs `node server/index.js` as `onefinity-relay` with
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `UMask=0077`, write access
only to `/var/lib/onefinity-relay`, `LimitNOFILE=65536` and `MemoryMax=512M`. `TimeoutStopSec=20`
covers the relay's graceful shutdown: on SIGTERM it stops accepting connections, closes WebSockets
with 1001 "relay restarting" (machines reconnect with backoff), waits up to 10 s for uploads and
downloads, flushes the audit log, checkpoints the WAL and exits; it force-exits after 15 s.

If the configuration is invalid the service exits 1 and `journalctl -u onefinity-relay` shows one
`config error: …` line per problem.

### 2.7 First admin account

Signup defaults to **invite-only**, so nobody can register until an admin exists. Create the first
account with the CLI. **The first account created on a relay always becomes the relay admin**, with or
without `--admin` (the CLI prints `first account on this relay: granted admin`). Later accounts are
admins only when you pass `--admin`.

The service must have started once (§2.6) so the data directory exists. Run the CLI **as the service
user**; running it as root would leave root-owned SQLite `-wal`/`-shm` files that the relay cannot open.

```sh
sudo sh -c 'set -a; . /etc/onefinity-relay.env; set +a; \
  exec runuser -u onefinity-relay -- /opt/node/bin/node --disable-warning=ExperimentalWarning \
  /opt/onefinity-relay/server/cli.js create-user --email you@example.com --name "Your Name"'
```

It prompts twice for the password (10–200 characters, not echoed). For scripts, add
`--password-stdin` and pipe the password in.

To keep commands short, define a helper for the rest of this guide:

```sh
relay-cli() {
  sudo sh -c 'set -a; . /etc/onefinity-relay.env; set +a; \
    exec runuser -u onefinity-relay -- /opt/node/bin/node --disable-warning=ExperimentalWarning \
    /opt/onefinity-relay/server/cli.js "$@"' relay-cli "$@"
}
```

### 2.8 Backups

`deploy/backup.sh` makes an online copy of the database (`cli.js backup`, incremental so it never
stalls the running relay), a `tar.gz` of `blobs/` plus the `secret` file, and deletes sets older than
14 days. Output goes to `/var/lib/onefinity-relay/backups/relay-YYYY-MM-DD.db` and
`blobs-YYYY-MM-DD.tar.gz`.

Schedule it with a systemd timer:

```sh
sudo tee /etc/systemd/system/onefinity-relay-backup.service >/dev/null <<'EOF'
[Unit]
Description=Onefinity relay backup
[Service]
Type=oneshot
User=onefinity-relay
Group=onefinity-relay
EnvironmentFile=/etc/onefinity-relay.env
ExecStart=/bin/sh /opt/onefinity-relay/deploy/backup.sh
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/onefinity-relay
EOF
sudo tee /etc/systemd/system/onefinity-relay-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Onefinity relay backup
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now onefinity-relay-backup.timer
sudo systemctl start onefinity-relay-backup.service && journalctl -u onefinity-relay-backup -n 20
```

Alternatively, from root's crontab: `30 3 * * * /bin/sh /opt/onefinity-relay/deploy/backup.sh`. Run as
root, the script reads `/etc/onefinity-relay.env` and re-runs itself as `onefinity-relay`.
`KEEP_DAYS`, `APP_DIR`, `NODE` and `ENV_FILE` can be overridden in the environment.

**Copy backups off the server** (rsync, restic, object storage). The database is what matters:
accounts, machine pairings (credential hashes), sharing and audit. Uploaded files are not critical;
undelivered ones expire after 7 days anyway. The backups contain no plaintext passwords, session
tokens or machine credentials, only hashes. `secret` is the key that signs "known device" login
cookies; losing it only means users lose the lockout exemption until their next successful login.

### 2.9 Connect a machine

On the machine PC (the kiosk, opened as operator — see `REMOTE_ACCESS_DOCUMENTATION.md` §2):

1. **Settings → Cloud access → Cloud link:** Relay URL `https://relay.example.com` → **Save** → switch on
   **Connect to the relay** (LAN-only must be off).
2. **Pair with your account → Get pairing code.** An 8-character code `XXXX-XXXX` appears (valid 10 minutes;
   a new one is fetched automatically until you press Cancel).
3. On the phone, open `https://relay.example.com`, log in, tap **+ Add machine** and enter the code.
4. The kiosk shows **"Pair this machine with <name> (<masked email>)?"** while Settings → Cloud access is
   open. Press **Confirm** only if that is you or someone you trust. Nothing connects before Confirm;
   **Reject** deletes the claim.
5. The phone opens the machine page once the machine connects.

No Windows firewall rule or router port forward is needed on the machine side: it only makes an
outbound connection on TCP 443.

---

## 3. Operations

### 3.1 Service and logs

```sh
sudo systemctl status onefinity-relay
journalctl -u onefinity-relay -f             # JSON lines; tokens, codes and credentials are never logged
sudo tail -f /var/log/caddy/relay-access.log
```

### 3.2 CLI

All commands use the same environment (`RELAY_DATA_DIR`) as the server. Use the `relay-cli` helper
from §2.7.

| Command | Effect |
|---|---|
| `create-user --email <e> --name <n> [--admin] [--password-stdin]` | Create an account. The first account on the relay is always admin |
| `reset-password --email <e> [--password-stdin]` | Set a new password and revoke all of that user's sessions. The running relay closes their open WebSockets within about 2 s and cancels any jog they own |
| `list-users` | Tab-separated: id, email, display name, admin, active/disabled, created |
| `disable-user --email <e>` | Disable the account and revoke its sessions (live sockets closed as above) |
| `disable-user --email <e> --enable` | Re-enable it |
| `create-invite [--count N] [--days D]` | Print N (1–20, default 1) invite codes valid for D (1–30, default 7) days |
| `backup --out <file>` | Online database copy |

Admins can also create invite codes in the web app (**Account → Invite codes (admin)**), list users
(`GET /api/admin/users`) and disable users (`POST /api/admin/users/:id/disable`).

### 3.3 Signup modes

| `RELAY_SIGNUP` | Who can get an account |
|---|---|
| `invite` (default) | Anyone with an unused, unexpired invite code. Register is rate-limited (5 per IP per hour, 50 per hour globally) |
| `closed` | Only accounts created with `cli.js create-user` |
| `open` | Anyone who can reach the relay. The register form answers "email already taken", so it reveals which emails have accounts. Use only on a private relay |

### 3.4 Accounts, sharing and roles

- The account that claims a machine is its **owner**. The owner can rename, unpair, rotate its
  credential and share it (**Sharing & settings** page) by email with role **operator** or **viewer**.
- **viewer:** telemetry, camera, file list, and Stop. **operator:** also uploads files and sends job
  and motion commands. **owner:** operator plus management.
- The relay role is only the upper bound. What a remote user can actually do is decided on the
  machine: Monitor by default; Job control and Motion must be enabled on the machine screen.
- Sessions last 14 days of inactivity, 30 days at most. Users see and revoke their sessions under
  **Account → Signed-in devices**; revoking one closes its live connection immediately.
- Login protection: 5 failures for the same email from the same IP lock that pair for 15 minutes;
  repeated failures for one email add up to 2 s delay but never lock the owner out from a device they
  have signed in on before.

### 3.5 Machine credentials

- A machine authenticates with a 256-bit credential generated **on the machine**. The relay stores only
  its SHA-256.
- Credentials rotate automatically when older than `RELAY_CRED_ROTATE_DAYS` (default 90) at connect
  time, or on demand (**Rotate machine credential** on the Sharing & settings page, or
  `POST /api/devices/:id/rotate`; owner only; the machine must be online, otherwise 409 `offline`).
- **Unpair machine** on the web app's Sharing & settings page (owner) or from the machine (Settings → Cloud access → Unpair) revokes the
  credential; the machine stops reconnecting and must be paired again.

---

## 4. Backups and restore

Restore onto a fresh server installed per §2 (or the same server):

```sh
sudo systemctl stop onefinity-relay
D=/var/lib/onefinity-relay
sudo rm -f $D/relay.db-wal $D/relay.db-shm        # stale WAL files would corrupt the restored copy
sudo install -o onefinity-relay -g onefinity-relay -m 0600 /path/to/relay-YYYY-MM-DD.db $D/relay.db
sudo tar -C $D -xzf /path/to/blobs-YYYY-MM-DD.tar.gz   # optional: undelivered uploads + secret
sudo chown -R onefinity-relay:onefinity-relay $D && sudo chmod 700 $D
sudo systemctl start onefinity-relay
journalctl -u onefinity-relay -n 50
```

Machines reconnect on their own. Everything that changed after the backup is lost: accounts, shares
and pairings made later are gone, and a machine whose credential rotated after the backup was taken
shows `auth-failed` and must be paired again.

---

## 5. Upgrades

1. `sudo systemctl stop onefinity-relay`
2. Back up: `sudo systemctl start onefinity-relay-backup.service` (or run `deploy/backup.sh`), and copy the files off-host.
3. Replace `/opt/onefinity-relay` with the new `relay/` directory (§2.2). Keep `/etc/onefinity-relay.env`;
   compare it with the new `deploy/relay.env.example` for added variables. Re-copy `deploy/Caddyfile`
   and `deploy/onefinity-relay.service` if they changed (`systemctl daemon-reload`, `systemctl reload caddy`).
4. `sudo systemctl start onefinity-relay`. Database migrations run automatically at boot.
5. Check `journalctl -u onefinity-relay -n 50` and `curl -s https://relay.example.com/api/health`.

Machines and phones reconnect with backoff; nothing on the machine side needs to change. Upgrading
Node: install the new tarball to `/opt/node` only after the relay tests pass on that version (§7).

---

## 6. Configuration reference

Read from the environment by `server/config.js`. Invalid values print `config error: …` and exit 1.

| Variable | Default | Rule / meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Bind address |
| `RELAY_PORT` | `8787` | Bind port |
| `RELAY_PUBLIC_URL` | — (required) | Public origin phones open. Must be `https://…`; `http://127.0.0.1…` / `http://localhost…` only with `RELAY_ALLOW_INSECURE=1` |
| `RELAY_DATA_DIR` | `./data` (relative to the working directory) | Database, blobs, secret. Created with mode 0700 |
| `RELAY_TRUST_PROXY` | `0` | `1`: client IP = last `X-Forwarded-For` entry when the TCP peer is loopback |
| `RELAY_ALLOW_INSECURE` | `0` | `1`: allow `http://` for local development. Refused unless `RELAY_HOST` is loopback. Also drops `Secure`/`__Host-` cookies and HSTS |
| `RELAY_SIGNUP` | `invite` | `closed`, `invite` or `open` (§3.3) |
| `RELAY_MAX_UPLOAD_MB` | `25` | 1–100. Per file |
| `RELAY_USER_QUOTA_MB` | `1024` | Per account, files not yet delivered or expired |
| `RELAY_TOTAL_STORAGE_MB` | `5120` | All accounts; must be ≥ `RELAY_MAX_UPLOAD_MB` |
| `RELAY_MIN_FREE_DISK_MB` | `1024` | Below this free space, uploads get 507 and new pairings 503 |
| `RELAY_MAX_DEVICES_PER_USER` | `10` | 1–100 |
| `RELAY_MAX_LIVE_PAIRINGS` | `1000` | Unclaimed pairing codes relay-wide |
| `RELAY_FILE_TTL_DAYS` | `7` | Undelivered uploads expire (24 h for a machine that never connected) |
| `RELAY_SNAPSHOT_MAX_FPS` | `2` | 1–2 |
| `RELAY_SNAPSHOT_MAX_KB` | `300` | 50–500 |
| `RELAY_AUDIT_RETENTION_DAYS` | `180` | Daily sweep |
| `RELAY_CRED_ROTATE_DAYS` | `90` | `0` disables automatic rotation |
| `RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `RELAY_TURN_URLS`, `RELAY_TURN_SECRET` | unset | Reserved for a future WebRTC camera; ignored |

Fixed (not configurable): JSON bodies ≤ 64 KiB; delivered or rejected files are deleted from the relay
1 hour later; transfer records kept 90 days; pairing codes live 10 minutes and a claimed code must be
confirmed on the machine within 15 minutes.

---

## 7. Local development and tests

Run a relay on your PC (loopback only, plain HTTP):

```powershell
cd relay
$env:RELAY_PUBLIC_URL = 'http://127.0.0.1:8787'
$env:RELAY_ALLOW_INSECURE = '1'
$env:RELAY_DATA_DIR = "$env:TEMP\onefinity-relay-dev"
..\runtime\node.exe --disable-warning=ExperimentalWarning server\cli.js create-user --email dev@example.com --name Dev
..\runtime\node.exe --disable-warning=ExperimentalWarning server\index.js
```

Open `http://127.0.0.1:8787`. On the machine, the relay URL `http://127.0.0.1:8787` is accepted because
it is loopback. Never set `RELAY_ALLOW_INSECURE` on a server.

Tests (no network access, no fixed ports):

```powershell
runtime\node.exe --disable-warning=ExperimentalWarning relay\tests\run-all.js
runtime\node.exe backend\tests\cloud_link_e2e.test.js      # real relay + machine link + scripted phone
```

---

## 8. What the relay host can see

v1 has no end-to-end encryption between phone and machine. Whoever controls the server can see:

- account emails, display names and scrypt password hashes;
- machines, their names, sharing, online times and IP addresses;
- **all telemetry** (position, state, job name and progress), **all commands** and their results;
- **uploaded G-code files** in plaintext until they are delivered and deleted (1 h) or expire;
- **camera frames** (in memory only, never written to disk);
- the audit log.

It cannot see user passwords, session tokens or machine credentials (hashes only), the machine's LAN
access code or PIN, or anything on the machine outside the remote command set (settings, macros,
firmware, files that were not uploaded through the relay). It cannot change machine settings, send raw
G-code, clear alarms or grant itself Motion. A compromised relay could serve modified JavaScript to
phones; that still cannot exceed the tier granted on the machine screen.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service exits at start, `config error: RELAY_PUBLIC_URL must be https://` | Wrong or missing URL | Fix `/etc/onefinity-relay.env`, `systemctl restart onefinity-relay` |
| `config error: RELAY_ALLOW_INSECURE=1 is refused …` | Insecure mode on a non-loopback host | Set `RELAY_ALLOW_INSECURE=0` |
| `relay failed to start` … `EADDRINUSE` | Something else on 8787 | `ss -ltnp 'sport = :8787'` |
| `SQLITE_CANTOPEN` / `readonly database` after running the CLI | CLI ran as root and created root-owned `relay.db-wal`/`-shm` | `sudo chown onefinity-relay: /var/lib/onefinity-relay/*`; always run the CLI as the service user (§2.7) |
| Sporadic 502 on upload, login or Add machine | Proxy keep-alive race | Make sure the Caddyfile has `transport http { keepalive 30s }` (§2.4) |
| Everyone disconnects on every `caddy reload` | Old Caddy or missing `stream_close_delay` | Caddy ≥ 2.7 and `stream_close_delay 5m` |
| Phone login works but the machine page says "Reconnecting" forever | WebSocket rejected: `RELAY_PUBLIC_URL` differs from the address in the browser (Origin check) | Use exactly the public URL; do not open the relay by IP or another hostname |
| All users locked out / rate limited together | `RELAY_TRUST_PROXY` is 0 behind Caddy, so every client has IP 127.0.0.1 | Set `RELAY_TRUST_PROXY=1` |
| Login gives `locked` | 5 wrong passwords from that IP for that email | Wait 15 minutes, or `relay-cli reset-password --email …` |
| Register says sign-up closed / invite invalid | `RELAY_SIGNUP` is `closed`, or the code is used/expired | Create an invite (`relay-cli create-invite`) or the account (`create-user`) |
| Upload fails with 507 `insufficient_storage` | Disk below `RELAY_MIN_FREE_DISK_MB` or `RELAY_TOTAL_STORAGE_MB` reached | Free disk; old undelivered files expire after `RELAY_FILE_TTL_DAYS` |
| Upload fails with 413 `quota` | Account quota reached by undelivered files | Delete pending uploads on the Files page, or enable cloud Job control on the machine so they are delivered |
| Add machine: `code_invalid` | Wrong, expired (10 min) or already used code | Get a new code on the machine |
| Added machine disappears from the list | Operator pressed Reject, or did not confirm within 15 minutes | Get a new code and confirm on the kiosk |
| Machine shows `auth-failed` "pair again" | Relay does not recognise the credential (restored old backup, database lost) | Unpair on the machine and pair again |
| Machine shows `unpaired` after being online | Owner unpaired it on the web, or the credential was revoked | Pair again |
| Machine stuck in `backoff`, last error `Relay answered HTTP 502` | Relay service down behind Caddy | `systemctl status onefinity-relay` |
| Camera shows "No camera image" | Machine not sending frames (USB camera needs the kiosk page open), or frames above `RELAY_SNAPSHOT_MAX_KB` | Open the kiosk UI on the machine; check `journalctl` for `SNAPSHOT_REJECTED` |
