#!/bin/bash
# global-test.sh - 直接放在 SCRIPTS_DIR 下的脚本
echo "=== 全局测试脚本 ==="
echo "当前工作目录: $(pwd)"
echo "脚本路径: $0"
echo "BASE_URL: $BASE_URL"
echo "WORKSPACE: $WORKSPACE"
echo ""

echo "列出当前目录内容:"
ls -la

echo ""
echo "测试完成！" 