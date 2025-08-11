#!/bin/bash
# dev.sh for project-a
echo "Starting dev server for project-a..."
echo "Base URL from dashboard: $BASE_URL"
count=0
while true; do
  echo "Dev server running... ($count)"
  count=$((count+1))
  sleep 2
done
