#!/usr/bin/env bash
set -euo pipefail

base_url="${OTIS_INSTALL_BASE_URL:-https://github.com/triangllabs/otis/releases}"
install_dir="${OTIS_INSTALL_DIR:-$HOME/.local/bin}"
version=""

usage() {
  cat <<'USAGE'
Install Otis.

Usage:
  curl -fsSL https://github.com/triangllabs/otis/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/triangllabs/otis/releases/latest/download/install.sh | bash -s -- --install-dir ~/.local/bin

Options:
  --install-dir DIR   Install otis into DIR. Defaults to ~/.local/bin.
  --version VERSION   Install a specific version, for example 0.1.16.
  --base-url URL      GitHub Releases base URL. Defaults to the Otis repository.
  -h, --help          Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      install_dir="${2:?missing value for --install-dir}"
      shift 2
      ;;
    --version)
      version="${2:?missing value for --version}"
      shift 2
      ;;
    --base-url)
      base_url="${2:?missing value for --base-url}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

base_url="${base_url%/}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Otis installer requires %s.\n' "$1" >&2
    exit 1
  fi
}

need curl
need tar

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    printf 'Unsupported operating system: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    printf 'Unsupported CPU architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

if [ -z "$version" ]; then
  version="$(curl -fsSL "$base_url/latest/download/latest.txt" | tr -d '[:space:]')"
fi
version="${version#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Invalid Otis version: %s\n' "$version" >&2
  exit 1
fi

artifact="otis-${os}-${arch}.tar.gz"
release_url="$base_url/download/v$version"
tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t otis-install)"
archive="$tmp_dir/$artifact"
checksums="$tmp_dir/checksums.txt"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

printf 'Installing Otis v%s for %s-%s...\n' "$version" "$os" "$arch"

curl -fsSL "$release_url/$artifact" -o "$archive"
curl -fsSL "$release_url/checksums.txt" -o "$checksums"

expected="$(awk -v file="$artifact" '$2 == file { print $1 }' "$checksums")"
if [ -z "$expected" ]; then
  printf 'Checksum for %s was not found.\n' "$artifact" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
else
  printf 'Otis installer requires sha256sum or shasum.\n' >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  printf 'Checksum verification failed for %s.\n' "$artifact" >&2
  exit 1
fi

entries="$(tar -tzf "$archive")"
if [ "$entries" != "otis" ] && [ "$entries" != "./otis" ]; then
  printf 'Otis release archive must contain only the otis binary.\n' >&2
  exit 1
fi

tar -xzf "$archive" -C "$tmp_dir"
if [ ! -f "$tmp_dir/otis" ] || [ -L "$tmp_dir/otis" ]; then
  printf 'Otis release archive did not contain a regular binary.\n' >&2
  exit 1
fi

mkdir -p "$install_dir"

if command -v install >/dev/null 2>&1; then
  install -m 0755 "$tmp_dir/otis" "$install_dir/otis"
else
  cp "$tmp_dir/otis" "$install_dir/otis"
  chmod 0755 "$install_dir/otis"
fi

printf 'Otis installed to %s/otis\n' "$install_dir"

case ":$PATH:" in
  *:"$install_dir":*) ;;
  *)
    printf '\nAdd Otis to your PATH:\n'
    printf '  export PATH="%s:$PATH"\n' "$install_dir"
    ;;
esac

existing="$(command -v otis 2>/dev/null || true)"
if [ -n "$existing" ] && [ "$existing" != "$install_dir/otis" ]; then
  printf '\nNote: another otis executable is earlier on PATH: %s\n' "$existing"
  printf 'Put %s before it on PATH, or remove the old install.\n' "$install_dir"
fi
