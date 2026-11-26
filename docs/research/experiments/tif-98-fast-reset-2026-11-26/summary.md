| log | boot | first ssh s | guest CPU at first ssh s | reset total s | class |
|---|---|---|---|---|---|
| pass1/reset-e1-after-request-stop.log | 1 | 151 | 287 | 171 | cold |
| pass1/reset-e2-after-request-stop-and-config-write.log | 1 | 13 | 4 | 26 | fast |
| pass1/reset-e3-after-force-stop-and-config-write.log | 1 | 13 | 4 | 25 | fast |
| pass1/reset-t0-after-long-stop.log | 1 | 142 | 283 | 166 | cold |
| pass2/reset-e1-after-request-stop.log | 1 | 144 | 312 | 165 | cold |
| pass2/reset-e2-after-request-stop-and-config-write.log | 1 | 13 | 4 | 27 | fast |
| pass2/reset-e3-after-force-stop-and-config-write.log | 1 | 13 | 4 | 25 | fast |
| pass2/reset-t0-after-long-stop.log | 1 | 142 | 282 | 162 | cold |
| pass3/reset-cold.log | 1 | 143 | 287 | 163 | cold |
| pass3/reset-fast.log | 1 | 13 | 4 | 26 | fast |
| pass4-guard/02-guarded-reset.log | 1 | 13 | 4 | 205 | fast |
| pass4-guard/02-guarded-reset.log | 2 | 143 | 291 | 205 | cold |
| ../tif-98-trial-base-v2-2026-11-26/02-reset-open.log | 1 | 14 | 4 | 27 | fast |
| ../tif-98-trial-base-v2-2026-11-26/20-post-failure-reset.log | 1 | 19 | 23 | 33 | fast |
| ../tif-98-trial-base-v2-2026-11-26-run2/02-reset-open.log | 1 | 14 | 4 | 29 | fast |
| ../tif-98-trial-base-v2-2026-11-26-run2/20-post-failure-reset.log | 1 | 14 | 4 | 34 | fast |
| ../tif-98-trial-base-v2-2026-11-26-run3/02-reset-open.log | 1 | 14 | 4 | 26 | fast |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#1 | 1 | 140 | 284 | 163 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#2 | 1 | 136 | 291 | 157 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#3 | 1 | 123 | 279 | 140 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#4 | 1 | 122 | 280 | 140 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#5 | 1 | 138 | 284 | 160 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#6 | 1 | 162 | 287 | 222 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#7 | 1 | 162 | 287 | 221 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#8 | 1 | 145 | 272 | 204 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#9 | 1 | 162 | 286 | 222 | cold |
| ../tif-98-trial-base-v2-2026-11-26-run3/bench-reset-lines.txt#10 | 1 | 158 | 283 | 218 | cold |
| ../tif-98-trial-base-v2-2026-11-26-parity/clean-base/reset.log | 1 | 164 | 274 | 224 | cold |
| ../tif-98-trial-base-v2-2026-11-26-parity/trial-base-v2/reset.log | 1 | 148 | 274 | 167 | cold |
| ../tif-98-trial-base-v2-2026-11-26-parity/post-reset.log | 1 | 166 | 294 | 226 | cold |
| ../tif-218-load-gate-2026-11-26/reset-clean-base-idle.log | 1 | 165 | 292 | 229 | cold |
| ../tif-218-load-gate-2026-11-26/reset-v2-action-1.log | 1 | 149 | 278 | 170 | cold |
| ../tif-218-load-gate-2026-11-26/reset-v2-action-2.log | 1 | 169 | 289 | 188 | cold |
| ../tif-218-load-gate-2026-11-26/reset-v2-action-3.log | 1 | 158 | 286 | 175 | cold |
| ../tif-218-load-gate-2026-11-26/reset-v2-idle.log | 1 | 158 | 295 | 177 | cold |

Threshold: cold when guest CPU at the first ssh answer >= 100 s.

| class | boots | first ssh s min-max | guest CPU s min-max |
|---|---|---|---|
| cold | 24 | 122-169 | 272-312 |
| fast | 11 | 13-19 | 4-23 |
