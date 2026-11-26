sudo mkdir -p /var/lib/kronoscast-cert-state
sudo tee /usr/local/bin/reload-nginx-on-cert-renewal.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

CERT_PATH="/var/lib/docker/volumes/backend_certbot-etc/_data/live/edge.kronoscast.com/fullchain.pem"
STATE_FILE="/var/lib/kronoscast-cert-state/edge.kronoscast.com.enddate"

[ -f "$CERT_PATH" ] || exit 0

CURRENT_ENDDATE="$(openssl x509 -in "$CERT_PATH" -noout -enddate)"
PREV_ENDDATE="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [ "$CURRENT_ENDDATE" != "$PREV_ENDDATE" ]; then
  /usr/bin/docker exec nginx_gateway nginx -t
  /usr/bin/docker exec nginx_gateway nginx -s reload
  printf '%s\n' "$CURRENT_ENDDATE" > "$STATE_FILE"
fi
EOF
sudo chmod +x /usr/local/bin/reload-nginx-on-cert-renewal.sh

# 25 3,15 * * * /usr/local/bin/reload-nginx-on-cert-renewal.sh >> /var/log/kronoscast-cert-reload.log 2>&1