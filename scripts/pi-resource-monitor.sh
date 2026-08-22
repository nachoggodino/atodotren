#!/usr/bin/env bash
set -Eeuo pipefail

# Temporary, acceptance-only host resource helper. Its in-memory alert state is
# intentionally lost on restart. Product incident state and notifications belong
# to the worker; do not extend this script into a second operational alert system.

ENV_FILE="${1:-.env}"

STATUS_INTERVAL_SECONDS="${STATUS_INTERVAL_SECONDS:-1800}"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-60}"

MIN_AVAILABLE_RAM_MIB="${MIN_AVAILABLE_RAM_MIB:-1024}"
MAX_SWAP_USED_MIB="${MAX_SWAP_USED_MIB:-1536}"
MIN_DISK_FREE_GIB="${MIN_DISK_FREE_GIB:-10}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi

for command in docker curl node awk df free; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

mapfile -t telegram_config < <(
  docker compose --env-file "$ENV_FILE" config --format json |
    node -e 'let input=""; process.stdin.on("data",c=>input+=c); process.stdin.on("end",()=>{const env=JSON.parse(input).services.worker.environment; console.log(env.TELEGRAM_BOT_TOKEN ?? ""); console.log(env.TELEGRAM_CHAT_ID ?? "");});'
)
TELEGRAM_BOT_TOKEN="${telegram_config[0]:-}"
TELEGRAM_CHAT_ID="${telegram_config[1]:-}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured in $ENV_FILE" >&2
  exit 1
fi

send_telegram() {
  local message="$1"
  local payload

  payload="$(
    node -e 'console.log(JSON.stringify({chat_id:process.argv[1],text:process.argv[2]}))' "$TELEGRAM_CHAT_ID" "$message"
  )"

  curl \
    --silent \
    --show-error \
    --fail \
    --max-time 15 \
    --request POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    >/dev/null
}

safe_send_telegram() {
  local message="$1"

  if ! send_telegram "$message"; then
    echo "WARNING: Telegram delivery failed; monitor will continue running." >&2
    return 1
  fi
}

get_available_ram_mib() {
  awk '/^MemAvailable:/ { printf "%.0f\n", $2 / 1024 }' /proc/meminfo
}

get_swap_used_mib() {
  awk '
    /^SwapTotal:/ { total=$2 }
    /^SwapFree:/  { free=$2 }
    END { printf "%.0f\n", (total-free)/1024 }
  ' /proc/meminfo
}

get_disk_free_gib() {
  df -Pk / | awk 'NR==2 { printf "%.2f\n", $4 / 1024 / 1024 }'
}

get_worker_running() {
  local worker_id

  worker_id="$(
    docker compose \
      --env-file "$ENV_FILE" \
      ps \
      --status running \
      --quiet worker \
      2>/dev/null || true
  )"

  [[ -n "$worker_id" ]]
}

build_status_message() {
  local ram_line
  local swap_line
  local disk_line
  local load_line
  local worker_status

  ram_line="$(
    free -h | awk '/^Mem:/ {
      print "RAM: "$3" used / "$2", "$7" available"
    }'
  )"

  swap_line="$(
    free -h | awk '/^Swap:/ {
      print "Swap: "$3" used / "$2
    }'
  )"

  disk_line="$(
    df -h / | awk 'NR==2 {
      print "Disk: "$3" used / "$2", "$4" free ("$5")"
    }'
  )"

  load_line="$(
    awk '{
      print "Load: "$1", "$2", "$3
    }' /proc/loadavg
  )"

  if get_worker_running; then
    worker_status="Worker: RUNNING ✅"
  else
    worker_status="Worker: NOT RUNNING ⚠️"
  fi

  cat <<EOF
🚆 Atodotren 48h status

$(date '+%Y-%m-%d %H:%M:%S %Z')
$worker_status
$ram_line
$swap_line
$disk_line
$load_line
EOF
}

declare -A ACTIVE_ALERTS=()

raise_alert() {
  local key="$1"
  local message="$2"

  if [[ "${ACTIVE_ALERTS[$key]:-0}" != "1" ]]; then
    echo "ALERT: $message"

    if safe_send_telegram "⚠️ Atodotren alert

$(date '+%Y-%m-%d %H:%M:%S %Z')
$message"; then
      ACTIVE_ALERTS["$key"]=1
    fi
  fi
}

recover_alert() {
  local key="$1"
  local message="$2"

  if [[ "${ACTIVE_ALERTS[$key]:-0}" == "1" ]]; then
    echo "RECOVERY: $message"

    if safe_send_telegram "✅ Atodotren recovery

$(date '+%Y-%m-%d %H:%M:%S %Z')
$message"; then
      ACTIVE_ALERTS["$key"]=0
    fi
  fi
}

check_alerts() {
  local available_ram_mib
  local swap_used_mib
  local disk_free_gib

  available_ram_mib="$(get_available_ram_mib)"
  swap_used_mib="$(get_swap_used_mib)"
  disk_free_gib="$(get_disk_free_gib)"

  if get_worker_running; then
    recover_alert \
      "worker" \
      "Worker is running again."
  else
    raise_alert \
      "worker" \
      "The ingestion worker is NOT running."
  fi

  if (( available_ram_mib < MIN_AVAILABLE_RAM_MIB )); then
    raise_alert \
      "ram" \
      "Low available RAM: ${available_ram_mib} MiB. Threshold: ${MIN_AVAILABLE_RAM_MIB} MiB."
  else
    recover_alert \
      "ram" \
      "Available RAM recovered to ${available_ram_mib} MiB."
  fi

  if (( swap_used_mib > MAX_SWAP_USED_MIB )); then
    raise_alert \
      "swap" \
      "High swap usage: ${swap_used_mib} MiB. Threshold: ${MAX_SWAP_USED_MIB} MiB."
  else
    recover_alert \
      "swap" \
      "Swap usage recovered to ${swap_used_mib} MiB."
  fi

  if awk "BEGIN { exit !(${disk_free_gib} < ${MIN_DISK_FREE_GIB}) }"; then
    raise_alert \
      "disk" \
      "Low disk space: ${disk_free_gib} GiB free on /. Threshold: ${MIN_DISK_FREE_GIB} GiB."
  else
    recover_alert \
      "disk" \
      "Disk space recovered to ${disk_free_gib} GiB free."
  fi
}

echo "Starting Atodotren Pi monitor"
echo "Status interval: ${STATUS_INTERVAL_SECONDS}s"
echo "Check interval:  ${CHECK_INTERVAL_SECONDS}s"
echo "RAM alert:       < ${MIN_AVAILABLE_RAM_MIB} MiB available"
echo "Swap alert:      > ${MAX_SWAP_USED_MIB} MiB used"
echo "Disk alert:      < ${MIN_DISK_FREE_GIB} GiB free"
echo

safe_send_telegram "🟢 Atodotren acceptance resource monitor started

$(date '+%Y-%m-%d %H:%M:%S %Z')

Status every $((STATUS_INTERVAL_SECONDS / 60)) min
RAM alert < ${MIN_AVAILABLE_RAM_MIB} MiB available
Swap alert > ${MAX_SWAP_USED_MIB} MiB
Disk alert < ${MIN_DISK_FREE_GIB} GiB free" || true

last_status="$(date +%s)"

while true; do
  now="$(date +%s)"

  check_alerts

  if (( now - last_status >= STATUS_INTERVAL_SECONDS )); then
    status_message="$(build_status_message)"

    echo "$status_message"
    echo

    safe_send_telegram "$status_message" || true

    last_status="$now"
  fi

  sleep "$CHECK_INTERVAL_SECONDS"
done
