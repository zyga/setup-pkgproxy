# setup-pkgproxy

A GitHub Action that builds and runs
[pkgproxy](https://gitlab.com/zygoon/pkgproxy) as a caching proxy for apt,
snap store, Go module, Docker Hub image, and LXD image traffic on a GitHub
Actions runner, and saves its cache at the end of the job.

## What it does

1. Restores a cached `pkgproxy` binary (keyed on `version`, `go-version`, and
   runner arch), or builds it with `go install` on a cache miss, with Go
   from the runner's tool cache or from go.dev.
2. Installs the binary to `/usr/local/bin/pkgproxy` (and a `pkgproxyctl`
   symlink — the binary dispatches on `argv[0]`).
3. Restores the newest package cache for this arch to `/var/cache/pkgproxy`.
4. Installs and starts a `pkgproxy.service` systemd unit. Its
   `RuntimeDirectory=`/`CacheDirectory=` directives create `/run/pkgproxy`
   and `/var/cache/pkgproxy` and own them appropriately.
5. Optionally points the host's `apt` and `snapd` at the proxy
   (`pkgproxyctl setup apt` / `setup snap`).
6. At the end of the job, passed or failed, stops pkgproxy and saves the
   package cache, if the job added to it, under a key unique to the job.
   The job summary shows what was restored and saved, and `pkgproxyctl
   stats`.

The caller is responsible for pointing any other tools at the proxy (e.g.
`pkgproxyctl setup snapcraft`, `pkgproxyctl setup lxd-remote`).

## Usage

```yaml
- name: Set up pkgproxy caching proxy
  id: pkgproxy
  uses: zyga/setup-pkgproxy@v2
  # version: defaults to this action's pinned pkgproxy release; only pass it
  # to override.
```

`id: pkgproxy` is the step's id, which GitHub Actions uses to name a step
so that later steps can read its [outputs](#outputs): every example below
passes `${{ steps.pkgproxy.outputs.addr }}` to `pkgproxyctl setup`. It is
optional, and `pkgproxy` is only a convention; with another id, use that in
the `steps.<id>.outputs` references.

That is all: there is no save step to add. **Only runs on the default
branch save the cache**, though, so make sure your workflow also runs on
pushes to it:

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

### Which runs save the cache

By default (`save-package-cache: default-branch`), only runs on the
repository's default branch save the package cache. Pull requests, other
branches and tags restore it, and never save one of their own. This
follows from how GitHub scopes caches:

- A run can restore caches saved on **its own ref**, on **its pull request's
  base branch**, and on **the default branch**: never those of another pull
  request or branch.
- The default branch's cache is the only one every run can restore. One saved
  by a pull request helps only that pull request's later runs.
- Every saved cache counts against the repository's cache storage (10 GB by
  default), and GitHub evicts the least recently used first. The package
  cache of a single snap build is several hundred MB (this repository's CI
  saves 540–660 MiB), so a few pull requests saving their own would soon
  evict the default branch's, and every run would start cold.

So if your workflow only runs on `pull_request`, nothing ever saves, and every
run starts cold: add a `push` trigger for the default branch, as above.

| `save-package-cache` | Saves on                | Use when                                                                                 |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `default-branch`     | the default branch only | almost always (the default)                                                              |
| `always`             | every ref               | long-lived branches whose runs should warm each other, such as a `releases/v1` branch    |
| `never`              | nothing                 | jobs that should only read the cache, such as a matrix's extra jobs on the same CPU arch |

Whatever the setting, a job that added nothing to the cache saves nothing, and
the job summary says what was restored, whether the cache was saved, and why.

A matrix with several jobs on the same CPU arch (say `ubuntu-22.04` and
`ubuntu-24.04`) saves one copy per job that added to the cache. They share
a cache, so give all but one of them `save-package-cache: never`.

### How the package cache is kept

GitHub caches cannot be overwritten, so a run that saves uses a key of its
own, `<package-cache-key>-<arch>-<run id>-<attempt>-<job>-<random>`, and the
next job restores the newest cache it can see under
`<package-cache-key>-<arch>-`. The cache therefore keeps up with what your
jobs download, and GitHub evicts the old copies (caches unused for 7 days,
and the oldest beyond the repository's size limit).

The key holds the CPU arch and nothing else, on purpose: runners of every
Ubuntu release share one cache, and so do changes to `snapcraft.yaml` or a
lockfile. pkgproxy revalidates what can change upstream, so an older cache
is still a warm one.

A job that adds nothing, because everything it needed was already cached,
saves nothing. The check compares the paths and sizes of the cache's files
right after restore and at the end of the job, ignoring pkgproxy's
`stats.json`. A failed or cancelled job's cache is saved too: what pkgproxy
cached is valid, only less complete.

### Upgrading from v1

- Delete the "Prepare pkgproxy cache for saving" and `actions/cache/save`
  steps: the action saves the cache itself, and a save of your own would
  only fail with "cache already exists" or upload the cache twice.
- v1 saved wherever your save step ran, pull requests included. v2 saves on
  the default branch only, unless you say otherwise: see
  [Which runs save the cache](#which-runs-save-the-cache).
- The outputs `package-cache-hit`, `package-cache-key-success` and
  `package-cache-key-partial` are gone; see [Outputs](#outputs).
- `package-cache-key` keeps its default, so the cache v1 saved warms the
  first v2 run.

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

| Input                | Default             | Description                                                               |
| -------------------- | ------------------- | ------------------------------------------------------------------------- |
| `version`            | `v0.11.0`           | pkgproxy version to build (Go module version string, pinned not `@main`). |
| `go-version`         | `1.27.1`            | Go toolchain used to build pkgproxy on a binary-cache miss.               |
| `addr`               | `:3142`             | Address pkgproxy listens on.                                              |
| `binary-cache-key`   | `pkgproxy-bin`      | `actions/cache` key prefix for the built binary.                          |
| `package-cache-key`  | `pkgproxy-cache-v3` | `actions/cache` key prefix for the payload cache.                         |
| `configure-host`     | `true`              | Whether to point the host's apt/snapd at the proxy.                       |
| `save-package-cache` | `default-branch`    | Which runs save the package cache: `default-branch`, `always` or `never`. |

Bumping the pinned pkgproxy `version` is a one-file change here (this
action's `version` default) — callers that don't pass `version:` explicitly
pick it up automatically on their next `@v2` resolution.

## Outputs

| Output                       | Description                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `addr`                       | The resolved listen address (echoes the `addr` input).                                                        |
| `cache-dir`                  | The payload cache directory (`/var/cache/pkgproxy`).                                                          |
| `package-cache-restored-key` | The key the package cache was restored from, or empty on a cold start.                                        |
| `package-cache-key`          | The key the post step saves the package cache under, if the job adds to it; empty when this run may not save. |

## Versioning

Releases are tagged `vX.Y.Z`, with a floating `vX` tag moved to the latest
release in that major version — pin to `zyga/setup-pkgproxy@v2` and get
compatible updates (including pkgproxy version bumps) automatically.

Each major version is maintained on its own long-lived branch,
`releases/vX`, from which its `vX.Y.Z` tags are cut. `main` is where the
next major version is developed: fixes and pkgproxy bumps for an existing
major version go to its `releases/vX` branch.
