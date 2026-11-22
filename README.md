# Cybersecurity Threat Intelligence Dashboard

Investigate a suspicious public IPv4 or IPv6 address from a firewall, server, or application log. The dashboard uses AbuseIPDB's community reporting data to help an analyst decide which indicators to review first.

**Deployed dashboard** · [Open via Lb01](http://3.8.170.130/)

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer with npm. The application uses built-in Node.js modules and has zero package dependencies.

1. Clone the [GitHub repository](https://github.com/richy-did/Cybersecurity-Threat-Intelligence-Dashboard) or use the existing checkout.
2. Copy the environment template to a private .env file. In PowerShell run `Copy-Item .env.example .env`. On Linux or macOS run `cp .env.example .env`.
3. Create a key in your [AbuseIPDB account](https://www.abuseipdb.com/account/api) and put it in the local .env file as `ABUSEIPDB_API_KEY`. The dashboard itself requires no login. The **Load sample** button works with an empty key.
4. Run `npm start` and open <http://127.0.0.1:3000>. Use `npm.cmd start` if PowerShell blocks npm.ps1.
5. Run `npm test` (or `npm.cmd test` in PowerShell) to exercise the HTTP API against a simulated provider.

## Investigate an indicator

1. Enter a public IP and choose a 7-, 30-, or 90-day report window.
2. Review the abuse confidence score, report count, network metadata, and last report date. The dashboard classifies 0-24 as low, 25-74 as moderate, and 75-100 as high. These are application triage thresholds. Assess the result alongside your logs and the address's role in the incident.
3. Search investigation history by IP, provider, domain, country code, or source. Filter by risk or sort by recency, score, or report count. Open any saved result by selecting its IP.
4. Select **Download report** to export the chosen result as JSON with source, timestamp, time window, score, risk, and network metadata.

The latest 50 unique IP/window/source records are kept in browser storage. Live results are timestamped when received from AbuseIPDB, and repeat requests may reuse that timestamp during the cache window. Synthetic samples are labeled in the result, history, and download. Select **Load sample** three times to create one record per risk level.

## API integration and development challenges

- **Protecting the key.** The browser calls a same-origin Node.js endpoint. The server sends the key in the upstream HTTPS `Key` header to the fixed AbuseIPDB host. Only allowlisted response fields are returned. The local secret file is ignored by Git, and the production secret lives outside the source tree.
- **Working within quotas.** The [AbuseIPDB rate-limit documentation](https://docs.abuseipdb.com/#api-daily-rate-limits) lists 1,000 CHECK requests per day on the Standard plan. Each process caches up to 500 successful results for ten minutes, shares concurrent identical lookups, and limits upstream attempts to 400 per 24-hour process window by default. Lb01 also throttles requests per client IP. The two process budgets reset on restart, and AbuseIPDB still enforces the account's actual quota.
- **Handling failures.** IPv4 and IPv6 inputs and provider responses are validated. A missing or rejected key, provider outage, invalid payload, slow response, or throttling produces user-facing feedback. The app respects the provider's `Retry-After` value and continues serving cached results while throttled.
- **Serving two nodes.** History lives in the browser and requests work on either server. Each node has its own disposable cache. The health check tests process liveness independently of the provider.

## Deploy on Web01 and Web02

These are deployment instructions for Linux servers running systemd. Use an administrator account, Node.js 22+, and the same source revision on both nodes. Match the service's `ExecStart` path to the installed binary. The server needs outbound HTTPS access to AbuseIPDB. Allow TCP port 3000 to the app nodes from Lb01's private address.

The assignment deployment uses Ubuntu 20.04 on both web nodes. The Node.js 22 ARM64 release was checksum-verified and its binary installed at `/usr/local/bin/node`. The deployed systemd unit uses that path.

On each application server, from the project checkout:

```sh
id ipintel >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home ipintel
sudo install -d -m 0755 /opt/ip-intelligence/public
sudo install -m 0644 server.mjs /opt/ip-intelligence/server.mjs
sudo install -m 0644 public/index.html public/app.js public/styles.css /opt/ip-intelligence/public/
sudo install -m 0644 deploy/ip-intelligence.service /etc/systemd/system/ip-intelligence.service
sudo touch /etc/ip-intelligence.env
sudo chown root:root /etc/ip-intelligence.env
sudo chmod 0600 /etc/ip-intelligence.env
sudoedit /etc/ip-intelligence.env
```

Set the following values in the environment file. On Web02 change the instance ID to `web02` and use its own private address. Enter the real key only on the server.

```dotenv
ABUSEIPDB_API_KEY=REPLACE_WITH_PRIVATE_KEY
HOST=WEB01_PRIVATE_IP
PORT=3000
INSTANCE_ID=web01
DAILY_LOOKUP_LIMIT=400
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable ip-intelligence
sudo systemctl restart ip-intelligence
sudo systemctl status ip-intelligence
curl -fsS http://WEB01_PRIVATE_IP:3000/health
```

Repeat the health request with the Web02 private address and confirm the instance names. For later releases update one node at a time. Verify the updated node is healthy and serving through Lb01 before updating the second.

## Configure Lb01

Install [HAProxy](https://www.haproxy.com/) using the server package manager. The assignment deployment validated the configuration with Ubuntu's HAProxy 2.0.33 package. Copy [deploy/haproxy.cfg](deploy/haproxy.cfg) to Lb01, replace both private-IP placeholders, and check each node's `/health` endpoint from Lb01. The template listens on port 80. For a public HTTPS endpoint configure Lb01 with a DNS hostname and a certificate for that hostname, then use the TLS bind shown in the config. Review existing listener bindings before installing the template on a shared server.

```sh
sudo haproxy -c -f ./haproxy.cfg
sudo cp /etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg.bak
sudo install -m 0644 ./haproxy.cfg /etc/haproxy/haproxy.cfg
sudo systemctl enable haproxy
sudo systemctl reload-or-restart haproxy
```

Set `LB_URL` to the actual URL, including its HTTP or HTTPS scheme. Make multiple requests and confirm both `web01` and `web02` appear. Then open the dashboard through that URL and run a live lookup.

```sh
for attempt in 1 2 3 4 5 6; do
  curl -fsS "$LB_URL/health"
  printf '\n'
done
curl -fsS "$LB_URL/api/lookup?ip=8.8.8.8&days=30"
```

To verify failover on dedicated assignment servers, stop the app on one node, give HAProxy time to detect the failed check, and repeat the requests. Confirm the other node serves them. Start the stopped service, wait for recovery, and verify both names reappear.

### Deployment verification

Six consecutive requests to the public [health endpoint](http://3.8.170.130/health) alternated between `web01` and `web02`. The public dashboard and its static assets returned HTTP 200. An invalid IP returned HTTP 400 with a validation message. Live lookups will return HTTP 503 until the AbuseIPDB key is provisioned on both web nodes. Sample investigations are available immediately.

## Submission and demo

- GitHub repository for submission is [Cybersecurity-Threat-Intelligence-Dashboard](https://github.com/richy-did/Cybersecurity-Threat-Intelligence-Dashboard).
- Add the hosted demo link to this README after recording.
- Provide any credentials required by the assignment using its private submission channel. Keep the API key out of source, screenshots, and video.

| Time | Show |
| --- | --- |
| 0:00-0:20 | Start the app locally and explain how it helps triage a suspicious indicator. |
| 0:20-0:50 | Run a live IP lookup, explain the score and report window, then show an invalid-IP message. |
| 0:50-1:20 | Use history search, risk filtering, and sorting. Reopen a result and download its report. |
| 1:20-1:50 | Open the public dashboard through Lb01. Show repeated /health requests reaching both nodes. |

## Credits

- AbuseIPDB maintains the reputation data and [API v2 CHECK endpoint](https://docs.abuseipdb.com/#check-endpoint). Its documentation credits [IPinfo](https://ipinfo.io/) for network metadata.
- The server uses [Node.js](https://nodejs.org/) and the deployment uses [HAProxy HTTP health checks](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/).
