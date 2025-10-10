#!/bin/bash
KEY_PATH=$1
ENCRYPTED_DATA=$2

# Decode base64 and decrypt using OpenSSL with PKCS1 padding
echo "$ENCRYPTED_DATA" | base64 -d | openssl pkeyutl -decrypt -inkey "$KEY_PATH" -pkeyopt rsa_padding_mode:pkcs1