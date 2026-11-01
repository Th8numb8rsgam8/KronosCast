import os
import time
import subprocess
import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

import pdb

def sign_payload(private_key_file, hardware_id, timestamp):

    """Signs the payload (hardware_id + timestamp) using the private key."""
    with open(private_key_file, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(),
            password=None
        )
    
    # Message to sign must match what the server expects
    message = f"{hardware_id}:{timestamp}".encode('utf-8')
    
    signature = private_key.sign(
        message,
        ec.ECDSA(hashes.SHA256())
    )
    return signature.hex()

def factory_register(api_gateway_url, hardware_id):

    timestamp = int(time.time())
    private_key_file = "private_key.pem" # Path to the private key on your factory machine
    
    try:
        signature = sign_payload(private_key_file, hardware_id, timestamp)
        
        payload = {
            "hardwareId": hardware_id,
            "timestamp": timestamp,
            "signature": signature,
        }
        
        print(f"Sending signed registration for HWID: {hardware_id}...")
        response = requests.post(api_gateway_url, json=payload, timeout=10)
        pdb.set_trace()
        
        if response.status_code == 200:
            print("Successfully pre-authorized via asymmetric verification!")
        else:
            print(f"Failed: {response.status_code} - {response.text}")
            
    except Exception as e:
        print(f"Error during factory signing: {e}")

if __name__ == "__main__":

    api_gateway_url = "http://localhost:80/api/factory/registration"
    hardware_id = "861f80d775293ae5"
    factory_register(api_gateway_url, hardware_id)