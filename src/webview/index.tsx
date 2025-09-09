import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

interface Key { keyBase64: string; valueSize: number; isBucket: boolean; }
interface KeysResponse { items: Key[]; nextAfterKey?: string; approxReturned: number; }
interface HeadResponse { mode: string; totalSize: number; valueHeadBase64: string; }
interface SearchResult { type: 'bucket' | 'key'; path: string; name: string; value?: string; }
interface SearchItem { keyBase64: string; valueSize: number; isBucket: boolean; path: string[]; type: string; }
interface SearchResponse { items: SearchItem[]; total: number; limited: boolean; }

function safeAtob(base64: string): string {
  try {
    return atob(base64);
  } catch {
    return '[invalid base64]';
  }
}

function safeBase64ToUtf8(base64: string): string {
  try {
    const decoded = atob(base64);
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array([...decoded].map(c => c.charCodeAt(0)))
    );
    return utf8;
  } catch {
    return '[binary]';
  }
}

function isJsonString(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

function formatContent(content: string): { formatted: string; type: 'json' | 'text' | 'binary' } {
  if (content === '[binary]') {
    return { formatted: content, type: 'binary' };
  }
  
  if (isJsonString(content)) {
    try {
      const parsed = JSON.parse(content);
      return { 
        formatted: JSON.stringify(parsed, null, 2), 
        type: 'json' 
      };
    } catch {
      return { formatted: content, type: 'text' };
    }
  }
  
  return { formatted: content, type: 'text' };
}

function App() {
  const [currentPath, setCurrentPath] = useState('');
  const [keys, setKeys] = useState<Key[]>([]);
  const [nextAfterKey, setNextAfterKey] = useState<string | undefined>();
  const [selectedKey, setSelectedKey] = useState<Key | null>(null);
  const [preview, setPreview] = useState<{ content: string; totalSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchCaseSensitive, setSearchCaseSensitive] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLDivElement>(null);

  function post(msg: any) { vscode.postMessage(msg); }

  function loadKeys(bucketPath: string, afterKey?: string) {
    setIsLoading(true);
    post({ type: 'listKeys', bucketPath, afterKey });
  }

  function handleSearch() {
    if (searchQuery.trim() === '') {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    post({ type: 'search', query: searchQuery.trim(), limit: 100, caseSensitive: searchCaseSensitive });
  }


  // Use a ref to persist pending highlight/preview across renders and async loads
  const pendingHighlightRef = useRef<
    { bucketPath: string; keyBase64: string; valueSize: number; loadedKeys: Key[] } | null
  >(null);

  function navigateToSearchResult(result: SearchItem) {
    const pathParts = result.path;
    const bucketPath = pathParts.join('/');
    console.log('[DEBUG] Search result selected:', {
      bucketPath,
      keyBase64: result.keyBase64,
      valueSize: result.valueSize,
      path: result.path,
      isBucket: result.isBucket
    });
    setCurrentPath(bucketPath);
    setPreview(null);
    setSearchResults([]); // Clear search results but keep query
    if (!result.isBucket) {
      pendingHighlightRef.current = { bucketPath, keyBase64: result.keyBase64, valueSize: result.valueSize, loadedKeys: [] };
    } else {
      pendingHighlightRef.current = null;
      setSelectedKey(null);
    }
    loadKeys(bucketPath);
  }

  // ...existing code...

  useEffect(() => {
    const listener = (event: any) => {
      const msg = event.data;
      if (msg.type === 'keys') {
        const res = msg as KeysResponse;
        console.log('[DEBUG] Keys loaded:', res.items.map(k => safeAtob(k.keyBase64)));
        if (res.items.length === 0 && !nextAfterKey) setKeys([]);
        else setKeys(prev => msg.afterKey ? [...prev, ...res.items] : res.items);
        setNextAfterKey(res.nextAfterKey);
        setIsLoading(false);
        // If we have a pending highlight/preview, try to find the key, and auto-page if needed
        const pending = pendingHighlightRef.current;
        if (pending) {
          console.log('[DEBUG] (NO PATH CHECK) Looking for keyBase64:', pending.keyBase64, 'in loaded keys.');
          console.log('[DEBUG] Decoded pending.keyBase64:', safeAtob(pending.keyBase64));
          res.items.forEach((k, idx) => {
            console.log(`[DEBUG] Page key[${idx}]:`, k.keyBase64, '| Decoded:', safeAtob(k.keyBase64));
          });
          const foundInPage = res.items.find(k => k.keyBase64 === pending.keyBase64);
          if (foundInPage) {
            console.log('[DEBUG] About to setSelectedKey:', safeAtob(foundInPage.keyBase64));
            setSelectedKey(null);
            setSelectedKey(foundInPage);
            console.log('[DEBUG] setSelectedKey called for:', safeAtob(foundInPage.keyBase64));
            post({ type: 'readHead', bucketPath: pending.bucketPath, keyBase64: pending.keyBase64 });
            pendingHighlightRef.current = null;
          } else if (res.nextAfterKey) {
            // Not found, load next page
            console.log('[DEBUG] Key not found in this page, paging for more... nextAfterKey:', res.nextAfterKey);
            pendingHighlightRef.current = pending;
            loadKeys(msg.bucketPath || '', res.nextAfterKey);
          } else {
            // Not found after all pages
            console.log('[DEBUG] Key not found after paging all pages:', safeAtob(pending.keyBase64));
            setSelectedKey(null);
            setPreview(null);
            pendingHighlightRef.current = null;
          }
        }
      } else if (msg.type === 'head') {
        const res = msg as HeadResponse;
        const content = safeBase64ToUtf8(res.valueHeadBase64);
        console.log('[DEBUG] Preview loaded:', content.slice(0, 100));
        setPreview({ content, totalSize: res.totalSize });
      } else if (msg.type === 'error') {
        setError(msg.message);
        setIsLoading(false);
      } else if (msg.type === 'searchResults') {
        setSearchResults(msg.items || []);
        setIsSearching(false);
      }
    };
    window.addEventListener('message', listener);
    loadKeys(''); // start with root
    return () => window.removeEventListener('message', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleKeyClick(key: Key) {
    pendingHighlightRef.current = null; // Clear any pending highlight/preview
    setSelectedKey(key);
    if (key.isBucket) {
      // Navigate into the bucket
      const newPath = currentPath ? `${currentPath}/${safeAtob(key.keyBase64)}` : safeAtob(key.keyBase64);
      setCurrentPath(newPath);
      setKeys([]);
      setNextAfterKey(undefined);
      setPreview(null);
      loadKeys(newPath);
    } else {
      post({ type: 'readHead', bucketPath: currentPath, keyBase64: key.keyBase64 });
    }
  }

  function handleSave() {
    if (selectedKey && !selectedKey.isBucket) {
      post({ type: 'saveValue', bucketPath: currentPath, keyBase64: selectedKey.keyBase64 });
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Could show a toast notification here
    }).catch(err => {
      console.error('Failed to copy to clipboard:', err);
    });
  }

  function navigateToParent() {
    const pathParts = currentPath.split('/');
    pathParts.pop();
    const newPath = pathParts.join('/');
    setCurrentPath(newPath);
    setKeys([]);
    setNextAfterKey(undefined);
    setSelectedKey(null);
    setPreview(null);
    loadKeys(newPath);
  }

  function navigateToRoot() {
    setCurrentPath('');
    setKeys([]);
    setNextAfterKey(undefined);
    setSelectedKey(null);
    setPreview(null);
    loadKeys('');
  }

  function formatSize(size: number): string {
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  useEffect(() => {
    if (selectedKey) {
      console.log('[DEBUG] Rendering preview panel for selectedKey:', safeAtob(selectedKey.keyBase64));
    }
  }, [selectedKey]);

  return (
    <div className="app">
      <div className="header">
        <h2>BoltDB Viewer</h2>
        <div className="breadcrumb">
          <button onClick={navigateToRoot}>Root</button>
          {currentPath && currentPath.split('/').map((part, i, arr) => {
            const pathUpToHere = arr.slice(0, i + 1).join('/');
            return (
              <span key={i}>
                {' / '}
                <button onClick={() => {
                  setCurrentPath(pathUpToHere);
                  setSelectedKey(null);
                  setPreview(null);
                  loadKeys(pathUpToHere);
                }}>{part}</button>
              </span>
            );
          })}
        </div>
      </div>

      <div className="search-section">
        <div className="search-controls" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1, height: 40, display: 'flex', alignItems: 'center', background: 'none' }}>
              <input
                ref={searchInputRef as any}
                type="text"
                className="search-input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search keys/values..."
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                spellCheck={false}
                style={{
                  width: '100%',
                  height: 40,
                  outline: 'none',
                  border: '1.5px solid var(--vscode-input-border, #e0e0e0)',
                  background: 'var(--vscode-input-background, #fff)',
                  color: 'var(--vscode-input-foreground, #222)',
                  borderRadius: 0,
                  padding: '0 44px 0 18px',
                  fontSize: 16,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  transition: 'border 0.2s',
                  position: 'relative',
                  zIndex: 2,
                  boxShadow: '0 1px 4px 0 var(--vscode-widget-shadow, rgba(0,0,0,0.04))',
                  fontFamily: 'inherit',
                }}
              />
              {searchQuery && (
                <div style={{
                  position: 'absolute',
                  right: 6,
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  zIndex: 3,
                }}>
                  <button
                    className="clear-search"
                    onClick={() => {
                      setSearchQuery('');
                      setSearchResults([]);
                      if (searchInputRef.current) {
                        searchInputRef.current.focus();
                      }
                    }}
                    style={{
                      background: 'var(--vscode-input-background, #1e1e1e)',
                      border: '1.5px solid var(--vscode-input-border, #e0e0e0)',
                      borderRadius: '50%',
                      cursor: 'pointer',
                      padding: 0,
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--vscode-input-foreground, #d6cfa6)',
                      fontSize: '1.2em',
                      boxShadow: 'none',
                      transition: 'background 0.15s, border 0.15s',
                    }}
                    title="Clear search"
                    tabIndex={-1}
                    onMouseOver={e => {
                      e.currentTarget.style.background = 'var(--vscode-inputOption-hoverBackground, #232323)';
                      e.currentTarget.style.border = '1.5px solid var(--vscode-inputOption-activeBorder, #c5c5c5)';
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.background = 'var(--vscode-input-background, #1e1e1e)';
                      e.currentTarget.style.border = '1.5px solid var(--vscode-input-border, #e0e0e0)';
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="8" cy="8" r="7" stroke="var(--vscode-input-foreground, #d6cfa6)" strokeWidth="2" fill="none"/>
                      <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" stroke="var(--vscode-input-foreground, #d6cfa6)" strokeWidth="2" strokeLinecap="round"/>
                      <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" stroke="var(--vscode-input-foreground, #d6cfa6)" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
            <button onClick={handleSearch} disabled={isSearching} className="search-button" style={{
              marginLeft: '0.75em',
              height: 40,
              minWidth: 80,
              borderRadius: 8,
              fontSize: 16,
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isSearching ? 'var(--vscode-button-secondaryBackground, #bfc9c9)' : 'var(--vscode-button-background, #46605a)',
              color: 'var(--vscode-button-foreground, #fff)',
              border: 'none',
              boxShadow: '0 1px 2px 0 var(--vscode-widget-shadow, rgba(0,0,0,0.06))',
              cursor: isSearching ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              padding: '0 18px',
            }}>
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          <label className="case-sensitive-label" style={{ marginLeft: '0.5em' }}>
            <input
              type="checkbox"
              checked={searchCaseSensitive}
              onChange={(e) => setSearchCaseSensitive(e.target.checked)}
            />
            Case sensitive
          </label>
        </div>

        {searchResults.length > 0 && (
          <div className="search-results">
            <h3>Search Results ({searchResults.length})</h3>
            <div className="results-list">
              {searchResults.map((result, index) => (
                <div key={index} className="search-result" onClick={() => navigateToSearchResult(result)}>
                  <div className="result-type">{result.type}</div>
                  <div className="result-path">{result.path.join('/')}</div>
                  <div className="result-name">{safeBase64ToUtf8(result.keyBase64)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error">Error: {error}</div>}
      
      <div className="main">
        <div className="keys-panel">
          {isLoading ? (
            <div className="loading-indicator">
              <div className="loading-spinner"></div>
              <div>Loading database...</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Key</th><th>Size</th><th>Type</th></tr>
              </thead>
              <tbody>
                {keys.map((k, i) => (
                  <tr
                    key={i}
                    className={selectedKey && selectedKey.keyBase64 === k.keyBase64 ? 'selected' : ''}
                    onClick={() => handleKeyClick(k)}
                  >
                    <td title={safeAtob(k.keyBase64)}>{safeAtob(k.keyBase64).slice(0, 40)}</td>
                    <td>{formatSize(k.valueSize)}</td>
                    <td>{k.isBucket ? 'Bucket' : 'Value'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!isLoading && nextAfterKey && (
            <button onClick={() => loadKeys(currentPath, nextAfterKey)}>Load More...</button>
          )}
        </div>
        
        <div className="preview-panel">
          {selectedKey && (
            <div>
              <h3>Selected: {safeAtob(selectedKey.keyBase64)}</h3>
              {selectedKey.isBucket ? (
                <p>This is a bucket.</p>
              ) : (
                <div>
                  <p>Size: {formatSize(selectedKey.valueSize)}</p>
                  {preview && (
                    <div>
                      {(() => {
                        const { formatted, type } = formatContent(preview.content);
                        return (
                          <div>
                            <div className="content-header">
                              <div className="content-type">
                                Content Type: <span className={`type-${type}`}>{type.toUpperCase()}</span>
                              </div>
                              {type !== 'binary' && (
                                <button 
                                  className="copy-button" 
                                  onClick={() => copyToClipboard(formatted)}
                                  title="Copy to clipboard"
                                >
                                  Copy
                                </button>
                              )}
                            </div>
                            <pre className={`preview preview-${type}`}>{formatted}</pre>
                          </div>
                        );
                      })()}
                      {preview.totalSize > 64 * 1024 && (
                        <p>Showing preview (up to 64 KiB of {formatSize(preview.totalSize)})</p>
                      )}
                      <button onClick={handleSave}>Save full value to file</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
