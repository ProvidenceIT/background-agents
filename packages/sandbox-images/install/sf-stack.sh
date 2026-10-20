#!/usr/bin/env bash
# sf: the project toolchain our repositories expect, on the Kubernetes target
# only. Sandboxes reach a short egress allowlist and cannot run Docker under
# gVisor, so this phase bakes what they cannot download at session time:
# extra Node majors, Postgres with pgvector, Redis, the sqlite3 CLI, and the
# system libraries Playwright's Chromium, Firefox and WebKit builds load.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
if [[ "$OI_OS" != debian ]]; then
  echo "The sf stack phase requires the Debian target (got $OI_OS)" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
toolchain="$OI_BUNDLE/packages/sandbox-images/toolchain.json"

# Every pinned Node major other than the target's default goes under
# /opt/openinspect/node-versions/<major>; the default stays /opt/openinspect/node.
mkdir -p /opt/openinspect/node-versions
ln -sfn /opt/openinspect/node /opt/openinspect/node-versions/default
download_dir="$(mktemp -d /tmp/openinspect-sf-stack.XXXXXX)"
trap 'rm -rf "$download_dir"' EXIT
for major in $(jq -r '.node | keys[]' "$toolchain"); do
  version="$(jq -r --arg m "$major" '.node[$m].version' "$toolchain")"
  if [[ "$version" == "$NODE_VERSION" ]]; then
    ln -sfn /opt/openinspect/node "/opt/openinspect/node-versions/$major"
    continue
  fi
  sha256="$(jq -r --arg m "$major" '.node[$m].sha256' "$toolchain")"
  download_checked "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz" "$sha256" "$download_dir/node-$major.tar.xz"
  mkdir -p "/opt/openinspect/node-versions/$major"
  tar -xJf "$download_dir/node-$major.tar.xz" -C "/opt/openinspect/node-versions/$major" --strip-components=1
done
install -d -m 0755 /opt/openinspect/node-select/bin
install -m 0755 "$OI_INSTALL_DIR/sf-stack/node-select" /opt/openinspect/node-select/bin/node-select
for command in node npm npx corepack; do
  ln -sf node-select "/opt/openinspect/node-select/bin/$command"
done
install -m 0755 "$OI_INSTALL_DIR/sf-stack/oi-services" /usr/local/bin/oi-services

# PGDG for Postgres 16 and pgvector (bookworm ships 15). No cluster is created
# at install time; oi-services initialises one in the runtime user's home.
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list
install -d /etc/postgresql-common
printf '%s\n' 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf
apt-get update
# Playwright's own debian12 lists (playwright-core 1.64 nativeDeps) for its
# tools, Chromium, Firefox and WebKit, so `playwright install` needs no apt.
apt-get install -y --no-install-recommends \
  postgresql-16 postgresql-16-pgvector postgresql-client-16 redis-server sqlite3 bsdextrautils \
  fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-scalable fonts-liberation \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
  libatspi2.0-0 libdbus-1-3 libglib2.0-0 libx11-6 libxcb1 libxext6 \
  libavcodec59 libcairo-gobject2 libdbus-glib-1-2 libgdk-pixbuf-2.0-0 libgtk-3-0 libharfbuzz0b \
  libpangocairo-1.0-0 libx11-xcb1 libxcb-shm0 libxcursor1 libxi6 libxrender1 libxtst6 \
  libsoup-3.0-0 gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good libegl1 libenchant-2-2 libepoxy0 libevdev2 libgles2 libglx0 \
  libgstreamer-gl1.0-0 libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 libgtk-4-1 libgudev-1.0-0 \
  libharfbuzz-icu0 libhyphen0 libicu72 libjpeg62-turbo liblcms2-2 libmanette-0.2-0 libnotify4 \
  libopengl0 libopenjp2-7 libopus0 libpng16-16 libproxy1v5 libsecret-1-0 libwayland-client0 \
  libwayland-egl1 libwayland-server0 libwebp7 libwebpdemux2 libwoff1 libxml2 libxslt1.1 \
  libatomic1 libevent-2.1-7 libavif15
rm -rf /var/lib/apt/lists/*
# The packaged redis service is unused; a stray default config must not bind.
rm -f /etc/redis/redis.conf

for major in $(jq -r '.node | keys[]' "$toolchain"); do
  expected="v$(jq -r --arg m "$major" '.node[$m].version' "$toolchain")"
  observed="$(OI_NODE_MAJOR="$major" /opt/openinspect/node-select/bin/node --version)"
  [[ "$observed" == "$expected" ]] || { echo "node $major: expected $expected, got $observed" >&2; exit 1; }
done
/usr/lib/postgresql/16/bin/postgres --version
test -f /usr/share/postgresql/16/extension/vector.control
psql --version
redis-server --version
sqlite3 --version
column --version
