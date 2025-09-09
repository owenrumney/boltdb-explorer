package search

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strings"

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

func Run() {
	var dbPath, query string
	var limit int
	var caseSensitive bool

	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&query, "query", "", "Search query")
	flag.IntVar(&limit, "limit", 100, "Maximum number of results")
	flag.BoolVar(&caseSensitive, "case-sensitive", false, "Case sensitive search")
	flag.Parse()

	if dbPath == "" || query == "" {
		fmt.Fprintln(os.Stderr, "missing required args: db and query")
		os.Exit(1)
	}

	db, err := common.OpenDB(dbPath)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()

	var results []SearchItem
	var count int

	searchQuery := query
	if !caseSensitive {
		searchQuery = strings.ToLower(searchQuery)
	}

	db.View(func(tx *bbolt.Tx) error {
		return searchRecursive(tx, []string{}, searchQuery, caseSensitive, limit, &results, &count)
	})

	response := SearchResult{
		Items:   results,
		Total:   len(results),
		Limited: len(results) >= limit,
	}
	common.PrintJSON(response)
}

func searchRecursive(tx *bbolt.Tx, path []string, query string, caseSensitive bool, limit int, items *[]SearchItem, count *int) error {
	if *count >= limit {
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

			// Check if bucket name matches search query
			if strings.Contains(searchKey, query) {
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

			// Search recursively in this bucket
			if *count < limit && bucket != nil {
				newPath := []string{keyStr}
				return searchInBucket(bucket, newPath, query, caseSensitive, limit, items, count)
			}

			return nil
		})
	} else {
		// Search in specific bucket
		bucket := common.BucketAtPath(tx, path)
		if bucket == nil {
			return nil
		}
		return searchInBucket(bucket, path, query, caseSensitive, limit, items, count)
	}
}

func searchInBucket(bucket *bbolt.Bucket, path []string, query string, caseSensitive bool, limit int, items *[]SearchItem, count *int) error {
	return bucket.ForEach(func(k, v []byte) error {
		if *count >= limit {
			return nil
		}

		keyStr := string(k)
		searchKey := keyStr
		if !caseSensitive {
			searchKey = strings.ToLower(keyStr)
		}

		// Check if key matches search query
		if strings.Contains(searchKey, query) {
			item := SearchItem{
				Path:      append([]string{}, path...),
				KeyBase64: base64.StdEncoding.EncodeToString(k),
				ValueSize: len(v),
				IsBucket:  v == nil,
			}
			if v == nil {
				item.Type = "bucket"
			} else {
				item.Type = "key"
			}
			*items = append(*items, item)
			*count++
		}

		// If this is a bucket, search recursively
		if v == nil && *count < limit {
			newPath := append(path, keyStr)
			subBucket := bucket.Bucket(k)
			if subBucket != nil {
				return searchInBucket(subBucket, newPath, query, caseSensitive, limit, items, count)
			}
		}

		return nil
	})
}
