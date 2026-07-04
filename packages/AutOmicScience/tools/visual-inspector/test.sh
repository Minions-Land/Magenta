#!/bin/bash
# Test script for visual-inspector tools

set -e

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$TOOL_DIR/target/release/visual-inspector"

echo "=== Visual Inspector Test Suite ==="
echo ""

# Check if binary exists
if [ ! -f "$BINARY" ]; then
    echo "❌ Binary not found at $BINARY"
    echo "Run: cargo build --release"
    exit 1
fi

echo "✓ Binary found: $BINARY"
echo ""

# Create test directory
TEST_DIR="/tmp/visual-inspector-test-$$"
mkdir -p "$TEST_DIR"
echo "✓ Test directory: $TEST_DIR"

# Generate a test plot using Python
echo ""
echo "=== Generating test plot ==="
cat > "$TEST_DIR/gen_plot.py" << 'EOF'
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import sys

# Create a simple scatter plot
np.random.seed(42)
x = np.random.randn(100)
y = np.random.randn(100)

plt.figure(figsize=(8, 6))
plt.scatter(x, y, alpha=0.5, c=np.random.rand(100), cmap='viridis')
plt.xlabel('X axis')
plt.ylabel('Y axis')
plt.title('Test Scatter Plot')
plt.colorbar(label='Color')
plt.savefig(sys.argv[1], dpi=100, bbox_inches='tight')
plt.close()

print("✓ Test plot generated")
EOF

python3 "$TEST_DIR/gen_plot.py" "$TEST_DIR/test_plot.png"

TEST_PLOT="$TEST_DIR/test_plot.png"

if [ ! -f "$TEST_PLOT" ]; then
    echo "❌ Failed to generate test plot"
    exit 1
fi

# Test 1: analyze_plot
echo ""
echo "=== Test 1: analyze_plot ==="
RESULT=$("$BINARY" analyze_plot "{\"image_path\":\"$TEST_PLOT\",\"plot_type\":\"scatter\"}")
echo "$RESULT" | python3 -m json.tool

QUALITY=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin)['quality_score'])")
echo ""
echo "Quality score: $QUALITY"

if (( $(echo "$QUALITY >= 0.3" | bc -l) )); then
    echo "✓ Quality score acceptable"
else
    echo "❌ Quality score too low"
    exit 1
fi

# Test 2: validate_render
echo ""
echo "=== Test 2: validate_render ==="
RESULT=$("$BINARY" validate_render "{\"image_path\":\"$TEST_PLOT\",\"min_quality_score\":0.3}")
echo "$RESULT" | python3 -m json.tool

OK=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin)['ok'])")
if [ "$OK" = "True" ]; then
    echo "✓ Validation passed"
else
    echo "❌ Validation failed"
    exit 1
fi

# Test 3: compare_images (using same image twice)
echo ""
echo "=== Test 3: compare_images ==="
cp "$TEST_PLOT" "$TEST_DIR/test_plot_copy.png"
RESULT=$("$BINARY" compare_images "{\"before_path\":\"$TEST_PLOT\",\"after_path\":\"$TEST_DIR/test_plot_copy.png\"}")
echo "$RESULT" | python3 -m json.tool

SIMILARITY=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin)['similarity'])")
echo ""
echo "Similarity: $SIMILARITY"

if (( $(echo "$SIMILARITY >= 0.99" | bc -l) )); then
    echo "✓ Identical images detected"
else
    echo "❌ Images should be identical"
    exit 1
fi

# Cleanup
echo ""
echo "=== Cleanup ==="
rm -rf "$TEST_DIR"
echo "✓ Test directory removed"

echo ""
echo "=== All tests passed! ==="
