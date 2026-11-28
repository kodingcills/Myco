Median (min-max) seconds per phase. n = rows counted; every row is counted.

| label | n | ok | stop | restore | start | ready | clock | total | stability | first ssh answer | load1 at start | host swap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 5 | 5 | 1 (0-1) | 2 (2-3) | 3 (3-3) | 193 (181-199) | 9 (6-14) | 205 (195-219) | 38 (35-54) | 145 (143-159) | 5.28 (3.83-8.27) | n/a |
| after | 2 | 2 | 0.5 (0-1) | 2.5 (2-3) | 3 (3-3) | 175.5 (168-183) | 12.5 (11-14) | 194 (185-203) | 33.5 (29-38) | 142 (139-145) | 6.65 (4.36-8.94) | 9876 (9864-9888) |
| after-recovered | 1 | 1 | 1 (1-1) | 2 (2-2) | 3 (3-3) | 211 (211-211) | 10 (10-10) | 227 (227-227) | 48 (48-48) | 163 (163-163) | 8.08 (8.08-8.08) | 4532 (4532-4532) |
| after-cycle | 5 | 5 | 1 (0-1) | 2 (1-3) | 3 (3-3) | 199 (195-231) | 11 (9-18) | 214 (213-254) | 43 (33-48) | 159 (152-183) | 8.92 (6.71-9.72) | 4460 (4420-4468) |

Reset -> deploy -> session_info cycles.

| label | run | reset s | deploy rc | deploy s | session_info rc | session_info s | session_id | window_station | desktop |
|---|---|---|---|---|---|---|---|---|---|
| after-cycle | 1 | 213 | 0 | 165 | 0 | 4 | 1 | WinSta0 | Default |
| after-cycle | 2 | 254 | 0 | 179 | 0 | 4 | 1 | WinSta0 | Default |
| after-cycle | 3 | 213 | 0 | 229 | 0 | 5 | 1 | WinSta0 | Default |
| after-cycle | 4 | 214 | 0 | 169 | 0 | 4 | 1 | WinSta0 | Default |
| after-cycle | 5 | 220 | 0 | 146 | 0 | 3 | 1 | WinSta0 | Default |

Failed or unchecked rows: 0
