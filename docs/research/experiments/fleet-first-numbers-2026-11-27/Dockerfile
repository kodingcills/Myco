# myco-fleet-probe:local — minimal lightweight Linux desktop for the R1 fleet probe.
# Xvfb + tiny WM + LibreOffice Calc + python3/flask + the tools OSWorld's
# controller (desktop_env/server) leans on: xdotool, wmctrl, screenshots, AT-SPI.
# OSWorld itself is NOT fetched here.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils xdotool wmctrl openbox \
      libreoffice-calc libreoffice-script-provider-python python3-uno \
      python3 python3-flask python3-pyatspi at-spi2-core dbus-x11 \
      imagemagick x11-apps fonts-dejavu-core procps \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
USER user
WORKDIR /home/user
CMD ["/usr/local/bin/start.sh"]
