| state | n | load1 p50 / p95 / max | qemu cores p50 / p95 / max | load - qemu p50 / p95 / max | mem free % p5 / p50 / min | swap free MB p5 / p50 / min | swapouts/min p50 / p95 / max |
|---|---|---|---|---|---|---|---|
| vm-stopped | 40 | 4.32 / 6.27 / 7.22 | 0.00 / 0.00 / 0.00 | 4.32 / 6.27 / 7.22 | 71 / 73 / 70 | 1683 / 1683 / 1683 | 0.00 / 0.00 / 0.00 |
| v2-idle | 40 | 5.99 / 11.87 / 16.33 | 0.02 / 1.57 / 2.71 | 5.97 / 11.59 / 16.31 | 70 / 75 / 70 | 1683 / 1691 / 1683 | 0.00 / 0.00 / 0.00 |
| v2-resets | 36 | 9.47 / 13.04 / 13.23 | 2.51 / 2.98 / 3.11 | 7.09 / 11.11 / 11.17 | 71 / 75 / 71 | 1691 / 1691 / 1691 | 0.00 / 0.00 / 0.00 |
| clean-base-idle | 40 | 4.43 / 9.11 / 10.23 | 1.06 / 2.60 / 2.67 | 3.18 / 7.07 / 8.40 | 63 / 68 / 62 | 1691 / 1691 / 1691 | 0.00 / 0.00 / 0.00 |

Resume check: consecutive samples with net load < 10.0 (a 180 s span clears the gate).

| state | samples at or over 10.0 | longest span under 10.0 (s) | first 180 s span complete at (s from state start) |
|---|---|---|---|
| vm-stopped | 0 | 593 | 182 |
| v2-idle | 5 | 457 | 274 |
| v2-resets | 7 | 152 | never |
| clean-base-idle | 0 | 596 | 184 |
