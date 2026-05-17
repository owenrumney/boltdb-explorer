package listkeys

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

type Item struct {
	KeyBase64 string `json:"keyBase64"`
	ValueSize int    `json:"valueSize"`
	IsBucket  bool   `json:"isBucket"`
}

type Result struct {
	Items          []Item `json:"items"`
	NextAfterKey   string `json:"nextAfterKey,omitempty"`
	ApproxReturned int    `json:"approxReturned"`
}

type StreamMessage struct {
	Type     string          `json:"type"` // "item", "progress", "complete", "error"
	Item     *Item           `json:"item,omitempty"`
	Progress *StreamProgress `json:"progress,omitempty"`
	Complete *StreamComplete `json:"complete,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type StreamProgress struct {
	Loaded     int    `json:"loaded"`
	Elapsed    string `json:"elapsed"`
	BucketPath string `json:"bucketPath"`
}

type StreamComplete struct {
	TotalLoaded  int    `json:"totalLoaded"`
	NextAfterKey string `json:"nextAfterKey,omitempty"`
	HasMore      bool   `json:"hasMore"`
	Elapsed      string `json:"elapsed"`
}

func Run() {
	var dbPath, bucketPath, prefix, afterKey string
	var limit int
	var stream bool
	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
	flag.StringVar(&prefix, "prefix", "", "prefix filter")
	flag.IntVar(&limit, "limit", 1000, "max keys")
	flag.StringVar(&afterKey, "after-key", "", "resume after key (base64)")
	flag.BoolVar(&stream, "stream", false, "Stream results as JSON lines")
	flag.Parse()
	if dbPath == "" {
		fmt.Fprintln(os.Stderr, "missing required args")
		os.Exit(1)
	}
	var path []string
	if bucketPath != "" {
		path = strings.Split(bucketPath, "/")
	}
	db, err := common.OpenDB(dbPath)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()

	if stream {
		runStreamingListKeys(db, path, prefix, afterKey, limit, bucketPath)
		return
	}

	var res Result
	db.View(func(tx *bbolt.Tx) error {
		var b *bbolt.Bucket
		if len(path) == 0 {
			// Root level - iterate through all top-level buckets using ForEach
			var allBuckets []struct {
				name []byte
				size int
			}
			_ = tx.ForEach(func(name []byte, bucket *bbolt.Bucket) error {
				if bucket != nil {
					// Calculate bucket size by counting items
					bucketSize := 0
					_ = bucket.ForEach(func(k, v []byte) error {
						bucketSize++
						return nil
					})
					allBuckets = append(allBuckets, struct {
						name []byte
						size int
					}{name, bucketSize})
				}
				return nil
			})

			// Apply pagination and filtering
			startIdx := 0
			if afterKey != "" {
				kRaw, _ := base64.StdEncoding.DecodeString(afterKey)
				for i, bucket := range allBuckets {
					if string(bucket.name) > string(kRaw) {
						startIdx = i
						break
					}
				}
			}

			count := 0
			for i := startIdx; i < len(allBuckets) && count < limit; i++ {
				bucket := allBuckets[i]
				if prefix != "" && !strings.HasPrefix(string(bucket.name), prefix) {
					continue
				}
				item := Item{
					KeyBase64: base64.StdEncoding.EncodeToString(bucket.name),
					ValueSize: bucket.size,
					IsBucket:  true,
				}
				res.Items = append(res.Items, item)
				count++
			}

			if startIdx+count < len(allBuckets) {
				res.NextAfterKey = base64.StdEncoding.EncodeToString(allBuckets[startIdx+count].name)
			}
			res.ApproxReturned = count
			return nil
		}

		b = common.BucketAtPath(tx, path)
		if b == nil {
			return fmt.Errorf("bucket not found")
		}
		c := b.Cursor()
		var k, v []byte
		if afterKey != "" {
			kRaw, _ := base64.StdEncoding.DecodeString(afterKey)
			k, v = c.Seek(kRaw)
			if k != nil {
				k, v = c.Next()
			}
		} else {
			k, v = c.First()
		}
		count := 0
		var nextAfterKey string
		for ; k != nil; k, v = c.Next() {
			if prefix != "" && !strings.HasPrefix(string(k), prefix) {
				continue
			}
			if count >= limit {
				// We have enough items, set NextAfterKey for paging and break
				nextAfterKey = base64.StdEncoding.EncodeToString(k)
				break
			}
			item := Item{KeyBase64: base64.StdEncoding.EncodeToString(k), ValueSize: len(v), IsBucket: v == nil}
			res.Items = append(res.Items, item)
			count++
		}
		if count == limit && nextAfterKey != "" {
			res.NextAfterKey = nextAfterKey
		}
		res.ApproxReturned = count
		fmt.Fprintf(os.Stderr, "[lsk.go] Returned %d items, NextAfterKey: %s\n", count, res.NextAfterKey)
		return nil
	})
	json.NewEncoder(os.Stdout).Encode(res)
}

func runStreamingListKeys(db *bbolt.DB, path []string, prefix, afterKey string, limit int, bucketPath string) {
	startTime := time.Now()
	encoder := json.NewEncoder(os.Stdout)
	loaded := 0
	var nextAfterKey string

	err := db.View(func(tx *bbolt.Tx) error {
		var b *bbolt.Bucket
		if len(path) == 0 {
			// Root level streaming - handle differently
			return streamRootLevel(tx, prefix, afterKey, limit, bucketPath, startTime, encoder, &loaded, &nextAfterKey)
		} else {
			// Specific bucket streaming
			b = common.BucketAtPath(tx, path)
			if b == nil {
				return fmt.Errorf("bucket not found")
			}
			return streamBucket(b, prefix, afterKey, limit, bucketPath, startTime, encoder, &loaded, &nextAfterKey)
		}
	})

	if err != nil {
		errorMsg := StreamMessage{
			Type:  "error",
			Error: err.Error(),
		}
		encoder.Encode(errorMsg)
		return
	}

	// Send completion message
	complete := StreamMessage{
		Type: "complete",
		Complete: &StreamComplete{
			TotalLoaded:  loaded,
			NextAfterKey: nextAfterKey,
			HasMore:      loaded >= limit,
			Elapsed:      time.Since(startTime).String(),
		},
	}
	encoder.Encode(complete)
}

func streamRootLevel(tx *bbolt.Tx, prefix, afterKey string, limit int, bucketPath string, startTime time.Time, encoder *json.Encoder, loaded *int, nextAfterKey *string) error {
	// True streaming - send buckets as we find them
	var skipUntil []byte
	if afterKey != "" {
		skipUntil, _ = base64.StdEncoding.DecodeString(afterKey)
	}

	progressSent := false

	err := tx.ForEach(func(name []byte, bucket *bbolt.Bucket) error {
		if *loaded >= limit {
			// We hit the limit, set nextAfterKey to this bucket name
			*nextAfterKey = base64.StdEncoding.EncodeToString(name)
			return nil
		}

		if bucket == nil {
			return nil
		}

		// Skip until we find buckets AFTER the afterKey
		if skipUntil != nil && string(name) <= string(skipUntil) {
			return nil
		}

		// Apply prefix filter
		if prefix != "" && !strings.HasPrefix(string(name), prefix) {
			return nil
		}

		// Send progress update every 10 items or after 50ms
		if !progressSent || *loaded%10 == 0 || time.Since(startTime).Milliseconds()%50 == 0 {
			progress := StreamMessage{
				Type: "progress",
				Progress: &StreamProgress{
					Loaded:     *loaded,
					Elapsed:    time.Since(startTime).String(),
					BucketPath: bucketPath,
				},
			}
			encoder.Encode(progress)
			progressSent = true
		}

		// Stream the bucket immediately
		item := Item{
			KeyBase64: base64.StdEncoding.EncodeToString(name),
			ValueSize: 0, // Don't calculate size for streaming performance
			IsBucket:  true,
		}

		itemMsg := StreamMessage{
			Type: "item",
			Item: &item,
		}
		encoder.Encode(itemMsg)
		*loaded++

		return nil
	})

	return err
}

func streamBucket(bucket *bbolt.Bucket, prefix, afterKey string, limit int, bucketPath string, startTime time.Time, encoder *json.Encoder, loaded *int, nextAfterKey *string) error {
	c := bucket.Cursor()
	var k, v []byte

	if afterKey != "" {
		kRaw, _ := base64.StdEncoding.DecodeString(afterKey)
		k, v = c.Seek(kRaw)
		if k != nil {
			k, v = c.Next()
		}
	} else {
		k, v = c.First()
	}

	progressSent := false
	for ; k != nil && *loaded < limit; k, v = c.Next() {
		if prefix != "" && !strings.HasPrefix(string(k), prefix) {
			continue
		}

		// Send progress update every 50 items or after 100ms
		if !progressSent || *loaded%50 == 0 || time.Since(startTime).Milliseconds()%100 == 0 {
			progress := StreamMessage{
				Type: "progress",
				Progress: &StreamProgress{
					Loaded:     *loaded,
					Elapsed:    time.Since(startTime).String(),
					BucketPath: bucketPath,
				},
			}
			encoder.Encode(progress)
			progressSent = true
		}

		item := Item{
			KeyBase64: base64.StdEncoding.EncodeToString(k),
			ValueSize: len(v),
			IsBucket:  v == nil,
		}

		itemMsg := StreamMessage{
			Type: "item",
			Item: &item,
		}
		encoder.Encode(itemMsg)
		*loaded++
	}

	// Set nextAfterKey if we stopped because of limit (more items available)
	if *loaded >= limit && k != nil {
		*nextAfterKey = base64.StdEncoding.EncodeToString(k)
	}

	return nil
}
