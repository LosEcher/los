# Network / Surge Operator Summary — 2026-08-09

- Generated: 2026-08-09T04:40:39.079386+00:00
- Latest probe snapshot: `2026-08-09T03:02:52.185Z` host=`Echers-Mbp.local`
- Bridge: still syncing (`bridge-manifest` latestReport=`2026-08-09T03-02-52-185Z`)

## Current network health (latest snapshot)

### Findings
- `info` `context`: network ssid=<redacted>: (non-home, lan findings downgraded)
- `info` `dns`: explicit DNS probes intercepted by Surge Fake-IP: 198.18.0.2, 223.5.5.5, 119.29.29.29, 1.1.1.1, 8.8.8.8
- `medium` `ping`: wan-1.1.1.1 jitter 59.159ms
- `medium` `ping`: hh-r-public loss 12.5%
- `medium` `ping`: hh-r-public jitter 73.449ms
- `medium` `ping`: hh-z-tail jitter 85.997ms
- `medium` `ping`: oracle-public jitter 85.253ms
- `medium` `ping`: oracle-tail jitter 82.21ms
- `medium` `ssh`: hh-sgp1-z-t SSH ok=2 fail=1
- `medium` `ssh`: hh-sgp1-z-t SSH avg 5588ms

### Ping
| Target | Loss | Avg | Jitter |
| --- | ---: | ---: | ---: |
| `wan-1.1.1.1` | 0% | 135.719 ms | 59.159 ms |
| `localnode34-lan` | 0% | 21.596 ms | 22.601 ms |
| `hh-r-public` | 12.5% | 399.829 ms | 73.449 ms |
| `hh-z-tail` | 0% | 411.579 ms | 85.997 ms |
| `vultr-tail` | 0% | 252.12 ms | 33.379 ms |
| `localnode34-tail` | 0% | 30.878 ms | 28.824 ms |
| `oracle-public` | 0% | 135.212 ms | 85.253 ms |
| `oracle-tail` | 0% | 124.601 ms | 82.21 ms |

### SSH
| Host | OK | Fail | Avg |
| --- | ---: | ---: | ---: |
| `localnode34-r-t` | 3 | 0 | 732 ms |
| `oracle-t` | 3 | 0 | 1158 ms |
| `oracle-p` | 3 | 0 | 2111 ms |
| `hh-sgp1-z-t` | 2 | 1 | 5588 ms |
| `vultr-r-t` | 3 | 0 | 4636 ms |

### Wi-Fi
- SNR 52 dB, channel 149 (5GHz, 80MHz), Tx 1200 Mbps, status Connected

## Surge error windows

- Recent consecutive zero-match windows: **12** (current quiet period)
- Non-zero windows retained: 12

| Window file | Matches | Notes |
| --- | ---: | --- |
| `surge-errors-2026-08-07T17-41-22.json` | 20 | top=10.222.35.3:6 |
| `surge-errors-2026-08-07T19-41-23.json` | 3763 | top=dns.alidns.com:665 |
| `surge-errors-2026-08-07T21-41-23.json` | 18314 | top=dns.alidns.com:3565 |
| `surge-errors-2026-08-07T23-41-24.json` | 18197 | top=dns.alidns.com:3567 |
| `surge-errors-2026-08-08T01-41-24.json` | 237066 | top=127.0.0.1:221336 |
| `surge-errors-2026-08-08T03-41-26.json` | 818829 | top=127.0.0.1:818817 |

- Peak window: `surge-errors-2026-08-08T03-41-26.json` with **818829** matches (dominated by `127.0.0.1` connect_failure storm on 2026-08-08 ~01:41–03:41 UTC).

## Schedule / approval fixes applied

1. **Code**: `preapproved_scope` now skips per-run approval wait for all templates (was only feed_analysis).
2. **Config**: network-observe v5 / surge v4 / NAS34 → `approvalTimeoutAction=approve` (belt-and-suspenders).
3. **Cadence** (earlier): readiness 5m→15m, freshness 10m→30m, retired duplicate network-observe.
4. **Trigger test**: runs entered `running` (no longer `awaiting_approval`) but failed with `Scheduled execution deduplicated` — separate dedupe-key issue on re-trigger; next natural cron/interval should proceed with unique scheduledFor.

## Verdict

- **Connectivity**: home LAN + localnode34 OK; remote HH public has mild loss; HH-SGP SSH flaky/slow; Wi-Fi healthy.
- **Surge**: quiet for last ~12×2h windows (0 matches); earlier 08-07 night / 08-08 early had DoH + 127.0.0.1 storm (HIGH band).
- **Ops**: analysis schedules unblocked from approval_timeout death spiral; need next scheduled tick (or unique manual trigger) to regenerate markdown reports under reports/.

## Recommended network actions

1. Watch `hh-r-public` 12.5% loss and `hh-sgp1-z-t` SSH flakiness over next snapshots.
2. If 127.0.0.1 connect_failure storm returns, inspect local loopback clients / Surge MITM / healthcheck loops.
3. No action on Wi-Fi or localnode34-lan (healthy).
4. Leave surge cadence at 6h once runs succeed; daily network-observe at 09:00 Asia/Shanghai remains appropriate.
