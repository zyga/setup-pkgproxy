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

# Stopping pkgproxy makes its unit write the archive of the cache that
# cache-dir holds (see "How the package cache is saved" below), owned by
# root: hand it to the runner user, as actions/cache/save runs unprivileged.
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

### How the package cache is saved

`cache-dir` is `/var/cache/pkgproxy-archive`, which holds an archive of
pkgproxy's cache, `cache.tar`, not the cache itself, which is in
`/var/cache/pkgproxy`. pkgproxy 0.12 keeps what it knows of each cached file
in an extended attribute of the file (`user.pkgproxy.meta`), and the `tar`
that `actions/cache` runs drops extended attributes; a file that lost its
attribute is downloaded again, so the cache would never help. So when
pkgproxy stops, its systemd unit writes the archive with `tar --xattrs`, and
the action unpacks a restored archive the same way. The steps above save
the archive with no change on your side, as long as they stop pkgproxy
first: without the stop there is no archive to save.

v1.2 moved to the archive, and with it the default `package-cache-key` from
`pkgproxy-cache-v3` to `pkgproxy-cache-v4`: the first run after the upgrade
starts cold on each CPU arch.

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
mirror is served on the same `addr` as apt/snap/go.

### LXD access on GitHub-hosted runners

The `lxd`, `lxd-remote`, `snapcraft`, `rockcraft` and `charmcraft` setups
below all talk to LXD, and so does the build tool itself. On GitHub-hosted
runners:

- `ubuntu-22.04` ships the LXD 5.0 snap; `ubuntu-24.04` and
  `ubuntu-24.04-arm` ship no LXD at all.
- The `runner` user is not in the `lxd` group, so `lxc` fails with
  `permission denied` on LXD's socket.
- `sudo usermod -aG lxd "$USER"` does not help later steps on its own:
  the runner starts every step with the groups it was started with.
  Run each command that needs LXD through `sg lxd -c '...'` instead.

So install LXD if needed, initialise it, and add the runner user to the
group once:

```yaml
- name: Install and initialise LXD
  run: |
    snap list lxd >/dev/null 2>&1 || sudo snap install lxd
    sudo lxd waitready
    sudo lxc storage list --format csv | grep -q . || sudo lxd init --auto
    sudo usermod -aG lxd "$USER"
```

and wrap every later LXD command in `sg lxd -c '...'`, as the examples
below do. Pass the address through `env:` rather than splicing
`${{ ... }}` into the single-quoted `sg` command.

This repository's CI runs exactly these steps, followed by a real
`snapcraft pack`, on all three runner images for every merge and release,
so a release is known to work on the images current at the time.

### lxd — containers as pkgproxy clients

Routes apt/snap/go traffic from *inside* LXD containers through pkgproxy —
the opposite direction from `lxd-remote` below. Used by anything that
launches build containers via LXD:

```yaml
- env:
    ADDR: ${{ steps.pkgproxy.outputs.addr }}
  run: sg lxd -c 'pkgproxyctl setup lxd -addr "$ADDR" | sh'
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
config you're setting up: the script refuses to run under `sudo`, so on a
GitHub-hosted runner `sg lxd` is the only way to give it LXD access:

```yaml
- env:
    ADDR: ${{ steps.pkgproxy.outputs.addr }}
  # lxc remote list first makes sure the LXD client config dir exists.
  run: sg lxd -c 'lxc remote list >/dev/null && pkgproxyctl setup lxd-remote -addr "$ADDR" | sh'
