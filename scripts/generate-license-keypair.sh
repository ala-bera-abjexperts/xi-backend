#!/usr/bin/env bash
#
# Generate the vendor Ed25519 keypair that signs on-premise licence artifacts.
#
# VENDOR TOOL. Run this once per key id, on a trusted machine, by whoever holds
# the SaaS secret store. It is not part of any build, is never run on a customer
# box, and the private half it produces must never enter this repository, an
# image, or anything a customer receives.
#
#   ./scripts/generate-license-keypair.sh v1
#
# It writes the private key to ./license-signing-<kid>.pem in the CURRENT
# directory (mode 0600) and prints the public half in exactly the form
# TRUSTED_PUBLIC_KEYS expects: base64 of the SPKI DER, on one line.
#
# WHY THE PUBLIC HALF IS PASTED INTO SOURCE AND NOT READ FROM ENV
# The on-prem customer owns their environment files. A public key supplied via
# env can be swapped for one whose private half they hold, and they can then
# mint their own licences. A compiled constant can only be changed by shipping a
# new image, which is the vendor's to control. See license-artifact.crypto.ts.
#
# ROTATION
# Keys are held in a map by `kid`, so rotation needs no flag day: generate a new
# kid, ship a release that trusts BOTH, re-issue artifacts under the new kid,
# then drop the old entry in a later release once no artifact under it is still
# within its TTL.
set -euo pipefail

KID="${1:-}"
if [ -z "$KID" ]; then
  echo "usage: $0 <kid>            e.g. $0 v1" >&2
  echo "  <kid> is the key id recorded in every artifact this key signs." >&2
  exit 2
fi

case "$KID" in
  *[!a-zA-Z0-9_-]*)
    echo "ERROR: kid '$KID' must be alphanumeric plus - and _ (it goes into JSON)." >&2
    exit 2 ;;
esac

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl not found." >&2; exit 1; }

PRIV="license-signing-${KID}.pem"

# Refuse to clobber. Overwriting a signing key silently invalidates every
# artifact already issued under this kid, and there is no way back.
if [ -e "$PRIV" ]; then
  echo "ERROR: $PRIV already exists. Refusing to overwrite a signing key." >&2
  echo "       Every artifact already issued under kid '$KID' would stop verifying." >&2
  exit 1
fi

# Create with restrictive permissions BEFORE openssl writes into it, so the key
# is never briefly world-readable.
umask 077
: > "$PRIV"

openssl genpkey -algorithm ed25519 -out "$PRIV" >/dev/null 2>&1
chmod 600 "$PRIV"

PUB_B64="$(openssl pkey -in "$PRIV" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"

# Sanity check. An Ed25519 SPKI DER is always 44 BYTES, which is 60 base64
# characters including the single '=' pad. Anything else means openssl produced
# a different algorithm, or `base64` wrapped despite the tr, and pasting it would
# fail closed at runtime with an opaque `unknown_key`.
#
# The key just generated is worthless if it did not validate, so remove it rather
# than leaving a file behind that makes the next run trip the no-clobber guard.
if [ "${#PUB_B64}" -ne 60 ]; then
  echo "ERROR: public key is ${#PUB_B64} base64 chars, expected 60 (44-byte Ed25519 SPKI DER)." >&2
  echo "       Inspect before retrying: openssl pkey -in $PRIV -text -noout" >&2
  rm -f "$PRIV"
  exit 1
fi

cat <<EOF

Private key written to: $PRIV  (mode 0600)

  Move it into the SaaS secret store now and delete the local copy. It is the
  only thing that can mint a licence; anyone holding it can license themselves.
  It must never be committed, baked into an image, or sent to a customer.

Public key for kid '$KID':

  $PUB_B64

Paste it into TRUSTED_PUBLIC_KEYS in
xisuite-backend/src/licensing/artifact/license-artifact.crypto.ts:

  export const TRUSTED_PUBLIC_KEYS: Readonly<Record<string, string>> =
    Object.freeze({
      '$KID': '$PUB_B64',
    });

The map is currently EMPTY on purpose, which makes every artifact fail
'unknown_key' — fail-closed. It stays that way until the line above is added.

EOF
