ssh-keygen -t ed25519 -f ~/.ssh/ssh_ca_key -C edge-fleet-ca

ssh-keygen -s ~/.ssh/ssh_ca_key -I droplet-admin-key -V +1d -n pi ~/.ssh/id_ed25519.pub

# sudo vim /etc/ssh/sshd_config.d/ca.conf
# TrustedUserCAKeys /etc/ssh/ssh_ca_key.pub
#
# sudo chown root:root /etc/ssh/sshd_config.d/ca.conf
# sudo chmod 644 /etc/ssh/sshd_config.d/ca.conf
#
# sudo chown root:root /etc/ssh/ssh_ca_key.pub
# sudo chmod 644 /etc/ssh/ssh_ca_key.pub
#
# sudo systemctl restart ssh
