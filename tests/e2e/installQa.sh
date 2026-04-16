#!/usr/bin/env bash
# tests/e2e/installQa.sh
#
# QA regression: `install.sh` must always print `hash -r` reminder so user
# can activate nimbus in the same shell. Without this banner, a shell with
# cached command lookup will call a deleted-binary path and error out.
#
# Bug: v0.2.5 install.sh only printed the reminder when cleanup_existing()
# actually removed a file. But bash hash cache persists across terminal
# sessions — a user re-installing after a previous cleanup still had the
# stale hash entry.
#
# Usage:
#   bash tests/e2e/installQa.sh
# Exit 0 = all checks pass. Non-zero = regression.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALLER="$REPO/install.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# 1. Syntax check — POSIX sh
sh -n "$INSTALLER" || fail "install.sh has syntax errors"
pass "POSIX syntax OK"

# 2. Help flag works
sh "$INSTALLER" --help | grep -qE "Usage: install\.sh" || fail "--help missing or broken"
pass "--help shows usage"

# 3. Uninstall flag parse
sh "$INSTALLER" --help | grep -q "uninstall" || fail "--uninstall flag not documented"
pass "--uninstall documented"

# 4. CRITICAL — `hash -r` reminder always appears in print_success section
grep -qE "hash -r" "$INSTALLER" || fail "install.sh missing 'hash -r' reminder"
pass "hash -r reminder present in source"

# 5. Reminder must be OUTSIDE any conditional gated on REMOVED_ANY
# (regression guard — the old bug was this being inside `if [ "$REMOVED_ANY" = "1" ]`)
if grep -B2 "hash -r" "$INSTALLER" | grep -q 'REMOVED_ANY.*=.*1'; then
  fail "hash -r reminder still gated on REMOVED_ANY — users who already cleaned up won't see it"
fi
pass "hash -r reminder unconditional (no REMOVED_ANY gate)"

# 6. Printf must use %b when ANSI variables are passed as args (not %s)
# (regression guard — %s prints literal \033[...] in POSIX sh when the
# escape sequence is in an ARG, not embedded in the format string itself)
#
# SAFE  pattern: printf "${CYAN}foo${RESET} %s\n" "$x"    (CYAN in fmt str)
# BAD   pattern: printf "    %sfoo%s" "$CYAN" "$RESET"     (CYAN as arg, need %b)
#
# Check: find printf lines where $CYAN/$RED/... appears AFTER the format
# string (i.e., as argument) AND the format uses %s for that slot.
BAD_LINES=$(awk '/printf[[:space:]]/ && /%s/ && !/%b/ {
  # locate the end of the format string
  match($0, /"[^"]*"/)
  if (RSTART > 0) {
    fmt = substr($0, RSTART, RLENGTH)
    rest = substr($0, RSTART + RLENGTH)
    # If args include $CYAN/$RED/$GREEN/$YELLOW/$BOLD and format has %s (not %b)
    if (rest ~ /\$(CYAN|RED|GREEN|YELLOW|BOLD)/ && fmt ~ /%s/ && fmt !~ /%b/) {
      print NR": "$0
    }
  }
}' "$INSTALLER")

if [ -n "$BAD_LINES" ]; then
  fail "install.sh passes ANSI var as %s arg (should be %b):\n$BAD_LINES"
fi
pass "ANSI-as-arg uses %b (not %s) — colors will render"

# 7. Exit success
echo ""
echo "=== All QA checks PASS ==="
