#!/usr/bin/env sh
# nimbus-os installer — POSIX sh (works on dash, bash, zsh)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/0xsyncroot/nimbus-os/main/install.sh | sh
#   sh install.sh          # interactive
#   sh install.sh -y       # non-interactive, auto-confirm
#   sh install.sh --force  # same as -y
#   sh install.sh --uninstall
#
# Installs to: ~/.nimbus/bin/nimbus
# Adds PATH line to shell rc file (bashrc / zshrc / fish config)

set -e

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPO="0xsyncroot/nimbus-os"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
INSTALL_DIR="${HOME}/.nimbus/bin"
BINARY_NAME="nimbus"
BINARY_PATH="${INSTALL_DIR}/${BINARY_NAME}"
ISSUES_URL="https://github.com/${REPO}/issues"
LEARN_URL="https://github.com/${REPO}"

# ---------------------------------------------------------------------------
# Colours (degraded gracefully if not a tty)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()    { printf "${CYAN}  →${RESET} %s\n" "$*"; }
success() { printf "${GREEN}  ✓${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}  ⚠${RESET} %s\n" "$*"; }
error()   { printf "${RED}  ✗${RESET} %s\n" "$*" >&2; }
die()     { error "$*"; exit 1; }
bold()    { printf "${BOLD}%s${RESET}\n" "$*"; }

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
AUTO_CONFIRM=0
DO_UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    -y|--force|--yes) AUTO_CONFIRM=1 ;;
    --uninstall)      DO_UNINSTALL=1 ;;
    --help|-h)
      printf "Usage: install.sh [-y|--force] [--uninstall]\n"
      printf "  -y, --force   auto-confirm all prompts\n"
      printf "  --uninstall   remove nimbus and PATH entries\n"
      exit 0
      ;;
    *)
      warn "Unknown argument: $arg (ignored)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Confirm helper — reads from /dev/tty so pipe-to-sh works
# ---------------------------------------------------------------------------
confirm() {
  # $1 = prompt text
  # Returns 0 (yes) or 1 (no)
  if [ "$AUTO_CONFIRM" = "1" ]; then
    return 0
  fi
  if [ ! -c /dev/tty ]; then
    # No TTY available (fully non-interactive pipe without -y); default to NO
    warn "No TTY available — pass -y to auto-confirm. Skipping: $1"
    return 1
  fi
  printf "${YELLOW}  ?${RESET} %s [y/N] " "$1" >/dev/tty
  read -r answer </dev/tty
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------
do_uninstall() {
  bold "nimbus-os uninstaller"
  printf "\n"

  removed=0

  if [ -f "$BINARY_PATH" ]; then
    if confirm "Remove binary at $BINARY_PATH?"; then
      rm -f "$BINARY_PATH"
      success "Removed $BINARY_PATH"
      removed=1
    fi
  else
    info "Binary not found at $BINARY_PATH — nothing to remove"
  fi

  # Remove PATH lines from rc files
  PATH_LINE='export PATH="$HOME/.nimbus/bin:$PATH"'
  # Also match literal $HOME expanded forms in older installs
  for rc in "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.zshrc" "${HOME}/.profile"; do
    if [ -f "$rc" ]; then
      if grep -qF ".nimbus/bin" "$rc" 2>/dev/null; then
        if confirm "Remove nimbus PATH entry from $rc?"; then
          # Use a temp file — POSIX sed -i is not universal
          tmp_rc="${rc}.nimbus-bak"
          grep -v ".nimbus/bin" "$rc" > "$tmp_rc" && mv "$tmp_rc" "$rc"
          # Also strip the comment line above if it's the nimbus comment
          tmp_rc="${rc}.nimbus-bak"
          grep -v "^# nimbus$" "$rc" > "$tmp_rc" && mv "$tmp_rc" "$rc"
          success "Cleaned PATH entry from $rc"
          removed=1
        fi
      fi
    fi
  done

  # Fish config
  fish_cfg="${HOME}/.config/fish/config.fish"
  if [ -f "$fish_cfg" ]; then
    if grep -qF ".nimbus/bin" "$fish_cfg" 2>/dev/null; then
      if confirm "Remove nimbus PATH entry from $fish_cfg?"; then
        tmp_rc="${fish_cfg}.nimbus-bak"
        grep -v ".nimbus/bin" "$fish_cfg" > "$tmp_rc" && mv "$tmp_rc" "$fish_cfg"
        grep -v "^# nimbus$" "$fish_cfg" > "$tmp_rc" && mv "$tmp_rc" "$fish_cfg"
        success "Cleaned PATH entry from $fish_cfg"
        removed=1
      fi
    fi
  fi

  if [ "$removed" = "1" ]; then
    printf "\n"
    success "nimbus uninstalled. Restart your shell to update PATH."
  else
    info "Nothing was removed."
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Detect OS + arch
# ---------------------------------------------------------------------------
detect_target() {
  os_name="$(uname -s 2>/dev/null || echo "unknown")"
  arch="$(uname -m 2>/dev/null || echo "unknown")"

  case "$os_name" in
    Linux)
      case "$arch" in
        x86_64)           TARGET="linux-x64" ;;
        aarch64|arm64)    TARGET="linux-arm64" ;;
        *)
          die "Unsupported Linux architecture: $arch. Open an issue: ${ISSUES_URL}"
          ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64)   TARGET="darwin-arm64" ;;
        x86_64)  TARGET="darwin-x64" ;;
        *)
          die "Unsupported macOS architecture: $arch. Open an issue: ${ISSUES_URL}"
          ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "Windows detected. Use Scoop or Chocolatey, or see the Releases page:
       https://github.com/${REPO}/releases
       Alternatively, use Git Bash and download the Windows binary manually."
      ;;
    *)
      die "Unsupported OS: $os_name. Open an issue: ${ISSUES_URL}"
      ;;
  esac

  info "Detected platform: ${TARGET}"
}

