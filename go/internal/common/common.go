package common

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"go.etcd.io/bbolt"
)

type Result map[string]any

func OpenDB(path string) (*bbolt.DB, error) {
	return bbolt.Open(path, 0444, &bbolt.Options{ReadOnly: true})
}

func BucketAtPath(tx *bbolt.Tx, path []string) *bbolt.Bucket {
	b := tx.Bucket([]byte(path[0]))
	for _, p := range path[1:] {
		if b == nil {
			return nil
		}
		b = b.Bucket([]byte(p))
	}
	return b
}

func Enc(b []byte) string {
	if b == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

func Fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}

func CmdMeta(db *bbolt.DB) Result {
	info, err := os.Stat(db.Path())
	size := int64(0)
	if err == nil {
		size = info.Size()
	}
	return Result{"ok": true, "path": db.Path(), "size": size}
}

func CmdListBuckets(tx *bbolt.Tx, path []string) Result {
	var buckets []string
	if len(path) == 0 {
		// Root level - list all top-level buckets
		_ = tx.ForEach(func(name []byte, b *bbolt.Bucket) error {
			if b != nil {
				buckets = append(buckets, Enc(name))
			}
			return nil
		})
	} else {
		b := BucketAtPath(tx, path)
		if b == nil {
			return Result{"error": "bucket not found"}
		}
		_ = b.ForEach(func(k, v []byte) error {
			if v == nil {
				buckets = append(buckets, Enc(k))
			}
			return nil
		})
	}
	return Result{"buckets": buckets}
}

func PrintJSON(v any) {
	json.NewEncoder(os.Stdout).Encode(v)
}
