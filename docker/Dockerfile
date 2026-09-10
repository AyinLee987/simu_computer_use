FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pil xvfb openbox x11vnc novnc websockify \
      chromium xdotool scrot fonts-noto-cjk ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/sh demo \
    && mkdir -p /opt/demo/labs /tmp/demo-downloads \
    && chown -R demo:demo /opt/demo /tmp/demo-downloads

COPY --chown=demo:demo docker/start-desktop.sh docker/control.py /opt/demo/
COPY --chown=demo:demo public/labs/ /opt/demo/labs/
RUN chmod 0755 /opt/demo/start-desktop.sh

USER demo
WORKDIR /opt/demo
EXPOSE 6080 8000
ENTRYPOINT ["/bin/sh", "/opt/demo/start-desktop.sh"]
