#!/bin/sh
# Entrypoint of the Myco fleet desktop (Dockerfile next to this file). Order matters (lead
# ruling 14:37Z, gap 1): the X server, then the session D-Bus, then the AT-SPI bus and its
# registry, and only then OSWorld's controller server. Every LibreOffice in this desktop is
# started later, by the server's own setup routes (/setup/launch, /setup/open_file), so each one
# finds the AT-SPI bus already up and registers its GTK3 UI on it.
set -eu
export DISPLAY=:0
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-user}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# 1. X server at OSWorld's default screen size.
Xvfb :0 -screen 0 1920x1080x24 -nolisten tcp -noreset >/tmp/xvfb.log 2>&1 &
i=0
until xdpyinfo -display :0 >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 600 ] && { echo "MYCO_FLEET_X_NOT_READY" >&2; exit 1; }
  sleep 0.05
done

# 2. Session D-Bus.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS

# 3. AT-SPI bus and registry, before any LibreOffice.
/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/at-spi-bus.log 2>&1 &
i=0
until dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 600 ] && { echo "MYCO_FLEET_A11Y_BUS_NOT_READY" >&2; exit 1; }
  sleep 0.05
done
/usr/libexec/at-spi2-registryd >/tmp/at-spi-registryd.log 2>&1 &
gsettings set org.gnome.desktop.interface toolkit-accessibility true >/dev/null 2>&1 || true
date +%s.%N >/tmp/myco-a11y-ready

# 4. Window manager (OSWorld's wmctrl-based setup routes need one).
openbox >/tmp/openbox.log 2>&1 &

# 5. OSWorld's controller server, unmodified, as its osworld_server.service runs it.
cd /home/user
exec /usr/bin/python /home/user/server/main.py
