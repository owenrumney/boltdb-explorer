package write

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"flag"
	"fmt"
	"strings"

	"go.etcd.io/bbolt"
)

func Run() {
	var dbPath, operation, bucketPath, keyBase64, valueBase64 string
	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&operation, "op", "", "Operation: create-bucket, put, delete-key, delete-bucket")
	flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
	flag.StringVar(&keyBase64, "key", "", "key (base64)")
	flag.StringVar(&valueBase64, "value", "", "value (base64)")
	flag.Parse()

	if dbPath == "" {
		common.Fail("write", fmt.Errorf("missing -db"))
	}
	if operation == "" {
		common.Fail("write", fmt.Errorf("missing -op"))
	}

	// Open DB in read-write mode
	db, err := bbolt.Open(dbPath, 0644, nil)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()

	switch operation {
	case "create-bucket":
		err = createBucket(db, bucketPath)
	case "put":
		err = putKeyValue(db, bucketPath, keyBase64, valueBase64)
	case "delete-key":
		err = deleteKey(db, bucketPath, keyBase64)
	case "delete-bucket":
		err = deleteBucket(db, bucketPath)
	default:
		common.Fail("write", fmt.Errorf("unknown operation: %s", operation))
	}

	if err != nil {
		common.Fail("write", err)
	}

	common.PrintJSON(common.Result{"ok": true})
}

func createBucket(db *bbolt.DB, bucketPath string) error {
	if bucketPath == "" {
		return fmt.Errorf("bucket path required")
	}

	return db.Update(func(tx *bbolt.Tx) error {
		path := strings.Split(bucketPath, "/")
		bucketName := path[len(path)-1]

		// Navigate to parent bucket
		var parentBucket *bbolt.Bucket
		if len(path) == 1 {
			// Creating at root level
			_, err := tx.CreateBucket([]byte(bucketName))
			return err
		} else {
			// Creating in nested bucket
			parentPath := path[:len(path)-1]
			parentBucket = common.BucketAtPath(tx, parentPath)
			if parentBucket == nil {
				return fmt.Errorf("parent bucket not found")
			}
			_, err := parentBucket.CreateBucket([]byte(bucketName))
			return err
		}
	})
}

func putKeyValue(db *bbolt.DB, bucketPath, keyBase64, valueBase64 string) error {
	if keyBase64 == "" {
		return fmt.Errorf("key required")
	}
	if valueBase64 == "" {
		return fmt.Errorf("value required")
	}

	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return fmt.Errorf("invalid key base64: %v", err)
	}

	value, err := base64.StdEncoding.DecodeString(valueBase64)
	if err != nil {
		return fmt.Errorf("invalid value base64: %v", err)
	}

	return db.Update(func(tx *bbolt.Tx) error {
		var bucket *bbolt.Bucket
		if bucketPath == "" {
			return fmt.Errorf("cannot put key-value at root level")
		}

		path := strings.Split(bucketPath, "/")
		bucket = common.BucketAtPath(tx, path)
		if bucket == nil {
			return fmt.Errorf("bucket not found")
		}

		return bucket.Put(key, value)
	})
}

func deleteKey(db *bbolt.DB, bucketPath, keyBase64 string) error {
	if keyBase64 == "" {
		return fmt.Errorf("key required")
	}

	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return fmt.Errorf("invalid key base64: %v", err)
	}

	return db.Update(func(tx *bbolt.Tx) error {
		var bucket *bbolt.Bucket
		if bucketPath == "" {
			return fmt.Errorf("cannot delete key at root level")
		}

		path := strings.Split(bucketPath, "/")
		bucket = common.BucketAtPath(tx, path)
		if bucket == nil {
			return fmt.Errorf("bucket not found")
		}

		return bucket.Delete(key)
	})
}

func deleteBucket(db *bbolt.DB, bucketPath string) error {
	if bucketPath == "" {
		return fmt.Errorf("bucket path required")
	}

	return db.Update(func(tx *bbolt.Tx) error {
		path := strings.Split(bucketPath, "/")
		bucketName := path[len(path)-1]

		if len(path) == 1 {
			// Deleting root level bucket
			return tx.DeleteBucket([]byte(bucketName))
		} else {
			// Deleting nested bucket
			parentPath := path[:len(path)-1]
			parentBucket := common.BucketAtPath(tx, parentPath)
			if parentBucket == nil {
				return fmt.Errorf("parent bucket not found")
			}
			return parentBucket.DeleteBucket([]byte(bucketName))
		}
	})
}
