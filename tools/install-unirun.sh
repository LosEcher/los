#!/bin/sh
# install-unirun.sh — install the pinned unirun build (deploy/unirun-pin.txt).
#
#   tools/install-unirun.sh                            # install to /usr/local/bin
#   tools/install-unirun.sh --dest "$HOME/.local/bin"  # install elsewhere
#   tools/install-unirun.sh --asset unirun-linux-x86_64-musl   # cross/platform build
#   tools/install-unirun.sh --check                    # verify what is installed, install nothing
#   tools/install-unirun.sh --force                    # reinstall even if the pin matches
#   tools/install-unirun.sh --skip-run-check           # do not execute the asset (cross-platform)
#
# Why this exists (audit C4/F1): the gateway only dispatches `unirun ssh` when the
# binary answers `unirun capabilities --json` with the keys it needs
# (packages/gateway/src/unirun-capabilities.ts). An older unirun is therefore
# installed-but-unusable and everything falls back to native ssh, so "install
# unirun" has to be a versioned, checksum-verified, verifiable step.
#
# Environment:
#   LOS_SKIP_UNIRUN_INSTALL=1   skip the install with a warning (explicit opt-out)
#   LOS_UNIRUN_ASSET=<asset>    same as --asset
#   LOS_UNIRUN_PIN=<file>       same as --pin
#
# An install only skips when the destination already holds exactly
# UNIRUN_VERSION and it passes the capability check; any other version is
# replaced (use --force to reinstall the pin over itself).
#
# Exit: 0 installed / already correct; 1 install or verification failure; 2 usage.
set -eu

# Capability keys the gateway gates on. Keep in sync with the key constants in
# packages/gateway/src/unirun-capabilities.ts (unirun-capabilities.test.ts
# asserts that dropping any of these makes the gate unusable).
REQUIRED_FEATURES="ssh-identity ssh-workdir-env"

usage() {
    sed -n '2,/^set -eu$/p' "$0"
    exit "${1:-0}"
}

die() {
    printf 'install-unirun: %s\n' "$*" >&2
    exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

need_arg() { [ $# -ge 2 ] || { printf 'install-unirun: %s needs a value\n' "$1" >&2; exit 2; }; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname -- "$script_dir")
pin_file=${LOS_UNIRUN_PIN:-$repo_root/deploy/unirun-pin.txt}
dest=/usr/local/bin
asset=${LOS_UNIRUN_ASSET:-}
check_only=0
force=0
skip_run_check=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dest) need_arg "$@"; dest=$2; shift 2 ;;
        --dest=*) dest=${1#*=}; shift ;;
        --pin) need_arg "$@"; pin_file=$2; shift 2 ;;
        --pin=*) pin_file=${1#*=}; shift ;;
        --asset) need_arg "$@"; asset=$2; shift 2 ;;
        --asset=*) asset=${1#*=}; shift ;;
        --check) check_only=1; shift ;;
        --force) force=1; shift ;;
        --skip-run-check) skip_run_check=1; shift ;;
        -h|--help|help) usage 0 ;;
        *) printf 'install-unirun: unknown argument %s\n' "$1" >&2; usage 2 ;;
    esac
done

[ -f "$pin_file" ] || die "pin file not found: $pin_file"
# shellcheck source=/dev/null
. "$pin_file"
[ -n "${UNIRUN_VERSION:-}" ] || die "$pin_file does not set UNIRUN_VERSION"

# ── Pin lookup ──────────────────────────────────────────────
# Digest per asset, explicit so a missing entry fails closed instead of
# installing something unverified.
digest_for() {
    case "$1" in
        unirun-linux-x86_64-musl) printf '%s' "${UNIRUN_SHA256_LINUX_X86_64_MUSL:-}" ;;
        unirun-linux-aarch64-musl) printf '%s' "${UNIRUN_SHA256_LINUX_AARCH64_MUSL:-}" ;;
        unirun-macos-aarch64) printf '%s' "${UNIRUN_SHA256_MACOS_AARCH64:-}" ;;
        *) printf '' ;;
    esac
}

detect_asset() {
    case "$(uname -s)" in
        Linux)
            case "$(uname -m)" in
                x86_64|amd64) printf 'unirun-linux-x86_64-musl' ;;
                aarch64|arm64) printf 'unirun-linux-aarch64-musl' ;;
                *) printf '' ;;
            esac
            ;;
        Darwin)
            case "$(uname -m)" in
                arm64|aarch64) printf 'unirun-macos-aarch64' ;;
                *) printf '' ;;
            esac
            ;;
        *) printf '' ;;
    esac
}

# ── Verification helpers ────────────────────────────────────
# Substring match against the capabilities document: the keys only appear in its
# `features` array, and a full JSON parser is not available in busybox sh.
has_required_capabilities() {
    doc=$("$1" capabilities --json 2>/dev/null) || return 1
    for key in $REQUIRED_FEATURES; do
        case "$doc" in
            *"\"$key\""*) ;;
            *) return 1 ;;
        esac
    done
    return 0
}

installed_version() {
    "$1" --version 2>/dev/null | awk '{print $NF}' || true
}

# Report one candidate; exit 0 when the gateway can use it. One machine-readable
# line per candidate so callers (deploy verify, los doctor) do not parse prose.
report() { # binary
    if has_required_capabilities "$1"; then
        printf 'unirun: %s version=%s capabilities=ok\n' "$1" "$(installed_version "$1")"
        return 0
    fi
    printf 'unirun: %s version=%s capabilities=missing\n' "$1" "$(installed_version "$1")"
    printf '  -> this binary cannot serve ssh dispatch; the gateway skips it\n'
    return 1
}

