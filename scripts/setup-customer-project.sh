#!/bin/zsh
set -euo pipefail

if [[ $# -lt 7 ]]; then
  echo "Usage:"
  echo "  scripts/setup-customer-project.sh <project_id> <api_key> <auth_domain> <storage_bucket> <messaging_sender_id> <app_id> <measurement_id>"
  exit 1
fi

PROJECT_ID="$1"
API_KEY="$2"
AUTH_DOMAIN="$3"
STORAGE_BUCKET="$4"
MESSAGING_SENDER_ID="$5"
APP_ID="$6"
MEASUREMENT_ID="$7"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cat > "${ROOT_DIR}/.firebaserc" <<EOF
{
  "projects": {
    "default": "${PROJECT_ID}"
  }
}
EOF

cat > "${ROOT_DIR}/firebase.web.config.js" <<EOF
window.__TWKT_FIREBASE_CONFIG__ = {
  apiKey: "${API_KEY}",
  authDomain: "${AUTH_DOMAIN}",
  projectId: "${PROJECT_ID}",
  storageBucket: "${STORAGE_BUCKET}",
  messagingSenderId: "${MESSAGING_SENDER_ID}",
  appId: "${APP_ID}",
  measurementId: "${MEASUREMENT_ID}"
};
EOF

echo "Created:"
echo "  ${ROOT_DIR}/.firebaserc"
echo "  ${ROOT_DIR}/firebase.web.config.js"
echo
echo "Next steps:"
echo "  1. firebase use ${PROJECT_ID}"
echo "  2. cd functions && npm install"
echo "  3. firebase functions:secrets:set GMAIL_USER"
echo "  4. firebase functions:secrets:set GMAIL_APP_PASSWORD"
echo "  5. firebase deploy"