# ---------------------------------------------------------------------------
# 2. Check for curl
# ---------------------------------------------------------------------------
require_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is required but not found. Install curl and retry.
       Ubuntu/Debian: sudo apt-get install -y curl
       macOS:         brew install curl"
  fi
}

# ---------------------------------------------------------------------------
# 3. Fetch latest release info + build download URL
# ---------------------------------------------------------------------------
fetch_release() {
  info "Fetching latest release from GitHub..."

  release_json="$(curl -fsSL "$API_URL" 2>/dev/null)" || \
    die "Failed to reach GitHub API at: $API_URL
       Check your internet connection or visit: https://github.com/${REPO}/releases"

  # Extract tag_name — works without jq (plain grep/sed, POSIX)
  RELEASE_TAG="$(printf '%s' "$release_json" | grep '"tag_name"' | head -1 \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"

  if [ -z "$RELEASE_TAG" ]; then
    die "Could not parse release tag. The GitHub API may have changed or rate-limited you.
       Check: https://github.com/${REPO}/releases"
  fi

  info "Latest release: ${RELEASE_TAG}"

  # Build asset name and download URL
  ASSET_NAME="nimbus-${TARGET}"
  SUMS_NAME="SHA256SUMS"

  # GitHub release asset URL pattern
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
  SUMS_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${SUMS_NAME}"
}

# ---------------------------------------------------------------------------
# 4. Cleanup existing binaries
# ---------------------------------------------------------------------------
cleanup_existing() {
  # Locations to check (prefer 'which' first, then well-known spots)
  found_paths=""

  # Check via 'which' (may return current BINARY_PATH on re-install — that's OK)
  existing="$(command -v "$BINARY_NAME" 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$BINARY_PATH" ]; then
    found_paths="$existing"
  fi

  # Well-known locations
  for candidate in \
    "/usr/local/bin/${BINARY_NAME}" \
    "/usr/bin/${BINARY_NAME}" \
    "${HOME}/.bun/bin/${BINARY_NAME}" \
    "${HOME}/.npm-global/bin/${BINARY_NAME}"; do
    if [ -f "$candidate" ] && [ "$candidate" != "$BINARY_PATH" ]; then
      # Avoid duplicates
      case "$found_paths" in
        *"$candidate"*) ;;
        *) found_paths="${found_paths}${found_paths:+ }${candidate}" ;;
      esac
    fi
  done

  if [ -z "$found_paths" ]; then
    return 0
  fi

  warn "Found existing nimbus installation(s):"
  for p in $found_paths; do
    warn "  $p"
  done

  if confirm "Remove existing nimbus binaries listed above?"; then
    for p in $found_paths; do
      rm -f "$p" && success "Removed $p"
    done
    # Invalidate shell's command hash cache (bash/zsh builtin; ignore failure on dash)
    hash -r 2>/dev/null || true
  else
    warn "Skipping removal. Old binary may shadow the new install."
  fi
}

