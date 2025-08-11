#!/bin/bash

echo "=== Echo Script Started ==="
echo "Script: $0"
echo "Arguments received: $#"
echo "All arguments: $@"
echo ""

# 显示每个参数
for i in $(seq 1 $#); do
    echo "Arg $i: ${!i}"
done

echo ""
echo "=== Echo Script Finished ==="
