package listkeys

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

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

func Run() {
	var dbPath, bucketPath, prefix, afterKey string
	var limit int
	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
	flag.StringVar(&prefix, "prefix", "", "prefix filter")
	flag.IntVar(&limit, "limit", 1000, "max keys")
	flag.StringVar(&afterKey, "after-key", "", "resume after key (base64)")
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
