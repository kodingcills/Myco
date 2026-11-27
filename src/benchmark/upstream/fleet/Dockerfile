# Myco Linux fleet desktop for the public R1 on OSWorld's LibreOffice subset (#682, #741).
#
# Lead rulings 2026-11-27: 14:05Z (retarget to the Linux fleet: OSWorld's own task configs,
# setup steps, controller and evaluators on lightweight Linux desktops), 14:37Z (gap 1: the
# accessibility tree, LibreOffice's GTK3 VCL plugin with the AT-SPI bus started before any
# LibreOffice; gap 2: pyautogui and python-xlib for OSWorld's action interface).
#
# One container is one desktop: Xvfb :0 at OSWorld's default 1920x1080, a session D-Bus, the
# AT-SPI bus and registry, openbox, LibreOffice Calc, Writer and Impress (GTK3 VCL plugin), and
# OSWorld's own controller server (desktop_env/server at the pinned commit, run UNMODIFIED on
# port 5000, as its osworld_server.service runs it). The host side is OSWorld's DesktopEnv with
# the Myco fleet provider (myco_fleet_provider.py next to this file); every arm uses it.
#
# Build (the coordinator, locally; this repository never builds or starts it):
#   docker build -t myco-osworld-desktop:local src/benchmark/upstream/fleet
# Started from a pre-built image only; nothing in this image downloads OSWorld's VM image.
# Started fresh per task: a new container is the reset (no snapshots).

ARG OSWORLD_COMMIT=0ad41bee56565efe7bb3c3a5ebc67590a1b8276f

# Stage 1: OSWorld's controller server, byte-verified against the pin (server.sha256 holds the
# SHA-256 of each file; src/benchmark/upstream/pins.ts pins the same digests).
FROM ubuntu:22.04 AS osworld-server
ARG OSWORLD_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git init -q /osworld \
  && git -C /osworld fetch -q --depth 1 https://github.com/xlang-ai/OSWorld "$OSWORLD_COMMIT" \
  && git -C /osworld checkout -q FETCH_HEAD \
  && test "$(git -C /osworld rev-parse HEAD)" = "$OSWORLD_COMMIT"
COPY server.sha256 /server.sha256
RUN cd /osworld && sha256sum -c /server.sha256

# Stage 2: the desktop.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
# Desktop, accessibility stack and LibreOffice:
#  - xvfb, openbox, wmctrl, xdotool, x11-xserver-utils (xset), x11-utils (xdpyinfo): the X side
#    the server's setup routes call (activate_window and open_file use wmctrl).
#  - dbus, dbus-x11, at-spi2-core, libatk-adaptor, libatk-bridge2.0-0, python3-pyatspi,
#    gir1.2-atspi-2.0: the AT-SPI bus, registry, GTK3 bridge and pyatspi, which the server's
#    /accessibility route reads (OSWorld's a11y-tree getters).
#  - libreoffice-gtk3: LibreOffice's GTK3 VCL plugin, so LibreOffice exposes its UI over AT-SPI.
#  - python-is-python3: OSWorld's controller and task postconfigs run `python -c ...`.
#  - scrot, ffmpeg: screenshots (pyscreeze fallback) and the server's screen recording.
#  - libglib2.0-bin, dconf-gsettings-backend, gsettings-desktop-schemas: gsettings, which
#    DesktopEnv and some setup steps call.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils x11-xserver-utils xdotool wmctrl openbox \
      dbus dbus-x11 at-spi2-core libatk-adaptor libatk-bridge2.0-0 python3-pyatspi gir1.2-atspi-2.0 \
      libreoffice-calc libreoffice-writer libreoffice-impress libreoffice-gtk3 python3-uno \
      python3 python3-pip python3-setuptools python3-wheel python-is-python3 \
      python3-flask python3-lxml python3-numpy python3-requests python3-tk \
      scrot ffmpeg sudo libglib2.0-bin dconf-gsettings-backend gsettings-desktop-schemas \
      fonts-dejavu-core fonts-liberation fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
      libxfixes3 procps curl ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
# OSWorld's action interface: PyAutoGUI and python3-xlib at the versions upstream pins, hash-pinned.
COPY requirements-fleet.txt /tmp/requirements-fleet.txt
RUN pip install --no-cache-dir --require-hashes --no-deps --no-build-isolation -r /tmp/requirements-fleet.txt \
  && rm /tmp/requirements-fleet.txt
# OSWorld's guest user. "password" is DesktopEnv's own default client password for non-AWS
# providers (desktop_env/desktop_env.py at the pin); setup steps that use sudo send it.
RUN useradd -m -u 1000 -s /bin/bash user \
  && echo 'user:password' | chpasswd \
  && usermod -aG sudo user
COPY --from=osworld-server --chown=user:user /osworld/desktop_env/server/ /home/user/server/
# LibreOffice profile: no first-start wizard, no tip of the day, and no "keep current format"
# prompt on Ctrl+S, because OSWorld's task postconfigs save .xlsx/.docx/.pptx with a bare Ctrl+S.
COPY --chown=user:user registrymodifications.xcu /home/user/.config/libreoffice/4/user/registrymodifications.xcu
COPY start.sh /usr/local/bin/myco-fleet-start
RUN chmod 0755 /usr/local/bin/myco-fleet-start && mkdir -p /home/user/Desktop && chown user:user /home/user/Desktop
# GTK3 VCL plugin plus the ATK bridge: LibreOffice's UI on the AT-SPI bus.
ENV DISPLAY=:0 \
    SAL_USE_VCLPLUGIN=gtk3 \
    GTK_MODULES=gail:atk-bridge \
    ACCESSIBILITY_ENABLED=1 \
    XDG_RUNTIME_DIR=/tmp/runtime-user
EXPOSE 5000
USER user
WORKDIR /home/user
CMD ["/usr/local/bin/myco-fleet-start"]
