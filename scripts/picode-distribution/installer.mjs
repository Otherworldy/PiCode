const packageDirName = "picode";

export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ZCODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${ZCODE_DIST_HOME:-$HOME/.PiCode/runtime}"
BIN_DIR="\${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "picode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar
need_cmd cmp

mkdir -p "$BIN_DIR"
WRAPPER_TMP="$(mktemp "$BIN_DIR/.picode-install.XXXXXX")"
TMP_DIR=""
cleanup() {
  rm -f "$WRAPPER_TMP"
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

cat > "$WRAPPER_TMP" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/picode.mjs" "\\$@"
SH
# 仅更新同一安装根的标准 wrapper；拒绝其他命令和符号链接，避免写入其目标。
if [ -L "$BIN_DIR/picode" ] || { [ -e "$BIN_DIR/picode" ] && { [ ! -f "$BIN_DIR/picode" ] || ! cmp -s "$WRAPPER_TMP" "$BIN_DIR/picode"; }; }; then
  echo "picode already exists and is not owned by this installation: $BIN_DIR/picode" >&2
  exit 1
fi
chmod +x "$WRAPPER_TMP"

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"

TMP_DIR="$(mktemp -d)"
ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

mkdir -p "$INSTALL_DIR/releases"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

mv -f "$WRAPPER_TMP" "$BIN_DIR/picode"

echo "PiCode $VERSION installed."
echo "Run: picode --help (help) or picode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
