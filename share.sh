#!/usr/bin/env bash
# DataHub one-shot share script.
# Registers/logs in, uploads one file, and prints the share URL.
#
# Usage:
#   bash share.sh [options] <file>
#
# Options:
#   -H, --host URL             DataHub base URL  (env DATAHUB_HOST, default http://localhost:3000)
#   -u, --username NAME        account username  (env DATAHUB_USERNAME; prompts if missing)
#   -p, --password PASS        account password  (env DATAHUB_PASSWORD; hidden prompt if missing)
#   -e, --expires HOURS        expiry in hours, 0 = never (default: server default, 7 days)
#   -P, --share-password PASS password visitors must enter to download
#   -c, --code CODE           custom 4-32 char share code [A-Za-z0-9_-]
#   -h, --help                show this help
#
# Examples:
#   bash share.sh clean.csv
#   bash share.sh -u alice -p secret -e 72 -P 8888 -c clean01 clean.csv
#
# Requires: curl (and a POSIX-ish shell). No jq needed.

set -euo pipefail

HOST="${DATAHUB_HOST:-http://localhost:3000}"
USERNAME="${DATAHUB_USERNAME:-}"
PASSWORD="${DATAHUB_PASSWORD:-}"
HOURS=""
SHARE_PW=""
CODE=""
FILE=""

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -H|--host) HOST="$2"; shift 2;;
    -u|--username) USERNAME="$2"; shift 2;;
    -p|--password) PASSWORD="$2"; shift 2;;
    -e|--expires) HOURS="$2"; shift 2;;
    -P|--share-password) SHARE_PW="$2"; shift 2;;
    -c|--code) CODE="$2"; shift 2;;
    -h|--help) usage 0;;
    --) shift; FILE="$1"; shift;;
    -*) echo "unknown option: $1" >&2; usage 1;;
    *) FILE="$1"; shift;;
  esac
done

[ -n "$FILE" ] || { echo "error: a file path is required" >&2; usage 1; }
[ -f "$FILE" ] || { echo "error: file not found: $FILE" >&2; exit 1; }
if [ -n "$HOURS" ]; then
  case "$HOURS" in *[!0-9]*) echo "error: --expires must be a non-negative integer (0 = never)" >&2; exit 1;; esac
fi
if [ -n "$CODE" ]; then
  printf '%s' "$CODE" | grep -Eq '^[A-Za-z0-9_-]{4,32}$' || { echo "error: --code must be 4-32 chars [A-Za-z0-9_-]" >&2; exit 1; }
fi

if [ -z "$USERNAME" ]; then printf 'DataHub username: '; read -r USERNAME; fi
if [ -z "$PASSWORD" ]; then printf 'DataHub password: '; stty -echo 2>/dev/null || true; read -r PASSWORD; stty echo 2>/dev/null || true; printf '\n'; fi

json_field() { # json_field <json> <key>
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"*\\([^\",}]*\\)\"*.*/\\1/p" | head -n1
}

echo ">> logging in to $HOST ..." >&2
RESP="$(curl -s -X POST "$HOST/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"
TOKEN="$(json_field "$RESP" token)"

if [ -z "$TOKEN" ]; then
  echo ">> login failed ($(json_field "$RESP" error)), trying to register a new account ..." >&2
  RESP="$(curl -s -X POST "$HOST/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"
  TOKEN="$(json_field "$RESP" token)"
  [ -n "$TOKEN" ] || { echo "error: register/login failed: $RESP" >&2; exit 1; }
fi

echo ">> uploading $(basename "$FILE") ..." >&2
FIELDS=(-F "file=@$FILE")
[ -z "$HOURS" ]    || FIELDS+=(-F "expiresIn=$HOURS")
[ -z "$SHARE_PW" ] || FIELDS+=(-F "password=$SHARE_PW")
[ -z "$CODE" ]     || FIELDS+=(-F "code=$CODE")

RESP="$(curl -s -X POST "$HOST/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  "${FIELDS[@]}")"
URL="$(json_field "$RESP" shareUrl)"

if [ -z "$URL" ]; then
  echo "error: upload failed: $RESP" >&2
  exit 1
fi

echo "$URL"
