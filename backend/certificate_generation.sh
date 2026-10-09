#!/usr/bin/bash

# 1. Generate CA Private Key
openssl genrsa -out ca.key 2048

# 2. Generate Self-Signed Root CA Certificate (valid for 10 years)
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/C=US/ST=State/L=City/O=MyOrg/OU=Development/CN=MyLocalCA"

# 1. Generate Broker Private Key (server.key)
openssl genrsa -out server.key 2048

# 2. Generate Certificate Signing Request (server.csr)
# Replace 'YOUR_SERVER_IP_OR_DOMAIN' with your actual server IP or domain name
openssl req -new -key server.key -out server.csr \
  -subj "/C=US/ST=State/L=City/O=MyOrg/OU=Development/CN=YOUR_SERVER_IP_OR_DOMAIN"

# 1. Create SAN extensions file (Replace IP/DNS values below with your server's address)
cat <<EOF > server.ext
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
# IP.2 = YOUR_SERVER_PUBLIC_OR_LOCAL_IP
# DNS.2 = your.domain.com
EOF

# 2. Sign the server certificate using your CA (valid for 2 years)
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 730 -sha256 -extfile server.ext

chmod 644 ca.crt server.crt
chmod 600 server.key ca.key

openssl verify -CAfile ca.crt server.crt