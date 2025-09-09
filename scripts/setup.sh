#!/bin/bash
set -e

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build Go helper for current platform
echo "Building Go helper for current platform..."
npm run build:helper

# Build extension
echo "Building extension..."
npm run build

echo "Setup complete. You can now run 'npm run watch' to start development."
