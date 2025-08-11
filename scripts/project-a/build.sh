#!/bin/bash
# build.sh for project-a
echo "Building project-a..."
for i in {1..10}; do
  echo "Build step $i/10"
  sleep 1
done
echo "Project-a build complete!"
