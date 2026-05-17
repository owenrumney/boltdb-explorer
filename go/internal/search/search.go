package search

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"go.etcd.io/bbolt"
)

type SearchItem struct {
	Path      []string `json:"path"`
	KeyBase64 string   `json:"keyBase64"`
	ValueSize int      `json:"valueSize"`
	IsBucket  bool     `json:"isBucket"`
	Type      string   `json:"type"` // "bucket" or "key"
}

type SearchResult struct {
	Items   []SearchItem `json:"items"`
	Total   int          `json:"total"`
	Limited bool         `json:"limited"`
}

type StreamMessage struct {
	Type     string      `json:"type"` // "result", "progress", "complete", "error"
	Item     *SearchItem `json:"item,omitempty"`
	Progress *Progress   `json:"progress,omitempty"`
	Error    string      `json:"error,omitempty"`
	Summary  *Summary    `json:"summary,omitempty"`
}

type Progress struct {
	CurrentPath []string `json:"currentPath"`
	Depth       int      `json:"depth"`
	Found       int      `json:"found"`
	Elapsed     string   `json:"elapsed"`
}

type Summary struct {
	TotalFound int    `json:"totalFound"`
	Completed  bool   `json:"completed"`
	Elapsed    string `json:"elapsed"`
}

func Run() {
	var dbPath, query, searchType string
	var limit, maxDepth int
	var caseSensitive, stream, exactMatch bool

	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&query, "query", "", "Search query")
	flag.StringVar(&searchType, "type", "both", "Search type: 'buckets', 'keys', or 'both'")
	flag.IntVar(&limit, "limit", 100, "Maximum number of results")
	flag.IntVar(&maxDepth, "max-depth", 10000, "Maximum recursion depth (-1 for unlimited)")
	flag.BoolVar(&caseSensitive, "case-sensitive", false, "Case sensitive search")
	flag.BoolVar(&exactMatch, "exact-match", false, "Exact match search")
	flag.BoolVar(&stream, "stream", false, "Stream results as JSON lines")
	flag.Parse()

	if dbPath == "" || query == "" {
		fmt.Fprintln(os.Stderr, "missing required args: db and query")
		os.Exit(1)
	}

	if searchType != "buckets" && searchType != "keys" && searchType != "both" {
		fmt.Fprintln(os.Stderr, "invalid search type: must be 'buckets', 'keys', or 'both'")
		os.Exit(1)
	}

	db, err := common.OpenDB(dbPath)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()

	searchQuery := query
	if !caseSensitive {
		searchQuery = strings.ToLower(searchQuery)
	}

	if stream {
		runStreamingSearch(db, searchQuery, caseSensitive, exactMatch, searchType, maxDepth, limit)
	} else {
		var results []SearchItem
		var count int

		db.View(func(tx *bbolt.Tx) error {
			return searchOptimized(tx, []string{}, searchQuery, caseSensitive, exactMatch, searchType, maxDepth, 0, limit, &results, &count)
		})

		response := SearchResult{
			Items:   results,
			Total:   len(results),
			Limited: len(results) >= limit,
		}
		common.PrintJSON(response)
	}
}

func runStreamingSearch(db *bbolt.DB, query string, caseSensitive, exactMatch bool, searchType string, maxDepth, limit int) {
	startTime := time.Now()
	count := 0
	encoder := json.NewEncoder(os.Stdout)

	db.View(func(tx *bbolt.Tx) error {
		return streamingSearchRecursive(tx, []string{}, query, caseSensitive, exactMatch, searchType, maxDepth, 0, limit, &count, startTime, encoder)
	})

	// Send completion message
	summary := StreamMessage{
		Type: "complete",
		Summary: &Summary{
			TotalFound: count,
			Completed:  true,
			Elapsed:    time.Since(startTime).String(),
		},
	}
	encoder.Encode(summary)
}

func streamingSearchRecursive(tx *bbolt.Tx, path []string, query string, caseSensitive, exactMatch bool, searchType string, maxDepth, currentDepth, limit int, count *int, startTime time.Time, encoder *json.Encoder) error {
	if *count >= limit {
		return nil
	}

	if maxDepth >= 0 && currentDepth > maxDepth {
		return nil
	}

	// Send progress update every 100ms or when depth changes
	if currentDepth == 0 || time.Since(startTime).Milliseconds()%100 == 0 {
		progress := StreamMessage{
			Type: "progress",
			Progress: &Progress{
				CurrentPath: path,
				Depth:       currentDepth,
				Found:       *count,
				Elapsed:     time.Since(startTime).String(),
			},
		}
		encoder.Encode(progress)
	}

	if len(path) == 0 {
		// Root level - iterate through top-level buckets
		return tx.ForEach(func(name []byte, bucket *bbolt.Bucket) error {
			if *count >= limit {
				return nil
			}
			if bucket == nil {
				return nil
			}

			keyStr := string(name)
			searchKey := keyStr
			if !caseSensitive {
				searchKey = strings.ToLower(keyStr)
			}

			// Check if bucket name matches and send result immediately
			var matches bool
			if exactMatch {
				matches = searchKey == query
			} else {
				matches = strings.Contains(searchKey, query)
			}
			if matches && (searchType == "both" || searchType == "buckets") {
				item := SearchItem{
					Path:      []string{},
					KeyBase64: base64.StdEncoding.EncodeToString(name),
					ValueSize: 0,
					IsBucket:  true,
					Type:      "bucket",
				}

				result := StreamMessage{
					Type: "result",
					Item: &item,
				}
				encoder.Encode(result)
				*count++
			}

			// Search recursively in this bucket
			if *count < limit {
				newPath := []string{keyStr}
				err := streamingSearchInBucket(bucket, newPath, query, caseSensitive, exactMatch, searchType, maxDepth, currentDepth+1, limit, count, startTime, encoder)
				if err != nil {
					return err
				}
			}
			return nil
		})
	} else {
		// Search in specific bucket
		bucket := common.BucketAtPath(tx, path)
		if bucket == nil {
			return nil
		}
		return streamingSearchInBucket(bucket, path, query, caseSensitive, exactMatch, searchType, maxDepth, currentDepth, limit, count, startTime, encoder)
	}
}