# ---------------------------------------------------------------------------
# 5. Download + optional SHA256 verify
# ---------------------------------------------------------------------------
download_binary() {
  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t nimbus-install)"
  TMP_BINARY="${TMP_DIR}/${ASSET_NAME}"
  TMP_SUMS="${TMP_DIR}/${SUMS_NAME}"

  info "Downloading ${ASSET_NAME} from GitHub..."
  if ! curl -fsSL --progress-bar -o "$TMP_BINARY" "$DOWNLOAD_URL"; then
    die "Download failed: ${DOWNLOAD_URL}
       Check your internet connection or verify the release exists:
       https://github.com/${REPO}/releases/tag/${RELEASE_TAG}"
  fi

  # Verify the file is non-empty and looks like an ELF/Mach-O binary or PE
  file_size="$(wc -c < "$TMP_BINARY" 2>/dev/null | tr -d ' ')"
  if [ -z "$file_size" ] || [ "$file_size" -lt 1000 ]; then
    # Read first bytes and check for HTML (asset not found → GitHub 404 page)
    first_bytes="$(head -c 15 "$TMP_BINARY" 2>/dev/null || true)"
    case "$first_bytes" in
      "<!DOCTYPE"*|"<html"*)
        die "Downloaded file appears to be an HTML error page — the asset '${ASSET_NAME}' was not found in release ${RELEASE_TAG}.
       Check available assets: https://github.com/${REPO}/releases/tag/${RELEASE_TAG}"
        ;;
      *)
        die "Downloaded file is suspiciously small (${file_size} bytes). Aborting."
        ;;
    esac
  fi

  # Try SHA256 verification (non-fatal if SHA256SUMS asset doesn't exist)
  if curl -fsSL -o "$TMP_SUMS" "$SUMS_URL" 2>/dev/null; then
    info "Verifying SHA256 checksum..."
    if command -v sha256sum >/dev/null 2>&1; then
      expected_hash="$(grep "${ASSET_NAME}" "$TMP_SUMS" 2>/dev/null | awk '{print $1}' || true)"
      if [ -n "$expected_hash" ]; then
        actual_hash="$(sha256sum "$TMP_BINARY" | awk '{print $1}')"
        if [ "$actual_hash" = "$expected_hash" ]; then
          success "SHA256 checksum verified"
        else
          rm -rf "$TMP_DIR"
          die "SHA256 mismatch!
         Expected: $expected_hash
         Got:      $actual_hash
         The download may be corrupted or tampered. Aborting."
        fi
      else
        warn "No checksum entry found for ${ASSET_NAME} in SHA256SUMS — skipping verification"
      fi
    elif command -v shasum >/dev/null 2>&1; then
      expected_hash="$(grep "${ASSET_NAME}" "$TMP_SUMS" 2>/dev/null | awk '{print $1}' || true)"
      if [ -n "$expected_hash" ]; then
        actual_hash="$(shasum -a 256 "$TMP_BINARY" | awk '{print $1}')"
        if [ "$actual_hash" = "$expected_hash" ]; then
          success "SHA256 checksum verified"
        else
          rm -rf "$TMP_DIR"
          die "SHA256 mismatch!
         Expected: $expected_hash
         Got:      $actual_hash
         The download may be corrupted or tampered. Aborting."
        fi
      fi
    else
      warn "Neither sha256sum nor shasum found — skipping checksum verification"
    fi
  else
    info "SHA256SUMS not available for this release — skipping checksum verification"
  fi

  chmod +x "$TMP_BINARY"
  DOWNLOADED_BINARY="$TMP_BINARY"
  CLEANUP_DIR="$TMP_DIR"
}

