#!/usr/bin/env python3

import json
import subprocess
import sys

def get_headscale_inventory():
    try:
        # Run tailscale status inside your container to get active nodes as JSON
        # Replace 'tailscale_node' with your actual container name if different
        docker_command = ['docker', 'exec', 'tailscale_node', 'tailscale', 'status', '--json']
        result = subprocess.run(docker_command, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
    except Exception as e:
        # Fallback empty inventory if docker/tailscale command fails
        print(json.dumps({"_meta": {"hostvars": {}}}, indent=2))
        sys.exit(1)

    hosts = {}
    
    # Check Self node (the gateway / droplet itself if needed)
    # self_node = data.get('Self', {})
    # self_hostname = self_node.get('HostName', '')
    # self_ips = self_node.get('TailscaleIPs', [])
    # if self_hostname and self_ips:
    #     hosts[self_hostname] = {
    #         'ansible_host': self_ips[0],
    #         'ansible_user': 'sentinel'
    #     }

    # Iterate through all Peer nodes connected to the tailnet
    for peer_id, peer in data.get('Peer', {}).items():
        hostname = peer.get('HostName', '')
        
        # Filter strictly for your edge devices starting with rpi5b-
        if hostname.startswith('rpi5b-'):
            ips = peer.get('TailscaleIPs', [])
            if ips:
                hosts[hostname] = {
                    'ansible_host': ips[0],
                    'ansible_user': 'sentinel'
                }

    # Construct the final dynamic inventory dictionary for Ansible
    inventory = {
        'edge_fleet': {
            'hosts': list(hosts.keys())
        },
        '_meta': {
            'hostvars': hosts
        }
    }

    return inventory

if __name__ == '__main__':
    # Handle Ansible's expected command-line arguments (--list or --host <hostname>)
    if len(sys.argv) > 1 and sys.argv[1] == '--host':
        # Hostvars are already bundled under _meta, so return an empty dict for individual hosts
        print(json.dumps({}))
    else:
        print(json.dumps(get_headscale_inventory(), indent=2))
