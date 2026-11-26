# Start init services first
docker compose up -d init-dynsec init-mosquitto certbot-init
docker compose ps -a # confirm services exited with code 0

docker compose up -d headscale mosquitto api-gateway
# verification: docker exec nginx_gateway nginx -t
# docker logs nginx_gateway

docker compose up -d node_app node-tailscale mosquitto-tailscale admin-tailscale certbot
# verification: docker exec admin_tailscale tailscale status
# verification: docker exec mosquitto_tailscale tailscale status

#
# Day-to-day maintenance
# docker exec nginx_gateway nginx -t && docker exec nginx_gateway nginx -s reload
# docker volume inspect --format '{{.Name}}: {{.Mountpoint}}' $(docker volume ls --filter name=certbot -q)
# docker exec certbot_renewer certbot renew --webroot -w /var/www/certbot --dry-run
# docker system df
# sudo journalctl -u cron -n 20 --no-pager 2>/dev/null || sudo grep -i cron /var/log/syslog | tail -n 20
#
# Updating services
# docker compose up -d --build --no-deps node_app
# docker compose up -d --no-deps node-tailscale
# docker inspect -f 'netns={{.HostConfig.NetworkMode}} state={{.State.Status}}' node_tailscale
# docker inspect -f 'node_backend_id={{.Id}}' node_backend
# docker exec node_tailscale tailscale status
#
# docker compose up -d --no-deps mosquitto
# docker compose up -d --no-deps mosquitto-tailscale
#
# docker compose pull headscale api-gateway && docker compose up -d --no-deps headscale api-gateway
# docker exec nginx_gateway nginx -t
# docke exec headscale headascale nodes list
