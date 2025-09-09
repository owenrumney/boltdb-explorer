package get

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"go.etcd.io/bbolt"
)

type HeadResult struct {
	Mode            string `json:"mode"`
	TotalSize       int    `json:"totalSize"`
	ValueHeadBase64 string `json:"valueHeadBase64"`
}

type SaveResult struct {
	Mode        string `json:"mode"`
	TotalSize   int    `json:"totalSize"`
	WrittenPath string `json:"writtenPath"`
}

func Run() {
	var dbPath, bucketPath, keyBase64, mode, out string
	var n int
	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
	flag.StringVar(&keyBase64, "key", "", "key (base64)")
	flag.StringVar(&mode, "mode", "head", "mode: head|save|pipe")
	flag.IntVar(&n, "n", 65536, "bytes for head")
	flag.StringVar(&out, "out", "", "output file (for save)")
	flag.Parse()
	if dbPath == "" || keyBase64 == "" {
		fmt.Fprintln(os.Stderr, "missing required args")
		os.Exit(1)
	}
	var path []string
	if bucketPath != "" {
		path = strings.Split(bucketPath, "/")
	}
	key, _ := base64.StdEncoding.DecodeString(keyBase64)
	db, err := common.OpenDB(dbPath)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()
	var total int
	var val []byte
	_ = db.View(func(tx *bbolt.Tx) error {
		if len(path) == 0 {
			// Root level - cannot get values directly, only buckets exist at root
			return fmt.Errorf("cannot get values at root level, only buckets")
		} else {
			b := common.BucketAtPath(tx, path)
			if b == nil {
				return fmt.Errorf("bucket not found")
			}
			val = b.Get(key)
		}
		if val != nil {
			total = len(val)
		}
		return nil
	})
	switch mode {
	case "head":
		head := val
		if len(val) > n {
			head = val[:n]
		}
		res := HeadResult{"head", total, base64.StdEncoding.EncodeToString(head)}
		_ = json.NewEncoder(os.Stdout).Encode(res)
	case "save":
		f, err := os.Create(out)
		if err != nil {
			common.Fail("create out", err)
		}
		defer f.Close()
		if val != nil {
			_, err = io.Copy(f, strings.NewReader(string(val)))
			if err != nil {
				common.Fail("write out", err)
			}
		}
		res := SaveResult{"save", total, out}
		_ = json.NewEncoder(os.Stdout).Encode(res)
	}
}