```

A plain `lxc remote add --accept-certificate` doesn't work for
`--protocol=simplestreams` (the flag is silently ignored) — this is why the
setup script exists at all: it pins pkgproxy's self-signed certificate for
you. Once added, pkgproxy also transparently proxies the exact remote names
`craft-providers` (snapcraft/rockcraft/charmcraft's LXD provisioner) already
uses for build-base images, so those tools get pkgproxy's cache for free
with no config on their side.

On LXD 6.10 and later, which downloads images only through image
registries, the script also adds a cluster link to pkgproxy and an image
registry for each remote. Those belong to the LXD server, not the user, so
every user of that LXD gets these remotes through pkgproxy.

### snapcraft, rockcraft, charmcraft — LXD build containers

`pkgproxyctl setup snapcraft` is `pkgproxyctl setup lxd -project snapcraft`
under the hood: snapcraft/craft-providers always builds in an LXD project
literally named `snapcraft`, so this shorthand saves you from needing to
know that convention. `setup rockcraft` and `setup charmcraft` do the same
for `rockcraft pack` and `charmcraft pack`. craft-providers creates its
project lazily, on the first build, so the setup script creates it first if
it does not exist yet, copying the `default` project's `default` profile as
craft-providers would. LXD must therefore already be initialised (for
example `lxd init --auto`) so that profile has a root disk and a NIC:

```yaml
- name: Configure pkgproxy for snapcraft build containers
  env:
    ADDR: ${{ steps.pkgproxy.outputs.addr }}
  run: sg lxd -c 'pkgproxyctl setup snapcraft -addr "$ADDR" | sh'
```

The same goes for the build itself, which also needs LXD:
`sg lxd -c 'snapcraft pack --use-lxd'`.

The profile carries everything in its own `raw.lxc`: a pre-start hook that
writes apt/snapd proxy configuration into the container, and a post-stop
hook that removes it, with no file on the LXD host. To fail early rather
than deep inside `snapcraft pack`, check that both hooks are in place:

```yaml
- name: Verify the pkgproxy LXC hooks are in the snapcraft profile
  run: |
    RAW_LXC=$(sg lxd -c 'lxc profile get default raw.lxc --project snapcraft')
    if ! printf '%s\n' "$RAW_LXC" | grep -q '^lxc.hook.pre-start = ' ||
       ! printf '%s\n' "$RAW_LXC" | grep -q '^lxc.hook.post-stop = '; then
      echo "::error::pkgproxy LXC hooks missing from the snapcraft project's default profile" >&2
      exit 1
    fi
```

A profile set up by pkgproxy 0.10.0 or earlier pointed at hook files on the
host that 0.11.0 no longer writes; run the setup command again to replace
it (`pkgproxyctl setup status | sh` reports this). This only matters for a
persistent LXD, such as a self-hosted runner; a fresh GitHub-hosted runner
always sets the profile up from scratch.

Add `lxd-remote` too (see above) if you also want pkgproxy's cache to serve
the build-base images craft-providers downloads, not just the apt/snap/go
traffic from inside the container — the two setups are independent and can
run in either order, as long as both finish before `snapcraft pack` runs.

## Inputs

| Input               | Default             | Description                                                               |
| ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `version`           | `v0.12.0`           | pkgproxy version to build (Go module version string, pinned not `@main`). |
| `go-version`        | `1.27.1`            | Go toolchain used to build pkgproxy on a binary-cache miss.               |
| `addr`              | `:3142`             | Address pkgproxy listens on.                                              |
| `binary-cache-key`  | `pkgproxy-bin`      | `actions/cache` key prefix for the built binary.                          |
| `package-cache-key` | `pkgproxy-cache-v4` | `actions/cache` key prefix for the payload cache.                         |
| `configure-host`    | `true`              | Whether to point the host's apt/snapd at the proxy.                       |

Bumping the pinned pkgproxy `version` is a one-file change here (this
action's `version` default) — callers that don't pass `version:` explicitly
pick it up automatically on their next `@v1` resolution.

## Outputs

| Output                      | Description                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `addr`                      | The resolved listen address (echoes the `addr` input).                                            |
| `cache-dir`                 | What to save at job end, after stopping pkgproxy: the directory holding the archive of the cache. |
| `package-cache-hit`         | `'true'` when the stable success key restored exactly.                                            |
| `package-cache-key-success` | Stable per-arch key to save under on success.                                                     |
| `package-cache-key-partial` | Stable per-arch key to save under when the job fails.                                             |

## Versioning

Releases are tagged `vX.Y.Z`, with a floating `vX` tag moved to the latest
release in that major version — pin to `zyga/setup-pkgproxy@v1` and get
compatible updates (including pkgproxy version bumps) automatically.

Each major version is maintained on its own long-lived branch,
`releases/vX`, from which its `vX.Y.Z` tags are cut. `main` is where the
next major version is developed: fixes and pkgproxy bumps for an existing
major version go to its `releases/vX` branch.
