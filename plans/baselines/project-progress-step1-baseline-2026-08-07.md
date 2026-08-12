# Project Progress Step 1 Baseline

- Captured: 2026-08-07
- Platform: Darwin 25.5.0 arm64
- Node.js: v24.3.0
- Scenario: `P=100`, `R=50`, `A=20`
- Command: `npm run benchmark:project-progress -w agent`

## Sample Result

| Metric | Value |
| --- | ---: |
| Duration | 270.7 ms |
| RSS start | 101,105,664 bytes |
| RSS peak | 146,161,664 bytes |
| RSS delta | 45,056,000 bytes |
| GitHub peak concurrency | 6 |
| Agent peak concurrency | 2 |
| OA write peak concurrency | 0 |
| Agent queue p50 | 10.49 ms |
| Agent queue p95 | 23.29 ms |

## Deterministic Request Counts

| Endpoint | Requests |
| --- | ---: |
| `oa.project.list` | 1 |
| `oa.project.get` | 100 |
| `github.repository.get` | 50 |
| `github.branches.list` | 50 |
| `github.commits.list` | 50 |
| `model.project-progress.summarize` | 20 |

The fake server intentionally adds only 1 ms of response delay. Absolute duration,
latency, and RSS are local comparison data, not production capacity targets. The
scenario shape, endpoint request counts, task counts, and configured concurrency
peaks are regression assertions and must remain deterministic.
