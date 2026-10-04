#!/data/data/com.termux/files/usr/bin/sh
set -eu
umask 077
case "${PREFIX:-}" in /data/data/com.termux/files/usr|/data/user/0/com.termux/files/usr) ;; *) echo 'Run this installer inside ordinary Termux.' >&2; exit 1;; esac
command -v node >/dev/null || { echo 'Install Node.js in Termux first: pkg install nodejs-lts' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)' || { echo 'Node.js 20 or later required.' >&2; exit 1; }
[ "$(getprop ro.build.version.sdk)" -ge 30 ] || { echo 'Android 11 or later required.' >&2; exit 1; }
case "$(getprop ro.product.cpu.abilist)" in *arm64-v8a*) ;; *) echo 'This native backend requires ARM64.' >&2; exit 1;; esac
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
(cd "$source_dir" && sha256sum -c TERMUX-SHA256SUMS) || { echo 'Bundle verification failed.' >&2; exit 1; }
target="$HOME/.local/share/p2p-tools-android/0.3.0-alpha.1"
if [ -e "$target" ]; then echo 'This version is already installed. Preserve its pairing and use its existing commands.'; exit 0; fi
mkdir -p "$(dirname -- "$target")" "$PREFIX/bin"
stage=$(mktemp -d "$HOME/.local/share/p2p-tools-android/.install.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
cp -R "$source_dir/runtime" "$stage/runtime"
cp "$source_dir/android-device-integration.md" "$stage/README.md"
node "$stage/runtime/dist/android-cli.js" --help >/dev/null
mv -- "$stage" "$target"
trap - EXIT HUP INT TERM
for command_name in p2p-tools-android p2p-tools-android-mcp; do
  if [ "$command_name" = p2p-tools-android ]; then entry=android-cli.js; else entry=android-mcp.js; fi
  if [ -e "$PREFIX/bin/$command_name" ] && [ ! -L "$PREFIX/bin/$command_name" ]; then echo "Existing command preserved: $command_name" >&2; exit 1; fi
  printf '#!%s/bin/sh\nexec "%s/bin/node" "%s/runtime/dist/%s" "$@"\n' "$PREFIX" "$PREFIX" "$target" "$entry" > "$target/$command_name"
  chmod 700 "$target/$command_name"
  ln -sfn "$target/$command_name" "$PREFIX/bin/$command_name"
done
echo 'Installed locally. Open the APK, enable automation, then run p2p-tools-android pair.'
echo 'After pairing, run p2p-tools-android register-hermes. Existing Hermes software is preserved.'