if [ "$check_only" -eq 1 ]; then
    # Same candidate order as resolveUnirunBinary()/probeUnirun(): the gateway
    # skips a candidate that cannot describe itself, so report every candidate
    # and succeed when one of them is usable.
    candidates_file=$(mktemp "${TMPDIR:-/tmp}/unirun-candidates.XXXXXX")
    trap 'rm -f "$candidates_file"' EXIT INT TERM
    {
        if [ -n "${LOS_UNIRUN_BIN:-}" ] && [ -x "$LOS_UNIRUN_BIN" ]; then
            printf '%s\n' "$LOS_UNIRUN_BIN"
        fi
        if have unirun; then command -v unirun; fi
        printf '%s\n' "$HOME/.cargo/bin/unirun" /usr/local/bin/unirun /opt/homebrew/bin/unirun "$dest/unirun"
    } | awk '!seen[$0]++' > "$candidates_file"
    seen=0
    usable=0
    while IFS= read -r bin; do
        [ -x "$bin" ] || continue
        seen=$((seen + 1))
        if report "$bin"; then usable=1; fi
    done < "$candidates_file"
    if [ "$seen" -eq 0 ]; then
        printf 'unirun: not installed (checked LOS_UNIRUN_BIN, PATH, ~/.cargo/bin, /usr/local/bin, /opt/homebrew/bin, %s)\n' "$dest"
        printf '  -> the gateway dispatches ssh via the native fallback on this host\n'
        printf '     fix: sh %s --dest %s\n' "$0" "$dest"
        exit 1
    fi
    if [ "$usable" -eq 0 ]; then
        printf 'unirun: none usable — no candidate reports (%s)\n' "$REQUIRED_FEATURES"
        printf '  -> the gateway dispatches ssh via the native fallback on this host\n'
        printf '     fix: sh %s --dest %s\n' "$0" "$dest"
        exit 1
    fi
    exit 0
fi

if [ "${LOS_SKIP_UNIRUN_INSTALL:-0}" = "1" ]; then
    printf 'install-unirun: SKIPPED (LOS_SKIP_UNIRUN_INSTALL=1) — the pinned unirun was NOT installed; hosts without a usable unirun dispatch ssh via the native fallback\n' >&2
    exit 0
fi

# ── Download and install ────────────────────────────────────
[ -n "$asset" ] || asset=$(detect_asset)
[ -n "$asset" ] || die "no pinned unirun asset for $(uname -s)/$(uname -m); build from source (cargo install unirun@$UNIRUN_VERSION) and set LOS_UNIRUN_BIN"
digest=$(digest_for "$asset")
[ -n "$digest" ] || die "$pin_file has no sha256 for $asset"

target="$dest/unirun"
if [ "$force" -eq 0 ] && [ -x "$target" ] &&
    [ "$(installed_version "$target")" = "$UNIRUN_VERSION" ] &&
    has_required_capabilities "$target"; then
    printf 'install-unirun: unirun %s already installed at %s with the required capabilities\n' "$UNIRUN_VERSION" "$target"
    exit 0
fi

fetch() { # url destination
    if have curl; then
        curl -fsSL --max-time 300 -o "$2" "$1"
    elif have wget; then
        wget -q -T 300 -O "$2" "$1"
    else
        die "need curl or wget to download $1"
    fi
}

sha256_of() {
    if have sha256sum; then
        sha256sum "$1" | cut -d' ' -f1
    elif have shasum; then
        shasum -a 256 "$1" | cut -d' ' -f1
    elif have openssl; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        die "need sha256sum, shasum or openssl to verify the download"
    fi
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/unirun-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

url="https://github.com/LosEcher/unirun/releases/download/v$UNIRUN_VERSION/$asset"
printf 'install-unirun: downloading %s\n' "$url"
fetch "$url" "$tmp_dir/unirun" ||
    die "download failed: $url (check network access to github.com and ca-certificates)"

got=$(sha256_of "$tmp_dir/unirun")
[ "$got" = "$digest" ] ||
    die "sha256 mismatch for $asset: expected $digest, got $got — refusing to install"

chmod 0755 "$tmp_dir/unirun" || die "cannot make the download executable"
# Verify the asset is the build the gateway can use *before* it lands in place,
# so a wrong asset never replaces a working unirun. --skip-run-check exists for
# cross-platform installs (a target-arch binary cannot run on this host).
if [ "$skip_run_check" -eq 0 ] && ! has_required_capabilities "$tmp_dir/unirun"; then
    die "$asset does not report ($REQUIRED_FEATURES) on this host — wrong asset for this platform, or a stale pin (use --skip-run-check for a cross-platform install)"
fi

mkdir -p "$dest" 2>/dev/null ||
    die "cannot create $dest (run with sudo or pass --dest to a writable directory)"
cp "$tmp_dir/unirun" "$target" ||
    die "cannot write $target (run with sudo or pass --dest to a writable directory)"
chmod 0755 "$target"

if [ "$skip_run_check" -eq 1 ]; then
    printf 'install-unirun: installed unirun %s at %s (runtime capabilities NOT verified — cross-platform install)\n' \
        "$UNIRUN_VERSION" "$target"
else
    printf 'install-unirun: installed unirun %s at %s\n' "$UNIRUN_VERSION" "$target"
fi