func streamingSearchInBucket(bucket *bbolt.Bucket, path []string, query string, caseSensitive, exactMatch bool, searchType string, maxDepth, currentDepth, limit int, count *int, startTime time.Time, encoder *json.Encoder) error {
	c := bucket.Cursor()
	for k, v := c.First(); k != nil && *count < limit; k, v = c.Next() {
		keyStr := string(k)
		searchKey := keyStr
		if !caseSensitive {
			searchKey = strings.ToLower(keyStr)
		}

		// Check if key matches search query and send result immediately
		var matches bool
		if exactMatch {
			matches = searchKey == query
		} else {
			matches = strings.Contains(searchKey, query)
		}
		if matches {
			isBucket := v == nil
			itemType := "key"
			if isBucket {
				itemType = "bucket"
			}

			// Apply search type filter
			shouldInclude := false
			if searchType == "both" {
				shouldInclude = true
			} else if searchType == "buckets" && isBucket {
				shouldInclude = true
			} else if searchType == "keys" && !isBucket {
				shouldInclude = true
			}

			if shouldInclude {
				item := SearchItem{
					Path:      append([]string{}, path...),
					KeyBase64: base64.StdEncoding.EncodeToString(k),
					ValueSize: len(v),
					IsBucket:  isBucket,
					Type:      itemType,
				}

				result := StreamMessage{
					Type: "result",
					Item: &item,
				}
				encoder.Encode(result)
				*count++
			}
		}

		// If this is a bucket, search recursively
		if v == nil && *count < limit && (maxDepth < 0 || currentDepth < maxDepth) {
			newPath := append(path, keyStr)
			subBucket := bucket.Bucket(k)
			if subBucket != nil {
				err := streamingSearchInBucket(subBucket, newPath, query, caseSensitive, exactMatch, searchType, maxDepth, currentDepth+1, limit, count, startTime, encoder)
				if err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func searchOptimized(tx *bbolt.Tx, path []string, query string, caseSensitive, exactMatch bool, searchType string, maxDepth, currentDepth, limit int, items *[]SearchItem, count *int) error {
	if *count >= limit {
		return nil
	}

	if maxDepth >= 0 && currentDepth > maxDepth {
		return nil
	}

	if len(path) == 0 {
		// Root level - search through top-level buckets
		return tx.ForEach(func(name []byte, bucket *bbolt.Bucket) error {
			if *count >= limit {
				return nil
			}

			keyStr := string(name)
			searchKey := keyStr
			if !caseSensitive {
				searchKey = strings.ToLower(keyStr)
			}

			// Check if bucket name matches search query and if we're searching for buckets
			var matches bool
			if exactMatch {
				matches = searchKey == query
			} else {
				matches = strings.Contains(searchKey, query)
			}
			if matches && (searchType == "both" || searchType == "buckets") {
				item := SearchItem{
					Path:      []string{},
					KeyBase64: base64.StdEncoding.EncodeToString(name),
					ValueSize: 0, // Bucket size calculation is expensive, skip for search
					IsBucket:  true,
					Type:      "bucket",
				}
				*items = append(*items, item)
				*count++
			}

			// Search recursively in this bucket if we haven't hit our limit
			if *count < limit && bucket != nil {
				newPath := []string{keyStr}
				return searchInBucket(bucket, newPath, query, caseSensitive, exactMatch, searchType, limit, items, count)
			}

			return nil
		})
	} else {
		// Search in specific bucket
		bucket := common.BucketAtPath(tx, path)
		if bucket == nil {
			return nil
		}
		return searchInBucket(bucket, path, query, caseSensitive, exactMatch, searchType, limit, items, count)
	}
}

func searchInBucket(bucket *bbolt.Bucket, path []string, query string, caseSensitive, exactMatch bool, searchType string, limit int, items *[]SearchItem, count *int) error {
	return bucket.ForEach(func(k, v []byte) error {
		if *count >= limit {
			return nil
		}

		keyStr := string(k)
		searchKey := keyStr
		if !caseSensitive {
			searchKey = strings.ToLower(keyStr)
		}

		// Check if key matches search query and search type filter
		var matches bool
		if exactMatch {
			matches = searchKey == query
		} else {
			matches = strings.Contains(searchKey, query)
		}
		if matches {
			isBucket := v == nil
			itemType := "key"
			if isBucket {
				itemType = "bucket"
			}

			// Apply search type filter
			shouldInclude := false
			if searchType == "both" {
				shouldInclude = true
			} else if searchType == "buckets" && isBucket {
				shouldInclude = true
			} else if searchType == "keys" && !isBucket {
				shouldInclude = true
			}

			if shouldInclude {
				item := SearchItem{
					Path:      append([]string{}, path...),
					KeyBase64: base64.StdEncoding.EncodeToString(k),
					ValueSize: len(v),
					IsBucket:  isBucket,
					Type:      itemType,
				}
				*items = append(*items, item)
				*count++
			}
		}

		// If this is a bucket, search recursively
		if v == nil && *count < limit {
			newPath := append(path, keyStr)
			subBucket := bucket.Bucket(k)
			if subBucket != nil {
				return searchInBucket(subBucket, newPath, query, caseSensitive, exactMatch, searchType, limit, items, count)
			}
		}

		return nil
	})
}
