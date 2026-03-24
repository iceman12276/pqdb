# PQC TLS Compatibility

pqdb uses **X25519MLKEM768** for TLS key exchange — a hybrid post-quantum key encapsulation mechanism that combines classical X25519 (ECDH) with ML-KEM-768 (NIST FIPS 203). This is negotiated automatically by Caddy, which uses Go 1.24+ where X25519MLKEM768 is the default key exchange group.

## How It Works

When a client connects to pqdb over HTTPS, the TLS handshake negotiates key exchange. If **both** the client and server support X25519MLKEM768, the connection uses post-quantum key exchange. If the client does not support it, TLS falls back to classical X25519 — the connection is still encrypted and secure, just not quantum-resistant at the transport layer.

**Important:** Regardless of TLS key exchange, all sensitive data in pqdb is **ML-KEM encrypted at the application layer** by the SDK before transmission. PQC TLS adds defense-in-depth but is not the only layer of post-quantum protection.

## Client Compatibility

### Clients that negotiate PQC (X25519MLKEM768)

| Client | Minimum Version | Notes |
|--------|----------------|-------|
| **Google Chrome** | 131+ | Enabled by default since Chrome 131 (Nov 2024). Uses BoringSSL with ML-KEM support. |
| **Microsoft Edge** | 131+ | Chromium-based, same TLS stack as Chrome. |
| **Mozilla Firefox** | 132+ | Enabled by default since Firefox 132 (Oct 2024). |
| **Safari** | 18.4+ | Enabled in Safari 18.4 (Apr 2025) on macOS/iOS. |
| **Node.js** | 23+ | Node 23 ships with OpenSSL 3.x with ML-KEM support. Use `tls.connect()` — X25519MLKEM768 is offered by default. |
| **curl** | 8.11+ | Requires curl built with OpenSSL 3.5+ or BoringSSL with ML-KEM. |
| **OpenSSL** | 3.5+ | `openssl s_client` negotiates X25519MLKEM768 when available. |

### Clients that fall back to classical X25519

| Client | Version | What Happens |
|--------|---------|--------------|
| **Node.js** | 22 (LTS) | Falls back to X25519 (classical ECDH). The connection is fully encrypted with TLS 1.3, just not using PQC key exchange. **This is still secure** — data confidentiality is provided by AES-256-GCM and forward secrecy by X25519. Additionally, all sensitive data is ML-KEM encrypted at the application layer by the pqdb SDK regardless of TLS version. |
| **Chrome** | <131 | Classical X25519. Same security note as above. |
| **Firefox** | <132 | Classical X25519. Same security note as above. |
| **Safari** | <18.4 | Classical X25519. Same security note as above. |
| **OpenSSL** | <3.5 | Classical X25519. Cannot verify PQC negotiation. |
| **Python requests** | Any | Uses system OpenSSL. PQC depends on the OpenSSL version installed. |

## Verifying PQC TLS

### Method 1: Verification script (recommended)

```bash
./infra/scripts/verify-pqc-tls.sh
```

This script connects to Caddy using `openssl s_client` and checks whether X25519MLKEM768 was negotiated. Requires OpenSSL 3.5+ on the client side to actually negotiate PQC — older versions will show a classical fallback warning.

### Method 2: Chrome DevTools

1. Open `https://localhost` in Chrome 131+
2. Open DevTools (F12) > **Security** tab
3. Look for the connection details — the key exchange should show **X25519MLKEM768**

### Method 3: Node.js

```javascript
const tls = require('node:tls');

const socket = tls.connect(443, 'localhost', {
  rejectUnauthorized: false, // Caddy internal CA
}, () => {
  const cipher = socket.getCipher();
  const ephemeral = socket.getEphemeralKeyInfo();
  console.log('Protocol:', socket.getProtocol());
  console.log('Cipher:', cipher.name);
  console.log('Ephemeral key:', ephemeral);
  // ephemeral.type should be 'X25519MLKEM768' on Node 23+
  socket.end();
});
```

### Method 4: openssl s_client

```bash
echo "Q" | openssl s_client -connect localhost:443 -servername localhost 2>&1 | grep "Server Temp Key"
# Expected (OpenSSL 3.5+): Server Temp Key: X25519MLKEM768, ...
# Fallback (older OpenSSL): Server Temp Key: X25519, 253 bits
```

## Security Model: Defense in Depth

pqdb's post-quantum security does **not** depend solely on PQC TLS:

| Layer | Protection | Algorithm |
|-------|-----------|-----------|
| **Application** | All sensitive column data encrypted client-side before transmission | ML-KEM-768 (FIPS 203) |
| **Application** | Blind index generation for searchable encrypted columns | HMAC-SHA3-256 |
| **Transport** | TLS 1.3 key exchange (when both sides support PQC) | X25519MLKEM768 |
| **Transport** | TLS 1.3 record encryption | AES-256-GCM |
| **Authentication** | API token signatures | ML-DSA-65 (FIPS 204) |

Even if an attacker records TLS traffic today and later gains access to a quantum computer:
- **With PQC TLS (X25519MLKEM768):** The recorded traffic cannot be decrypted — ML-KEM-768 is quantum-resistant.
- **Without PQC TLS (X25519 fallback):** The TLS session keys could theoretically be recovered, but the payload contains ML-KEM ciphertext that is still quantum-resistant. The attacker sees encrypted blobs, not plaintext.

## Caddy Configuration

Caddy uses Go's standard `crypto/tls` package. Since Go 1.24, `X25519MLKEM768` is included in the default key exchange groups — no explicit configuration is needed in the Caddyfile. The relevant line in `infra/Caddyfile`:

```
tls internal
```

This enables TLS with Caddy's internal CA. Go 1.24+ automatically offers X25519MLKEM768 during the TLS handshake.
