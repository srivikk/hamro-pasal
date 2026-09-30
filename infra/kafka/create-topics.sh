#!/usr/bin/env bash
# Provisions the Hamro Pasal Kafka topics. Idempotent: safe to run on every `infra:up`.
# Existing topics with fewer partitions than declared are expanded
# (Kafka can only increase partition counts, never decrease them).
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP_SERVER:-kafka:29092}"
REPLICATION_FACTOR="${KAFKA_REPLICATION_FACTOR:-1}"
KAFKA_TOPICS=/opt/kafka/bin/kafka-topics.sh

# topic:partitions
TOPICS=(
  "order.lifecycle:4"
  "payment.reconciliation:4"
  "ledger.mutations:4"
  "notifications.broadcast:2"
  "notifications.dlq:2"
)

for entry in "${TOPICS[@]}"; do
  topic="${entry%%:*}"
  partitions="${entry##*:}"

  "$KAFKA_TOPICS" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
    --topic "$topic" --partitions "$partitions" --replication-factor "$REPLICATION_FACTOR"

  current="$("$KAFKA_TOPICS" --bootstrap-server "$BOOTSTRAP" --describe --topic "$topic" \
    | sed -n 's/.*PartitionCount: *\([0-9]*\).*/\1/p' | head -n 1)"

  if [ "$current" -lt "$partitions" ]; then
    echo "Expanding $topic from $current to $partitions partitions"
    "$KAFKA_TOPICS" --bootstrap-server "$BOOTSTRAP" --alter --topic "$topic" --partitions "$partitions"
  elif [ "$current" -gt "$partitions" ]; then
    echo "WARNING: $topic has $current partitions (declared $partitions); Kafka cannot shrink topics." >&2
  fi
done

echo "Kafka topics:"
"$KAFKA_TOPICS" --bootstrap-server "$BOOTSTRAP" --describe --exclude-internal \
  | grep 'PartitionCount'
