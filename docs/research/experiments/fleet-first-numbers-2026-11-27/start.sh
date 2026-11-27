#!/bin/sh
# Container entrypoint: Xvfb on :1, openbox, then Calc with a seeded CSV.
# Writes marker files so the host can timestamp milestones without guessing.
set -u
export DISPLAY=:1
printf 'region,q1,q2\nnorth,10,12\nsouth,7,9\neast,4,15\n' > /home/user/seed.csv
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp -noreset >/tmp/xvfb.log 2>&1 &
i=0
until xdpyinfo -display :1 >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.05; done
date +%s.%N > /tmp/x_ready
( until openbox >>/tmp/openbox.log 2>&1; do sleep 0.1; done ) &
soffice --calc --norestore --nologo --nofirststartwizard \
  --infilter="Text - txt - csv (StarCalc):44,34,76,1" /home/user/seed.csv >/tmp/soffice.log 2>&1 &
# "Calc up" = a top-level window titled with the seeded file exists on :1.
( until wmctrl -l 2>/dev/null | grep -qi 'seed'; do sleep 0.1; done
  date +%s.%N > /tmp/calc_ready ) &
wait
