# Torrent-side VPN isolation deployment

This deployment runs Jackett and qBittorrent inside a Docker network namespace that is tunneled through NordVPN.

Goal:

- Hermes/OpenAI stays on the host's normal network.
- Only torrent-side services use NordVPN.
- qBittorrent and Jackett are published back to `127.0.0.1` for `torrent-mcp`.

## Files

- `deploy/vpn-qbit/docker-compose.yml`
- `deploy/vpn-qbit/.env.example`

## Requirements

- Docker + Docker Compose plugin 2.17 or newer (dependency restart propagation)
- NordVPN service credentials for the VPN container
- A local download directory

## Quick start

Create private working copies of the templates. On macOS/Linux:

```sh
cd deploy/vpn-qbit
cp .env.example .env
cp config.yaml config.local.yaml
# edit .env and config.local.yaml with local credentials

docker compose --env-file .env up -d
```

On Windows PowerShell:

```powershell
Set-Location deploy/vpn-qbit
Copy-Item .env.example .env
Copy-Item config.yaml config.local.yaml
docker compose --env-file .env up -d
```

Do not commit `.env` or `config.local.yaml`.

### Optional permission hardening

On a shared host or a host with broad default permissions, restrict `.env` and `config.local.yaml` to the account launching Docker. For example, macOS/Linux users can run:

```sh
chmod 600 .env config.local.yaml
```

Windows users can optionally apply a current-user-only ACL. This is not required by the quick-start flow.

Expected local endpoints:

```text
http://127.0.0.1:8080   qBittorrent WebUI
http://127.0.0.1:9117   Jackett WebUI / API
```

## How this fits p2p-tools-mcp

Use the normal Hermes config from `docs/hermes-config.md` so `torrent-mcp` talks to:

- Jackett at `http://127.0.0.1:9117`
- qBittorrent at `http://127.0.0.1:8080`

Point `P2P_TOOLS_CONFIG` at `config.local.yaml`. The supplied deployment config
disables the host-level guard because Gluetun is the network boundary.

In this topology the torrent stack already has its own VPN boundary. A second host-wide VPN is unnecessary and may disrupt the MCP client's connectivity.

## Network guard note

Because the VPN is now inside the torrent container stack, the host-level `vpn-mcp` and host-level `network_guard` are no longer the mechanism that protects torrent traffic.

For this deployment, leave `network_guard.enabled: false`. Enabling the host
guard while leaving the host VPN disconnected blocks searches and adds even
though the container network is healthy.

The container stack itself is what enforces torrent-side VPN isolation here.

The Compose images are pinned by digest. Refresh those digests deliberately as
part of dependency maintenance, review upstream release notes, and do not switch
them back to floating tags such as `latest`.

## Recovery and verification

Gluetun's internal tunnel recovery and a whole-container restart are different events. The dependency `restart: true` settings propagate explicit Compose operations; they do not promise recovery after every automatic runtime crash or namespace replacement. See [Docker startup/restart ordering](https://docs.docker.com/compose/how-tos/startup-order/) and [Gluetun health behavior](https://github.com/qdm12/gluetun-wiki/blob/main/faq/healthcheck.md).

If APIs remain unreachable after a VPN-container restart, inspect health and logs, then deliberately recreate the three-service stack together using `docker compose --env-file .env up -d --force-recreate`. This interrupts active service operations; the configured bind mounts retain their data. Confirm API reachability and VPN egress before resuming work. A healthy container alone does not demonstrate correct egress or leak protection.

The default `data/` directory contains service configuration and downloads and is ignored by Git. Keep any custom runtime paths out of source exports as well. Do not copy the deployment folder wholesale into a publication artifact.

The [local validation record](../../docs/validation.md) does not claim a live container test. Deployment acceptance requires separate checks for startup, internal tunnel recovery, explicit Compose restart, runtime crash, and namespace replacement, including API availability and egress after each event.

## Troubleshooting

### qBittorrent or Jackett do not start

Check the compose logs:

```sh
docker compose --env-file .env logs -f
```

### Port 8080 or 9117 already in use

Stop the older host-side containers or services first.

### VPN credentials fail

NordVPN service credentials are required by the container image.
If you only have the interactive NordVPN CLI login token, that is not enough for this Docker deployment.

### Hermes cannot reach the services

Confirm the compose stack is publishing to `127.0.0.1` and that the containers are healthy:

```sh
docker compose --env-file .env ps
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9117
```
