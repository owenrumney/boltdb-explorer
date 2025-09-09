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
  const [isWriteMode, setIsWriteMode] = useState<boolean>(false);
  const [showAddBucketForm, setShowAddBucketForm] = useState<boolean>(false);
  const [showAddKeyForm, setShowAddKeyForm] = useState<boolean>(false);
  const [newBucketName, setNewBucketName] = useState<string>('');
  const [newKeyName, setNewKeyName] = useState<string>('');
  const [newKeyValue, setNewKeyValue] = useState<string>('');
  const [isEditingValue, setIsEditingValue] = useState<boolean>(false);
  const [editedValue, setEditedValue] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<{item: Key, type: 'bucket' | 'key', name: string, path?: string} | null>(null);
  const searchInputRef = useRef<HTMLDivElement>(null);

  function post(msg: any) { vscode.postMessage(msg); }

  function loadKeys(bucketPath: string, afterKey?: string) {
    console.log('[DEBUG] loadKeys called with bucketPath:', bucketPath, 'afterKey:', afterKey);
    console.time(`loadKeys-${bucketPath || 'root'}`);
    setIsLoading(true);
    setError(null); // Clear any previous errors
    
    // Normalize bucket path to avoid issues with empty strings vs root paths
    const normalizedPath = bucketPath || '';
    
    // Make sure currentPath is updated consistently
    if (normalizedPath !== currentPath) {
      console.log('[DEBUG] Updating currentPath from:', currentPath, 'to:', normalizedPath);
      setCurrentPath(normalizedPath);
    }
    
    // For debugging breadcrumb issues
    if (normalizedPath) {
      console.log('[DEBUG] Current path parts:', normalizedPath.split('/'));
    }
    
    post({ type: 'listKeys', bucketPath: normalizedPath, afterKey });
    
    // Safety timeout - if no response after 10 seconds, stop loading
    setTimeout(() => {
      setIsLoading(false);
      console.log('[DEBUG] Loading timeout - forced stop');
      console.timeEnd(`loadKeys-${bucketPath || 'root'}`);
    }, 10000);
  }

  function handleSearch() {
    if (searchQuery.trim() === '') {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    post({ type: 'search', query: searchQuery.trim(), limit: 100, caseSensitive: searchCaseSensitive });
  }

  function handleCreateBucket() {
    if (newBucketName.trim() === '') return;
    
    // Construct the full path for the new bucket
    const bucketPath = currentPath ? `${currentPath}/${newBucketName.trim()}` : newBucketName.trim();
    
    console.log('[DEBUG] Creating bucket with path:', bucketPath);
    
    // Send the create bucket message with the new path
    post({ type: 'createBucket', bucketPath });
    
    // Reset form state
    setNewBucketName('');
    setShowAddBucketForm(false);
  }

  function handlePutKey() {
    if (newKeyName.trim() === '' || currentPath === '') return;
    
    const keyName = newKeyName.trim();
    const bucketPath = currentPath;  // Store in a stable variable to avoid async issues
    
    console.log('[DEBUG] Adding key with detailed info:', {
      bucketPath: bucketPath, 
      keyName: keyName,
      valueLength: newKeyValue.length
    });
    
    // Convert to base64
    const keyBase64 = btoa(keyName);
    const valueBase64 = btoa(newKeyValue);
    
    // Log the path parts to help debug path inconsistencies
    console.log('[DEBUG] Bucket path parts:', bucketPath.split('/'));
    
    // Mark this key for selection after it's created
    pendingHighlightRef.current = {
      bucketPath: bucketPath,
      keyBase64: keyBase64,
      valueSize: newKeyValue.length,
      loadedKeys: []
    };
    
    // Send the request to create the key
    post({ type: 'putKey', bucketPath: bucketPath, keyBase64, valueBase64 });
    
    // Reset form state
    setNewKeyName('');
    setNewKeyValue('');
    setShowAddKeyForm(false);
  }

  function handleDeleteKey(key: Key) {
    if (!isWriteMode || key.isBucket) return;
    console.log('[DEBUG] handleDeleteKey called for:', safeAtob(key.keyBase64));
    // Use custom confirmation dialog instead of native browser confirm
    setConfirmDelete({
      item: key, 
      type: 'key',
      name: safeAtob(key.keyBase64)
    });
  }

  function handleDeleteBucket(key: Key) {
    if (!isWriteMode || !key.isBucket) return;
    
    // Get the name of the selected bucket
    const bucketName = safeAtob(key.keyBase64);
    
    // When clicking delete bucket in the UI, we're already inside the bucket
    // So the currentPath is the one we want to delete
    const bucketPath = currentPath;
    
    console.log('[DEBUG] handleDeleteBucket - FULL DETAILS:', {
      bucketName,
      currentPath,
      selectedBucketPath: bucketPath
    });
    
    // Use custom confirmation dialog instead of native browser confirm
    setConfirmDelete({
      item: key, 
      type: 'bucket',
      name: bucketName,
      path: bucketPath
    });
  }
  
  function handleConfirmDelete() {
    if (!confirmDelete) return;
    
    // Clear the right pane immediately when deletion is confirmed
    setSelectedKey(null);
    setPreview(null);
    
    if (confirmDelete.type === 'key') {
      console.log('[DEBUG] Delete confirmed, sending deleteKey message');
      // Store current path in a stable variable to ensure consistency
      const keyBucketPath = currentPath;
      console.log('[DEBUG] Deleting key from bucket path:', keyBucketPath);
      post({ 
        type: 'deleteKey', 
        bucketPath: keyBucketPath, 
        keyBase64: confirmDelete.item.keyBase64 
      });
    } else if (confirmDelete.type === 'bucket') {
      // When deleting a bucket, we're deleting the current path
      console.log('[DEBUG] Delete confirmed, sending deleteBucket message with path:', currentPath);
      post({ type: 'deleteBucket', bucketPath: currentPath });
    }
    
    setConfirmDelete(null);
  }
  
  function handleCancelDelete() {
    setConfirmDelete(null);
  }

  function handleEditValue() {
    if (!selectedKey || !preview) return;
    setIsEditingValue(true);
    setEditedValue(preview.content);
  }

  function handleSaveValue() {
    if (!selectedKey || !isEditingValue) return;
    const keyBase64 = selectedKey.keyBase64;
    const valueBase64 = btoa(editedValue);
    post({ type: 'putKey', bucketPath: currentPath, keyBase64, valueBase64 });
    setIsEditingValue(false);
  }

  function handleCancelEdit() {
    setIsEditingValue(false);
    setEditedValue('');
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
      
      // Add more extensive logging to help debug navigation issues
      console.log(`[DEBUG] Message received: ${msg.type}`, { 
        messageType: msg.type,
        currentPath,
        messageData: msg
      });
      
      // Enhanced debugging for bucket operations
      if (msg.type === 'bucketCreated' || msg.type === 'bucketDeleted') {
        console.log('[DEBUG] Bucket operation details:', {
          operation: msg.type,
          path: msg.bucketPath,
          currentPathBefore: currentPath
        });
      }
      if (msg.type === 'keys') {
        const res = msg as KeysResponse;
        const responseBucketPath = msg.bucketPath || '';
        
        console.log('[DEBUG] Keys response received with detailed info:', {
          responseBucketPath,
          currentPath,
          keysCount: res.items?.length || 0,
          afterKey: msg.afterKey
        });
        console.timeEnd(`loadKeys-${responseBucketPath || 'root'}`);
        
        // Ensure currentPath matches the bucket path we just loaded
        // This fixes inconsistency between breadcrumbs and content
        if (currentPath !== responseBucketPath) {
          console.log('[DEBUG] Fixing path mismatch - updating currentPath from', 
                      currentPath, 'to', responseBucketPath);
          setCurrentPath(responseBucketPath);
        }
        
        // Always set keys based on response, regardless of pagination state
        setKeys(prev => msg.afterKey ? [...prev, ...(res.items || [])] : (res.items || []));
        setNextAfterKey(res.nextAfterKey);
        setIsLoading(false);
        // If we have a pending highlight/preview, try to find the key, and auto-page if needed
        const pending = pendingHighlightRef.current;
        if (pending) {
          console.log('[DEBUG] Looking for keyBase64:', pending.keyBase64, 'in loaded keys.');
          console.log('[DEBUG] Decoded pending.keyBase64:', safeAtob(pending.keyBase64));
          console.log('[DEBUG] Number of keys loaded:', res.items.length);
          
          // Log all loaded keys to help with debugging
          res.items.forEach((k, idx) => {
            console.log(`[DEBUG] Page key[${idx}]:`, k.keyBase64, '| Decoded:', safeAtob(k.keyBase64));
          });
          
          // Try to find the key in the current page
          const foundInPage = res.items.find(k => k.keyBase64 === pending.keyBase64);
          
          if (foundInPage) {
            // We found the key we're looking for!
            console.log('[DEBUG] Found key to select:', safeAtob(foundInPage.keyBase64));
            
            // Set the selected key (clear first to ensure UI updates properly)
            setSelectedKey(null);
            setTimeout(() => {
              setSelectedKey(foundInPage);
              
              // Load the key's value for preview
              post({ type: 'readHead', bucketPath: pending.bucketPath, keyBase64: pending.keyBase64 });
              
              // Clear the pending highlight
              pendingHighlightRef.current = null;
            }, 10);
          } else if (res.nextAfterKey) {
            // Not found on this page, load the next page
            console.log('[DEBUG] Key not found in this page, paging for more... nextAfterKey:', res.nextAfterKey);
            pendingHighlightRef.current = pending;
            loadKeys(msg.bucketPath || '', res.nextAfterKey);
          } else {
            // We've checked all pages and didn't find the key
            console.log('[DEBUG] Key not found after paging all pages:', safeAtob(pending.keyBase64));
            
            // As a fallback for newly created keys, create a synthetic key object
            const syntheticKey: Key = {
              keyBase64: pending.keyBase64,
              valueSize: pending.valueSize || 1,
              isBucket: false
            };
            
            console.log('[DEBUG] Using synthetic key as fallback:', safeAtob(syntheticKey.keyBase64));
            setSelectedKey(syntheticKey);
            post({ type: 'readHead', bucketPath: pending.bucketPath, keyBase64: pending.keyBase64 });
            pendingHighlightRef.current = null;
          }
        }
      } else if (msg.type === 'head') {
        const res = msg as HeadResponse;
        const content = safeBase64ToUtf8(res.valueHeadBase64);
        console.log('[DEBUG] Preview loaded:', content.slice(0, 100));
        
        // If we have a selected key, update its valueSize property with the actual size
        if (selectedKey && !selectedKey.isBucket) {
          setSelectedKey({
            ...selectedKey,
            valueSize: res.totalSize
          });
        }
        
        setPreview({ content, totalSize: res.totalSize });
      } else if (msg.type === 'error') {
        console.log('[DEBUG] Error received:', msg.message);
        setError(msg.message);
        setIsLoading(false);
      } else if (msg.type === 'searchResults') {
        setSearchResults(msg.items || []);
        setIsSearching(false);
      } else if (msg.type === 'bucketCreated') {
        // Extract the new bucket path from the message
        const newBucketPath = msg.bucketPath;
        console.log('[DEBUG] Bucket created:', newBucketPath);
        
        // Get the new bucket name (last part of the path)
        const bucketName = newBucketPath.split('/').pop() || '';
        const bucketNameBase64 = btoa(bucketName);
        
        // Update currentPath to the newly created bucket
        setCurrentPath(newBucketPath);
        
        // Reset pagination when navigating to a new bucket
        setNextAfterKey(undefined);
        
        // Add a small delay to allow database to be properly closed after write
        setTimeout(() => {
          loadKeys(newBucketPath);
          
          // Create a synthetic bucket key object to represent the selected bucket
          const newBucketKey: Key = {
            keyBase64: bucketNameBase64,
            valueSize: 0,
            isBucket: true
          };
          
          // Select this bucket to update the details pane
          setSelectedKey(newBucketKey);
          setPreview({ content: "This is a newly created bucket.", totalSize: 0 });
          
          console.log('[DEBUG] New bucket selected:', {
            name: bucketName,
            base64: bucketNameBase64,
            path: newBucketPath
          });
        }, 100);
      } else if (msg.type === 'keyPut') {
        // Get the bucket path where the key was added/updated
        const bucketPath = msg.bucketPath;
        const keyBase64 = msg.keyBase64;
        
        console.log('[DEBUG] Key put, detailed info:', {
          serverBucketPath: bucketPath,
          currentPath: currentPath,
          keyBase64: keyBase64,
          decodedKey: safeAtob(keyBase64)
        });
        
        // Make sure currentPath is correctly set to the bucket path
        // This ensures consistency between breadcrumbs, keys list and preview
        if (currentPath !== bucketPath) {
          console.log('[DEBUG] Correcting currentPath from', currentPath, 'to', bucketPath);
          setCurrentPath(bucketPath);
        }
        
        // Set a flag to track that we need to select this key after reload
        const isEditing = isEditingValue && selectedKey;
        const keyToSelect = isEditing ? selectedKey!.keyBase64 : keyBase64;
        
        // Track this key for automatic selection after loading keys
        pendingHighlightRef.current = { 
          bucketPath: bucketPath,  // Use the server-provided bucket path
          keyBase64: keyToSelect, 
          valueSize: 1,  // Initial placeholder size
          loadedKeys: [] 
        };
        
        console.log('[DEBUG] Setting pendingHighlight to auto-select key:', safeAtob(keyToSelect));
        
        // Reset pagination when refreshing after write operations
        setNextAfterKey(undefined);
        
        // Add a small delay to allow database to be properly closed after write
        setTimeout(() => {
          // Clear any selected key temporarily to prevent UI flicker
          setSelectedKey(null);
          setPreview(null);
          
          // Load the keys from the correct bucket path
          loadKeys(bucketPath);
          
          // The pendingHighlightRef mechanism will handle auto-selecting the key
          // when the keys response is received
        }, 100);
      } else if (msg.type === 'keyDeleted') {
        // Get the bucket path where the key was deleted
        const bucketPath = msg.bucketPath;
        
        console.log('[DEBUG] Key deleted, refreshing path:', {
          bucketPath,
          currentPath,
          deletedKey: msg.keyBase64,
          decodedKey: safeAtob(msg.keyBase64)
        });
        
        // Always clear the preview panel when a key is deleted
        setSelectedKey(null);
        setPreview(null);
        
        // Make sure currentPath is correctly set to the bucket path
        // This ensures breadcrumbs will show correctly
        if (currentPath !== bucketPath) {
          console.log('[DEBUG] Correcting currentPath from', currentPath, 'to', bucketPath);
          setCurrentPath(bucketPath);
        }
        
        // Reset pagination when refreshing after write operations
        setNextAfterKey(undefined);
        
        // Add a small delay to allow database to be properly closed after write
        setTimeout(() => loadKeys(bucketPath), 100);
      } else if (msg.type === 'bucketDeleted') {
        // After deleting a bucket, we always need to navigate to its parent
        const deletedBucketPath = msg.bucketPath;
        
        console.log('[DEBUG] Bucket deleted - navigating to parent:', {
          deletedBucketPath,
          currentPath
        });
        
        // Calculate the parent path of the deleted bucket
        const parentPath = deletedBucketPath.includes('/') ? 
          deletedBucketPath.substring(0, deletedBucketPath.lastIndexOf('/')) : '';
        
        console.log('[DEBUG] Navigating to parent path:', parentPath);
        
        // Always ensure the preview panel is cleared when a bucket is deleted
        setSelectedKey(null);
        setPreview(null);
        
        // Update UI state for navigation
        setCurrentPath(parentPath);
        setNextAfterKey(undefined); // Reset pagination state
        
        // Load the parent bucket contents
        loadKeys(parentPath);
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
    setError(null); // Clear any previous errors
    // Reset editing state when selecting a different key
    setIsEditingValue(false);
    setEditedValue('');
    if (key.isBucket) {
      // Navigate into the bucket
      const newPath = currentPath ? `${currentPath}/${safeAtob(key.keyBase64)}` : safeAtob(key.keyBase64);
      console.log('[DEBUG] Navigating to bucket:', newPath);
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
        <div className="header-top">
          <h2>BoltDB Viewer</h2>
          <div className="mode-toggle">
            <label>
              <input
                type="checkbox"
                checked={isWriteMode}
                onChange={(e) => setIsWriteMode(e.target.checked)}
              />
              <span className="toggle-slider"></span>
              <span className="toggle-label">{isWriteMode ? 'Write Mode' : 'Read Only'}</span>
            </label>
          </div>
        </div>
        <div className="breadcrumb">
          <button onClick={navigateToRoot}>Root</button>
          {currentPath && currentPath.split('/').filter(Boolean).map((part, i, arr) => {
            // Construct path up to this part, ensuring no duplicate slashes
            const pathParts = arr.slice(0, i + 1);
            const pathUpToHere = pathParts.join('/');
            
            // Add debug logging to help diagnose breadcrumb issues
            console.log(`[DEBUG] Breadcrumb part ${i}:`, {
              part,
              pathUpToHere,
              fullCurrentPath: currentPath
            });
            
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
        <div className="search-controls">
            <div className="search-input-container">
              <input
                ref={searchInputRef as any}
                type="text"
                className="search-input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search keys/values..."
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                spellCheck={false}
              />
              {searchQuery && (
                <div className="clear-search-container">
                  <button
                    className="clear-search-button"
                    onClick={() => {
                      setSearchQuery('');
                      setSearchResults([]);
                      if (searchInputRef.current) {
                        searchInputRef.current.focus();
                      }
                    }}
                    title="Clear search"
                    tabIndex={-1}
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
            <button 
              onClick={handleSearch} 
              disabled={isSearching} 
              className="search-button"
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          <label className="case-sensitive-label">
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
            <>
              <div className="table-header">
                <h3>Database Contents</h3>
                {isWriteMode && (
                  <div className="table-actions">
                    <button 
                      onClick={() => setShowAddBucketForm(!showAddBucketForm)}
                      className="write-button"
                    >
                      {showAddBucketForm ? 'Cancel' : '+ Add Bucket'}
                    </button>
                    {currentPath && (
                      <button 
                        onClick={() => setShowAddKeyForm(!showAddKeyForm)}
                        className="write-button"
                      >
                        {showAddKeyForm ? 'Cancel' : '+ Add Key'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              
              {isWriteMode && showAddBucketForm && (
                <div className="add-form">
                  <input
                    type="text"
                    value={newBucketName}
                    onChange={(e) => setNewBucketName(e.target.value)}
                    placeholder="Bucket name"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateBucket();
                      if (e.key === 'Escape') setShowAddBucketForm(false);
                    }}
                  />
                  <button onClick={handleCreateBucket} disabled={!newBucketName.trim()}>
                    Create Bucket
                  </button>
                </div>
              )}
              
              {isWriteMode && showAddKeyForm && currentPath && (
                <div className="add-form">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key name"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newKeyName.trim()) {
                        const valueInput = e.currentTarget.nextElementSibling as HTMLInputElement;
                        if (valueInput) valueInput.focus();
                      }
                      if (e.key === 'Escape') setShowAddKeyForm(false);
                    }}
                  />
                  <input
                    type="text"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="Value"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handlePutKey();
                      if (e.key === 'Escape') setShowAddKeyForm(false);
                    }}
                  />
                  <button onClick={handlePutKey} disabled={!newKeyName.trim()}>
                    Add Key
                  </button>
                </div>
              )}
              
              <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Size</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k, i) => (
                  <tr
                    key={i}
                    className={`table-row ${selectedKey && selectedKey.keyBase64 === k.keyBase64 ? 'selected' : ''}`}
                    onClick={() => handleKeyClick(k)}
                  >
                    <td title={safeAtob(k.keyBase64)}>
                      {safeAtob(k.keyBase64).slice(0, 40)}
                    </td>
                    <td>
                      {formatSize(k.valueSize)}
                    </td>
                    <td>
                      {k.isBucket ? 'Bucket' : 'Value'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
          )}
          {!isLoading && nextAfterKey && (
            <button onClick={() => loadKeys(currentPath, nextAfterKey)}>Load More...</button>
          )}
        </div>
        
        <div className="preview-panel">
          {selectedKey && (
            <div>
              <div className="preview-header">
                <h3>Selected: {safeAtob(selectedKey.keyBase64)}</h3>
                <div className="key-metadata">
                  {/* <span>Type: {selectedKey.isBucket ? 'bucket' : 'key'}</span> */}
                  {isWriteMode && (
                    <div className="preview-actions">
                      <button
                        onClick={() => {
                          console.log('[DEBUG] Delete button clicked');
                          if (selectedKey.isBucket) {
                            handleDeleteBucket(selectedKey);
                          } else {
                            handleDeleteKey(selectedKey);
                          }
                        }}
                        className="delete-button-improved"
                        title={`Delete ${selectedKey.isBucket ? 'bucket' : 'key'}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5ZM11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H2.506a.58.58 0 0 0-.01 1.152l.557 10.056A2 2 0 0 0 5.046 16h5.908a2 2 0 0 0 1.993-1.836l.557-10.056a.58.58 0 0 0-.01-1.152H11ZM4.5 5.5a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7ZM7.5 5.5a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7Zm3-1a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5Z"/>
                        </svg>
                        <span>Delete</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {selectedKey.isBucket ? (
                <p>This is a bucket.</p>
              ) : (
                <div>
                  <p>Size: {formatSize(selectedKey.valueSize)}</p>
                  {preview && (
                    <div>
                      {isEditingValue ? (
                        <div className="edit-value-container">
                          <div className="content-header">
                            <div className="content-type">Editing Value</div>
                            <div className="edit-actions">
                              <button onClick={handleSaveValue} className="save-button">
                                Save
                              </button>
                              <button onClick={handleCancelEdit} className="cancel-button">
                                Cancel
                              </button>
                            </div>
                          </div>
                          <textarea
                            className="edit-value-textarea"
                            value={editedValue}
                            onChange={(e) => setEditedValue(e.target.value)}
                            rows={10}
                          />
                        </div>
                      ) : (
                        <>
                          {(() => {
                            const { formatted, type } = formatContent(preview.content);
                            return (
                              <div>
                                <div className="content-header">
                                  <div className="content-type">
                                    Content Type: <span className={`type-${type}`}>{type.toUpperCase()}</span>
                                  </div>
                                  <div className="content-actions">
                                    {isWriteMode && type !== 'binary' && (
                                      <button 
                                        className="edit-button" 
                                        onClick={handleEditValue}
                                        title="Edit value"
                                      >
                                        Edit
                                      </button>
                                    )}
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
                                </div>
                                <pre className={`preview preview-${type}`}>{formatted}</pre>
                              </div>
                            );
                          })()}
                          {preview.totalSize > 64 * 1024 && (
                            <p>Showing preview (up to 64 KiB of {formatSize(preview.totalSize)})</p>
                          )}
                          <button onClick={handleSave}>Save full value to file</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Custom Confirmation Dialog */}
      {confirmDelete && (
        <div className="modal-overlay">
          <div className="confirmation-dialog">
            <h3>Confirm Delete</h3>
            <p>
              Are you sure you want to delete {confirmDelete.type} "{confirmDelete.name}"
              {confirmDelete.type === 'bucket' && " and all its contents"}?
            </p>
            <div className="dialog-buttons">
              <button 
                className="cancel-button" 
                onClick={handleCancelDelete}
              >
                Cancel
              </button>
              <button 
                className="delete-button" 
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
