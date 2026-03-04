# 24h Colocated Benchmark of Solana pump.fun WebSocket Feeds

Capture service and analysis scripts for benchmarking WebSocket latency across pump.fun token creation feeds. Connects simultaneously to Darkfibre, PumpAPI and PumpPortal, records the exact millisecond each new mint is received, then computes win rate, relative delay and coverage across platforms.

This is the tooling used in the [24h Colocated WebSocket Benchmark](https://darkfibre.dev/benchmarks/24h-colocated-websocket).

## How It Works

`ws-measure.ts` opens a persistent WebSocket connection to all three platforms at the same time. The moment a new pump.fun token creation event arrives on any feed, it records `Date.now()` and appends a row to a CSV file:

```
mint, signature, timestamp_ms, platform, server
```

`ws-analyze.ts` loads one or more of those CSVs, groups rows by mint address and computes three metrics per platform:

- **Win rate** — how often a platform was the first to deliver the event
- **Relative delay** — for each mint, the delay between a platform and the fastest observed platform (mean, p50, p95, p99)
- **Coverage** — what percentage of unique mints each platform delivered at all

The analysis uses a *colocated perspective*: each platform is evaluated from its nearest server (Darkfibre from Frankfurt, PumpAPI and PumpPortal from New York). This is the fairest comparison — it removes cross-continental network distance as a variable.

## Infrastructure

### Where to Rent Servers

You need two servers in specific regions to replicate the benchmark setup:

- **Frankfurt (FRA)** for Darkfibre.
- **New York (NY)** for PumpAPI and PumpPortal.

### Network Proximity

Aim for **under 1ms ping** from each server to its target endpoint. You can check this with:

```bash
ping ws.darkfibre.dev       # from Frankfurt server
ping stream.pumpapi.io      # from New York server
ping pumpportal.fun         # from New York server
```

> **Note on PumpPortal:** PumpPortal is located in New York. As of the time of writing, PumpPortal is blocking ICMP (ping).

## Clock Synchronization

Cross-server timestamp comparison is only meaningful if both clocks are synchronized to the same time source. A 10ms clock drift between servers would corrupt the entire dataset. Use Chrony to keep both servers locked to NTP.

### Install Chrony

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y chrony

# RHEL / CentOS / Fedora
sudo dnf install -y chrony
```

### Configure Chrony

Replace the contents of `/etc/chrony.conf` (or `/etc/chrony/chrony.conf` on Debian-based systems) with:

```
# Use multiple high quality pools
pool pool.ntp.org iburst
pool time.google.com iburst
pool time.cloudflare.com iburst

# Step clock if offset >1s on startup
makestep 1.0 3

# Drift file
driftfile /var/lib/chrony/chrony.drift

# Allow large initial correction
rtcsync

# Faster convergence
maxupdateskew 100.0
```

Then restart and enable the service:

```bash
sudo systemctl restart chronyd
sudo systemctl enable chronyd
```

### Wait for Stabilization

After starting Chrony, **wait at least 15 minutes** before starting the benchmark. NTP synchronization is not instant — the daemon needs time to measure network delay, estimate clock drift and converge to a stable offset. Starting measurements too early will produce noisy or biased timestamps.

### Verify Sync

```bash
chronyc tracking
```

Example output:

```
Reference ID    : D8EF2308 (time3.google.com)
Stratum         : 2
Ref time (UTC)  : Wed Mar 04 10:19:13 2026
System time     : 0.000117030 seconds fast of NTP time
Last offset     : +0.000018439 seconds
RMS offset      : 0.000017913 seconds
Frequency       : 9.377 ppm fast
Residual freq   : -0.000 ppm
Skew            : 0.001 ppm
Root delay      : 0.009670629 seconds
Root dispersion : 0.000476209 seconds
Update interval : 1026.1 seconds
Leap status     : Normal
```

**What the key fields mean:**


| Field               | What it means                                                         | Good value               |
| ------------------- | --------------------------------------------------------------------- | ------------------------ |
| **System time**     | How far your clock currently is from NTP time                         | < 1ms                    |
| **Last offset**     | The correction applied in the last update                             | < 0.1ms                  |
| **RMS offset**      | Average offset over recent history                                    | < 0.1ms                  |
| **Root delay**      | Round-trip network latency to the NTP source                          | < 20ms (lower is better) |
| **Root dispersion** | Accumulated uncertainty in the time source                            | < 1ms                    |
| **Stratum**         | Distance from a reference atomic clock (1 = direct, 2 = one hop away) | 2 is fine                |
| **Skew**            | Rate of change of the frequency error                                 | < 1 ppm                  |


The output above is a good baseline for starting measurements: system time is 0.117ms fast, RMS offset is 0.018ms and skew is 0.001 ppm. At those numbers the clock is stable and the inter-server comparison will be reliable.

## Setup

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
git clone https://github.com/darkfibre-dev/darkfibre-measure-ws-public
cd darkfibre-measure-ws-public
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```env
# FRA | NY depending on the physical server location
SERVER=

# API key for WS connection: https://darkfibre.dev/register
DARKFIBRE_API_KEY=
```

Set `SERVER` to `FRA` on the Frankfurt server and `NY` on the New York server. Both servers need the same `DARKFIBRE_API_KEY`.

## Running the Benchmark

### Start the Capture

The benchmark runs for 24 hours and writes CSV data to `data/ws/`. Start it on **both servers at the same time**, open two terminals with SSH into each server, prepare the command on both, then hit enter on each as close together as possible. The exact timing difference does not matter much, but starting together avoids missing any mints that happen to be created in the gap between the two starts.

> Use `nohup` so the process keeps running after you close the SSH session. Without it, closing the terminal kills the process.

```bash
nohup npm run ws-measure > /dev/null 2>&1 &
echo $!
```

To check that the process is still running:

```bash
ps aux | grep ws-measure
```

Verify this on both servers before walking away and closing the connection.

### Collect the Data

After 24 hours, copy the CSV files from both servers to a single machine for analysis. The filename contains the Unix timestamp of when the capture was started. Copy the specific file for your run:

```bash
mkdir -p data/2026-03-04

scp root@fra-server:/root/darkfibre-measure-ws-public/data/measurements_1234567890_FRA.csv data/2026-03-04/
scp root@ny-server:/root/darkfibre-measure-ws-public/data/measurements_1234567890_NY.csv   data/2026-03-04/
```

### Run the Analysis

Point the analyzer at the folder containing both CSV files:

```bash
npm run ws-analyze data/2026-03-04
```

## Interpreting the Results

The analyzer prints three sections per view.

**Win rate** shows how often each platform was the first to deliver a mint event.

**Delay vs. fastest** shows relative latency. For each mint, the gap between a platform and whichever platform saw the event first. A platform that wins has a delay of 0ms for that event.  

**Coverage** shows what fraction of unique mints each platform recieved. All platforms should be above 99%. If one is significantly lower, check for connection drops in the log file.