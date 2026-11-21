#!/usr/bin/env bash

# Exit immediately if any command fails
set -euo pipefail

ACTION="${1:-}"

case "$ACTION" in
        wifi-connect)
                SSID="${2:-}"
                if [ -z "$SSID" ]; then
                        echo "Error: Missing SSID." >&2
                        exit 1
                fi
                exec nmcli --ask dev wifi connect "$SSID"
                ;;

        connection-delete)
                CONNECTION_ID="${2:-}"
                if [ -z "$CONNECTION_ID" ]; then
                        echo "Error: Missing connection ID."
                        exit 1
                fi
                exec nmcli connection delete id "$2"
                ;;

        connection-up)
                CONNECTION_ID="${2:-}"
                if [ -z "$CONNECTION_ID" ]; then
                        echo "Error: Missing connection ID." >&2
                        exit 1
                fi
                exec nmcli connection up id "$CONNECTION_ID"
                ;;

        tailscale-login)
                LOGIN_SERVER="${2:-}"
                if [ -z "$LOGIN_SERVER" ]; then
                        echo "Error: Missing Login Server." >&2
                        exit 1
                fi

                PREAUTH_KEY="${3:-}"
                if [ -z "$PREAUTH_KEY" ]; then
                        echo "Error: Missing Preauth Key." >&2
                        exit 1
                fi

                HOSTNAME="${4:-}"
                if [ -z "$HOSTNAME" ]; then
                        echo "Error: Missing Hostname." >&2
                        exit 1
                fi

                exec tailscale up --login-server "$LOGIN_SERVER" --authkey "$PREAUTH_KEY" --hostname "$HOSTNAME"
                ;;

        start-ble)
                exec systemctl start ble.service
                ;;

        stop-ble)
                exec systemctl stop ble.service
                ;;

	start-streamswitch)
		exec systemctl start streamswitch.service
		;;

	stop-streamswitch)
		exec systemctl stop streamswitch.service
		;;

	reboot)
		exec reboot
		;;

	wifi-rescan)
		exec nmcli device wifi rescan
		;;
        *)
                echo "Error: Unauthorized or unknown action '$ACTION'."
                exit 1
                ;;
esac
