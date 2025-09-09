# BoltDB Explorer

A Visual Studio Code extension for viewing and manipulating BoltDB database files. BoltDB Explorer provides a convenient interface to browse, search, and edit key-value pairs and buckets in BoltDB files directly within VS Code.

## Screenshots
![BoltDB Explorer Overview](https://raw.githubusercontent.com/owenrumney/boltdb-explorer/main/images/explorer.png)

## Features

- **Browse** bucket hierarchies and key-value pairs with an intuitive tree-like interface
- **Search** across keys and values to quickly find content within the database
- **View** values with automatic formatting for JSON and text content
- **Create** new buckets and key-value pairs
- **Edit** existing values with a built-in editor
- **Delete** buckets and key-value pairs
- **Export** values to files
- **Navigate** through nested buckets with breadcrumb navigation

## Usage

1. Open a folder containing a BoltDB file (`.db` extension)
2. Right-click on the file and select "Open with BoltDB Explorer"
3. Use the explorer interface to navigate, view, and edit the database content

### Interface Overview

The BoltDB Explorer interface consists of:

- **Breadcrumb navigation** at the top to show your current path
- **Left panel** showing buckets and keys at the current level
- **Right panel** displaying key values or bucket information
- **Search box** for finding keys and values across the database
- **Write mode toggle** to enable editing operations

### Write Operations

Toggle the "Write Mode" switch in the top-right corner to enable the following operations:

- **Add Bucket**: Create new buckets at the current level
- **Add Key**: Add new key-value pairs to the current bucket
- **Delete**: Remove buckets or key-value pairs
- **Edit Value**: Modify the value of an existing key

## Requirements

- Visual Studio Code version 1.70.0 or higher
- No additional dependencies required - the extension includes pre-built binaries for Windows, macOS, and Linux

## Extension Settings

This extension doesn't add any VS Code settings yet.

## Known Issues

- Very large values (over 64KB) are previewed only partially in the UI
- Complex nested bucket structures with many keys may experience performance slowdowns

## Release Notes

### 1.0.0

Initial release of BoltDB Explorer with the following features:
- Browsing bucket hierarchies and key-value pairs
- Viewing formatted values (JSON, text)
- Creating, editing, and deleting buckets and keys
- Searching across the database
- Exporting values to files

## Development

If you want to contribute to BoltDB Explorer, follow these steps to set up the development environment:

1. Clone the repository
2. Run `npm install` to install the required dependencies
3. Build the Go helper binaries:
   ```bash
   cd go
   go build -o ../bin/bolthelper-[platform]-[arch] ./cmd/bolthelper
   ```
4. Run `npm run watch` to compile TypeScript and watch for changes
5. Press F5 in VS Code to launch a new window with the extension loaded

### Project Structure

- `src/` - TypeScript source for the VS Code extension
  - `extension.ts` - Main extension entry point
  - `boltClient.ts` - Interface to the Go helper binary
  - `webview/` - React webview UI components
- `go/` - Go source for BoltDB operations
  - `cmd/bolthelper/` - CLI entry point
  - `internal/` - BoltDB operation implementations
- `bin/` - Pre-built helper binaries for different platforms

## Contributing

Contributions are welcome! Here are some ways you can contribute:

1. Report bugs and request features by creating issues
2. Improve documentation
3. Submit pull requests with bug fixes or new features
4. Share the extension with others

## License

This extension is licensed under the MIT License. See the LICENSE file for details.

## Credits

- BoltDB Explorer uses the [bbolt](https://github.com/etcd-io/bbolt) Go package, a maintained fork of the original BoltDB
- Icon design inspired by database and key-value store concepts


