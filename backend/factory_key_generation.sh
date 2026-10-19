# 1. Generate the Private Key
openssl ecparam -name prime256v1 -genkey -noout -out private_key.pem

# 2. Extract the Public Key
openssl ec -in private_key.pem -pubout -out public_key.pem