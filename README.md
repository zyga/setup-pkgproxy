# setup-pkgproxy

A composite GitHub Action that builds and runs
[pkgproxy](https://gitlab.com/zygoon/pkgproxy) as a caching proxy for apt,
snap store, Go module, Docker Hub image, and LXD image traffic on a GitHub Actions runner.

## What it does

1. Restores a cached `pkgproxy` binary (keyed on `version`, `go-version`, and
   runner arch), or builds it with `go install` on a cache miss.
2. Installs the binary to `/usr/local/bin/pkgproxy` (and a `pkgproxyctl`
   symlink — the binary dispatches on `argv[0]`).
3. Restores a persistent payload cache at `/var/cache/pkgproxy`.
4. Installs and starts a `pkgproxy.service` systemd unit. Its
   `RuntimeDirectory=`/`CacheDirectory=` directives create `/run/pkgproxy`
   and `/var/cache/pkgproxy` and own them appropriately.
5. Optionally points the host's `apt` and `snapd` at the proxy
   (`pkgproxyctl setup apt` / `setup snap`).

The caller is responsible for pointing any other tools at the proxy (e.g.
`pkgproxyctl setup snapcraft`, `pkgproxyctl setup lxd-remote`) and for saving
the payload cache at the end of the job.

## Usage

```yaml
- name: Set up pkgproxy caching proxy
  id: pkgproxy
  uses: zyga/setup-pkgproxy@v1
  # version: defaults to this action's pinned pkgproxy release; only pass it
  # to override.

# ... later, after the job's real work:

# pkgproxy.service runs as root, so everything under cache-dir is root-owned
# while the daemon is up. Stop it and hand the directory back to the runner
# user first, or actions/cache/save (which runs unprivileged) can fail to
# read it.
- name: Prepare pkgproxy cache for saving
  if: always()
  shell: bash
  run: |
    sudo systemctl stop pkgproxy.service || true
    sudo chown -R "$USER:$USER" ${{ steps.pkgproxy.outputs.cache-dir }}

# Save only on a miss (GitHub caches are immutable, so re-saving an exact
# hit is wasted writes) — restore-keys already lets a partial cache warm
# the next run:
- if: steps.pkgproxy.outputs.package-cache-hit != 'true'
  uses: actions/cache/save@v6
  with:
    path: ${{ steps.pkgproxy.outputs.cache-dir }}
    key: ${{ steps.pkgproxy.outputs.package-cache-key-success }}
```

If the job can fail after the cache is warmed but before it would normally
be saved, save under `package-cache-key-partial` instead in an `if: failure()`
step, so the next run's `restore-keys` fallback still picks up that partial
progress.

## Setting up each proxy client

`configure-host: true` (the default) already runs `pkgproxyctl setup apt` and
`pkgproxyctl setup snap` on the runner for you. Everything below is what you
run yourself with `${{ steps.pkgproxy.outputs.addr }}`, for the remaining
targets — or for apt/snap too if you set `configure-host: false` (e.g.
because you want to configure a container instead of the host).

### apt

```yaml
- run: pkgproxyctl setup apt -addr "${{ steps.pkgproxy.outputs.addr }}" | sudo sh
```

Not needed if `configure-host` is left at its default `true`.

### snap

```yaml
- run: pkgproxyctl setup snap -addr "${{ steps.pkgproxy.outputs.addr }}" | sudo sh
```

Not needed if `configure-host` is left at its default `true`.

### go

```yaml
- run: pkgproxyctl setup go -addr "${{ steps.pkgproxy.outputs.addr }}" | sh
```

Points `GOPROXY` at pkgproxy for the invoking user (`go env -w`, a per-user
config file — no `sudo` needed).

### docker

```yaml
- run: pkgproxyctl setup docker -addr "${{ steps.pkgproxy.outputs.addr }}" | sudo sh
```

Adds pkgproxy as a Docker Hub registry mirror in the Docker daemon's
`daemon.json` and **restarts the Docker daemon**, which is why it is not part
of `configure-host`. Only anonymous pulls of public images are cached; the
mirror is served on the same `addr` as apt/snap/go. Needs `jq` if a
`daemon.json` already exists.

### lxd — containers as pkgproxy clients

Routes apt/snap/go traffic from *inside* LXD containers through pkgproxy —
the opposite direction from `lxd-remote` below. Used by anything that
launches build containers via LXD:

```yaml
- run: pkgproxyctl setup lxd -addr "${{ steps.pkgproxy.outputs.addr }}" | sudo sh
```

With no `-project`, this creates a standalone `pkgproxy` LXD profile that you
attach explicitly (`lxc launch ... --profile pkgproxy`, or add it to a
container's profile list). Pass `-project <name>` instead to patch that
project's `default` profile directly, so every container launched in it uses
pkgproxy automatically — see `snapcraft` below, which is exactly this with
`-project snapcraft` hardwired in.

### lxd-remote — LXD itself as a pkgproxy client

Adds pkgproxy as a cached LXD image-server remote (`lxc remote add`) — the
opposite direction from `lxd`/`snapcraft`. Run as the user whose LXD client
config you're setting up (no `sudo`):

```yaml
- run: |
    lxc remote list >/dev/null  # make sure the LXD client config dir exists first
    pkgproxyctl setup lxd-remote -addr "${{ steps.pkgproxy.outputs.addr }}" | sh
```

A plain `lxc remote add --accept-certificate` doesn't work for
`--protocol=simplestreams` (the flag is silently ignored) — this is why the
setup script exists at all: it pins pkgproxy's self-signed certificate for
you. Once added, pkgproxy also transparently proxies the exact remote names
`craft-providers` (snapcraft/rockcraft/charmcraft's LXD provisioner) already
uses for build-base images, so those tools get pkgproxy's cache for free
with no config on their side.

### snapcraft — extra steps required

`pkgproxyctl setup snapcraft` is `pkgproxyctl setup lxd -project snapcraft`
under the hood: snapcraft/craft-providers always builds in an LXD project
literally named `snapcraft`, so this shorthand saves you from needing to
know that convention. But craft-providers creates that project **lazily**,
only when `snapcraft pack` first needs it — so unlike the plain `lxd` case,
you must pre-create the project and its `default` profile's network/disk
devices yourself first, or `setup snapcraft` has no profile to patch:

```yaml
- name: Pre-create the snapcraft LXD project
  run: |
    lxc project create snapcraft || true
    lxc profile device add default root disk path=/ pool=default --project snapcraft || true
    lxc profile device add default eth0 nic network=lxdbr0 name=eth0 --project snapcraft || true

- name: Configure pkgproxy for snapcraft build containers
  run: pkgproxyctl setup snapcraft -addr "${{ steps.pkgproxy.outputs.addr }}" | sudo sh
```

Then **verify it actually took**, before running `snapcraft pack`. The setup
step injects a `raw.lxc` pre-start hook into the profile; if that hook is
missing or not executable, the failure won't surface here — it surfaces
minutes later, deep inside the build, as an opaque `lxd forkstart ... exit
status 1`:

```yaml
- name: Verify the LXC pre-start hook was provisioned
  run: |
    HOOK_PATH=$(lxc profile get default raw.lxc --project snapcraft | sed -n 's/^lxc.hook.pre-start = //p')
    if [ -z "$HOOK_PATH" ] || ! sudo test -x "$HOOK_PATH"; then
      echo "::error::pkgproxy pre-start hook not provisioned/executable at '${HOOK_PATH}'" >&2
      exit 1
    fi
```

Add `lxd-remote` too (see above) if you also want pkgproxy's cache to serve
the build-base images craft-providers downloads, not just the apt/snap/go
traffic from inside the container — the two setups are independent and can
run in either order, as long as both finish before `snapcraft pack` runs.

## Inputs

| Input               | Default             | Description                                                               |
| ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `version`           | `v0.8.0`            | pkgproxy version to build (Go module version string, pinned not `@main`). |
| `go-version`        | `1.27.1`            | Go toolchain used to build pkgproxy on a binary-cache miss.               |
| `addr`              | `:3142`             | Address pkgproxy listens on.                                              |
| `binary-cache-key`  | `pkgproxy-bin`      | `actions/cache` key prefix for the built binary.                          |
| `package-cache-key` | `pkgproxy-cache-v3` | `actions/cache` key prefix for the payload cache.                         |
| `configure-host`    | `true`              | Whether to point the host's apt/snapd at the proxy.                       |

Bumping the pinned pkgproxy `version` is a one-file change here (this
action's `version` default) — callers that don't pass `version:` explicitly
pick it up automatically on their next `@v1` resolution.

## Outputs

| Output                      | Description                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `addr`                      | The resolved listen address (echoes the `addr` input).                      |
| `cache-dir`                 | The payload cache directory (`/var/cache/pkgproxy`) — save this at job end. |
| `package-cache-hit`         | `'true'` when the stable success key restored exactly.                      |
| `package-cache-key-success` | Stable per-arch key to save under on success.                               |
| `package-cache-key-partial` | Stable per-arch key to save under when the job fails.                       |

## Versioning

Releases are tagged `vX.Y.Z`, with a floating `vX` tag moved to the latest
release in that major version — pin to `zyga/setup-pkgproxy@v1` and get
compatible updates (including pkgproxy version bumps) automatically.
