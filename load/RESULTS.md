# Zingo load test results

Run on 3 November 2026 with `npm run load`. One Zingo server process (a single CPU core) on an Apple
silicon Mac with 10 cores and 16 GB. The simulated people ran in 8 separate processes on the same Mac.

Each simulated person connects, joins the text-chat queue, sends 5 messages 4 seconds apart, then
skips to someone new, again and again. People arrive at 400 a second. Each wave is measured for 20 seconds.

## Everyone with no topic (the common case)

| People online | Failed to connect | Messages/s | Delivery p95 | Delivery p99 | Match p95 | Server CPU | Memory |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 500 | 0 | 117 | 1 ms | 1 ms | 43 ms | 4% | 119 MB |
| 1,000 | 0 | 233 | 1 ms | 2 ms | 49 ms | 4% | 125 MB |
| 2,000 | 0 | 467 | 1 ms | 1 ms | 44 ms | 9% | 171 MB |
| 4,000 | 0 | 936 | 1 ms | 2 ms | 21 ms | 15% | 216 MB |
| 8,000 | 0 | 1,873 | 1 ms | 14 ms | 13 ms | 25% | 314 MB |
| 12,000 | 0 | 2,811 | 2 ms | 47 ms | 9 ms | 35% | 406 MB |

## Half of everyone picks a topic nobody else has

They wait for a shared-topic match, then are paired with anyone after 6 seconds, by design.

| People online | Failed to connect | Delivery p95 | Match p50 | Match p95 | Server CPU | Memory |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 0 | 1 ms | 14 ms | 6.9 s | 5% | 152 MB |
| 2,000 | 0 | 1 ms | 6 ms | 6.8 s | 8% | 172 MB |
| 4,000 | 0 | 1 ms | 3 ms | 6.7 s | 13% | 213 MB |
| 8,000 | 0 | 1 ms | 10 ms | 6.9 s | 25% | 308 MB |
| 12,000 | 0 | 2 ms | 11 ms | 6.9 s | 33% | 416 MB |

## Sign-ups

200 sign-ups, 20 at a time: about 170 a second, p95 121 ms. Passwords are hashed with scrypt on
purpose (slow to guess); this is the most CPU-heavy thing the server does.

## Bottlenecks found and fixed

1. **The "people online" count was sent to everyone each time anyone joined.** With 1,600 people
   online and 400 arriving a second, that was about 640,000 messages a second. New connections were
   dropped (about 20% failed at 2,000 people). Now only the newcomer gets the count on joining;
   everyone else gets the 5-second update.
2. **Matching compared everyone waiting with everyone else waiting**, on every join. When people
   queued up (picky topics, strict filters), the work grew with the square of the queue and the
   server stalled (a third of connections failed at 2,000 people). Matching now looks a newcomer up
   by topic, and a once-a-second sweep pairs people who have waited, with a cap on its work.
   The matching rules are unchanged; a new test covers the 6-second wait.

## What this means

- One server handled 12,000 people chatting at once using about a third of one core. The test
  stopped there only because one Mac runs out of local network ports at about 16,000 connections.
- Cloud CPUs are slower per core than this Mac. A reasonable planning figure for one small cloud
  server (2 vCPU, 4 GB) is **around 10,000 people online at once**. Re-run this test on the real
  server before launch to get its own number.
- Move to several servers with Redis (Stage 2 of the plan) when the real server reaches about half
  its measured limit.

## What this test does not cover

- Video. Calls go directly between people, so they barely touch the server, but the relay (TURN)
  server for blocked networks needs its own capacity check.
- Real internet delays and Cloudflare in front of the server. Everything here ran on one machine.
- Database growth over months, and email or SMS provider limits.

## Running it

```bash
npm run load                                  # 500 to 8,000 people
npm run load -- --levels 1000,4000,12000      # your own waves
npm run load -- --picky 0.5                   # half the people pick rare topics
npm run load -- --rate 100 --measure 30000    # slower arrivals, longer measuring
```

On macOS, very fast arrivals can hit the system's small connection queue (`kern.ipc.somaxconn` is
128 there). Linux servers default to 4,096, so this is a limit of the test machine, not of Zingo.