# ---------------------------------------------------------------------------
# 6. Install binary
# ---------------------------------------------------------------------------
install_binary() {
  if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    info "Created ${INSTALL_DIR}"
  fi

  mv "$DOWNLOADED_BINARY" "$BINARY_PATH"
  chmod 755 "$BINARY_PATH"
  success "Installed binary to ${BINARY_PATH}"

  # Cleanup temp dir
  rm -rf "$CLEANUP_DIR" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 7. Add to PATH in shell rc
# ---------------------------------------------------------------------------
add_to_path() {
  PATH_EXPORT='export PATH="$HOME/.nimbus/bin:$PATH"'
  FISH_PATH_CMD="fish_add_path \$HOME/.nimbus/bin"

  # Detect shell
  detected_shell="$(basename "${SHELL:-sh}")"

  # Pick rc file
  case "$detected_shell" in
    zsh)  RC_FILE="${HOME}/.zshrc" ;;
    fish) RC_FILE="${HOME}/.config/fish/config.fish" ;;
    bash) RC_FILE="${HOME}/.bashrc" ;;
    *)
      # Fallback: try .bashrc → .profile
      if [ -f "${HOME}/.bashrc" ]; then
        RC_FILE="${HOME}/.bashrc"
      else
        RC_FILE="${HOME}/.profile"
      fi
      ;;
  esac

  # Fish uses a different syntax
  if [ "$detected_shell" = "fish" ]; then
    if grep -qF ".nimbus/bin" "$RC_FILE" 2>/dev/null; then
      info "PATH entry already present in ${RC_FILE}"
    else
      mkdir -p "$(dirname "$RC_FILE")"
      printf "\n# nimbus\n%s\n" "$FISH_PATH_CMD" >> "$RC_FILE"
      success "Added PATH entry to ${RC_FILE}"
    fi
  else
    if grep -qF ".nimbus/bin" "$RC_FILE" 2>/dev/null; then
      info "PATH entry already present in ${RC_FILE}"
    else
      printf "\n# nimbus\n%s\n" "$PATH_EXPORT" >> "$RC_FILE"
      success "Added PATH entry to ${RC_FILE}"
    fi
  fi

  CHOSEN_RC="$RC_FILE"
}

# ---------------------------------------------------------------------------
# 8. Detect installed version
# ---------------------------------------------------------------------------
detect_version() {
  # Temporarily add to PATH for this shell process so --version works immediately
  export PATH="${INSTALL_DIR}:${PATH}"

  NIMBUS_VERSION="$("$BINARY_PATH" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' || echo "unknown")"
}

# ---------------------------------------------------------------------------
# 9. Print success banner
# ---------------------------------------------------------------------------
print_success() {
  printf "\n"
  bold "nimbus-os ${NIMBUS_VERSION}"
  printf "\n"
  success "nimbus installed successfully"
  printf "  Location: %s\n" "$BINARY_PATH"
  printf "  Version:  %s\n" "$NIMBUS_VERSION"
  printf "\n"
  printf "  Next: set your API key and start chatting\n"
  printf "    %sexport ANTHROPIC_API_KEY=sk-ant-...%s    # Anthropic (Claude)\n" "$CYAN" "$RESET"
  printf "    %sexport OPENAI_API_KEY=sk-...%s           # OpenAI / OpenAI-compat\n" "$CYAN" "$RESET"
  printf "    %snimbus init%s                             # Interactive setup wizard\n" "$CYAN" "$RESET"
  printf "    %snimbus%s                                  # Start chatting\n" "$CYAN" "$RESET"
  printf "\n"

  # Check if INSTALL_DIR is already on PATH (current process)
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*)
      info "PATH already includes ${INSTALL_DIR} — nimbus is ready to use."
      ;;
    *)
      warn "Restart your shell or run the following to use nimbus immediately:"
      printf "    %ssource %s%s\n" "$CYAN" "$CHOSEN_RC" "$RESET"
      ;;
  esac

  printf "\n"
  printf "  Learn more: %s%s%s\n" "$CYAN" "$LEARN_URL" "$RESET"
  printf "\n"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  printf "\n"
  bold "nimbus-os installer"
  printf "\n"

  if [ "$DO_UNINSTALL" = "1" ]; then
    do_uninstall
    # do_uninstall calls exit — but be explicit
    exit 0
  fi

  require_curl
  detect_target
  fetch_release
  cleanup_existing
  download_binary
  install_binary
  add_to_path
  detect_version
  print_success
}

main "$@"
