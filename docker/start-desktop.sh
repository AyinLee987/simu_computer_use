#!/bin/sh
set -eu

: "${DEMO_CONTROL_TOKEN:?DEMO_CONTROL_TOKEN must be set}"
# One private container session bus for Chromium, AT-SPI and the controller.
# Never inherit or mount the host desktop's bus.
if [ "${1:-}" != "--desktop-session" ]; then
  unset DBUS_SESSION_BUS_ADDRESS AT_SPI_BUS_ADDRESS
  exec dbus-run-session -- /bin/sh /opt/demo/start-desktop.sh --desktop-session
fi
export DISPLAY=:99
export NO_AT_BRIDGE=0
# Chromium's ATK bridge has a separate enable gate from renderer AX generation.
# Explicitly enable it inside this private desktop, without toggling host state.
export ACCESSIBILITY_ENABLED=1
export GTK_MODULES=atk-bridge
export GDK_BACKEND=x11
export XDG_RUNTIME_DIR=/tmp/runtime-demo
mkdir -p "$XDG_RUNTIME_DIR" /tmp/demo-downloads
chmod 700 "$XDG_RUNTIME_DIR" /tmp/demo-downloads

cleanup() {
  for worker in "${CONTROL_PID:-}" "${NOVNC_PID:-}" "${VNC_PID:-}" "${WM_PID:-}" "${XVFB_PID:-}"; do
    if [ -n "$worker" ]; then kill -TERM "$worker" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# Forced container stops can retain X11 endpoints in /tmp. Check the current
# display and process identities before removing only those fixed stale files.
python3 /opt/demo/x11_startup.py
Xvfb :99 -screen 0 1000x720x24 -nolisten tcp -ac >/tmp/demo-xvfb.log 2>&1 &
XVFB_PID=$!
attempt=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ] || ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo 'The virtual desktop could not start.' >&2
    exit 1
  fi
  sleep 0.1
done

openbox --sm-disable >/tmp/demo-openbox.log 2>&1 &
WM_PID=$!
x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -viewonly -noxdamage -quiet >/tmp/demo-vnc.log 2>&1 &
VNC_PID=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/demo-novnc.log 2>&1 &
NOVNC_PID=$!
python3 /opt/demo/control.py &
CONTROL_PID=$!

while kill -0 "$CONTROL_PID" 2>/dev/null && kill -0 "$NOVNC_PID" 2>/dev/null && kill -0 "$VNC_PID" 2>/dev/null && kill -0 "$XVFB_PID" 2>/dev/null; do
  sleep 1
done
echo 'A desktop service stopped.' >&2
exit 1
